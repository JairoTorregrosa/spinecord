// The runtime executes every tool that addresses one robot, next to the hardware (CONTRACT.md §4). It knows devices only
// through their manifests and the Provider interface; the only kinds it names are motor_pair (drivetrain)
// and gyro (heading source). Limits come from the profile. The process around it (apps/local) owns the link and activity state.
import { RETRYABLE, RuntimeError } from "../protocol/types";
import { newTraceId, stackOf } from "../protocol/types";
import type {
  BackendKind,
  Clamp,
  InternalFailure,
  CommandResult,
  CommandSpec,
  DeviceSpec,
  Drivetrain,
  ErrorCode,
  ImagePayload,
  Limits,
  ProgramNode,
  Provider,
  Reading,
  RobotActivity,
  RobotProfile,
  RobotTool,
  Runtime,
  RuntimeResult,
  StopReason,
  Value,
} from "../protocol/types";
import { TOOLS } from "../protocol/tools";
import { type Clock, linkAbort, realClock } from "./clock";
import { compileCondition, makeEvaluator, type CompiledCondition } from "./conditions";
import { validateProgram } from "../protocol/validate";
import { validateSchema } from "../protocol/schema";

export const STALE_IMAGE_MS = 1500; // CONTRACT §7 stale_image
export const MAX_CHUNK_MS = 250; // CONTRACT §0.8: longest operation for a command that declares no time bound of its own
export const MAX_SAMPLE_HZ = 50;
// CONTRACT §4: while an operation runs under `until`, the condition is read again this often, or as often as
// one read takes when the link is slower. A channel's max_rate_hz does not slow it down: reading a sensor
// faster than it refreshes costs nothing (reads have no side effects) and shortens the wait for its next value.
export const UNTIL_POLL_MS = 10;
// How old a timed round trip may be and still let the first chunk of a move coast: about what a move itself
// relies on between two of its chunks. Older than this, the link is timed again before anything moves.
export const LINK_FRESH_MS = 2 * MAX_CHUNK_MS;
// Coasting is decided on the slow end of the link: the 90th percentile (nearest rank) of the latest
// LINK_WINDOW timed round trips of a provider. One fast answer on a slow link proves nothing.
export const LINK_WINDOW = 10;
export const LINK_PERCENTILE = 0.9;
// Fewer timed round trips than this say nothing about a link: no coasting on them.
export const LINK_MIN_SAMPLES = 3;
// A device re-scan that failed is tried again after this long, doubling after every failure up to the max.
export const SCAN_RETRY_MS = 250;
export const SCAN_RETRY_MAX_MS = 5000;
// CONTRACT §4: drive, turn and arc refuse a target under this much rotation of the leading wheel. Wheel
// encoders count whole degrees, so a smaller move can be neither commanded nor measured.
export const MIN_WHEEL_DEG = 1;
const ROBOT_TOOLS: readonly RobotTool[] = [
  "describe_robot",
  "describe_device",
  "read_device",
  "read_all",
  "sample_device",
  "wait_until",
  "drive",
  "turn",
  "arc",
  "command_device",
  "reset_fault",
  "run_program",
];

export function rerr(code: ErrorCode, message: string): RuntimeError {
  return new RuntimeError(code, message, RETRYABLE.includes(code));
}

export interface RuntimeOptions {
  profile: RobotProfile;
  // Providers, or factories that receive profile.limits (the only source of motion limits) to build one.
  providers: (Provider | ((limits: Limits) => Provider))[];
  clock?: Clock;
  chunk_ms?: number; // target motion time per chunk, ≤ 250 (default 200)
}
export interface LocalRuntime extends Runtime {
  readonly backend: BackendKind;
  readonly stop_worst_ms: number; // upper bound for stop(): slowest provider + runtime overhead
  ready(): Promise<void>; // first device scan done (throws if it failed)
  // Re-scans every provider's devices; rejects when the scan failed. The registry of the last scan that
  // succeeded stays in use meanwhile, calls keep working on it, and the scan is tried again by itself.
  refresh(): Promise<void>;
  dispose(): void; // unsubscribe from every provider
}
export interface ProgramStep {
  path: string;
  tool: string;
  ok: boolean;
  reason?: string;
  error?: { code: ErrorCode; message: string; trace_id?: string };
  /** What the step's call measured: the `measured` of the same call made outside a program. */
  measured?: Record<string, Value>;
  /** true when the step's call cut an argument to a limit. */
  clamped?: true;
  ms: number;
}
export interface ProgramResult {
  outcome: "succeeded" | "failed" | "aborted" | "timeout";
  reason: string;
  steps: ProgramStep[];
  steps_dropped: number;
  ms: number;
}

type Args = Record<string, unknown>;
type Run = ((signal: AbortSignal) => Promise<RuntimeResult>) & { moves?: boolean };
const STOP_OVERHEAD_MS = 50; // aborting calls and collecting the providers' answers
const moving = (run: Run): Run => Object.assign(run, { moves: true });
interface Entry {
  spec: DeviceSpec;
  provider: Provider;
}
// A condition being watched while operations run. `first` is the outcome of the poll made before anything
// moves; `state()` is what the watch knows now; `fresh()` waits for a poll that starts after the call.
// state() and fresh() throw what a poll threw (a channel that could not be read or needs a mode switch, an
// unknown device).
interface Monitor {
  readonly first: Promise<boolean>;
  state(): boolean;
  fresh(): Promise<boolean>;
  /** The readings of the poll that met the condition; undefined while it is not met. */
  readings(): Reading[] | undefined;
  stop(): void;
}
// Where a device really is during a chunked move, from a measurement of its own (wheel encoders).
// Fractions are of the whole move, signed along the commanded direction (negative = moved the wrong way).
interface Track {
  // Reads the position the next operation starts from; resolves to the fraction done there. Called right
  // before that operation is sent. The read and the operation travel the same link in that order, so the
  // caller awaits it only when it needs the answer before sending.
  mark(): Promise<number>;
  // After that operation ended with `measured`: the fraction done now, the fraction its reading showed when
  // it started, and the part that happened between operations (coasting on, or creeping after a brake),
  // which no operation's `measured` shows.
  done(measured: Record<string, Value> | undefined): Promise<{ f: number; start: number; drift: number }>;
  // A reading of its own, with nothing running: the fraction done.
  settle(): Promise<number>;
}
const MAX_STEPS = 500;
const round1 = (x: number) => Math.round(x * 10) / 10;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The clamp of one argument, or none when it was sent as asked. */
const cut = (arg: string, requested: number, applied: number, target: boolean): Clamp[] =>
  requested === applied ? [] : [{ arg, requested, applied, target }];
// How a command that reached its end reports clamping (CONTRACT §0.2): `clamped` is true when anything was cut,
// by the runtime (`clamps`) or by the device; the reason is "clamped" only when a target was cut, so that less
// was done than asked. A cut speed, or any other argument that is not the target, leaves the reason "completed".
// A device's own reason "clamped" is a completed operation: the runtime caps every bound parameter before it sends.
function clampFields(
  reason: StopReason,
  clamps: Clamp[],
  byDevice: boolean,
): { clamped: boolean; clamps?: Clamp[]; reason: StopReason } {
  const ended = reason === "clamped" ? "completed" : reason;
  return {
    clamped: clamps.length > 0 || byDevice,
    ...(clamps.length ? { clamps } : {}),
    reason: ended === "completed" && clamps.some((c) => c.target) ? "clamped" : ended,
  };
}

export function createRuntime(opts: RuntimeOptions): LocalRuntime {
  return new RuntimeImpl(opts);
}

class RuntimeImpl implements LocalRuntime {
  private readonly prof: RobotProfile;
  private readonly local: Provider[];
  private readonly clock: Clock;
  private readonly chunkMs: number;
  private entries = new Map<string, Entry>();
  // Round trip of the latest timed read of each provider (what the link costs right now), and the latest
  // LINK_WINDOW of them, oldest first: the evidence for coasting between chunks.
  private readonly linkMs = new WeakMap<Provider, number>();
  private readonly linkSeen = new WeakMap<Provider, number[]>();
  private readonly linkAt = new WeakMap<Provider, number>(); // when that read came back
  private readonly inflight = new Set<AbortController>();
  // What every call waits for: the latest scan. It rejects only while no scan has ever succeeded.
  private scan: Promise<void>;
  private scanned = false; // `entries` comes from a scan that succeeded
  // A re-scan failed and `entries` is the registry of the last scan that succeeded; shown by describe_robot.
  private scanFailure: { message: string; attempts: number } | undefined;
  private retry: AbortController | undefined; // the wait before the next attempt
  private disposed = false;
  readonly backend: BackendKind;

