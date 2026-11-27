// Where a robot's runtime comes from. Each source wires packages together and hands the runtime to a LocalRobot:
//   twin     SimBrick + the real Ev3Provider + SimWorldProvider, built at start
//   ev3dev   Ev3devProvider over the system ssh client; the robot starts offline and is connected in the
//            background, at start and each time the link closes, until a link holds
//   ev3      the real Ev3Provider over the bridge page's socket, built each time the page opens an EV3
//   pages    the page hub alone: a robot with no body, online from start
// With pages enabled, every robot's runtime gets that robot's page hub as its last provider; the hub outlives the
// runtimes, so a runtime built again (the bridge page opened the EV3 again) finds the pages' devices where they were.
import { EV3_USB_LOOP_RATE_HZ, Ev3Provider } from "../../../packages/driver-ev3/provider";
import type { Transport } from "../../../packages/driver-ev3/transport";
import { RuntimeError } from "../../../packages/protocol/types";
import { Ev3devProvider } from "../../../packages/driver-ev3dev/src/provider";
import { SshLineTransport, installBridge } from "../../../packages/driver-ev3dev/src/ssh";
import type { Clock } from "../../../packages/runtime/clock";
import { PageHub, type PageHubOptions } from "../../../packages/page-hub/hub";
import type { Provider } from "../../../packages/protocol/types";
import { createRuntime, type LocalRuntime } from "../../../packages/runtime/runtime";
import { LARGE_DEG_S, SIM_BRICK_LOOP_RATE_HZ, SimBrick, drivetrainFromProfile } from "../../../packages/sim-ev3/brick";
import { World, parseWorld } from "../../../packages/sim-world/world";
import { SimWorldProvider } from "../../../packages/sim-world/world-provider";
import { buildPeripheralPage } from "../../peripheral-page/page-build";
import { buildBridgePage } from "../../robot-page/bridge-build";
import type { LocalConfig, RobotSource } from "./config";
import { serveBridge, type BridgePageFiles, type BridgeServer } from "./hid-bridge";
import { prepareLan, type LanDeps, type LanSetup } from "./lan";
import { servePages, type PagesServer, type PageTimes } from "./pages";
import { LocalRobot, type LoopEndLine } from "./robot";

export type Log = (ev: string, fields?: Record<string, unknown>) => void;
export interface Fleet {
  robots: LocalRobot[];
  /** Simulated bricks by robot id (tests read their motors, the 3D view shows them). */
  bricks: Map<string, SimBrick>;
  /** The world provider of each twin, by robot id (the 3D view hears its speaker). */
  sims: Map<string, SimWorldProvider>;
  bridge: BridgeServer | null;
  /** The page listener; null when pages are off. */
  pages: PagesServer | null;
  /** What --lan chose: the address, the name and where the certificate came from; null without --lan. */
  lan: LanSetup | null;
  /** The page hub of each robot, by robot id, when pages are on. */
  hubs: Map<string, PageHub>;
  /** The time source the twins were built on: "virtual" for an injected clock (tests), else "real". */
  clock: "real" | "virtual";
  /** Stops every robot that can be reached, then closes links. One entry per robot: null = no link to stop through. */
  shutdown(): Promise<{ robot_id: string; motors_stopped: boolean | null }[]>;
}

type Source<K extends RobotSource["source"]> = Extract<RobotSource, { source: K }>;

/** The robot's page hub, last of its providers, when pages are on. */
const last = (hub?: PageHub): Provider[] => (hub ? [hub] : []);

/** `clock`: the one time source of the twin's brick, providers and runtime. Default: each runs on real time.
 * `hub`: the robot's page hub, when pages are on. */
export function twinRuntime(
  s: Source<"twin">,
  clock?: Clock,
  hub?: PageHub,
): { runtime: LocalRuntime; brick: SimBrick; sim: SimWorldProvider } {
  const { pair, hardware } = s.robot;
  const profile = { ...s.robot.profile, id: s.id };
  const config = parseWorld(s.world);
  const time = clock && { now: () => clock.now(), sleep: (ms: number) => clock.sleep(ms) };
  const brick = new SimBrick({
    world: new World(config, s.seed),
    // the brick rolls on what the robot physically is; the runtime below plans with what its profile believes
    drivetrain: drivetrainFromProfile(profile, pair, s.build?.drive),
    ...(time && { now: time.now }),
  });
  const sim = new SimWorldProvider({
    host: brick,
    worlds: { [config.name]: s.world },
    seed: s.seed,
    ...(time && { now: time.now }),
  });
  const runtime = createRuntime({
    profile,
    providers: [
      // first, so the runtime's backend is "sim"
      sim,
      (limits) =>
        new Ev3Provider(brick, {
          limits,
          hardware,
          pair,
          roles: profile.roles,
          degPerSecAt100: LARGE_DEG_S,
          loopRateHz: SIM_BRICK_LOOP_RATE_HZ,
          ...time,
        }),
      ...last(hub),
    ],
    ...(clock && { clock }),
  });
  return { runtime, brick, sim };
}

