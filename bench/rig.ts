// The path of a tool call, assembled from the real pieces, in this process:
//   callTool (apps/local) -> LocalRobot (link and activity state) -> createRuntime -> Ev3Provider -> Ev3Link ->
//   SimBrick (byte-level EV3 on 2D physics)
// The simulated brick runs on the real clock at 1x, so sim time and wall time are the same time.
// The bench owns three taps, none of which changes package code:
//   packets    every packet that reaches the brick (when, how long until its reply, opcodes)
//   ops        every Provider call the runtime makes (and the injected link round trip)
//   calls      every tool call the runtime executes
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OP } from "../packages/driver-ev3/encode";
import { Ev3Provider, EXAMPLE_EV3_HARDWARE } from "../packages/driver-ev3/provider";
import type { Transport } from "../packages/driver-ev3/transport";
import type {
  CommandResult,
  DeviceSpec,
  Envelope,
  Provider,
  Reading,
  RobotProfile,
  Value,
} from "../packages/protocol/types";
import { createRuntime, type LocalRuntime } from "../packages/runtime/runtime";
import { drivetrainFromProfile, LARGE_DEG_S, SimBrick } from "../packages/sim-ev3/brick";
import { NO_NOISE, parseWorld, World } from "../packages/sim-world/world";
import { SimWorldProvider } from "../packages/sim-world/world-provider";
import { LocalRobot } from "../apps/local/src/robot";
import { callTool, summarize } from "../apps/local/src/tools";

export const ROOT = join(import.meta.dir, "..");

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const now = () => performance.now();

const MOTION_OPS: number[] = [
  OP.OUTPUT_START,
  OP.OUTPUT_STEP_POWER,
  OP.OUTPUT_TIME_POWER,
  OP.OUTPUT_STEP_SPEED,
  OP.OUTPUT_TIME_SPEED,
  OP.OUTPUT_STEP_SYNC,
  OP.OUTPUT_TIME_SYNC,
];
export interface Packet {
  at: number;
  ms: number;
  /** The brick's own list for this packet: filled when it executes it. */
  opcodes: number[];
}
export const isMotion = (p: Packet) => p.opcodes.some((o) => MOTION_OPS.includes(o));
export const isBrake = (p: Packet) => p.opcodes.includes(OP.OUTPUT_STOP);
export interface ProviderOp {
  at: number;
  ms: number;
  provider: string;
  op: "read" | "command" | "stop";
  what: string;
}
export interface RuntimeCall {
  at: number;
  ms: number;
  tool: string;
}

/** Records every packet on its way to the brick. The brick writes the opcodes it executed into its own log entry. */
class TapTransport implements Transport {
  packets: Packet[] = [];
  constructor(
    private readonly brick: SimBrick,
    private readonly usb: { packet_ms: number },
  ) {}
  async send(bytes: Uint8Array): Promise<Uint8Array> {
    const at = now();
    // the cable: a packet reaches the brick this much later (USB HID costs about 2 ms per exchange)
    if (this.usb.packet_ms > 0) await sleep(this.usb.packet_ms);
    const sent = this.brick.send(bytes);
    const entry = this.brick.log[this.brick.log.length - 1]!;
    const p: Packet = { at, ms: 0, opcodes: entry.opcodes };
    this.packets.push(p);
    const reply = await sent;
    p.ms = now() - at;
    return reply;
  }
}

/**
 * Sits between the runtime and a provider: records each call and adds the link's round trip to it
 * (half before, half after), as a USB cable, a LAN or an SSH tunnel between the runtime and the hardware would.
 */
