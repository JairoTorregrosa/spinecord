// The twin as apps/local runs it, assembled for measurement: tool call (apps/local callTool) -> LocalRobot ->
// runtime -> Ev3Provider -> [a cable of `rtt_ms`] -> SimBrick -> World. It is twinRuntime (apps/local/src/sources.ts)
// option for option, with one addition the bench needs and the app does not have: a Transport between the provider
// and the brick that delays each packet by half the round trip on the way in and half on the way out, so a stop
// decided by the host lands as late as it would over a real cable. With rtt_ms 0 the packet goes straight through.
// Everything runs on one FakeClock (time moves only when something sleeps): runs are fast and deterministic.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Transport } from "../../packages/driver-ev3/transport";
import { Ev3Provider } from "../../packages/driver-ev3/provider";
import type { RobotFile } from "../../packages/driver-ev3/robot-file";
import type { RobotProfile } from "../../packages/protocol/types";
import { type Clock, FakeClock, realClock } from "../../packages/runtime/clock";
import { createRuntime } from "../../packages/runtime/runtime";
import { drivetrainFromProfile, LARGE_DEG_S, SIM_BRICK_LOOP_RATE_HZ, SimBrick } from "../../packages/sim-ev3/brick";
import {
  DEFAULT_NOISE,
  NO_NOISE,
  type NoiseConfig,
  parseWorld,
  type Rect,
  World,
} from "../../packages/sim-world/world";
import { SimWorldProvider } from "../../packages/sim-world/world-provider";
import { LocalRobot } from "../../apps/local/src/robot";
import { callTool } from "../../apps/local/src/tools";

export const ROOT = join(import.meta.dir, "..", "..");
const readJson = (...p: string[]): any => JSON.parse(readFileSync(join(ROOT, ...p), "utf8"));

/** The two robot files the workshop uses: a wheeled base with a gyro (r1) and the tracked one (orugas). */
export const R1: RobotFile & { twin: any } = readJson("deployments", "example", "robots", "r1.json");
export const ORUGAS: RobotFile & { twin: any } = readJson("deployments", "orugas", "robots", "orugas.json");
/** The noise of the workshop's room (deployments/orugas/worlds/sala.json), over the package defaults. */
export const SALA_NOISE: NoiseConfig = {
  ...DEFAULT_NOISE,
  ...readJson("deployments", "orugas", "worlds", "sala.json").noise,
};

/** Room for every row: full speed (the workshop files cap it at 60) and a 2 m drive. */
export const BENCH_LIMITS = {
  max_speed_pct: 100,
  max_command_ms: 60_000,
  max_program_ms: 120_000,
  max_loop_ms: 60_000,
};

export type Base = "r1" | "r1-encoders" | "orugas";

export interface RigOptions {
  base: Base;
  /** "off": NO_NOISE (but a tracked base keeps its turn_scrub: that is structure, not noise). Default "off". */
  noise?: "off" | NoiseConfig;
  seed?: number;
  /** Override what is plugged in (default: the robot file's twin.ev3, plus a free large motor on D). */
  ev3?: { motors: Record<string, string>; sensors: Record<string, string> };
  boxes?: Rect[];
  lines?: { points: [number, number][]; width_cm: number }[];
  arena?: { width_cm: number; height_cm: number };
  start?: { x: number; y: number; heading_deg: number };
  body?: Record<string, number>;
  rtt_ms?: number;
  /** Real time instead of the FakeClock (the wall-clock rows only). */
  real?: boolean;
}

export interface Rig {
  id: string;
  clock: Clock;
  fake: FakeClock | null;
  brick: SimBrick;
  world: World;
  robot: LocalRobot;
  profile: RobotProfile;
  /** One tool call through apps/local's dispatch; throws unless ok (pass allowError to get the error envelope). */
  call(name: string, args: Record<string, unknown>, allowError?: boolean): Promise<any>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Packets that reached the brick. */
  packets: number;
  /** The EV3 provider under the runtime, for the rows that must bypass the runtime's chunking (coast). */
  ev3: Ev3Provider;
}

class Cable implements Transport {
  packets = 0;
  constructor(
    private readonly brick: SimBrick,
    private readonly clock: Clock,
    private readonly rtt: number,
  ) {}
  async send(bytes: Uint8Array): Promise<Uint8Array> {
    if (this.rtt > 0) await this.clock.sleep(this.rtt / 2);
    this.packets++;
    const reply = await this.brick.send(bytes);
    if (this.rtt > 0) await this.clock.sleep(this.rtt / 2);
    return reply;
  }
}

function fileFor(base: Base): RobotFile & { twin: any } {
  if (base === "orugas") return ORUGAS;
  if (base === "r1") return R1;
  // r1 measuring its heading by encoders, like orugas and like the ev3dev robot of docs/hardware-log.md
  const { heading: _, ...drivetrain } = R1.profile.drivetrain!;
  return { ...R1, profile: { ...R1.profile, drivetrain } as RobotProfile };
}

