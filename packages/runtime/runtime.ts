// The runtime executes every robot-local tool next to the hardware (CONTRACT.md §4). It knows devices only
// through their manifests and the Provider interface; the only kinds it names are motor_pair (drivetrain)
// and gyro (heading source). Limits come from the profile. The relay owns auth, FSMs and idempotency.
import { RuntimeError } from "../protocol/types";
import type {
  BackendKind,
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
import { validateSchema } from "./schema";

export const STALE_IMAGE_MS = 1500; // CONTRACT §7 stale_image
export const MAX_CHUNK_MS = 250; // CONTRACT §0.8: longest operation for a command that declares no time bound of its own
export const MAX_SAMPLE_HZ = 50;
const RETRYABLE: readonly ErrorCode[] = [
  "robot_offline",
  "busy",
  "timeout",
  "provider_stale",
  "stale_image",
  "rate_limited",
];
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
  refresh(): Promise<void>; // re-scan every provider's devices
  setRemoteProviders(providers: Provider[]): Promise<void>; // replace the set of organ providers
  localDevices(): DeviceSpec[]; // devices of the local providers only
  // Called after a local provider reported a device change (Provider.onDevicesChanged) and the registry was
  // re-read. Returns the unsubscribe function.
  onLocalDevicesChanged(cb: () => void): () => void;
  dispose(): void; // unsubscribe from every provider
}
export interface ProgramStep {
  path: string;
  tool: string;
  ok: boolean;
  reason?: string;
  error?: { code: ErrorCode; message: string };
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
  remote: boolean;
}
const MAX_STEPS = 500;
const round1 = (x: number) => Math.round(x * 10) / 10;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function createRuntime(opts: RuntimeOptions): LocalRuntime {
  return new RuntimeImpl(opts);
}