/** The runtime of a stock-firmware EV3 reached through `transport` (the bridge page's socket, or a fake brick). */
export function ev3Runtime(s: Source<"ev3">, transport: Transport, hub?: PageHub): LocalRuntime {
  const { pair, hardware } = s.robot;
  const profile = { ...s.robot.profile, id: s.id };
  return createRuntime({
    profile,
    providers: [
      (limits) =>
        new Ev3Provider(transport, { limits, hardware, pair, roles: profile.roles, loopRateHz: EV3_USB_LOOP_RATE_HZ }),
      ...last(hub),
    ],
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
  /** Time source of every twin (see twinRuntime). Default: real time. */
  clock?: Clock;
  /** Port of the page listener; 0 (tests) takes any free port. Default: the config's. */
  pagePort?: number;
  /** Shorter times of the page state machine and the hub (tests). */
  pageTimes?: Partial<PageTimes>;
  pageHub?: PageHubOptions;
  /** What `--lan` takes from the network, the clock and the disk (tests replace them). */
  lan?: LanDeps;
}

/** One link to a robot's hardware: the runtime that talks through it, and the news that it closed. */
export interface HardwareLink {
  runtime: LocalRuntime;
  onClose(cb: (reason: string) => void): void;
  close(): Promise<void>;
}
/**
 * Keeps a robot attached through links that can close. `connect` opens one and resolves when the robot is online
 * through it. `start` does the same without being waited for: the robot stays offline while the attempt runs, and
 * an attempt that fails is followed by the next. A link that closes, during the handshake or after it, puts the
 * robot offline, and a new one is opened every `reconnectMs` until one holds. `open` may do what a link needs
 * first (copy a bridge to the brick); when it throws, the attempt failed. Logs `gone`, `ready` and `attach_failed`.
 */
export function keepAttached(
  robot: LocalRobot,
  open: () => HardwareLink | Promise<HardwareLink>,
  o: { log: Log; reconnectMs?: number },
): { connect(): Promise<void>; start(): void; end(): void; close(): Promise<void> } {
  // The link the robot is online through; null while the robot is offline.
  let live: HardwareLink | null = null;
  let ended = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  /** One attempt nobody waits for: online and `ready`, or the reason in `list_robots` and the next attempt. */
  const attempt = (): void => {
    if (ended) return;
    connect().then(
      () => {
        if (!ended) o.log("ready");
      },
      (e: unknown) => {
        // a configuration the attempts cannot change by themselves (a bridge of another version on the brick)
        robot.attachFailed((e as Error).message, e instanceof RuntimeError && e.code === "misconfigured");
        o.log("attach_failed", { error: (e as Error).message });
        again();
      },
    );
  };
  const again = (): void => {
    if (ended) return;
    retry = setTimeout(() => {
      retry = null;
      attempt();
    }, o.reconnectMs ?? 2000);
    retry.unref?.();
  };
  const connect = async (): Promise<void> => {
    const link = await open();
    if (ended) return void (await link.close().catch(() => {}));
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
    start: attempt,
    end() {
      ended = true;
      if (retry) clearTimeout(retry);
    },
    close: async () => void (await live?.close()),
  };
}

/**
 * Builds every robot of the config. A twin is online when this returns. A robot on hardware starts offline with
 * its `connect` hint and comes online when its hardware answers: an ev3dev brick through attempts that run by
 * themselves, a stock EV3 when a person opens it on the bridge page.
 */
export async function buildFleet(config: LocalConfig, o: FleetOptions): Promise<Fleet> {
  const robots: LocalRobot[] = [];
  const bricks = new Map<string, SimBrick>();
  const sims = new Map<string, SimWorldProvider>();
  const closers: (() => Promise<void> | void)[] = [];
  // run before anything else at shutdown: a source stops bringing its robot back
  const enders: (() => void)[] = [];
  let bridge: BridgeServer | null = null;
  // pages: one hub per robot, and the listener the pages join through
  const hubs = new Map<string, PageHub>();
  // --lan: the interface and the certificate first, so that a start that cannot have them binds nothing
  const lan: LanSetup | undefined = config.pages?.lan ? await prepareLan(config.pages.lan, o.lan) : undefined;
  if (config.pages) for (const s of config.robots) hubs.set(s.id, new PageHub(o.pageHub));
  const byId = new Map<string, LocalRobot>();
  const pages = config.pages
    ? servePages(hubs, o.pagePort ?? config.pages.port, {
        page: await buildPeripheralPage(),
        log: o.log,
        times: o.pageTimes,
        ...(lan ? { lan } : {}),
        ...(config.pages.origin ? { origin: config.pages.origin } : {}),
        ...(config.pages.ext ? { ext: config.pages.ext } : {}),
        // the runtime scans again when a hub announces a change; a robot offline has no registry to wait for
        scanned: async (id) => void (await byId.get(id)?.runtime()?.ready()),
      })
    : null;
  if (pages) closers.push(() => pages.stop());
  const pageHooks = (id: string) => (pages ? { join: () => pages.join(id), view: () => pages.view(id) } : undefined);
  const transitions = (id: string) => (fsm: string, from: string, to: string, why: string) =>
    o.log(fsm, { robot_id: id, from, to, why });
  const cancels = (id: string) => (tool: string, moving: boolean) =>
    o.log("cancelled", { robot_id: id, tool, action: moving ? "stop" : "abort" });
  const loopEnds = (line: LoopEndLine) => o.log("loop_end", { ...line });

  for (const s of config.robots) {
    if (s.source === "pages") {
      const robot = new LocalRobot({
        id: s.id,
        onTransition: transitions(s.id),
        onCancel: cancels(s.id),
        onLoopEnd: loopEnds,
        pages: pageHooks(s.id),
      });
      const profile = { ...s.profile, id: s.id };
      await robot.attach(createRuntime({ profile, providers: [hubs.get(s.id)!] }));
      robots.push(robot);
    } else if (s.source === "twin") {
      const robot = new LocalRobot({
        id: s.id,
        onTransition: transitions(s.id),
        onCancel: cancels(s.id),
        onLoopEnd: loopEnds,
        pages: pageHooks(s.id),
        ...(o.clock && { clock: o.clock }),
      });
      const { runtime, brick, sim } = twinRuntime(s, o.clock, hubs.get(s.id));
      await robot.attach(runtime);
      bricks.set(s.id, brick);
      sims.set(s.id, sim);
      robots.push(robot);
    } else if (s.source === "ev3dev") {
      const robot = new LocalRobot({
        id: s.id,
        connect: `Check that the brick is on and that "ssh ${s.ssh.user}@${s.ssh.host}" connects from this computer without asking for a password or about the host key; this server keeps trying by itself.`,
        onTransition: transitions(s.id),
        onCancel: cancels(s.id),
        onLoopEnd: loopEnds,
        pages: pageHooks(s.id),
      });
      // --install-bridge: part of every attempt until one copy has succeeded, so a brick that is off at start
      // gets its bridge when it answers
      let bridgeToInstall = s.installBridge;
      const { pair } = s.robot;
      const profile = { ...s.robot.profile, id: s.id };
      const link = keepAttached(
        robot,
        async () => {
          if (bridgeToInstall) {
            o.log("bridge_installed", { robot_id: s.id, ...(await installBridge(s.ssh)) });
            bridgeToInstall = false;
          }
          const transport = new SshLineTransport(s.ssh);
          let provider!: Ev3devProvider;
          const runtime = createRuntime({
            profile,
            providers: [
              (limits) => {
                provider = new Ev3devProvider(transport, { limits, hardware: s.hardware, pair, roles: profile.roles });
                return provider;
              },
              ...last(hubs.get(s.id)),
            ],
          });
          // the ssh process ended: the brick, the network or the bridge went away
          return { runtime, onClose: (cb) => transport.onClose(cb), close: () => provider.close() };
        },
        { log: (ev, fields) => o.log(`ev3dev_${ev}`, { robot_id: s.id, ...fields }), reconnectMs: o.reconnectMs },
      );
      link.start();
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
              await robot.attach(ev3Runtime(s, transport, hubs.get(s.id)));
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
        onLoopEnd: loopEnds,
        pages: pageHooks(s.id),
      });
      closers.push(() => b.stop());
      robots.push(robot);
    }
  }

  for (const r of robots) byId.set(r.id, r);
  return {
    robots,
    bricks,
    sims,
    bridge,
    pages,
    lan: lan ?? null,
    hubs,
    clock: o.clock ? "virtual" : "real",
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
