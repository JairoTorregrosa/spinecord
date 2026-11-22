// Where a robot's runtime comes from. Each source wires packages together and hands the runtime to a LocalRobot:
//   twin     SimBrick + the real Ev3Provider + SimWorldProvider, built at start
//   ev3dev   Ev3devProvider over the system ssh client, connected at start and again each time the link closes
//   ev3      the real Ev3Provider over the bridge page's socket, built each time the page opens an EV3
import { Ev3Provider } from "../../../packages/driver-ev3/provider";
import type { Transport } from "../../../packages/driver-ev3/transport";
import { RuntimeError } from "../../../packages/protocol/types";
import { Ev3devProvider } from "../../../packages/driver-ev3dev/src/provider";
import { SshLineTransport, installBridge } from "../../../packages/driver-ev3dev/src/ssh";
import { createRuntime, type LocalRuntime } from "../../../packages/runtime/runtime";
import { LARGE_DEG_S, SimBrick, drivetrainFromProfile } from "../../../packages/sim-ev3/brick";
import { World, parseWorld } from "../../../packages/sim-world/world";
import { SimWorldProvider } from "../../../packages/sim-world/world-provider";
import { buildBridgePage } from "../../robot-page/bridge-build";
import type { LocalConfig, RobotSource } from "./config";
import { serveBridge, type BridgePageFiles, type BridgeServer } from "./hid-bridge";
import { LocalRobot } from "./robot";

export type Log = (ev: string, fields?: Record<string, unknown>) => void;
export interface Fleet {
  robots: LocalRobot[];
  /** Simulated bricks by robot id (tests read their motors). */
  bricks: Map<string, SimBrick>;
  bridge: BridgeServer | null;
  /** Stops every robot that can be reached, then closes links. One entry per robot: null = no link to stop through. */
  shutdown(): Promise<{ robot_id: string; motors_stopped: boolean | null }[]>;
}

type Source<K extends RobotSource["source"]> = Extract<RobotSource, { source: K }>;

export function twinRuntime(s: Source<"twin">): { runtime: LocalRuntime; brick: SimBrick } {
  const { pair, hardware } = s.robot;
  const profile = { ...s.robot.profile, id: s.id };
  const config = parseWorld(s.world);
  const brick = new SimBrick({ world: new World(config, s.seed), drivetrain: drivetrainFromProfile(profile, pair) });
  const runtime = createRuntime({
    profile,
    providers: [
      // first, so the runtime's backend is "sim"
      new SimWorldProvider({ host: brick, worlds: { [config.name]: s.world }, seed: s.seed }),
      (limits) => new Ev3Provider(brick, { limits, hardware, pair, roles: profile.roles, degPerSecAt100: LARGE_DEG_S }),
    ],
  });
  return { runtime, brick };
}

/** The runtime of a stock-firmware EV3 reached through `transport` (the bridge page's socket, or a fake brick). */
export function ev3Runtime(s: Source<"ev3">, transport: Transport): LocalRuntime {
  const { pair, hardware } = s.robot;
  const profile = { ...s.robot.profile, id: s.id };
  return createRuntime({
    profile,
    providers: [(limits) => new Ev3Provider(transport, { limits, hardware, pair, roles: profile.roles })],
  });
}

export interface FleetOptions {
  log: Log;
  /** The bridge page's files; built from apps/robot-page when absent. */
  page?: BridgePageFiles;
  /** Port 0 (tests) takes any free port. */
  port?: number;
  /** Pause before an ev3dev link that closed is opened again, and between attempts, ms. Default 2000. */
  reconnectMs?: number;
}

/** One link to a robot's hardware: the runtime that talks through it, and the news that it closed. */
export interface HardwareLink {
  runtime: LocalRuntime;
  onClose(cb: (reason: string) => void): void;
  close(): Promise<void>;
}
/**
 * Keeps a robot attached through links that can close. `connect` opens one and resolves when the robot is online
 * through it. A link that closes, during the handshake or after it, puts the robot offline, and a new one is
 * opened every `reconnectMs` until one holds. Logs `gone`, `ready` and `attach_failed`.
 */
export function keepAttached(
  robot: LocalRobot,
  open: () => HardwareLink,
  o: { log: Log; reconnectMs?: number },
): { connect(): Promise<void>; end(): void; close(): Promise<void> } {
  // The link the robot is online through; null while the robot is offline.
  let live: HardwareLink | null = null;
  let ended = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const again = (): void => {
    if (ended) return;
    retry = setTimeout(() => {
      retry = null;
      if (ended) return;
      connect().then(
        () => o.log("ready"),
        (e: unknown) => {
          // a configuration the attempts cannot change by themselves (a bridge of another version on the brick)
          robot.attachFailed((e as Error).message, e instanceof RuntimeError && e.code === "misconfigured");
          o.log("attach_failed", { error: (e as Error).message });
          again();
        },
      );
    }, o.reconnectMs ?? 2000);
    retry.unref?.();
  };
  const connect = async (): Promise<void> => {
    const link = open();
    let closed: string | null = null;
    link.onClose((reason) => {
      closed ??= reason;
      if (live !== link || ended) return;
      live = null;
      robot.detach(`the link to the robot closed: ${reason}`);
      o.log("gone", { why: reason });
      void link.close().catch(() => {});
      again();
    });
    try {
      await robot.attach(link.runtime);
    } catch (e) {
      await link.close().catch(() => {});
      throw e;
    }
    // a link that closed while the handshake ran is not a link: the robot must not stay online through it
    if (closed !== null || ended) {
      if (closed !== null) robot.detach(`the link to the robot closed during the handshake: ${closed}`);
      await link.close().catch(() => {});
      if (closed !== null) throw new Error(`the link closed during the handshake: ${closed}`);
      return;
    }
    live = link;
  };
  return {
    connect,
    end() {
      ended = true;
      if (retry) clearTimeout(retry);
    },
    close: async () => void (await live?.close()),
  };
}