  constructor(o: RuntimeOptions) {
    if (!o.profile) throw rerr("misconfigured", "createRuntime: profile is required");
    if (!o.providers?.length) throw rerr("misconfigured", "createRuntime: at least one provider is required");
    for (const k of ["max_speed_pct", "max_command_ms", "max_drive_cm", "max_turn_deg", "max_program_ms"] as const) {
      if (!(o.profile.limits?.[k] > 0))
        throw rerr("misconfigured", `createRuntime: profile.limits.${k} must be a positive number`);
    }
    const built = o.providers.map((p) => (typeof p === "function" ? p(o.profile.limits) : p));
    const ids = built.map((p) => p.id);
    if (new Set(ids).size !== ids.length)
      throw rerr("misconfigured", `createRuntime: duplicate provider ids: ${ids.join(", ")}`);
    this.prof = o.profile;
    this.local = built;
    for (const p of built)
      if (!(p.stop_worst_ms > 0))
        throw rerr("misconfigured", `createRuntime: provider ${p.id} must declare stop_worst_ms > 0`);
    this.clock = o.clock ?? realClock;
    this.chunkMs = o.chunk_ms ?? 200;
    if (!(this.chunkMs > 0 && this.chunkMs <= MAX_CHUNK_MS))
      throw rerr("misconfigured", `createRuntime: chunk_ms must be in (0, ${MAX_CHUNK_MS}]`);
    this.backend = built[0]!.backend;
    this.scan = this.rescan();
    this.scan.catch(() => {}); // surfaced by ready() and by every call()
    for (const p of built) {
      const off = p.onDevicesChanged?.(() => {
        // A failed re-read is not hidden: describe_robot reports it until a later scan succeeds.
        void this.refresh().catch(() => {});
      });
      if (off) this.unsubscribe.push(off);
    }
  }
  get stop_worst_ms(): number {
    return Math.max(...this.local.map((p) => p.stop_worst_ms)) + STOP_OVERHEAD_MS;
  }
  private acting = 0; // moving calls in flight; explicit mode-switching reads are refused meanwhile
  private movesSent = 0; // moving operations handed to a provider, ever: a call compares it before and after
  private callerActivity: RobotActivity = "idle"; // activity of the call being planned, as its caller reported it
  private readonly unsubscribe: (() => void)[] = [];
  dispose(): void {
    this.disposed = true;
    this.retry?.abort();
    for (const off of this.unsubscribe.splice(0)) off();
  }

  // ---------- registry ----------
  profile(): RobotProfile {
    return this.prof;
  }
  devices(): DeviceSpec[] {
    return [...this.entries.values()].map((e) => e.spec);
  }
  ready(): Promise<void> {
    return this.scan;
  }
  refresh(): Promise<void> {
    this.retry?.abort(); // this attempt is the retry
    this.retry = undefined;
    // one scan at a time, in the order requested
    const attempt = this.scan.catch(() => {}).then(() => this.rescan());
    // Calls wait for the attempt. One that fails leaves the last good registry in place and is tried again;
    // with no registry at all (no scan ever succeeded) calls fail with it.
    this.scan = attempt.catch((err) => {
      this.scanFailed(err);
      if (!this.scanned) throw err;
    });
    this.scan.catch(() => {});
    attempt.catch(() => {});
    return attempt;
  }
  private scanFailed(err: unknown): void {
    const attempts = (this.scanFailure?.attempts ?? 0) + 1;
    this.scanFailure = { message: String((err as Error)?.message ?? err), attempts };
    if (this.disposed) return;
    const wait = new AbortController();
    this.retry = wait;
    void this.clock.sleep(Math.min(SCAN_RETRY_MS * 2 ** (attempts - 1), SCAN_RETRY_MAX_MS), wait.signal).then(() => {
      if (!wait.signal.aborted) void this.refresh().catch(() => {});
    });
  }

  private async rescan(): Promise<void> {
    const next = new Map<string, Entry>();
    for (const p of this.local)
      for (const d of await p.devices()) {
        // A pair that can coast between chunks must be brakeable on its own (never through provider.stop()).
        if (d.kind === "motor_pair" && !d.commands.some((c) => c.name === "brake"))
          throw rerr(
            "misconfigured",
            `motor_pair ${d.id} has no brake{} command; the runtime needs it to end a move after coasting chunks (provider ${p.id})`,
          );
        if (next.has(d.id)) throw rerr("misconfigured", `device id "${d.id}" is announced twice (provider ${p.id})`);
        const roles = new Set(d.roles ?? []);
        for (const [role, id] of Object.entries(this.prof.roles)) if (id === d.id) roles.add(role);
        next.set(d.id, { spec: { ...d, roles: [...roles] }, provider: p });
      }
    this.entries = next;
    this.scanned = true;
    this.scanFailure = undefined;
  }