let serial = 0;
export async function rig(o: RigOptions): Promise<Rig> {
  const file = fileFor(o.base);
  const id = `bench${++serial}-sim`;
  const profile: RobotProfile = {
    ...file.profile,
    id,
    limits: { ...file.profile.limits, ...BENCH_LIMITS },
    drivetrain: { ...file.profile.drivetrain!, max_drive_cm: 250, max_turn_deg: 360 },
  };
  const scrub = o.base === "orugas" ? SALA_NOISE.turn_scrub : 0;
  const noise = o.noise === undefined || o.noise === "off" ? { ...NO_NOISE, turn_scrub: scrub } : o.noise;
  const ports = o.ev3 ?? {
    motors: { ...file.twin.ev3.motors, D: "large" },
    sensors: file.twin.ev3.sensors,
  };
  const worldJson = {
    schema: "spinecord/world@1",
    name: "bench",
    arena: o.arena ?? { width_cm: 800, height_cm: 800 },
    obstacles: o.boxes ?? [],
    lines: o.lines ?? [],
    start: o.start ?? { x: 100, y: 400, heading_deg: 0 },
    body: { ...(file.twin.body ?? {}), ...(o.body ?? {}) },
    noise,
    extensions: { ev3: ports },
  };
  const fake = o.real ? null : new FakeClock(0);
  const clock: Clock = fake ?? realClock;
  const time = { now: () => clock.now(), sleep: (ms: number) => clock.sleep(ms) };
  const config = parseWorld(worldJson);
  const brick = new SimBrick({
    world: new World(config, o.seed ?? 1),
    drivetrain: drivetrainFromProfile(profile, file.pair),
    ...(fake ? { now: time.now } : {}),
  });
  const cable = new Cable(brick, clock, o.rtt_ms ?? 0);
  let ev3: Ev3Provider | null = null;
  const runtime = createRuntime({
    profile,
    providers: [
      new SimWorldProvider({
        host: brick,
        worlds: { bench: worldJson },
        seed: o.seed ?? 1,
        ...(fake ? { now: time.now } : {}),
      }),
      (limits) =>
        (ev3 = new Ev3Provider(cable, {
          limits,
          hardware: file.hardware,
          pair: file.pair,
          roles: profile.roles,
          degPerSecAt100: LARGE_DEG_S,
          loopRateHz: SIM_BRICK_LOOP_RATE_HZ,
          ...(fake ? time : {}),
        })),
    ],
    ...(fake ? { clock } : {}),
  });
  const robot = new LocalRobot({ id, clock });
  await robot.attach(runtime);
  if (!ev3) throw new Error("rig: the runtime did not build the EV3 provider");
  const provider: Ev3Provider = ev3;
  return {
    ev3: provider,
    id,
    clock,
    fake,
    brick,
    world: brick.world,
    robot,
    profile,
    get packets() {
      return cable.packets;
    },
    sleep: (ms) => clock.sleep(ms),
    now: () => clock.now(),
    async call(name, args, allowError = false) {
      const { envelope } = await callTool([robot], name, { robot_id: id, ...args });
      if (!envelope.ok && !allowError)
        throw new Error(`${name} ${JSON.stringify(args)} failed: ${JSON.stringify(envelope.error)}`);
      return envelope;
    },
  };
}

/** Value of one channel from a read_device envelope. */
export function reading(env: { data: { readings: any[] } }, channel: string): any {
  const r = env.data.readings.find((x: { channel: string }) => x.channel === channel);
  if (!r) throw new Error(`no reading of ${channel} in ${JSON.stringify(env.data.readings)}`);
  if (r.error && r.value === null) throw new Error(`${channel}: ${r.error}`);
  return r.value;
}

/** Runs `sample` every `every_ms` of clock time until `done` resolves; returns what it collected. */
export async function during<T, S>(
  r: Rig,
  every_ms: number,
  work: Promise<T>,
  sample: () => S,
): Promise<{ out: T; samples: { t: number; v: S }[] }> {
  const samples: { t: number; v: S }[] = [];
  let finished = false;
  const out = work.finally(() => {
    finished = true;
  });
  const loop = (async () => {
    while (!finished) {
      r.brick.tick();
      samples.push({ t: r.now(), v: sample() });
      await r.sleep(every_ms);
    }
  })();
  const value = await out;
  await loop;
  return { out: value, samples };
}

/** Lets the physics run until every motor rests (or `max_ms` passes); returns how long it took. */
export async function settle(r: Rig, max_ms = 5000): Promise<number> {
  const t0 = r.now();
  while (r.now() - t0 < max_ms) {
    const m = r.brick.peek().motors;
    if (m.every((x) => x.speed_pct === 0 && !x.coasting)) return r.now() - t0;
    await r.sleep(1);
  }
  return r.now() - t0;
}

export const deg = (rad: number) => (rad * 180) / Math.PI;