class TapProvider implements Provider {
  readonly id: string;
  readonly backend: Provider["backend"];
  constructor(
    private readonly inner: Provider,
    private readonly link: { round_trip_ms: number },
    private readonly ops: ProviderOp[],
  ) {
    this.id = inner.id;
    this.backend = inner.backend;
  }
  get stop_worst_ms(): number {
    return this.inner.stop_worst_ms + this.link.round_trip_ms;
  }
  devices(): Promise<DeviceSpec[]> {
    return this.inner.devices();
  }
  onDevicesChanged(cb: () => void): () => void {
    return this.inner.onDevicesChanged?.(cb) ?? (() => {});
  }
  private async through<T>(op: ProviderOp["op"], what: string, run: () => Promise<T>): Promise<T> {
    const rec: ProviderOp = { at: now(), ms: 0, provider: this.id, op, what };
    this.ops.push(rec);
    const half = this.link.round_trip_ms / 2;
    try {
      if (half > 0) await sleep(half);
      const out = await run();
      if (half > 0) await sleep(half);
      return out;
    } finally {
      rec.ms = now() - rec.at;
    }
  }
  read(device: string, channels?: string[], opts?: { allow_mode_switch?: boolean }): Promise<Reading[]> {
    return this.through("read", device, () => this.inner.read(device, channels, opts));
  }
  command(device: string, command: string, args: Record<string, Value>, signal: AbortSignal): Promise<CommandResult> {
    return this.through("command", `${device} ${command}`, () => this.inner.command(device, command, args, signal));
  }
  stop(): Promise<{ motors_stopped: boolean }> {
    return this.through("stop", "stop", () => this.inner.stop());
  }
}

const EXAMPLE = JSON.parse(
  readFileSync(join(ROOT, "packages", "sim-ev3", "examples", "twin.example.json"), "utf8"),
) as { pair: { left: "B"; right: "C" }; profile: RobotProfile };
const WORLD_JSON: unknown = JSON.parse(
  readFileSync(join(ROOT, "packages", "sim-world", "examples", "line-oval.json"), "utf8"),
);

/** The documented example twin profile, with room for the slow link profile (one move may take a minute there). */
export const profileFor = (id: string): RobotProfile => ({
  ...EXAMPLE.profile,
  id,
  limits: { ...EXAMPLE.profile.limits, max_command_ms: 60_000, max_program_ms: 120_000 },
});

export interface Twin {
  id: string;
  profile: RobotProfile;
  brick: SimBrick;
  world: World;
  ev3: Ev3Provider;
  runtime: LocalRuntime;
  /** Round trip added to every provider call, ms. Mutable: one twin serves every link profile. */
  link: { round_trip_ms: number };
  /** Latency added to every packet between the provider and the brick, ms. Mutable; 0 unless a metric says so. */
  usb: { packet_ms: number };
  packets: Packet[];
  ops: ProviderOp[];
  calls: RuntimeCall[];
  /** ms from createRuntime() to ready() (the provider's device scan over the brick). */
  ready_ms: number;
}

export async function buildTwin(id: string, seed: number): Promise<Twin> {
  const profile = profileFor(id);
  // noise off: the benchmark compares latency, and the same seed must give the same run
  const world = new World({ ...parseWorld(WORLD_JSON), noise: { ...NO_NOISE } }, seed, {
    axle_track_cm: profile.drivetrain!.axle_track_cm,
  });
  const brick = new SimBrick({ world, drivetrain: drivetrainFromProfile(profile, EXAMPLE.pair) });
  const usb = { packet_ms: 0 };
  const tap = new TapTransport(brick, usb);
  const link = { round_trip_ms: 0 };
  const ops: ProviderOp[] = [];
  const calls: RuntimeCall[] = [];
  const t0 = now();
  // every option at its default except the simulated motor's calibration
  const ev3 = new Ev3Provider(tap, {
    limits: profile.limits,
    hardware: EXAMPLE_EV3_HARDWARE,
    roles: profile.roles,
    pair: EXAMPLE.pair,
    degPerSecAt100: LARGE_DEG_S,
  });
  const runtime = createRuntime({
    profile,
    providers: [new TapProvider(ev3, link, ops), new TapProvider(new SimWorldProvider({ host: brick }), link, ops)],
  });
  await runtime.ready();
  const ready_ms = now() - t0;
  const call = runtime.call.bind(runtime);
  runtime.call = async (tool, args, signal, ctx) => {
    const rec: RuntimeCall = { at: now(), ms: 0, tool };
    calls.push(rec);
    try {
      return await call(tool, args, signal, ctx);
    } finally {
      rec.ms = now() - rec.at;
    }
  };
  return { id, profile, brick, world, ev3, runtime, link, usb, packets: tap.packets, ops, calls, ready_ms };
}