  private roleMap(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const e of this.entries.values()) for (const r of e.spec.roles) map[r] ??= e.spec.id;
    for (const [role, id] of Object.entries(this.prof.roles)) if (this.entries.has(id)) map[role] = id;
    return map;
  }

  private entry(name: unknown, field = "device"): Entry {
    if (typeof name !== "string" || !name)
      throw rerr("invalid_argument", `${field} must be a device id or role (string)`);
    const hit = this.entries.get(name) ?? this.entries.get(this.roleMap()[name] ?? "");
    if (hit) return hit;
    const roles = this.roleMap();
    const unplugged =
      this.prof.roles[name] && !this.entries.has(this.prof.roles[name]!)
        ? ` Role "${name}" points to ${this.prof.roles[name]}, which is not attached.`
        : "";
    throw rerr(
      "unknown_device",
      `No device or role "${name}".${unplugged} Valid device ids: ${[...this.entries.keys()].join(", ") || "(none)"}. Valid roles: ${Object.keys(roles).join(", ") || "(none)"}.`,
    );
  }
  private readonly resolver = { resolve: (name: string) => this.entry(name).spec };

  // ---------- reads ----------
  // Readings come back in the order requested, with the canonical device id; a value the provider did not
  // return is null with an error string.
  private async readEntry(e: Entry, channels: string[], allowModeSwitch = false): Promise<Reading[]> {
    if (!channels.length) return [];
    const got = await e.provider.read(e.spec.id, channels, allowModeSwitch ? { allow_mode_switch: true } : undefined);
    return channels.map((name) => {
      const r = got.find((x) => x.channel === name);
      const unit = e.spec.channels.find((c) => c.name === name)?.unit;
      if (!r)
        return {
          device: e.spec.id,
          channel: name,
          value: null,
          ...(unit ? { unit } : {}),
          ts: this.clock.now(),
          error: "the device returned no value for this channel",
        };
      return { ...r, device: e.spec.id, ...((r.unit ?? unit) ? { unit: r.unit ?? unit } : {}) };
    });
  }
  private readonly readFn = (device: string, channels: string[]) => this.readEntry(this.entry(device), channels);

  private channelsOf(e: Entry, names: unknown): string[] {
    const all = e.spec.channels;
    if (names === undefined) return all.filter((c) => c.type !== "image" && c.active !== false).map((c) => c.name); // active only: a read never switches a mode
    const list = names as string[];
    for (const n of list) {
      if (!all.some((c) => c.name === n))
        throw rerr(
          "unknown_channel",
          `Device ${e.spec.id} has no channel "${n}". Valid channels: ${all.map((c) => `${c.name} (${c.type})`).join(", ") || "(none)"}.`,
        );
    }
    return [...new Set(list)];
  }

  private planReadDevice(a: Args): Run {
    const e = this.entry(a.device);
    const names = this.channelsOf(e, a.channels);
    const images = names.filter((n) => e.spec.channels.find((c) => c.name === n)!.type === "image");
    if (images.length > 1)
      throw rerr("invalid_argument", `channels: request one image channel per call, got ${images.join(", ")}`);
    // Only a channel named by the caller may switch a sensor mode, and only while nothing is moving.
    const switching =
      a.channels === undefined ? [] : names.filter((n) => e.spec.channels.find((c) => c.name === n)!.active === false);
    const activity = this.callerActivity;
    return async () => {
      if (switching.length && (this.acting > 0 || activity !== "idle"))
        throw rerr(
          "busy",
          `Reading ${switching.map((n) => `${e.spec.id}.${n}`).join(", ")} needs a sensor mode switch, which is only done while the robot is idle (it is ${this.acting > 0 ? "acting" : activity}). Retry when it ends, or read the active channels (omit channels).`,
        );
      const readings = await this.readEntry(e, names, switching.length > 0);
      let image: ImagePayload | undefined;
      const out = readings.map((r) => {
        if (r.channel !== images[0]) return r;
        if (!r.image)
          return r.error ? r : { ...r, value: null, error: "the device returned no image for this channel" };
        const age_ms = Math.max(0, Math.round(r.image.age_ms));
        if (age_ms > STALE_IMAGE_MS)
          throw rerr(
            "stale_image",
            `Frame from ${r.device}.${r.channel} is ${age_ms} ms old (limit ${STALE_IMAGE_MS} ms). The source stopped sending frames; retry, or check the device.`,
          );
        image = { mime: r.image.mime, b64: r.image.b64, age_ms };
        return { device: r.device, channel: r.channel, value: null, image: true, mime: image.mime, age_ms, ts: r.ts };
      });
      // {readings}: the shape read_all and wait_until return
      const data = { readings: out };
      return image ? { data, image } : { data };
    };
  }

  private planReadAll(): Run {
    return async () => {
      const t0 = this.clock.now();
      const groups = await Promise.all(
        [...this.entries.values()].map(async (e) => {
          const names = this.channelsOf(e, undefined);
          try {
            return await this.readEntry(e, names);
          } catch (err) {
            const msg =
              err instanceof RuntimeError
                ? `${err.code}: ${err.message}`
                : `read failed: ${String((err as Error)?.message ?? err)}`;
            return names.map((channel): Reading => ({
              device: e.spec.id,
              channel,
              value: null,
              ts: this.clock.now(),
              error: msg,
            }));
          }
        }),
      );
      return { data: { readings: groups.flat(), ms: Math.round(this.clock.now() - t0) } };
    };
  }

  private planSample(a: Args): Run {
    const e = this.entry(a.device);
    const [name] = this.channelsOf(e, [a.channel]);
    const ch = e.spec.channels.find((c) => c.name === name)!;
    if (ch.type !== "number")
      throw rerr(
        "invalid_argument",
        `channel "${ch.name}" of ${e.spec.id} is ${ch.type}; sample_device needs a number channel. Number channels: ${
          e.spec.channels
            .filter((c) => c.type === "number")
            .map((c) => c.name)
            .join(", ") || "(none)"
        }.`,
      );
    const cap = Math.min(MAX_SAMPLE_HZ, ch.max_rate_hz ?? MAX_SAMPLE_HZ);
    const rate_hz = Math.min((a.rate_hz as number | undefined) ?? 10, cap);
    const duration = a.duration_ms as number;
    return async (signal) => {
      const t0 = this.clock.now();
      const period = 1000 / rate_hz;
      const samples: [number, number | null][] = [];
      for (let i = 0; !signal.aborted; i++) {
        const [r] = await this.readEntry(e, [name!]);
        if (r!.error === "mode_switch_required")
          throw rerr(
            "invalid_argument",
            `Channel ${e.spec.id}.${name} is not active: sampling never switches a sensor mode. While the robot is idle, call read_device naming that channel, then retry.`,
          );
        samples.push([Math.round(this.clock.now() - t0), typeof r!.value === "number" ? r!.value : null]);
        const nextAt = (i + 1) * period;
        if (nextAt > duration) break;
        await this.clock.sleep(Math.max(0, t0 + nextAt - this.clock.now()), signal);
      }
      const vals = samples.map((s) => s[1]).filter((v): v is number => v !== null);
      const stats = vals.length
        ? {
            min: Math.min(...vals),
            max: Math.max(...vals),
            mean: vals.reduce((x, y) => x + y, 0) / vals.length,
            last: vals[vals.length - 1]!,
          }
        : { min: null, max: null, mean: null, last: null };
      return {
        data: {
          samples,
          ...stats,
          rate_hz,
          ...(ch.unit ? { unit: ch.unit } : {}),
          ...(signal.aborted ? { reason: "preempted" } : {}),
        },
      };
    };
  }

  private planWaitUntil(a: Args): Run {
    const cond = compileCondition(a.condition, this.resolver);
    const timeout = a.timeout_ms as number;
    const period = 1000 / ((a.poll_hz as number | undefined) ?? 20);
    return async (signal) => {
      const t0 = this.clock.now();
      const ev = makeEvaluator(cond, this.readFn);
      for (;;) {
        const r = await ev.poll();
        const ms = Math.round(this.clock.now() - t0);
        if (r.met) return { data: { met: true, reason: "condition_met", ms, readings: r.readings } };
        if (signal.aborted) return { data: { met: false, reason: "preempted", ms, readings: r.readings } };
        if (ms >= timeout) return { data: { met: false, reason: "timeout", ms, readings: r.readings } };
        // A poll without a value is asked again soon: it is an answer only when it repeats (conditions.ts).
        await this.clock.sleep(Math.min(r.unreadable ? UNTIL_POLL_MS : period, timeout - ms), signal);
      }
    };
  }

  // ---------- drivetrain ----------
  private drivetrain(tool: string): { dt: Drivetrain; pair: Entry; cmd: CommandSpec } {
    const dt = this.prof.drivetrain;
    if (!dt)
      throw rerr(
        "unsupported",
        `${tool}: this robot has no drivetrain in its profile, so it cannot drive, turn or arc. Use command_device on individual actuators (see describe_robot).`,
      );
    if (
      dt.type !== "differential" ||
      !(dt.wheel_diameter_cm > 0) ||
      !(dt.axle_track_cm > 0) ||
      (dt.forward_sign !== 1 && dt.forward_sign !== -1)
    ) {
      throw rerr(
        "unsupported",
        `${tool}: the profile's drivetrain is not a valid differential drive (needs wheel_diameter_cm > 0, axle_track_cm > 0, forward_sign 1 or -1).`,
      );
    }
    const pair = this.entries.get(dt.pair_device);
    if (!pair)
      throw rerr(
        "unsupported",
        `${tool}: drivetrain pair device "${dt.pair_device}" is not attached. Attached devices: ${[...this.entries.keys()].join(", ") || "(none)"}.`,
      );
    const cmd = pair.spec.commands.find((c) => c.name === "run_pair");
    const hasEnc = ["left_deg", "right_deg"].every((n) => pair.spec.channels.some((c) => c.name === n));
    if (!cmd || !hasEnc)
      throw rerr(
        "unsupported",
        `${tool}: drivetrain pair device ${pair.spec.id} must expose command run_pair and channels left_deg, right_deg (kind motor_pair); it is kind ${pair.spec.kind}.`,
      );
    return { dt, pair, cmd };
  }

  private gyro(): Entry | undefined {
    const byRole = this.entries.get(this.roleMap()["gyro"] ?? "");
    const e = byRole ?? [...this.entries.values()].find((x) => x.spec.kind === "gyro");
    return e?.spec.channels.some((c) => c.name === "angle_deg" && c.type === "number") ? e : undefined;
  }

  private speed(a: Args): { asked: number; speed: number; clamps: Clamp[] } {
    const asked = (a.speed_pct as number | undefined) ?? 30;
    const speed = Math.min(asked, this.prof.limits.max_speed_pct);
    return { asked, speed, clamps: cut("speed_pct", asked, speed, false) };
  }

  // The smallest move of a drivetrain (CONTRACT §4): MIN_WHEEL_DEG of rotation of its leading wheel. A smaller
  // target is refused, not rounded up to a step or answered as done. A target of exactly 0 asks for no motion
  // and is answered as done.
  private smallestStep(
    tool: string,
    field: string,
    asked: number,
    unit: string,
    leadDeg: number,
    perDeg: number, // units of `field` per degree of the leading wheel
  ): void {
    if (leadDeg === 0 || Math.abs(leadDeg) >= MIN_WHEEL_DEG) return;
    const min = Math.ceil(MIN_WHEEL_DEG * perDeg * 100) / 100;
    throw rerr(
      "invalid_argument",
      `${tool}: ${field} ${asked} is below the smallest move of this drivetrain, ${min} ${unit} (${MIN_WHEEL_DEG} degree of wheel rotation, the step its wheels are measured in), so nothing was sent and nothing moved. Ask for at least ${min} ${unit}, or 0 for no motion. A move this small overshoots by a few wheel degrees: read measured.`,
    );
  }

  private planDrive(a: Args): Run {
    const { dt } = this.drivetrain("drive");
    const lim = this.prof.limits;
    const asked = a.distance_cm as number;
    const dist = Math.sign(asked) * Math.min(Math.abs(asked), lim.max_drive_cm);
    const sp = this.speed(a);
    const wheel = (dt.forward_sign * 360 * dist) / (Math.PI * dt.wheel_diameter_cm);
    this.smallestStep("drive", "distance_cm", asked, "cm", wheel, (Math.PI * dt.wheel_diameter_cm) / 360);
    const until = a.until === undefined ? undefined : compileCondition(a.until, this.resolver, "until");
    return moving((signal) =>
      this.move(
        "drive",
        { distance_cm: asked, speed_pct: sp.asked },
        { distance_cm: dist, speed_pct: sp.speed },
        [...cut("distance_cm", asked, dist, true), ...sp.clamps],
        wheel,
        wheel,
        sp.speed,
        until,
        signal,
      ),
    );
  }

  private planTurn(a: Args): Run {
    const { dt } = this.drivetrain("turn");
    const asked = a.angle_deg as number;
    const angle = Math.sign(asked) * Math.min(Math.abs(asked), this.prof.limits.max_turn_deg);
    const sp = this.speed(a);
    const w = (dt.forward_sign * angle * dt.axle_track_cm) / dt.wheel_diameter_cm; // positive angle = counter-clockwise: right wheel forward
    this.smallestStep("turn", "angle_deg", asked, "deg", w, dt.wheel_diameter_cm / dt.axle_track_cm);
    const until = a.until === undefined ? undefined : compileCondition(a.until, this.resolver, "until");
    return moving((signal) =>
      this.move(
        "turn",
        { angle_deg: asked, speed_pct: sp.asked },
        { angle_deg: angle, speed_pct: sp.speed },
        [...cut("angle_deg", asked, angle, true), ...sp.clamps],
        -w,
        w,
        sp.speed,
        until,
        signal,
      ),
    );
  }

  // radius_cm > 0 to the robot's center; angle_deg = heading change (positive = curve left); direction = which
  // way the robot travels. Wheel paths: center path ± heading change × half the axle track.
  private planArc(a: Args): Run {
    const { dt } = this.drivetrain("arc");
    const lim = this.prof.limits;
    const radius = a.radius_cm as number;
    const asked = a.angle_deg as number;
    const direction = (a.direction as "forward" | "backward" | undefined) ?? "forward";
    let angle = Math.sign(asked) * Math.min(Math.abs(asked), lim.max_turn_deg);
    const path = Math.abs((radius * angle * Math.PI) / 180); // distance travelled by the robot's center
    if (path > lim.max_drive_cm) angle *= lim.max_drive_cm / path;
    const sp = this.speed(a);
    const theta = (angle * Math.PI) / 180;
    const center = (direction === "forward" ? 1 : -1) * radius * Math.abs(theta);
    const toDeg = (cm: number) => (dt.forward_sign * 360 * cm) / (Math.PI * dt.wheel_diameter_cm);
    const left = toDeg(center - (theta * dt.axle_track_cm) / 2);
    const right = toDeg(center + (theta * dt.axle_track_cm) / 2);
    // the outer wheel leads: its path per degree of heading is (radius + half the axle track)
    const lead = Math.abs(left) >= Math.abs(right) ? left : right;
    this.smallestStep(
      "arc",
      "angle_deg",
      asked,
      "deg",
      lead,
      (dt.wheel_diameter_cm * 180) / (360 * (radius + dt.axle_track_cm / 2)),
    );
    const until = a.until === undefined ? undefined : compileCondition(a.until, this.resolver, "until");
    return moving((signal) =>
      this.move(
        "arc",
        { radius_cm: radius, angle_deg: asked, direction, speed_pct: sp.asked },
        { radius_cm: radius, angle_deg: round1(angle), direction, speed_pct: sp.speed },
        [
          ...(angle !== asked ? [{ arg: "angle_deg", requested: asked, applied: round1(angle), target: true }] : []),
          ...sp.clamps,
        ],
        left,
        right,
        sp.speed,
        until,
        signal,
      ),
    );
  }

  // One read of a device, timed: the latest round trip of its provider's link.
  private async timedRead(e: Entry, channels: string[]): Promise<Reading[]> {
    const asked = this.clock.now();
    const got = await this.readEntry(e, channels);
    const took = this.clock.now() - asked;
    this.linkMs.set(e.provider, took);
    this.linkAt.set(e.provider, this.clock.now());
    const seen = this.linkSeen.get(e.provider) ?? [];
    seen.push(took);
    if (seen.length > LINK_WINDOW) seen.shift();
    this.linkSeen.set(e.provider, seen);
    return got;
  }
  // The round trip the link is good for: the larger of its latest timed read and a high percentile of the
  // recent ones, never the best one. Unknown until the link was timed LINK_MIN_SAMPLES times.
  private linkSlowMs(p: Provider): number | undefined {
    const seen = this.linkSeen.get(p);
    const latest = this.linkMs.get(p);
    if (!seen || seen.length < LINK_MIN_SAMPLES || latest === undefined) return undefined;
    const sorted = [...seen].sort((a, b) => a - b);
    return Math.max(latest, sorted[Math.ceil(LINK_PERCENTILE * sorted.length) - 1]!);
  }
  private async encoders(pair: Entry): Promise<{ l: number; r: number }> {
    const [l, r] = await this.timedRead(pair, ["left_deg", "right_deg"]);
    if (typeof l!.value !== "number" || typeof r!.value !== "number")
      throw rerr(
        "internal",
        `Could not read wheel encoders of ${pair.spec.id}: ${l!.error ?? r!.error ?? "no numeric value"}. The move was not continued.`,
      );
    return { l: l!.value, r: r!.value };
  }
  private async gyroAngle(g: Entry | undefined): Promise<number | undefined> {
    if (!g) return undefined;
    try {
      const [r] = await this.readEntry(g, ["angle_deg"]);
      return typeof r!.value === "number" ? r!.value : undefined;
    } catch {
      return undefined;
    } // heading then falls back to encoders and says so in `source`
  }

  // Watches a condition for as long as the caller keeps operations running (CONTRACT §4): polls its devices
  // every max(UNTIL_POLL_MS, the round trip of one such read) and calls `trip` the
  // moment it is met or cannot be evaluated, so the caller aborts the operation in flight instead of waiting
  // for it to end. One poll at a time; reads here never switch a sensor mode.
  private monitor(cond: CompiledCondition, trip: () => void, signal: AbortSignal): Monitor {
    const ev = makeEvaluator(cond, this.readFn);
    let met = false,
      failed = false,
      stopped = false,
      error: unknown,
      started = 0,
      done = 0,
      wanted = 1;
    let deciding: Reading[] | undefined;
    let nap: AbortController | undefined;
    let waiters: (() => void)[] = [];
    const wake = () => {
      for (const w of waiters.splice(0)) w();
    };
    const settled = () => met || failed || stopped;
    const result = () => {
      if (failed) throw error;
      return met;
    };
    // Whoever waits for a poll also stops waiting when the call is aborted: the answer is then what is known.
    const until = async (n: number) => {
      while (done < n && !settled() && !signal.aborted) await new Promise<void>((r) => waiters.push(r));
      return result();
    };
    signal.addEventListener("abort", wake, { once: true });
    void (async () => {
      while (!settled()) {
        const asked = this.clock.now();
        started++;
        let decided = true;
        try {
          const r = await ev.poll();
          if (r.met) {
            met = true;
            deciding = r.readings;
          }
          decided = !r.unreadable; // a poll without a value is no answer: whoever waits for a poll waits on
        } catch (err) {
          failed = true;
          error = err;
        }
        if (decided) done = started;
        if (stopped) break;
        if (met || failed) trip();
        wake();
        if (settled() || (decided && wanted > done)) continue;
        const took = this.clock.now() - asked;
        nap = new AbortController();
        await this.clock.sleep(Math.max(UNTIL_POLL_MS, took) - took, nap.signal);
        nap = undefined;
      }
      wake();
    })();
    const first = until(1);
    first.catch(() => {}); // surfaced by whoever awaits it
    return {
      first,
      state: result,
      readings: () => deciding,
      fresh: () => {
        wanted = started + 1;
        nap?.abort();
        return until(wanted);
      },
      stop: () => {
        stopped = true;
        signal.removeEventListener("abort", wake);
        nap?.abort();
        wake();
      },
    };
  }

  // The only chunker (CONTRACT §4). Splits one bounded motion into operations of about chunk_ms (never more
  // than 250 ms of device time, which the provider enforces on the hardware), coasting between chunks
  // (brake:false) and braking on the last one. Under `until` the condition is watched while every operation
  // runs and ends it the moment it is met, and the runtime also ends every operation itself at 250 ms of
  // motion, whatever bound the device declares. `targets` are the totals of the command's bound params; every
  // chunk sends the same fraction of each.
  private async chunked(o: {
    entry: Entry;
    cmd: CommandSpec;
    base: Record<string, Value>;
    targets: Record<string, number>;
    unit: "degrees" | "ms"; // what the targets measure; ms targets are sliced by time, degree targets adaptively
    track?: Track; // an independent measurement of progress; absent → the provider's `measured` is used
    until?: CompiledCondition; // watched for the whole run; ends it with reason condition_met
    signal: AbortSignal;
    t0: number;
  }): Promise<{
    reason: StopReason;
    chunks: number;
    clamped: boolean;
    measured: Record<string, Value>;
    braked: boolean;
    problem?: string;
    // The readings that met `until`, when the run ended with reason condition_met.
    readings?: Reading[];
    // The watch of `until` could not evaluate the condition: the move ended there, braked like any early end.
    // The caller reads what was done and throws the error with it.
    failure?: { error: unknown };
  }> {
    const { entry, cmd, signal } = o;
    const keys = Object.keys(o.targets);
    const lead = Math.max(...keys.map((k) => Math.abs(o.targets[k]!)));
    const leadKey = keys.find((k) => Math.abs(o.targets[k]!) === lead)!;
    const byTime = o.unit === "ms";
    // The command's own bound caps one operation when it is in the same unit as the targets.
    const opCap = cmd.bound.kind === o.unit ? cmd.bound.max : Infinity;
    const props = cmd.params.properties as Record<string, { type?: string } | undefined>;
    const integer = byTime || keys.some((k) => props[k]?.type === "integer");
    const q = (x: number) => (integer ? Math.round(x) : Math.round(x * 100) / 100);
    const tol = integer ? 1 : 0.5;
    // Coast between chunks only when the device can then be braked on its own with its brake{} command.
    const canCoast = "brake" in props && entry.spec.commands.some((c) => c.name === "brake");
    const measured: Record<string, Value> = {};
    // How long one operation should last (CONTRACT §4): the command's declared time bound, or short chunks
    // while an `until` must be evaluated between them. A command without a time bound gets chunk_ms.
    const declaredMs = cmd.bound.kind === "ms" ? cmd.bound.max : undefined;
    const sliceMs = o.until ? Math.min(declaredMs ?? this.chunkMs, this.chunkMs) : (declaredMs ?? this.chunkMs);
    // Under `until` a degree target must not hide a long operation (a slow motor, a device with a long declared
    // bound): the runtime itself ends every operation at cutMs of motion by aborting it, which is a chunk end,
    // not a preemption. Not armed when the device already cuts sooner, nor for ms targets (sliced above).
    const cutAt = Math.min(MAX_CHUNK_MS, 1.25 * sliceMs);
    const cutMs = o.until && !byTime && (declaredMs === undefined || declaredMs > cutAt) ? cutAt : undefined;
    const aimMs = Math.min(
      declaredMs !== undefined && sliceMs === declaredMs ? 0.8 * declaredMs : sliceMs, // stay inside the device's own cut
      cutMs === undefined ? Infinity : 0.8 * cutMs, // and inside the runtime's
    );
    // The link's round trip, which is not motion time: the latest timed read of this provider. With a track
    // every operation travels with one, so a link that gets slower mid-move shows before the next is sent.
    const latency = () => this.linkMs.get(entry.provider);
    // Coast between chunks only on a link whose round trip is small next to the chunk: on a slow link the
    // device would roll uncontrolled between operations, so there every operation brakes. "Small" is judged
    // on the slow end of the recent round trips (linkSlowMs), so one fast answer among slow ones never coasts.
    const coastOk = () => canCoast && (this.linkSlowMs(entry.provider) ?? Infinity) < aimMs / 4;
    // Coasting needs a round trip measured just now: in this call before anything moves, or no longer ago
    // than LINK_FRESH_MS (moves sent back to back, as a program or a script does). What an older call saw may
    // be long gone. With a track, a link last seen slow needs none: every operation brakes there, and the
    // readings that travel with the operations show it when the link is fast again. Without one nothing else
    // would ever time the link, so one read does, on every call.
    const fresh = () => this.clock.now() - (this.linkAt.get(entry.provider) ?? -Infinity) <= LINK_FRESH_MS;
    // A link timed fewer than LINK_MIN_SAMPLES times is timed here, with nothing moving, for as long as it
    // answers fast: on a fast link that costs next to nothing and lets the first chunks coast; the first slow
    // answer ends it, and that link brakes every operation.
    const probe = entry.spec.channels.find((c) => c.type !== "image" && c.active !== false);
    const timed = () => this.linkSeen.get(entry.provider) ?? [];
    if (canCoast && probe)
      while (timed().length < LINK_MIN_SAMPLES && timed().every((ms) => ms < aimMs / 4) && !signal.aborted)
        await this.timedRead(entry, [probe.name]);
    let proven = !canCoast || (latency() !== undefined && (!coastOk() || fresh()));
    if (canCoast && !o.track) {
      if (probe) await this.timedRead(entry, [probe.name]);
      else {
        this.linkMs.delete(entry.provider); // nothing to time it with: never coast
        this.linkSeen.delete(entry.provider);
      }
      proven = true;
    }
    // Degree targets on a fast link, or under `until`: a small probe first, then chunks sized from the speed
    // just measured (degrees moved / motion time, round trip taken out). No device speed is assumed.
    // Otherwise the whole remainder goes in one operation and the device's time bound cuts it if needed.
    const sized = () => !byTime && (coastOk() || o.until !== undefined || declaredMs === undefined);
    let chunkLead = 20;
    let f = 0,
      drift = 0, // degrees the device is expected to move by itself before the next operation starts
      rate = 0, // lead degrees per ms of motion in the latest operation
      checked = false, // f comes from a reading taken after the last operation
      chunks = 0,
      noProgress = 0,
      creep = 0, // degrees gained over the latest deadline-cut operations
      clamped = false,
      coasting = false,
      braked = false;
    let before: "coast" | "brake" = "brake"; // how the previous operation left the device
    const keepsMs: { coast?: number; brake?: number } = {};
    let reason: StopReason | undefined;
    let problem: string | undefined;
    // The operation in flight, and whether the watch ended it: that abort is the condition, not a preemption.
    let flying: AbortController | undefined;
    let tripped = false;
    const mon =
      o.until &&
      this.monitor(
        o.until,
        () => {
          if (!flying) return;
          tripped = true;
          flying.abort();
        },
        signal,
      );
    // A watch that could not evaluate the condition ends the move: nothing more is sent, and what follows the
    // loop brakes a device that still rolls.
    let failure: { error: unknown } | undefined;
    const met = (): boolean => {
      try {
        return mon?.state() ?? false;
      } catch (error) {
        failure = { error };
        return false;
      }
    };
    const metAt = async (poll: Promise<boolean>): Promise<boolean> => {
      try {
        return await poll;
      } catch (error) {
        failure = { error };
        return false;
      }
    };
    // Reversal and stall detection (CONTRACT §0.8), on what one operation really moved along the commanded
    // direction. Both end the move by setting `reason`.
    const reversed = (moved: number, step: number, n: number, asked: Value | undefined): boolean => {
      if (byTime || moved >= -Math.max(3, 0.2 * step)) return false;
      // Moving away from the target is never corrected by sending more: stop here and say so.
      reason = "stalled";
      problem = `reversed: operation ${n} asked ${cmd.name} ${leadKey} ${asked} but ${entry.spec.id} moved ${round1(moved * Math.sign(o.targets[leadKey]!))} (opposite direction). The move was stopped and braked; check the driver and how the motors are mounted (drivetrain.forward_sign).`;
      return true;
    };
    const stuck = (moved: number, step: number, wasCut: boolean): boolean => {
      if (byTime) return false;
      // An operation the runtime cut was never going to cover its step: there, motion that adds up over the
      // cut operations is progress, however slow the motor.
      creep = wasCut ? creep + moved : 0;
      if (wasCut && creep >= tol) creep = noProgress = 0;
      else noProgress = wasCut || moved < 0.1 * step ? noProgress + 1 : 0;
      if (noProgress >= 3) reason = "stalled";
      return noProgress >= 3;
    };
    // The latest operation as it was judged from its own `measured`, until the next reading of the device (the
    // one the following operation starts from, or the closing one) says what it really moved since the
    // reading it started from. Two readings, never a reading against an operation's word.
    let unread:
      | {
          s0: number;
          step: number;
          cut: boolean;
          n: number;
          asked: Value | undefined;
          noProgress: number;
          creep: number;
        }
      | undefined;
    // A reading that must be awaited before the first operation shares its wait with the condition's first poll.
    let early = o.track && !proven ? o.track.mark() : undefined;
    early?.catch(() => {});
    try {
      if (mon && (await metAt(mon.first))) reason = "condition_met";
      while (!reason && !failure) {
        let remaining = (1 - f) * lead - drift;
        if (remaining < tol) {
          // What the operations reported, or what the device is expected to roll by itself, says the target is
          // reached: a reading with nothing running decides, so a device still coasting is braked first.
          if (o.track && !checked) {
            if (coasting) {
              await entry.provider.command(entry.spec.id, "brake", {}, new AbortController().signal);
              coasting = false;
            }
            const read = await o.track.settle();
            drift = 0;
            checked = true;
            // The reading, not the operation's own word, says what that operation did: judge it again.
            const u = unread;
            unread = undefined;
            if (u) {
              const moved = (read - u.s0) * lead;
              noProgress = u.noProgress;
              creep = u.creep;
              if (reversed(moved, u.step, u.n, u.asked) || stuck(moved, u.step, u.cut)) break;
            }
            f = Math.min(1, Math.max(0, read));
            continue;
          }
          reason = "completed";
          break;
        }
        if (signal.aborted) {
          reason = "preempted";
          break;
        }
        if (this.clock.now() - o.t0 >= this.prof.limits.max_command_ms) {
          reason = "timeout";
          break;
        }
        // A time target never asks for more than the call's budget still holds.
        const budgetMs = () => o.t0 + this.prof.limits.max_command_ms - this.clock.now();
        const size = () =>
          Math.min(remaining, opCap, byTime ? Math.min(sliceMs, budgetMs()) : sized() ? chunkLead : Infinity);
        // The reading this operation starts from travels with it. It is awaited first only when its answer is
        // needed before sending: to prove the link fast enough to coast.
        const marked = early ?? o.track?.mark();
        early = undefined;
        marked?.catch(() => {}); // a failed reading surfaces at done(), after the operation it travelled with
        const exact = marked !== undefined && !proven;
        if (marked && exact) {
          f = Math.min(1, Math.max(0, await marked));
          proven = true;
          drift = 0;
          remaining = (1 - f) * lead;
          if (remaining < tol) continue; // decided at the top, with the device braked
          if (signal.aborted) continue;
        }
        if (met()) {
          reason = "condition_met"; // met while a reading was awaited: nothing more is sent
          break;
        }
        if (failure) break;
        const step = size();
        const last = step >= remaining - 1e-9;
        const args: Record<string, Value> = { ...o.base };
        for (const k of keys) args[k] = q((o.targets[k]! * step) / lead);
        if (keys.every((k) => args[k] === 0)) {
          reason = "completed";
          break;
        }
        const coast = !last && coastOk();
        if (canCoast) args.brake = !coast;
        coasting = coast; // from here on the device may be rolling, however this operation ends
        const sent = this.clock.now();
        // One operation, with its own abort: the caller's, or the `until` deadline. The deadline runs from the
        // send: the abort travels the same link as the request and arrives as late as it did, so the device
        // has moved for cutMs when it lands.
        const op = new AbortController();
        const settled = new AbortController();
        const preempt = () => op.abort();
        if (signal.aborted) op.abort();
        else signal.addEventListener("abort", preempt, { once: true });
        let cut = false;
        if (cutMs !== undefined)
          void this.clock.sleep(cutMs, settled.signal).then(async () => {
            await this.clock.sleep(0, settled.signal); // a device that ends by itself at this very instant wins the tie
            if (settled.signal.aborted || op.signal.aborted) return;
            cut = true;
            op.abort();
          });
        // The call's budget (max_command_ms) is watched while the operation runs, like the deadline above: an
        // operation still running when it is spent is aborted there, whatever bound the device declares.
        let spent = false;
        void this.clock.sleep(budgetMs(), settled.signal).then(async () => {
          await this.clock.sleep(0, settled.signal);
          if (settled.signal.aborted || op.signal.aborted) return;
          spent = true;
          op.abort();
        });
        let res: CommandResult;
        tripped = false;
        flying = op;
        if (cmd.moves) this.movesSent++;
        try {
          res = await entry.provider.command(entry.spec.id, cmd.name, args, op.signal);
        } finally {
          flying = undefined;
          settled.abort(); // the deadline timer goes away with its operation
          signal.removeEventListener("abort", preempt);
        }
        const ended = cut || tripped || spent; // the runtime ended this operation itself
        const wall = this.clock.now() - sent;
        checked = false;
        chunks++;
        clamped ||= res.clamped;
        for (const [k, v] of Object.entries(res.measured ?? {}))
          measured[k] =
            typeof v === "number" && typeof (measured[k] ?? 0) === "number"
              ? ((measured[k] as number | undefined) ?? 0) + v
              : v;
        // delta = fraction of the whole move this chunk really covered, signed along the commanded direction
        let delta: number;
        let own: number | undefined; // what this operation says it moved by itself
        let startedAt = 0;
        let verdict = false; // the operation before this one, judged again by the readings, ended the move
        const got = res.measured?.[leadKey];
        if (o.track) {
          const at = await o.track.done(res.measured);
          startedAt = at.start;
          const u = unread;
          unread = undefined;
          if (u) {
            noProgress = u.noProgress;
            creep = u.creep;
            const moved = (at.start - u.s0) * lead;
            verdict = reversed(moved, u.step, u.n, u.asked) || stuck(moved, u.step, u.cut);
          }
          delta = at.f - f;
          // What the device moved by itself before this operation says for how long it keeps going after one
          // that ends the same way (coasting or braked), at the speed of the operation before it.
          const gap = at.drift * lead;
          if (chunks > 1 && rate > 0) keepsMs[before] = Math.min(Math.max(0, gap / rate), 1000);
          own = delta * lead - (exact ? 0 : gap);
          const ownMs = wall - (latency() ?? 0);
          if (own > 0 && ownMs >= 10) rate = own / ownMs;
          before = coast ? "coast" : "brake";
          // Until one such gap was seen: a coasting device keeps going for the link's round trip, a braked one stops.
          drift = Math.min(Math.max(0, rate * (keepsMs[before] ?? (coast ? (latency() ?? 0) : 0))), step);
        } else if (typeof got === "number" && !byTime) delta = got / o.targets[leadKey]!;
        else delta = ended ? 0 : step / lead; // an operation cut short that reports nothing is credited nothing
        const movedLead = delta * lead; // degrees (or ms) along the commanded direction
        const judged = own ?? movedLead; // with a track: this operation alone, until the readings say more
        if (verdict) break;
        unread = o.track && { s0: startedAt, step, cut, n: chunks, asked: args[leadKey], noProgress, creep };
        f = Math.min(1, Math.max(0, f + delta));
        if (signal.aborted || (res.reason === "preempted" && !ended)) {
          reason = "preempted";
          break;
        }
        if (spent) {
          reason = "timeout";
          break;
        }
        if (reversed(judged, step, chunks, args[leadKey])) break;
        if (res.reason === "stalled") {
          reason = "stalled";
          break;
        }
        if (met()) {
          reason = "condition_met";
          break;
        }
        if (failure) break;
        if (stuck(judged, step, cut)) break;
        if (!byTime) {
          const motionMs = wall - (latency() ?? 0);
          const floor = integer ? 2 : 1;
          if (movedLead > 0 && motionMs >= 10)
            chunkLead = Math.max(floor, Math.min((movedLead / motionMs) * aimMs, chunkLead * 4));
          else if (motionMs < 10) chunkLead = Math.max(floor, chunkLead * 2); // too fast to time: probe bigger
        }
        // A device that now stands still (the operation braked) waits for a reading taken after the operation;
        // one that coasts gets its next operation at once, watched.
        if (mon && !coast && (await metAt(mon.fresh()))) {
          reason = "condition_met";
          break;
        }
      }
    } finally {
      mon?.stop();
      // The last operation sent did not brake and no braking one follows (early end, timeout, error, or the
      // target was reached while coasting): brake this device, and only this device, now. A brake that fails
      // is an error, except after an abort, where the caller is already stopping everything.
      if (coasting) {
        braked = true;
        const brake = entry.provider.command(entry.spec.id, "brake", {}, new AbortController().signal);
        await (reason === "preempted" ? brake.catch(() => {}) : brake);
      }
    }
    return {
      reason: reason ?? "preempted",
      chunks,
      clamped,
      measured,
      braked,
      ...(problem ? { problem } : {}),
      ...(reason === "condition_met" && mon?.readings() ? { readings: mon.readings() } : {}),
      ...(failure ? { failure } : {}),
    };
  }

  // The error of a watch that ended a move, with what the move had done by then.
  // A watch that failed before any operation was sent ended nothing: the error says that nothing moved.
  private endedMove(error: unknown, measured: Record<string, Value>, sent: number): unknown {
    if (!(error instanceof RuntimeError)) return error;
    if (sent === 0)
      return new RuntimeError(
        error.code,
        /nothing was sent/i.test(error.message)
          ? error.message
          : `${error.message} Nothing was sent: the robot did not move.`,
        error.retryable,
        measured,
      ).from(error);
    return new RuntimeError(
      error.code,
      `${error.message} The move was ended and the device braked. Measured so far: ${JSON.stringify(measured)}.`,
      error.retryable,
      measured,
    ).from(error);
  }

  // Executes wheel targets (degrees, forward_sign already applied). Progress comes from the wheel encoders,
  // so each chunk is sized from the distance really missing. Reads here never switch a sensor mode.
  private async move(
    tool: "drive" | "turn" | "arc",
    requested: Record<string, Value>,
    applied: Record<string, Value>,
    clamps: Clamp[],
    L: number,
    R: number,
    speed: number,
    until: CompiledCondition | undefined,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    const { dt, pair, cmd } = this.drivetrain(tool);
    const t0 = this.clock.now();
    const gyro = this.gyro();
    const leftLeads = Math.abs(L) >= Math.abs(R);
    const target = leftLeads ? L : R;
    const leadKey = leftLeads ? "left_deg" : "right_deg";
    type Enc = { l: number; r: number };
    // Wheels and heading before the move come from the reading that travels with the first operation, and
    // after it from one reading taken with nothing running: no provider call is made only to measure.
    let before: Promise<[Enc, number | undefined]> | undefined;
    let enc0: Enc | undefined;
    let at: Promise<Enc> | undefined; // where the operation in flight started
    let est = 0; // lead wheel degrees done when the latest operation ended
    let after: { enc: Enc; g: number | undefined } | undefined; // read with nothing running since
    const ahead = (e: Enc) => (leftLeads ? e.l - enc0!.l : e.r - enc0!.r);
    const frac = (deg: number) => (target === 0 ? 1 : deg / target); // signed: negative = the wheels went the wrong way
    const track: Track = {
      mark: () => {
        after = undefined;
        const read = this.encoders(pair);
        before ??= Promise.all([read, this.gyroAngle(gyro)]);
        before.catch(() => {});
        at = read;
        return read.then((e) => {
          enc0 ??= e;
          return frac(ahead(e));
        });
      },
      done: async (measured) => {
        const start = await at!;
        enc0 ??= start;
        const drift = ahead(start) - est;
        const got = measured?.[leadKey];
        // an operation that does not say what it moved is measured with a read of its own
        est = typeof got === "number" ? ahead(start) + got : ahead(await this.encoders(pair));
        return { f: frac(est), start: frac(ahead(start)), drift: target === 0 ? 0 : drift / target };
      },
      settle: async () => {
        const [enc, g] = await Promise.all([this.encoders(pair), this.gyroAngle(gyro)]);
        before ??= Promise.resolve([enc, g]); // nothing was sent: the move starts and ends here
        enc0 ??= (await before)[0];
        after = { enc, g };
        est = ahead(enc);
        return frac(est);
      },
    };
    const run = await this.chunked({
      entry: pair,
      cmd,
      base: { speed_pct: speed },
      targets: { left_deg: L, right_deg: R },
      unit: "degrees",
      track,
      until,
      signal,
      t0,
    });
    // An early end, or the brake{} after a coasting chunk, moved the wheels since the last reading.
    if (!after || run.braked)
      await track.settle().catch((err) => {
        throw run.failure ? run.failure.error : err; // the wheels cannot be read either: the watch's error stands
      });
    const [, g0] = await before!;
    const { enc, g: g1 } = after!;
    const start = enc0!;

    const dl = dt.forward_sign * (enc.l - start.l);
    const dr = dt.forward_sign * (enc.r - start.r);
    const cmPerDeg = (Math.PI * dt.wheel_diameter_cm) / 360;
    const source = g0 !== undefined && g1 !== undefined ? "gyro" : "encoders";
    // Providers normalize angles to the contract's sign (counter-clockwise positive), so the gyro is trusted as is.
    const heading = source === "gyro" ? g1! - g0! : ((dr - dl) * dt.wheel_diameter_cm) / (2 * dt.axle_track_cm);
    // drive, turn and arc report the same fields
    const measured: Record<string, Value> = {
      distance_cm: round1(((dl + dr) / 2) * cmPerDeg),
      heading_change_deg: round1(heading),
      source,
    };
    measured.left_deg = round1(enc.l - start.l);
    measured.right_deg = round1(enc.r - start.r);
    if (run.failure) throw this.endedMove(run.failure.error, measured, run.chunks);
    return {
      data: {
        requested,
        applied,
        measured,
        ...clampFields(run.reason, clamps, run.clamped),
        ...(run.readings ? { readings: run.readings } : {}),
        ...(run.problem ? { problem: run.problem } : {}),
        chunks: run.chunks,
        ms: Math.round(this.clock.now() - t0),
      },
    };
  }

  // ---------- command_device ----------
  private planCommand(a: Args): Run {
    const e = this.entry(a.device);
    const cmd = e.spec.commands.find((c) => c.name === a.command);
    if (!cmd)
      throw rerr(
        "unknown_command",
        `Device ${e.spec.id} (kind ${e.spec.kind}) has no command "${String(a.command)}". Valid commands: ${e.spec.commands.map((c) => c.name).join(", ") || "(none, this device is read-only)"}.`,
      );
    const requested = (a.args ?? {}) as Record<string, Value>;
    const lim = this.prof.limits;
    // Clamp first, then validate what will really be sent: a value over the bound is cut and reported,
    // anything else that breaks the schema is an invalid_argument.
    const applied: Record<string, Value> = { ...requested };
    const clamps: Clamp[] = [];
    // A bound parameter is the command's target: cutting it means less is done than asked. Speed is not.
    const cap = (key: string, max: number, target: boolean) => {
      const v = applied[key];
      if (typeof v === "number" && Math.abs(v) > max) {
        applied[key] = Math.sign(v) * max;
        clamps.push({ arg: key, requested: v, applied: applied[key] as number, target });
      }
    };
    // A moving command bounded in ms declares the longest single operation; the runtime chains operations, so
    // the total is capped by the profile's max_command_ms. Every other bound caps the argument itself.
    const sliced = cmd.moves && cmd.bound.kind === "ms";
    for (const key of cmd.bound.params ?? [])
      cap(
        key,
        sliced
          ? lim.max_command_ms
          : cmd.bound.kind === "ms"
            ? Math.min(cmd.bound.max, lim.max_command_ms)
            : cmd.bound.max,
        true,
      );
    if (!(cmd.bound.params ?? []).includes("speed_pct")) cap("speed_pct", lim.max_speed_pct, false);
    const chunkKeys =
      cmd.moves && cmd.bound.kind !== "instant"
        ? (cmd.bound.params ?? []).filter((k) => typeof applied[k] === "number" && applied[k] !== 0)
        : [];
    // The schema describes one operation: check the first one that would be sent.
    const firstOp = { ...applied };
    if (sliced)
      for (const k of chunkKeys)
        firstOp[k] = Math.sign(applied[k] as number) * Math.min(Math.abs(applied[k] as number), cmd.bound.max);
    const errs = validateSchema(cmd.params, firstOp, "args");
    if (errs.length)
      throw rerr(
        "invalid_argument",
        `${e.spec.id} ${cmd.name}: ${errs.join("; ")}. Params schema: ${JSON.stringify(cmd.params)}`,
      );
    if (a.until !== undefined && !cmd.moves)
      throw rerr(
        "invalid_argument",
        `until is only supported for commands that move; ${e.spec.id} ${cmd.name} does not move. Use wait_until first, then the command.`,
      );
    const until = a.until === undefined ? undefined : compileCondition(a.until, this.resolver, "until");

    // A moving command bounded by degrees or ms is chunked like the drivetrain; anything else is one operation.
    if (chunkKeys.length) {
      const targets = Object.fromEntries(chunkKeys.map((k) => [k, applied[k] as number]));
      const base = Object.fromEntries(Object.entries(applied).filter(([k]) => !chunkKeys.includes(k) && k !== "brake"));
      return moving(async (signal) => {
        const t0 = this.clock.now();
        const run = await this.chunked({
          entry: e,
          cmd,
          base,
          targets,
          unit: cmd.bound.kind === "ms" ? "ms" : "degrees",
          until,
          signal,
          t0,
        });
        if (run.failure) throw this.endedMove(run.failure.error, run.measured, run.chunks);
        return {
          data: {
            requested,
            applied,
            measured: run.measured,
            ...clampFields(run.reason, clamps, run.clamped),
            ...(run.readings ? { readings: run.readings } : {}),
            ...(run.problem ? { problem: run.problem } : {}),
            chunks: run.chunks,
            ms: Math.round(this.clock.now() - t0),
          },
        };
      });
    }

    // One operation. A driver that had to cut a target at its time bound says so (reason "timeout" with
    // measured.time_limited true); the rest is then sent as further operations, each argument reduced by the
    // measured value of the same name (an absolute target has none and is sent again as is).
    // A command that does not move but declares a time bound (a speaker saying a text) may block for that
    // long: max_command_ms is a motion limit and does not cut it short.
    const waitMs =
      !cmd.moves && cmd.bound.kind === "ms" ? Math.max(lim.max_command_ms, cmd.bound.max) : lim.max_command_ms;
    const single: Run = async (signal) => {
      const t0 = this.clock.now();
      // The operation in flight and why the runtime ended it, if it did.
      let flying: AbortController | undefined;
      let why: "condition_met" | "timeout" | undefined;
      const mon =
        until &&
        this.monitor(
          until,
          () => {
            if (!flying) return;
            why = "condition_met";
            flying.abort();
          },
          signal,
        );
      const total: Record<string, Value> = {};
      const done = (reason: StopReason, byDevice: boolean, ops: number): RuntimeResult => ({
        data: {
          requested,
          applied,
          measured: total,
          ...clampFields(reason, clamps, byDevice),
          ...(reason === "condition_met" && mon?.readings() ? { readings: mon.readings() } : {}),
          ...(ops > 1 ? { chunks: ops } : {}),
          ms: Math.round(this.clock.now() - t0),
        },
      });
      // A watch that cannot evaluate the condition ends the command with its error and what was measured.
      const watched = async (poll: Promise<boolean> | undefined): Promise<boolean> => {
        try {
          return (await poll) ?? false;
        } catch (err) {
          throw this.endedMove(err, total, sentOps);
        }
      };
      let sentOps = 0;
      try {
        if (await watched(mon?.first)) return done("condition_met", false, 0);
        let args = { ...applied };
        let anyClamp = false;
        for (let ops = 1; ; ops++) {
          if (signal.aborted) return done("preempted", anyClamp, ops - 1);
          const child = new AbortController();
          linkAbort(signal, child);
          // The call's own time limit, counted from its start.
          const limit = new AbortController();
          void this.clock.sleep(Math.max(0, t0 + waitMs + MAX_CHUNK_MS - this.clock.now()), limit.signal).then(() => {
            if (limit.signal.aborted || child.signal.aborted) return;
            why = "timeout";
            child.abort();
          });
          why = undefined;
          let res: CommandResult;
          flying = child;
          sentOps = ops;
          if (cmd.moves) this.movesSent++;
          try {
            res = await e.provider.command(e.spec.id, cmd.name, args, child.signal);
          } finally {
            flying = undefined;
            limit.abort();
          }
          anyClamp ||= res.clamped;
          const m = res.measured ?? {};
          for (const [k, v] of Object.entries(m))
            total[k] =
              typeof v === "number" && typeof (total[k] ?? 0) === "number"
                ? ((total[k] as number | undefined) ?? 0) + v
                : v;
          try {
            mon?.state(); // a condition that could not be read is an error, not a result
          } catch (err) {
            throw this.endedMove(err, total, sentOps);
          }
          if (signal.aborted) return done("preempted", anyClamp, ops);
          if (why && res.reason === "preempted") return done(why, anyClamp, ops);
          if (!(cmd.moves && res.reason === "timeout" && m.time_limited === true))
            return done(res.reason, anyClamp, ops);
          if (this.clock.now() - t0 >= lim.max_command_ms) return done("timeout", anyClamp, ops);
          if (await watched(mon?.fresh())) return done("condition_met", anyClamp, ops);
          const rest = { ...args };
          for (const [k, v] of Object.entries(args))
            if (typeof v === "number" && typeof m[k] === "number") rest[k] = v - (m[k] as number);
          args = rest;
        }
      } finally {
        mon?.stop();
      }
    };
    return cmd.moves ? moving(single) : single;
  }

  // ---------- stop / reset_fault ----------
  async stop(): Promise<{ motors_stopped: boolean }> {
    for (const c of this.inflight) c.abort();
    // Each provider gets its own announced worst case; one that takes longer counts as not stopped.
    const results = await Promise.all(
      this.local.map(async (p) => {
        const late = new AbortController();
        const timeout = this.clock.sleep(p.stop_worst_ms, late.signal).then(() => false);
        try {
          return await Promise.race([
            p.stop().then(
              (r) => r?.motors_stopped === true,
              () => false,
            ),
            timeout,
          ]);
        } finally {
          late.abort();
        }
      }),
    );
    return { motors_stopped: results.every(Boolean) };
  }

  private planResetFault(): Run {
    return async () => {
      const { motors_stopped } = await this.stop();
      if (!motors_stopped)
        throw rerr(
          "stop_unverified",
          "Could not verify that every motor is stopped, so the fault stays. Check the brick's connection and power, then call stop and reset_fault again.",
        );
      return { data: { activity: "idle" } };
    };
  }

  // ---------- programs ----------
  private planProgram(a: Args): Run {
    const body = a.body;
    const success =
      a.success === undefined || a.success === null ? undefined : compileCondition(a.success, this.resolver, "success");
    const issues = validateProgram(body);
    if (issues.length)
      throw rerr(
        "invalid_argument",
        `program is not valid: ${issues
          .slice(0, 8)
          .map((i) => `${i.path}: ${i.message}`)
          .join("; ")}${issues.length > 8 ? `; and ${issues.length - 8} more` : ""}`,
      );
    const sites = collectSites(body as ProgramNode, "body");
    for (const c of sites.conds) compileCondition(c.cond, this.resolver, `program ${c.path}`);
    for (const c of sites.calls) {
      try {
        this.plan(c.tool, c.args);
      } catch (err) {
        throw err instanceof RuntimeError
          ? new RuntimeError(err.code, `program ${c.path} (${c.tool}): ${err.message}`, err.retryable).from(err)
          : err;
      }
    }
    return moving((signal) => this.runProgram(body as ProgramNode, success, signal));
  }

  private async runProgram(
    body: ProgramNode,
    success: CompiledCondition | undefined,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    const t0 = this.clock.now();
    const steps: ProgramStep[] = [];
    const internal: InternalFailure[] = [];
    let dropped = 0;
    const record = (s: ProgramStep) => {
      if (steps.length < MAX_STEPS) steps.push(s);
      else dropped++;
    };
    const budget = new AbortController();
    linkAbort(signal, budget);
    const timer = new AbortController();
    let timedOut = false;
    void this.clock.sleep(this.prof.limits.max_program_ms, timer.signal).then(() => {
      if (!timer.signal.aborted) {
        timedOut = true;
        budget.abort();
      }
    });
    class End {
      constructor(
        public outcome: ProgramResult["outcome"],
        public reason: string,
      ) {}
    }
    const interrupted = () =>
      timedOut
        ? new End("timeout", `program exceeded max_program_ms (${this.prof.limits.max_program_ms} ms)`)
        : new End("aborted", "preempted");
    const check = () => {
      if (budget.signal.aborted) throw interrupted();
    };
    const test = async (cond: unknown, path: string, ev?: ReturnType<typeof makeEvaluator>) => {
      try {
        const e = ev ?? makeEvaluator(compileCondition(cond, this.resolver, `program ${path}`), this.readFn);
        // One answer is needed: a poll without a value is asked again until the evaluator answers or gives up.
        // A program interrupted while it waits (its budget spent, the call aborted) ends as interrupted.
        let r = await e.poll();
        while (r.unreadable) {
          await this.clock.sleep(UNTIL_POLL_MS, budget.signal);
          check();
          r = await e.poll();
        }
        return r.met;
      } catch (err) {
        if (err instanceof End) throw err;
        throw new End(
          "failed",
          `${path}: ${err instanceof RuntimeError ? `${err.code}: ${err.message}` : String(err)}`,
        );
      }
    };

    const exec = async (n: ProgramNode, path: string): Promise<void> => {
      check();
      if ("seq" in n) {
        for (let i = 0; i < n.seq.length; i++) await exec(n.seq[i]!, `${path}.seq[${i}]`);
        return;
      }
      if ("repeat" in n) {
        for (let i = 0; i < n.repeat.times; i++) await exec(n.repeat.body, `${path}.repeat[${i}]`);
        return;
      }
      if ("while" in n) {
        const ev = makeEvaluator(
          compileCondition(n.while.cond, this.resolver, `program ${path}.while.cond`),
          this.readFn,
        );
        for (let i = 0; i < n.while.max_iterations; i++) {
          check();
          if (!(await test(n.while.cond, `${path}.while.cond`, ev))) return;
          await exec(n.while.body, `${path}.while[${i}]`);
        }
        return;
      }
      if ("if" in n) {
        if (await test(n.if.cond, `${path}.if.cond`)) await exec(n.if.then, `${path}.if.then`);
        else if (n.if.else) await exec(n.if.else, `${path}.if.else`);
        return;
      }
      if ("fail" in n) throw new End("failed", n.fail);
      if ("succeed" in n) throw new End("succeeded", n.succeed);
      const s0 = this.clock.now();
      const ms = () => Math.round(this.clock.now() - s0);
      if ("wait_ms" in n) {
        await this.clock.sleep(n.wait_ms, budget.signal);
        record({
          path,
          tool: "wait_ms",
          ok: !budget.signal.aborted,
          reason: budget.signal.aborted ? "preempted" : "completed",
          ms: ms(),
        });
        check();
        return;
      }
      const { tool, args } = n.call;
      let data: Record<string, unknown>;
      try {
        data = (await this.plan(tool, args ?? {})(budget.signal)).data as Record<string, unknown>;
      } catch (err) {
        const typed = err instanceof RuntimeError ? err : this.unexpected(`${path} (${tool})`, err);
        // the program answers with data, so the failure's stack reaches the log through the result
        if (typed.code === "internal")
          internal.push({
            trace_id: (typed.trace_id ??= newTraceId()),
            message: typed.message,
            stack: stackOf(typed),
          });
        const e = { code: typed.code, message: typed.message, ...(typed.trace_id ? { trace_id: typed.trace_id } : {}) };
        record({ path, tool, ok: false, error: e, ...(typed.measured ? { measured: typed.measured } : {}), ms: ms() });
        throw new End("failed", `${path} (${tool}) failed: ${e.code}: ${e.message}`);
      }
      const reason = String(data.reason);
      // what the step did, as the same call outside a program reports it
      const did = {
        ...(isObj(data.measured) ? { measured: data.measured as Record<string, Value> } : {}),
        ...(data.clamped === true ? { clamped: true as const } : {}),
      };
      if (reason === "preempted") {
        record({ path, tool, ok: false, reason, ...did, ms: ms() });
        throw interrupted();
      }
      if (tool !== "wait_until" && (reason === "stalled" || reason === "timeout")) {
        record({ path, tool, ok: false, reason, ...did, ms: ms() });
        throw new End("failed", `${path} (${tool}) ended with reason ${reason}`);
      }
      record({ path, tool, ok: true, reason, ...did, ms: ms() });
    };

    let end: End;
    try {
      await exec(body, "body");
      check();
      end = !success
        ? new End("succeeded", "completed")
        : (await test(undefined, "success", makeEvaluator(success, this.readFn)))
          ? new End("succeeded", "success condition met")
          : new End("failed", "body completed but the success condition is false");
    } catch (err) {
      if (!(err instanceof End)) {
        timer.abort();
        throw err;
      }
      end = err;
    }
    timer.abort();
    const result: ProgramResult = {
      outcome: end.outcome,
      reason: end.reason,
      steps,
      steps_dropped: dropped,
      ms: Math.round(this.clock.now() - t0),
    };
    return { data: result, ...(internal.length ? { internal } : {}) };
  }

  // ---------- dispatch ----------
  // plan() does every check that needs no I/O (schema, names, clamps); the returned function does the work.
  private plan(tool: RobotTool, raw: Args): Run {
    if (!ROBOT_TOOLS.includes(tool))
      throw rerr("invalid_argument", `Unknown runtime tool "${String(tool)}". Valid tools: ${ROBOT_TOOLS.join(", ")}.`);
    if (!isObj(raw)) throw rerr("invalid_argument", `${tool}: args must be an object`);
    const { robot_id: _r, request_id: _q, ...a } = raw;
    if (tool !== "run_program") {
      const def = TOOLS.find((t) => t.name === tool)!;
      const schema = {
        ...def.input,
        required: (def.input.required ?? []).filter((k) => k !== "robot_id" && k !== "request_id"),
      };
      const errs = validateSchema(schema, a, "args");
      if (errs.length) throw rerr("invalid_argument", `${tool}: ${errs.join("; ")}`);
    }
    switch (tool) {
      case "describe_robot":
        return async () => ({ data: this.describeRobot() });
      case "describe_device": {
        const e = this.entry(a.device);
        return async () => ({ data: e.spec });
      }
      case "read_device":
        return this.planReadDevice(a);
      case "read_all":
        return this.planReadAll();
      case "sample_device":
        return this.planSample(a);
      case "wait_until":
        return this.planWaitUntil(a);
      case "drive":
        return this.planDrive(a);
      case "turn":
        return this.planTurn(a);
      case "arc":
        return this.planArc(a);
      case "command_device":
        return this.planCommand(a);
      case "reset_fault":
        return this.planResetFault();
      case "run_program":
        return this.planProgram(a);
    }
  }

  private describeRobot() {
    return {
      id: this.prof.id,
      backend: this.backend,
      devices: this.devices().map((d) => ({
        id: d.id,
        provider: d.provider,
        kind: d.kind,
        roles: d.roles,
        channels: d.channels.map((c) => c.name),
        commands: d.commands.map((c) => c.name),
        description: d.description,
      })),
      roles: this.roleMap(),
      drivetrain: this.prof.drivetrain ?? null,
      limits: this.prof.limits,
      notes: this.prof.notes,
      scan_error: this.scanFailure
        ? `device scan failed (${this.scanFailure.attempts} in a row): ${this.scanFailure.message}. The device list and each channel's active flag are those of the last scan that succeeded and may be out of date; the scan is tried again by itself.`
        : null,
    };
  }

  async call(
    tool: RobotTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
    ctx?: { activity: RobotActivity },
  ): Promise<RuntimeResult> {
    const ctl = new AbortController();
    linkAbort(signal, ctl);
    this.inflight.add(ctl);
    // One moving call at a time per robot (CONTRACT §1), so the operations sent meanwhile are this call's.
    let sentBefore: number | undefined;
    try {
      await this.scan;
      this.callerActivity = ctx?.activity ?? "idle"; // plan() is synchronous, so this cannot interleave
      const run = this.plan(tool, args ?? {});
      if (!run.moves) return await run(ctl.signal);
      this.acting++;
      sentBefore = this.movesSent;
      try {
        const result = await run(ctl.signal);
        return { ...result, moved: this.movesSent > sentBefore };
      } finally {
        this.acting--;
      }
    } catch (err) {
      const typed = err instanceof RuntimeError ? err : this.unexpected(tool, err);
      if (sentBefore !== undefined) typed.moved = this.movesSent > sentBefore;
      throw typed;
    } finally {
      this.inflight.delete(ctl);
    }
  }
  // An error no part of the runtime or its drivers typed: a bug, or a device that broke its interface. It gets
  // a trace id, which its message carries, and keeps what caused it, so the process can log the stack under
  // that id (CONTRACT §6).
  private unexpected(what: string, err: unknown): RuntimeError {
    const trace = newTraceId();
    const e = rerr(
      "internal",
      `${what} failed unexpectedly (trace_id ${trace}): ${String((err as Error)?.message ?? err)}`,
    );
    e.trace_id = trace;
    e.cause = err;
    return e;
  }
}

// Call and condition sites of an already validated program, to check them against the real devices.
function collectSites(
  n: ProgramNode,
  path: string,
  out: { calls: { path: string; tool: RobotTool; args: Args }[]; conds: { path: string; cond: unknown }[] } = {
    calls: [],
    conds: [],
  },
) {
  if ("seq" in n) n.seq.forEach((c, i) => collectSites(c, `${path}.seq[${i}]`, out));
  else if ("repeat" in n) collectSites(n.repeat.body, `${path}.repeat.body`, out);
  else if ("while" in n) {
    out.conds.push({ path: `${path}.while.cond`, cond: n.while.cond });
    collectSites(n.while.body, `${path}.while.body`, out);
  } else if ("if" in n) {
    out.conds.push({ path: `${path}.if.cond`, cond: n.if.cond });
    collectSites(n.if.then, `${path}.if.then`, out);
    if (n.if.else) collectSites(n.if.else, `${path}.if.else`, out);
  } else if ("call" in n) out.calls.push({ path, tool: n.call.tool, args: n.call.args });
  return out;
}