class RuntimeImpl implements LocalRuntime {
  private readonly prof: RobotProfile;
  private readonly local: Provider[];
  private remote: Provider[] = [];
  private readonly clock: Clock;
  private readonly chunkMs: number;
  private entries = new Map<string, Entry>();
  private readonly inflight = new Set<AbortController>();
  private scan: Promise<void>;
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
        // A failed re-read is not hidden: every call fails with it until a later scan succeeds.
        void this.refresh().then(
          () => {
            for (const cb of [...this.listeners]) cb();
          },
          () => {},
        );
      });
      if (off) this.unsubscribe.push(off);
    }
  }
  get stop_worst_ms(): number {
    return Math.max(...[...this.local, ...this.remote].map((p) => p.stop_worst_ms)) + STOP_OVERHEAD_MS;
  }
  private acting = 0; // moving calls in flight; explicit mode-switching reads are refused meanwhile
  private relayActivity: RobotActivity = "idle"; // activity of the call being planned, as the relay reported it
  private providerErrors: { provider: string; error: string }[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: (() => void)[] = [];
  onLocalDevicesChanged(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }
  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    this.listeners.clear();
  }

  // ---------- registry ----------
  profile(): RobotProfile {
    return this.prof;
  }
  devices(): DeviceSpec[] {
    return [...this.entries.values()].map((e) => e.spec);
  }
  localDevices(): DeviceSpec[] {
    return [...this.entries.values()].filter((e) => !e.remote).map((e) => e.spec);
  }
  ready(): Promise<void> {
    return this.scan;
  }
  refresh(): Promise<void> {
    // one scan at a time, in the order requested
    this.scan = this.scan.catch(() => {}).then(() => this.rescan());
    this.scan.catch(() => {});
    return this.scan;
  }
  setRemoteProviders(providers: Provider[]): Promise<void> {
    const localIds = new Set(this.local.map((p) => p.id));
    const clash = providers.find((p) => localIds.has(p.id));
    if (clash)
      return Promise.reject(
        rerr("invalid_argument", `remote provider id "${clash.id}" collides with a local provider`),
      );
    this.remote = providers;
    // The registry keeps every organ that answered; one that could not list its devices is reported, not hidden.
    return this.refresh().then(() => {
      if (this.providerErrors.length)
        throw rerr(
          "provider_stale",
          `Could not list the devices of: ${this.providerErrors.map((e) => `${e.provider} (${e.error})`).join("; ")}. Their devices are not available; the others are.`,
        );
    });
  }

  private async rescan(): Promise<void> {
    const next = new Map<string, Entry>();
    const errors: { provider: string; error: string }[] = [];
    const add = async (p: Provider, remote: boolean) => {
      for (const d of await p.devices()) {
        // A pair that can coast between chunks must be brakeable on its own (never through provider.stop()).
        if (d.kind === "motor_pair" && !d.commands.some((c) => c.name === "brake")) {
          const why = `motor_pair ${d.id} has no brake{} command; the runtime needs it to end a move after coasting chunks`;
          if (remote) {
            errors.push({ provider: p.id, error: `${why}; this device was ignored` });
            continue;
          }
          throw rerr("misconfigured", `${why} (provider ${p.id})`);
        }
        if (next.has(d.id)) {
          if (remote) {
            errors.push({ provider: p.id, error: `device id "${d.id}" is already taken; this device was ignored` });
            continue;
          }
          throw rerr("misconfigured", `device id "${d.id}" is announced twice (provider ${p.id})`);
        }
        const roles = new Set(d.roles ?? []);
        for (const [role, id] of Object.entries(this.prof.roles)) if (id === d.id) roles.add(role);
        next.set(d.id, { spec: { ...d, roles: [...roles] }, provider: p, remote });
      }
    };
    for (const p of this.local) await add(p, false);
    for (const p of this.remote) {
      try {
        await add(p, true);
      } catch (err) {
        errors.push({ provider: p.id, error: String((err as Error)?.message ?? err) });
      }
    }
    this.entries = next;
    this.providerErrors = errors;
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
          error: "provider returned no value for this channel",
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
    const activity = this.relayActivity;
    return async () => {
      if (switching.length && (this.acting > 0 || activity !== "idle"))
        throw rerr(
          "busy",
          `Reading ${switching.map((n) => `${e.spec.id}.${n}`).join(", ")} needs a sensor mode switch, which is only done while the robot is idle (it is ${this.acting > 0 ? "acting" : activity}). Retry when it ends, or read the active channels (omit channels).`,
        );
      const readings = await this.readEntry(e, names, switching.length > 0);
      let image: ImagePayload | undefined;
      const data = readings.map((r) => {
        if (r.channel !== images[0]) return r;
        if (!r.image) return r.error ? r : { ...r, value: null, error: "provider returned no image for this channel" };
        const age_ms = Math.max(0, Math.round(r.image.age_ms));
        if (age_ms > STALE_IMAGE_MS)
          throw rerr(
            "stale_image",
            `Frame from ${r.device}.${r.channel} is ${age_ms} ms old (limit ${STALE_IMAGE_MS} ms). The source stopped sending frames; retry, or check the device.`,
          );
        image = { mime: r.image.mime, b64: r.image.b64, age_ms };
        return { device: r.device, channel: r.channel, value: null, image: true, mime: image.mime, age_ms, ts: r.ts };
      });
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
        const after_ms = Math.round(this.clock.now() - t0);
        if (r.met) return { data: { met: true, after_ms, readings: r.readings } };
        if (signal.aborted) return { data: { met: false, after_ms, readings: r.readings, reason: "preempted" } };
        if (after_ms >= timeout) return { data: { met: false, after_ms, readings: r.readings } };
        await this.clock.sleep(Math.min(period, timeout - after_ms), signal);
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

  private speed(a: Args): { speed: number; clamped: boolean } {
    const asked = (a.speed_pct as number | undefined) ?? 30;
    const speed = Math.min(asked, this.prof.limits.max_speed_pct);
    return { speed, clamped: speed !== asked };
  }

  private planDrive(a: Args): Run {
    const { dt } = this.drivetrain("drive");
    const lim = this.prof.limits;
    const asked = a.distance_cm as number;
    const dist = Math.sign(asked) * Math.min(Math.abs(asked), lim.max_drive_cm);
    const sp = this.speed(a);
    const wheel = (dt.forward_sign * 360 * dist) / (Math.PI * dt.wheel_diameter_cm);
    const until = a.until === undefined ? undefined : compileCondition(a.until, this.resolver, "until");
    return moving((signal) =>
      this.move(
        "drive",
        { distance_cm: asked, speed_pct: (a.speed_pct as number | undefined) ?? 30 },
        { distance_cm: dist, speed_pct: sp.speed },
        dist !== asked || sp.clamped,
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
    const until = a.until === undefined ? undefined : compileCondition(a.until, this.resolver, "until");
    return moving((signal) =>
      this.move(
        "turn",
        { angle_deg: asked, speed_pct: (a.speed_pct as number | undefined) ?? 30 },
        { angle_deg: angle, speed_pct: sp.speed },
        angle !== asked || sp.clamped,
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
    const until = a.until === undefined ? undefined : compileCondition(a.until, this.resolver, "until");
    const speed_pct = (a.speed_pct as number | undefined) ?? 30;
    return moving((signal) =>
      this.move(
        "arc",
        { radius_cm: radius, angle_deg: asked, direction, speed_pct },
        { radius_cm: radius, angle_deg: round1(angle), direction, speed_pct: sp.speed },
        angle !== asked || sp.clamped,
        left,
        right,
        sp.speed,
        until,
        signal,
      ),
    );
  }

  private async encoders(pair: Entry): Promise<{ l: number; r: number }> {
    const [l, r] = await this.readEntry(pair, ["left_deg", "right_deg"]);
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

  // The only chunker (CONTRACT §4). Splits one bounded motion into operations of about chunk_ms (never more
  // than 250 ms of device time, which the provider enforces on the hardware), coasting between chunks
  // (brake:false) and braking on the last one, and evaluates `until` between chunks; under `until` it also
  // ends every operation itself at 250 ms of motion, whatever bound the device declares. `targets` are the totals
  // of the command's bound params; every chunk sends the same fraction of each.
  private async chunked(o: {
    entry: Entry;
    cmd: CommandSpec;
    base: Record<string, Value>;
    targets: Record<string, number>;
    unit: "degrees" | "ms"; // what the targets measure; ms targets are sliced by time, degree targets adaptively
    // Signed fraction done from an independent measurement (encoders), negative = moved the wrong way;
    // absent → the provider's `measured` is used.
    progress?: () => Promise<number>;
    latency_ms?: number; // a measured round trip to the device (e.g. the first encoder read)
    ev?: ReturnType<typeof makeEvaluator>;
    signal: AbortSignal;
    t0: number;
  }): Promise<{
    reason: StopReason;
    chunks: number;
    clamped: boolean;
    measured: Record<string, Value>;
    braked: boolean;
    problem?: string;
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
    const sliceMs = o.ev ? Math.min(declaredMs ?? this.chunkMs, this.chunkMs) : (declaredMs ?? this.chunkMs);
    // Under `until` a degree target must not hide a long operation (a slow motor, a device with a long declared
    // bound): the runtime itself ends every operation at cutMs of motion by aborting it, which is a chunk end,
    // not a preemption. Not armed when the device already cuts sooner, nor for ms targets (sliced above), nor
    // for a remote organ: an abort does not reach it through the relay, so the next chunk would be sent on top
    // of an operation still running. There the organ's own declared bound is the limit.
    const cutAt = Math.min(MAX_CHUNK_MS, 1.25 * sliceMs);
    const abortable = entry.provider.backend !== "organ";
    const cutMs = o.ev && !byTime && abortable && (declaredMs === undefined || declaredMs > cutAt) ? cutAt : undefined;
    const aimMs = Math.min(
      declaredMs !== undefined && sliceMs === declaredMs ? 0.8 * declaredMs : sliceMs, // stay inside the device's own cut
      cutMs === undefined ? Infinity : 0.8 * cutMs, // and inside the runtime's
    );
    let latency = o.latency_ms; // smallest round trip seen; it is not motion time
    if (latency === undefined && canCoast) {
      // one timed read of the device tells whether the link is fast enough to chain coasting chunks
      const ch = entry.spec.channels.find((c) => c.type !== "image" && c.active !== false);
      if (ch) {
        const asked = this.clock.now();
        await this.readEntry(entry, [ch.name]);
        latency = this.clock.now() - asked;
      }
    }
    // Coast between chunks only on a link whose round trip is small next to the chunk: on a slow link the
    // device would roll uncontrolled between operations, so there every operation brakes.
    const coastOk = () => canCoast && latency !== undefined && latency < aimMs / 4;
    // Degree targets on a fast link, or under `until`: a small probe first, then chunks sized from the speed
    // just measured (degrees moved / motion time, round trip taken out). No device speed is assumed.
    // Otherwise the whole remainder goes in one operation and the device's time bound cuts it if needed.
    const sized = () => !byTime && (coastOk() || o.ev !== undefined || declaredMs === undefined);
    let chunkLead = 20;
    let f = 0,
      chunks = 0,
      noProgress = 0,
      creep = 0, // degrees gained over the latest deadline-cut operations
      clamped = false,
      coasting = false,
      braked = false;
    let reason: StopReason | undefined;
    let problem: string | undefined;
    try {
      if (o.ev && (await o.ev.poll()).met) reason = "condition_met";
      while (!reason) {
        const remaining = (1 - f) * lead;
        if (remaining < tol) {
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
        const step = Math.min(remaining, opCap, byTime ? sliceMs : sized() ? chunkLead : Infinity);
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
        let res: CommandResult;
        try {
          res = await entry.provider.command(entry.spec.id, cmd.name, args, op.signal);
        } finally {
          settled.abort(); // the deadline timer goes away with its operation
          signal.removeEventListener("abort", preempt);
        }
        const wall = this.clock.now() - sent;
        chunks++;
        clamped ||= res.clamped;
        for (const [k, v] of Object.entries(res.measured ?? {}))
          measured[k] =
            typeof v === "number" && typeof (measured[k] ?? 0) === "number"
              ? ((measured[k] as number | undefined) ?? 0) + v
              : v;
        // delta = fraction of the whole move this chunk really covered, signed along the commanded direction
        let delta: number;
        const got = res.measured?.[leadKey];
        if (o.progress) {
          const asked = this.clock.now();
          const raw = await o.progress();
          latency = Math.min(latency ?? Infinity, this.clock.now() - asked);
          delta = raw - f;
        } else if (typeof got === "number" && !byTime) delta = got / o.targets[leadKey]!;
        else delta = cut ? 0 : step / lead; // an operation cut short that reports nothing is credited nothing
        const movedLead = delta * lead; // degrees (or ms) along the commanded direction
        f = Math.min(1, Math.max(0, f + delta));
        if (signal.aborted || (res.reason === "preempted" && !cut)) {
          reason = "preempted";
          break;
        }
        if (!byTime && movedLead < -Math.max(3, 0.2 * step)) {
          // Moving away from the target is never corrected by sending more: stop here and say so.
          reason = "stalled";
          problem = `reversed: operation ${chunks} asked ${cmd.name} ${leadKey} ${args[leadKey]} but ${entry.spec.id} moved ${round1(movedLead * Math.sign(o.targets[leadKey]!))} (opposite direction). The move was stopped and braked; check the driver and how the motors are mounted (drivetrain.forward_sign).`;
          break;
        }
        if (res.reason === "stalled") {
          reason = "stalled";
          break;
        }
        if (!byTime) {
          // An operation the runtime cut was never going to cover its step: there, motion that adds up over the
          // cut operations is progress, however slow the motor.
          creep = cut ? creep + movedLead : 0;
          if (cut && creep >= tol) creep = noProgress = 0;
          else noProgress = cut || movedLead < 0.1 * step ? noProgress + 1 : 0;
          if (noProgress >= 3) {
            reason = "stalled";
            break;
          }
          const motionMs = wall - (latency ?? 0);
          const floor = integer ? 2 : 1;
          if (movedLead > 0 && motionMs >= 10)
            chunkLead = Math.max(floor, Math.min((movedLead / motionMs) * aimMs, chunkLead * 4));
          else if (motionMs < 10) chunkLead = Math.max(floor, chunkLead * 2); // too fast to time: probe bigger
        }
        if (o.ev && (await o.ev.poll()).met) {
          reason = "condition_met";
          break;
        }
      }
    } finally {
      // The last operation sent did not brake and no braking one follows (early end, timeout, error, or the
      // target was reached while coasting): brake this device, and only this device, now. A brake that fails
      // is an error, except after an abort, where the caller is already stopping everything.
      if (coasting) {
        braked = true;
        const brake = entry.provider.command(entry.spec.id, "brake", {}, new AbortController().signal);
        await (reason === "preempted" ? brake.catch(() => {}) : brake);
      }
    }
    return { reason: reason!, chunks, clamped, measured, braked, ...(problem ? { problem } : {}) };
  }

  // Executes wheel targets (degrees, forward_sign already applied). Progress comes from the wheel encoders,
  // so each chunk is sized from the distance really missing. Reads here never switch a sensor mode.
  private async move(
    tool: "drive" | "turn" | "arc",
    requested: Record<string, Value>,
    applied: Record<string, Value>,
    clamped: boolean,
    L: number,
    R: number,
    speed: number,
    until: CompiledCondition | undefined,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    const { dt, pair, cmd } = this.drivetrain(tool);
    const t0 = this.clock.now();
    const gyro = this.gyro();
    const enc0 = await this.encoders(pair);
    const latency_ms = this.clock.now() - t0; // one read round trip
    const g0 = await this.gyroAngle(gyro);
    const leftLeads = Math.abs(L) >= Math.abs(R);
    const target = leftLeads ? L : R;
    let enc = enc0;
    const progress = async () => {
      enc = await this.encoders(pair);
      const done = leftLeads ? enc.l - enc0.l : enc.r - enc0.r;
      return target === 0 ? 1 : done / target; // signed: negative = the wheels went the wrong way
    };
    const run = await this.chunked({
      entry: pair,
      cmd,
      base: { speed_pct: speed },
      targets: { left_deg: L, right_deg: R },
      unit: "degrees",
      progress,
      latency_ms,
      ev: until && makeEvaluator(until, this.readFn),
      signal,
      t0,
    });
    let reason = run.reason;
    if (reason === "completed" && (clamped || run.clamped)) reason = "clamped";
    if (run.braked) enc = await this.encoders(pair); // the brake{} after a coasting chunk moved the wheels a little more

    const dl = dt.forward_sign * (enc.l - enc0.l);
    const dr = dt.forward_sign * (enc.r - enc0.r);
    const cmPerDeg = (Math.PI * dt.wheel_diameter_cm) / 360;
    const g1 = g0 === undefined ? undefined : await this.gyroAngle(gyro);
    const source = g0 !== undefined && g1 !== undefined ? "gyro" : "encoders";
    // Providers normalize angles to the contract's sign (counter-clockwise positive), so the gyro is trusted as is.
    const heading = source === "gyro" ? g1! - g0! : ((dr - dl) * dt.wheel_diameter_cm) / (2 * dt.axle_track_cm);
    const measured: Record<string, Value> =
      tool === "turn"
        ? { angle_deg: round1(heading), source }
        : { distance_cm: round1(((dl + dr) / 2) * cmPerDeg), heading_change_deg: round1(heading), source };
    return {
      data: {
        requested,
        applied,
        measured: { ...measured, left_deg: round1(enc.l - enc0.l), right_deg: round1(enc.r - enc0.r) },
        clamped: clamped || run.clamped,
        reason,
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
    let clamped = false;
    const cap = (key: string, max: number) => {
      const v = applied[key];
      if (typeof v === "number" && Math.abs(v) > max) {
        applied[key] = Math.sign(v) * max;
        clamped = true;
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
      );
    cap("speed_pct", lim.max_speed_pct);
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
          ev: until && makeEvaluator(until, this.readFn),
          signal,
          t0,
        });
        const anyClamp = clamped || run.clamped;
        return {
          data: {
            requested,
            applied,
            measured: run.measured,
            clamped: anyClamp,
            reason: run.reason === "completed" && anyClamp ? "clamped" : run.reason,
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
    const single: Run = async (signal) => {
      const t0 = this.clock.now();
      const ev = until && makeEvaluator(until, this.readFn);
      const total: Record<string, Value> = {};
      const done = (reason: StopReason, anyClamp: boolean, ops: number): RuntimeResult => ({
        data: {
          requested,
          applied,
          measured: total,
          clamped: anyClamp,
          reason: reason === "completed" && anyClamp ? "clamped" : reason,
          ...(ops > 1 ? { chunks: ops } : {}),
          ms: Math.round(this.clock.now() - t0),
        },
      });
      if (ev && (await ev.poll()).met) return done("condition_met", clamped, 0);
      let args = { ...applied };
      let anyClamp = clamped;
      for (let ops = 1; ; ops++) {
        if (signal.aborted) return done("preempted", anyClamp, ops - 1);
        const child = new AbortController();
        linkAbort(signal, child);
        const wake = new AbortController();
        linkAbort(child.signal, wake);
        let why: "condition_met" | "timeout" | undefined;
        let pollError: unknown;
        let finished = false;
        const watcher = (async () => {
          while (!finished && !child.signal.aborted) {
            await this.clock.sleep(cmd.moves ? 50 : 250, wake.signal);
            if (finished || child.signal.aborted) return;
            if (this.clock.now() - t0 >= lim.max_command_ms + MAX_CHUNK_MS) {
              why = "timeout";
              child.abort();
              return;
            }
            if (!ev) continue;
            try {
              if ((await ev.poll()).met && !finished) {
                why = "condition_met";
                child.abort();
              }
            } catch (err) {
              pollError = err;
              child.abort();
            }
          }
        })();
        let res: CommandResult;
        try {
          res = await e.provider.command(e.spec.id, cmd.name, args, child.signal);
        } finally {
          finished = true;
          wake.abort();
          await watcher;
        }
        if (pollError) throw pollError;
        anyClamp ||= res.clamped;
        const m = res.measured ?? {};
        for (const [k, v] of Object.entries(m))
          total[k] =
            typeof v === "number" && typeof (total[k] ?? 0) === "number"
              ? ((total[k] as number | undefined) ?? 0) + v
              : v;
        if (signal.aborted) return done("preempted", anyClamp, ops);
        if (why && res.reason === "preempted") return done(why, anyClamp, ops);
        if (!(cmd.moves && res.reason === "timeout" && m.time_limited === true)) return done(res.reason, anyClamp, ops);
        if (this.clock.now() - t0 >= lim.max_command_ms) return done("timeout", anyClamp, ops);
        if (ev && (await ev.poll()).met) return done("condition_met", anyClamp, ops);
        const rest = { ...args };
        for (const [k, v] of Object.entries(args))
          if (typeof v === "number" && typeof m[k] === "number") rest[k] = v - (m[k] as number);
        args = rest;
      }
    };
    return cmd.moves ? moving(single) : single;
  }

  // ---------- stop / reset_fault ----------
  async stop(): Promise<{ motors_stopped: boolean }> {
    for (const c of this.inflight) c.abort();
    // Each provider gets its own announced worst case; one that takes longer counts as not stopped.
    const results = await Promise.all(
      [...this.local, ...this.remote].map(async (p) => {
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
    const src = isObj(a.program) ? a.program : a;
    const body = src.body;
    const success =
      src.success === undefined || src.success === null
        ? undefined
        : compileCondition(src.success, this.resolver, "success");
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
          ? new RuntimeError(err.code, `program ${c.path} (${c.tool}): ${err.message}`, err.retryable)
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
        return (
          await (ev ?? makeEvaluator(compileCondition(cond, this.resolver, `program ${path}`), this.readFn)).poll()
        ).met;
      } catch (err) {
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
        const e =
          err instanceof RuntimeError
            ? { code: err.code, message: err.message }
            : { code: "internal" as ErrorCode, message: String((err as Error)?.message ?? err) };
        record({ path, tool, ok: false, error: e, ms: ms() });
        throw new End("failed", `${path} (${tool}) failed: ${e.code}: ${e.message}`);
      }
      const reason =
        tool === "wait_until"
          ? ((data.reason as string | undefined) ?? (data.met ? "condition_met" : "timeout"))
          : String(data.reason);
      if (reason === "preempted") {
        record({ path, tool, ok: false, reason, ms: ms() });
        throw interrupted();
      }
      if (tool !== "wait_until" && (reason === "stalled" || reason === "timeout")) {
        record({ path, tool, ok: false, reason, ms: ms() });
        throw new End("failed", `${path} (${tool}) ended with reason ${reason}`);
      }
      record({ path, tool, ok: true, reason, ms: ms() });
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
    return { data: result };
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
      ...(this.providerErrors.length ? { provider_errors: this.providerErrors } : {}),
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
    try {
      await this.scan;
      this.relayActivity = ctx?.activity ?? "idle"; // plan() is synchronous, so this cannot interleave
      const run = this.plan(tool, args ?? {});
      if (!run.moves) return await run(ctl.signal);
      this.acting++;
      try {
        return await run(ctl.signal);
      } finally {
        this.acting--;
      }
    } catch (err) {
      if (err instanceof RuntimeError) throw err;
      const trace = Math.random().toString(36).slice(2, 10);
      throw rerr(
        "internal",
        `${tool} failed unexpectedly (trace_id ${trace}): ${String((err as Error)?.message ?? err)}`,
      );
    } finally {
      this.inflight.delete(ctl);
    }
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