/** Builds every robot of the config. Throws when one that must be there at start (twin, ev3dev) cannot be built. */
export async function buildFleet(config: LocalConfig, o: FleetOptions): Promise<Fleet> {
  const robots: LocalRobot[] = [];
  const bricks = new Map<string, SimBrick>();
  const closers: (() => Promise<void> | void)[] = [];
  // run before anything else at shutdown: a source stops bringing its robot back
  const enders: (() => void)[] = [];
  let bridge: BridgeServer | null = null;
  const transitions = (id: string) => (fsm: string, from: string, to: string, why: string) =>
    o.log(fsm, { robot_id: id, from, to, why });
  const cancels = (id: string) => (tool: string, moving: boolean) =>
    o.log("cancelled", { robot_id: id, tool, action: moving ? "stop" : "abort" });

  for (const s of config.robots) {
    if (s.source === "twin") {
      const robot = new LocalRobot({ id: s.id, onTransition: transitions(s.id), onCancel: cancels(s.id) });
      const { runtime, brick } = twinRuntime(s);
      await robot.attach(runtime);
      bricks.set(s.id, brick);
      robots.push(robot);
    } else if (s.source === "ev3dev") {
      const robot = new LocalRobot({
        id: s.id,
        connect: `Check that the brick is on and that ssh ${s.ssh.user}@${s.ssh.host} works; this server connects again by itself.`,
        onTransition: transitions(s.id),
        onCancel: cancels(s.id),
      });
      if (s.installBridge) o.log("bridge_installed", { robot_id: s.id, ...(await installBridge(s.ssh)) });
      const { pair } = s.robot;
      const profile = { ...s.robot.profile, id: s.id };
      const link = keepAttached(
        robot,
        () => {
          const transport = new SshLineTransport(s.ssh);
          let provider!: Ev3devProvider;
          const runtime = createRuntime({
            profile,
            providers: [
              (limits) => {
                provider = new Ev3devProvider(transport, { limits, hardware: s.hardware, pair, roles: profile.roles });
                return provider;
              },
            ],
          });
          // the ssh process ended: the brick, the network or the bridge went away
          return { runtime, onClose: (cb) => transport.onClose(cb), close: () => provider.close() };
        },
        { log: (ev, fields) => o.log(`ev3dev_${ev}`, { robot_id: s.id, ...fields }), reconnectMs: o.reconnectMs },
      );
      await link.connect();
      enders.push(link.end);
      closers.push(link.close);
      robots.push(robot);
    } else {
      const page = o.page ?? (await buildBridgePage());
      let robot!: LocalRobot;
      // attach and detach are serialized: a page that flaps must not interleave two handshakes
      let chain: Promise<void> = Promise.resolve();
      bridge = serveBridge(page, o.port ?? config.port, {
        onDevice(transport, info) {
          chain = chain.then(async () => {
            robot.detach("the page opened an EV3 again");
            try {
              await robot.attach(ev3Runtime(s, transport));
              o.log("ev3_ready", { robot_id: s.id, ...info });
            } catch (e) {
              o.log("ev3_attach_failed", { robot_id: s.id, error: (e as Error).message });
            }
          });
        },
        onGone(why) {
          chain = chain.then(() => {
            robot.detach(why);
            o.log("ev3_gone", { robot_id: s.id, why });
          });
        },
      });
      const b = bridge;
      robot = new LocalRobot({
        id: s.id,
        connect: `Ask the person at this computer to open ${b.url} in Chrome or Edge, plug the EV3 in over USB, turn it on and press "Connect EV3".`,
        onTransition: transitions(s.id),
        onCancel: cancels(s.id),
      });
      closers.push(() => b.stop());
      robots.push(robot);
    }
  }

  return {
    robots,
    bricks,
    bridge,
    async shutdown() {
      // every robot refuses calls before the first stop is issued
      for (const end of enders) end();
      for (const r of robots) r.beginShutdown();
      const out = await Promise.all(robots.map(async (r) => ({ robot_id: r.id, motors_stopped: await r.shutdown() })));
      for (const close of closers) await Promise.resolve(close()).catch(() => {});
      return out;
    },
  };
}