export interface ToolOut {
  envelope: Envelope<any>;
  /** UTF-8 bytes of the text block the model receives. */
  bytes: number;
  ms: number;
}
export interface Tools {
  /** One tool call. Throws unless the envelope is ok, so a benchmark never times an error by accident. */
  call(name: string, args: Record<string, unknown>, allowError?: boolean): Promise<ToolOut>;
  /** ms from attach() to online (device scan + verified stop). */
  online_ms: number;
}

/** The twin as apps/local holds it: a LocalRobot around the runtime, its tools through callTool. No stdio. */
export async function localTools(twin: Twin): Promise<Tools> {
  const robot = new LocalRobot({ id: twin.id });
  const t0 = now();
  await robot.attach(twin.runtime);
  const online_ms = now() - t0;
  return {
    online_ms,
    async call(name, args, allowError = false) {
      const t0 = now();
      const { envelope } = await callTool([robot], name, args);
      const ms = now() - t0;
      if (!envelope.ok && !allowError)
        throw new Error(`${name} ${JSON.stringify(args)} failed: ${JSON.stringify(envelope.error)}`);
      // what a model reads is the text block: the summary line, then the envelope (apps/local/src/mcp.ts)
      const text = `${summarize(name, envelope)}\n${JSON.stringify(envelope)}`;
      return { envelope: envelope as Envelope<any>, bytes: Buffer.byteLength(text, "utf8"), ms };
    },
  };
}

export interface Sample {
  t: number;
  /** World time, ms (advances only while the physics runs). */
  sim: number;
  /** True distance the forward sensor sees, cm (geometry only: no noise is drawn, nothing is rounded). */
  d: number;
  x: number;
  y: number;
  th: number;
}
/** Ground truth from the world itself, sampled about every millisecond while a scenario runs. */
export function watch(twin: Twin): { samples: Sample[]; stop(): Sample[] } {
  const samples: Sample[] = [];
  const take = () => {
    twin.brick.tick();
    const w = twin.brick.world;
    samples.push({
      t: now(),
      sim: w.t_ms,
      d: w.coneDistance(),
      x: w.pose.x,
      y: w.pose.y,
      th: w.pose.th,
    });
  };
  take();
  const timer = setInterval(take, 1);
  return {
    samples,
    stop() {
      clearInterval(timer);
      take();
      return samples;
    },
  };
}
/** First sample from which the robot never moves again (its pose equals the final pose). */
export function halted(samples: Sample[]): Sample {
  const last = samples[samples.length - 1]!;
  let i = samples.length - 1;
  while (i > 0 && samples[i - 1]!.x === last.x && samples[i - 1]!.y === last.y && samples[i - 1]!.th === last.th) i--;
  return samples[i]!;
}

/** Puts the stopped robot at a pose (the bench's own hand, like lifting the robot; not a timed call). */
export function place(twin: Twin, x: number, y: number, heading_deg: number): void {
  twin.brick.tick();
  if (twin.brick.busy()) throw new Error("place: the robot is still moving");
  twin.brick.world.setPose({ x, y, th: (heading_deg * Math.PI) / 180 });
}

/**
 * When the distance fell under `below`, interpolated between the two samples around it: the runtime's own
 * read can advance the physics between two samples, so the first sample under the line may already be late.
 */
export function crossing(samples: Sample[], below: number): Sample | undefined {
  const i = samples.findIndex((s) => s.d < below);
  if (i < 0) return undefined;
  const b = samples[i]!;
  const a = samples[i - 1];
  if (!a || a.d === b.d) return b;
  const f = (a.d - below) / (a.d - b.d);
  const mix = (x: number, y: number) => x + (y - x) * f;
  return { t: mix(a.t, b.t), sim: mix(a.sim, b.sim), d: below, x: mix(a.x, b.x), y: mix(a.y, b.y), th: b.th };
}
