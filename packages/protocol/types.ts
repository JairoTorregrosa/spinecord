// Mirrors CONTRACT.md v3. Change CONTRACT.md first.
// Nothing here names a use case. Robots are bags of devices; devices describe themselves.

// ---------- Values and conditions ----------
export type Scalar = number | boolean | string;
export type Value = Scalar | number[] | string[];
export type CompareOp = "lt" | "lte" | "gt" | "gte" | "eq" | "neq" | "changed" | "contains"; // contains: vector channel includes value
export type Condition =
  | { device: string; channel: string; op: CompareOp; value?: Scalar } // `value` omitted only for "changed"; lt..gte numeric only
  | { any: Condition[] }
  | { all: Condition[] }
  | { not: Condition };

// ---------- Device model (§2) ----------
export type ChannelType = "number" | "boolean" | "string" | "vector" | "image";
export interface ChannelSpec {
  name: string;
  // Channels sharing a non-empty `mode_group` value cannot be read at the same time without a mode switch
  // (EV3 sensors). `active: false` = reading it needs a switch, which has side effects (e.g. gyro resets).
  mode_group?: string;
  active?: boolean;
  type: ChannelType;
  unit?: string; // SI-ish: cm, deg, deg_s, pct, v, lux, c, hz ...
  range?: [number, number];
  length?: number; // for vector
  max_rate_hz?: number; // fastest meaningful sampling
  // true = this channel may answer "nothing to report" (no beacon in view): a reading with value null and
  // `absent: true`. A condition takes that reading as "not met" and never as condition_unreadable; a null
  // without `absent` is a failed read on this channel too (CONTRACT §2.2).
  null_when_absent?: boolean;
  approx?: string; // honest note on accuracy, e.g. "IR proximity is ~0.7 cm per unit"
  // How far two readings of a scene that did not change can lie apart, in the channel's unit (number channels,
  // and each component of a numeric vector). A condition's `changed` takes a difference up to this as no change
  // (CONTRACT §4). Absent = the channel is exact: every difference is a change.
  noise?: number;
  // true = the device reports every change of this channel by itself (a page's touch button); a read is answered
  // from the latest value it reported, with that value's ts, at no round trip (CONTRACT §2.2).
  pushed?: boolean;
  description: string;
}
export type BoundKind = "degrees" | "ms" | "instant";
export interface CommandSpec {
  name: string;
  description: string;
  params: JsonSchema; // JSON Schema (object). The runtime validates args against it before anything is sent.
  // every listed param is capped at max. A command with moves false and kind "ms" may block up to max
  // (a speaker's speak): the runtime waits that long for its answer.
  bound: { kind: BoundKind; params?: string[]; max: number };
  moves: boolean; // true → one at a time per robot: it needs activity idle, and stop preempts it
  // Present on a command a loop may refresh every tick (CONTRACT §2, Loop outputs): `arg` is the numeric argument
  // the loop computes, `max_hold_ms` how long the device lets one refresh last; then it ends the effect itself.
  drives?: LoopDrives;
}
export interface DeviceSpec {
  id: string; // "<provider>.<local>", e.g. "ev3.B", "ev3.S3", "cam1.frame"
  provider: string; // the id of the provider that announced it: "ev3", "sim", ...
  kind: string; // open vocabulary; known kinds listed in CONTRACT.md §2.3
  roles: string[]; // aliases from the profile, e.g. ["left_wheel"]
  channels: ChannelSpec[];
  commands: CommandSpec[];
  description: string;
}
export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

// ---------- Provider interface (implemented by packages/driver-ev3, packages/driver-ev3dev and packages/sim-world) ----------
export type StopReason = "completed" | "condition_met" | "timeout" | "clamped" | "stalled" | "preempted";
// From a provider, `clamped` (and the reason "clamped") says the device cut a value of one operation. The runtime
// decides the reason of the whole call: "clamped" there means the target was cut short (CONTRACT §0.2).
export interface CommandResult {
  requested: Record<string, Value>;
  measured: Record<string, Value>;
  clamped: boolean;
  reason: StopReason;
  ms: number;
}
/** One argument the runtime cut to a limit: what was asked and what was sent. */
export interface Clamp {
  arg: string;
  requested: number;
  applied: number;
  /** true → the argument is the target of the command (a distance, an angle, a bound parameter): less was done than asked. */
  target: boolean;
}
// Image channels: value is null and `image` carries the frame (ts = capture time). Errors: value null + error.
export interface Reading {
  device: string;
  channel: string;
  value: Value | null;
  image?: ImagePayload;
  unit?: string;
  ts: number;
  error?: string;
  // The device answered, and its answer is "nothing to report" (value null, on a null_when_absent channel).
  // Absent on a null that comes from a failed read.
  absent?: true;
}
/** Serves calls in the order they were made (CONTRACT §4): a read issued just before a command observes the device before that command starts. */
export interface Provider {
  readonly id: string;
  readonly backend: BackendKind;
  devices(): Promise<DeviceSpec[]>;
  read(device: string, channels?: string[], opts?: { allow_mode_switch?: boolean }): Promise<Reading[]>;
  // read(): side-effect free. Channels that are not `active` come back as value null + error
  // "mode_switch_required" unless listed explicitly in `channels` AND opts.allow_mode_switch is true.
  // Executes exactly ONE bounded operation on the hardware, limited by TIME on the device itself
  // (≤ the command's bound and ≤ 250 ms of motion for chunkable motion commands). Providers never chunk;
  // the runtime is the only chunker. Motion commands accept `brake: boolean` (default true): false = coast
  // at the end so the runtime can chain chunks smoothly. Must resolve with reason "preempted" when aborted,
  // with the motion ended and `measured` covering what was done: the runtime also aborts an operation to end
  // a chunk on time while an `until` is active (CONTRACT §4).
  command(device: string, command: string, args: Record<string, Value>, signal: AbortSignal): Promise<CommandResult>;
  stop(): Promise<{ motors_stopped: boolean }>; // brake every actuator; verified = every motor reads speed 0
  readonly stop_worst_ms: number; // honest upper bound for stop() to resolve on this hardware
  // Optional: providers whose device set can change (hot-plug, a loaded world with other ports) call cb;
  // the runtime then re-reads devices().
  onDevicesChanged?(cb: () => void): () => void;
  // Optional: how this provider runs a loop (CONTRACT §4, §5a). Absent → a loop that names its devices is refused.
  readonly loop?: ProviderLoop;
}
/** One output refresh of a host loop's tick: the command with every argument but the one the loop computes, and that one. */
export interface LoopWrite {
  device: string;
  command: string;
  args: Record<string, Value>;
}
/** One input of a host loop's tick: a channel, and the component of a vector channel. */
export interface LoopRead {
  device: string;
  channel: string;
  index?: number;
}
/** What the device-side executor of a loop pushes while it runs. */
export type LoopEvent = { t: "report"; report: Partial<LoopReport> } | { t: "end"; end: LoopEnd };
/**
 * How a provider runs a loop. `host`: the runtime's executor ticks it, one exchange per tick. `device`: the device
 * runs the planned loop by itself and pushes telemetry and its end.
 */
export type ProviderLoop =
  | {
      runs_on: "host";
      /** The fastest rate a tick can be held at on this provider's link. */
      max_rate_hz: number;
      /**
       * One exchange with the hardware: refreshes every output, then reads every input, in that order, and resolves
       * with one value per read (null = no value). A refresh supersedes the refresh in flight on its device and
       * lasts on the device at most `hold_ms` (cut to the command's `drives.max_hold_ms`). The first tick claims the
       * written devices: `command` on them answers busy until `end`.
       */
      tick(writes: LoopWrite[], reads: LoopRead[], hold_ms: number): Promise<(number | null)[]>;
      /** Brakes the driven devices and releases them. */
      end(devices: string[]): Promise<void>;
    }
  | {
      runs_on: "device";
      max_rate_hz: number;
      start(
        plan: LoopPlan,
        on: (ev: LoopEvent) => void,
      ): Promise<{
        set(params: Record<string, number>, ramp_ms: number): Promise<void>;
        end(): Promise<void>;
        ended: Promise<LoopEnd>;
      }>;
    };
export type BackendKind = "ev3" | "sim" | "page";

// ---------- Robot profile (§3) ----------
export interface Drivetrain {
  type: "differential";
  pair_device: string; // device exposing the `run_pair` command (EV3: the synced pair the robot file declares)
  wheel_diameter_cm: number;
  axle_track_cm: number;
  forward_sign: 1 | -1;
  max_drive_cm: number; // longest distance of one drive or arc
  max_turn_deg: number; // largest angle of one turn or arc
  // The channel that measures rotation about the vertical axis, in degrees; `device` is a device id or a role.
  // Absent → the heading of a move comes from the wheel encoders. The runtime picks no heading device itself.
  heading?: { device: string; channel: string };
}
// The limits of every robot, with or without wheels. Providers are constructed with these (no separate provider
// bounds for speed). The distance and angle limits of a drivetrain move are fields of Drivetrain.
export interface Limits {
  max_speed_pct: number;
  max_command_ms: number;
  max_program_ms: number;
  max_loop_ms: number; // the longest life of one loop (CONTRACT §5a)
}
export interface RobotProfile {
  id: string;
  roles: Record<string, string>; // role → device id
  drivetrain?: Drivetrain; // absent → drive/turn/arc return `unsupported`
  limits: Limits;
  notes: string[]; // free-form facts for the model ("color sensor points down, 1 cm above floor")
}

// ---------- State machines (§1) ----------
export type RobotLink = "offline" | "handshaking" | "online";
export type RobotActivity = "idle" | "acting" | "stopping" | "running_program" | "looping" | "fault";
export const LINK_TRANSITIONS: Record<RobotLink, readonly RobotLink[]> = {
  offline: ["handshaking"],
  handshaking: ["online", "offline"],
  online: ["offline", "handshaking"],
};
export const ACTIVITY_TRANSITIONS: Record<RobotActivity, readonly RobotActivity[]> = {
  idle: ["acting", "running_program", "looping", "stopping", "fault"],
  acting: ["idle", "stopping", "fault"],
  running_program: ["idle", "stopping", "fault"],
  // a loop ends by the path of stop, whoever ends it (CONTRACT §1)
  looping: ["stopping", "fault"],
  stopping: ["idle", "fault"],
  fault: ["idle", "stopping"],
};

// ---------- Peripheral pages (§1 Page, §2.4) ----------
/** The life of one peripheral page in its robot, owned by apps/local. */
export type PageState = "announced" | "active" | "asleep" | "gone";
export const PAGE_TRANSITIONS: Record<PageState, readonly PageState[]> = {
  announced: ["active", "asleep"],
  active: ["asleep"],
  // announced again: a page joins under the name of one whose socket closed, and takes its place
  asleep: ["active", "announced", "gone"],
  gone: [],
};
/** A device as a page declares it: a DeviceSpec without `provider`, with an id local to the page. */
export type PageDevice = Omit<DeviceSpec, "provider">;
/** What a page tried to offer and could not, with the reason in plain words. */
export interface PageUnavailable {
  kind: string;
  why: string;
}
/** The result of one command as a page reports it; the hub adds `requested` and `ms`. */
export interface PageCommandResult {
  measured: Record<string, Value>;
  reason: StopReason;
  clamped?: boolean;
}
/** Every message a page sends as text. An image reading's `res` is followed by one binary message of `image.bytes`. */
export type PageToServer =
  | {
      t: "hello";
      v: 1;
      token: string;
      robot?: string;
      name: string;
      devices: PageDevice[];
      unavailable?: PageUnavailable[];
    }
  | { t: "devices"; devices: PageDevice[]; unavailable?: PageUnavailable[] }
  | {
      t: "res";
      id: number;
      ok: true;
      readings?: Record<string, Value | null>;
      result?: PageCommandResult;
      image?: { channel: string; mime: ImagePayload["mime"]; bytes: number; age_ms: number };
    }
  | { t: "res"; id: number; ok: false; error: { code: ErrorCode; message: string } }
  | { t: "state"; device: string; values: Record<string, Scalar | null>; ts?: number }
  | { t: "pong"; n: number; visible?: boolean }
  | { t: "down"; device: string; why: string }
  | { t: "up"; device: string }
  | { t: "paused"; why?: string }
  | { t: "resumed" };
/** Every message the process sends to a page. */
export type ServerToPage =
  | { t: "welcome"; name: string; robot: string }
  | { t: "req"; id: number; op: "read"; device: string; channels: string[] }
  | {
      t: "req";
      id: number;
      op: "command";
      device: string;
      command: string;
      args: Record<string, Value>;
      deadline_ms: number;
    }
  | { t: "req"; id: number; op: "abort"; of: number }
  | { t: "req"; id: number; op: "stop" }
  | { t: "ping"; n: number };
/** Close codes of the page socket (CONTRACT §2.4). */
export const PAGE_CLOSE = {
  bad_message: 4000,
  bad_token: 4001,
  unknown_robot: 4004,
  name_taken: 4009,
  manifest_refused: 4010,
  too_many: 4029,
} as const;

export interface RobotStateView {
  id: string;
  backend: BackendKind | null;
  link: RobotLink;
  activity: RobotActivity;
}

// ---------- Programs (§5) ----------
export type ProgramNode =
  | { seq: ProgramNode[] }
  | { repeat: { times: number; body: ProgramNode } } // times ≤ 50
  | { while: { cond: Condition; body: ProgramNode; max_iterations: number } } // ≤ 200
  | { if: { cond: Condition; then: ProgramNode; else?: ProgramNode } }
  | { call: { tool: "drive" | "turn" | "arc" | "command_device" | "wait_until"; args: Record<string, unknown> } }
  | { wait_ms: number } // ≤ 10000
  | { fail: string }
  | { succeed: string };

// ---------- Envelope (§7) ----------
// The members are the `code` enum of every tool's output schema (tools.ts).
export type ErrorCode =
  | "unknown_robot"
  | "unknown_device"
  | "unknown_channel"
  | "unknown_command"
  | "unsupported"
  | "robot_offline"
  | "busy"
  | "illegal_state"
  | "invalid_argument"
  | "fault"
  | "timeout"
  | "stop_unverified"
  | "stale_image"
  | "condition_unreadable"
  | "device_offline"
  | "internal"
  | "misconfigured";
/** The codes a caller may send again as they are (CONTRACT §7). The one list: the runtime and the drivers read it. */
export const RETRYABLE: readonly ErrorCode[] = ["robot_offline", "busy", "timeout", "stale_image", "device_offline"];
export interface ToolError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retry_after_ms?: number;
  /** What a move had done when the error ended it; the robot was stopped there. */
  measured?: Record<string, Value>;
}
export type Envelope<T> =
  | { ok: true; robot?: RobotStateView; data: T; next: string[] }
  | { ok: false; robot?: RobotStateView; error: ToolError; next: string[] };

// ---------- Runtime (§4): runs in the process that holds the providers ----------
// The runtime executes the tools that address one robot, so `until` conditions and programs react in
// milliseconds. The process around it (apps/local) owns the link and activity state of the robot.
export type RobotTool =
  | "describe_robot"
  | "describe_device"
  | "read_device"
  | "read_all"
  | "sample_device"
  | "wait_until"
  | "drive"
  | "turn"
  | "arc"
  | "command_device"
  | "reset_fault"
  | "run_program";
export interface ImagePayload {
  mime: "image/jpeg" | "image/png";
  b64: string;
  age_ms: number;
}
/** An unexpected failure, for the process's log (CONTRACT §6): the id its message carries, and where it came from. */
export interface InternalFailure {
  trace_id: string;
  message: string;
  stack?: string;
}
export interface RuntimeResult {
  data: unknown;
  image?: ImagePayload;
  /** A moving operation was sent to a device during the call. Never part of the envelope: the call log has it. */
  moved?: boolean;
  /** Unexpected failures the call answered as data (a program step that failed with `internal`). For the log only. */
  internal?: InternalFailure[];
}
export class RuntimeError extends Error {
  /** The tools that fix this error, in order; the envelope's `next` starts with them (CONTRACT §7). */
  next?: string[];
  /** Names an `internal` error: the message carries it, and the process logs the stack under it (CONTRACT §6). */
  trace_id?: string;
  /** A moving operation was sent to a device before the call failed. */
  moved?: boolean;
  /** How long a caller should wait before sending the call again (a busy device, a page that sleeps). */
  retry_after_ms?: number;
  constructor(
    public code: ErrorCode,
    message: string,
    public retryable = false,
    /** What a move had done when this error ended it (the robot was stopped there). */
    public measured?: Record<string, Value>,
  ) {
    super(message);
  }
  /** Takes over what `from` knew beyond code and message. For an error built from another one. */
  from(from: unknown): this {
    if (from instanceof RuntimeError) {
      this.next ??= from.next;
      this.trace_id ??= from.trace_id;
      this.moved ??= from.moved;
      // a wait before sending again belongs to an error that may be sent again
      if (this.retryable) this.retry_after_ms ??= from.retry_after_ms;
      this.cause ??= from.cause ?? from;
    } else this.cause ??= from;
    return this;
  }
}
/** A short random id for one unexpected failure. Not a secret: it joins a message to a log line. */
export const newTraceId = (): string => Math.random().toString(36).slice(2, 10).padEnd(8, "0");
/** The stack of an error for the log, starting at what first went wrong: its cause comes before the error built from it. */
export function stackOf(e: unknown): string {
  const parts: string[] = [];
  for (let at = e, depth = 0; at !== undefined && at !== null && depth < 4; depth++) {
    parts.unshift(at instanceof Error ? (at.stack ?? `${at.name}: ${at.message}`) : String(at));
    at = at instanceof Error ? at.cause : undefined;
  }
  return parts.join("\nreported as: ");
}
export interface Runtime {
  profile(): RobotProfile;
  devices(): DeviceSpec[];
  call(
    tool: RobotTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
    ctx?: { activity: RobotActivity },
  ): Promise<RuntimeResult>;
  stop(): Promise<{ motors_stopped: boolean }>;
}

// ---------- Loops (§5a) ----------
// A loop is a control law given as data. validate.ts owns its validation, loop.ts owns the law.
/** A number, or the name of a param of the loop. */
export type LoopNumber = number | string;
/** The part of a signal a term or a guard looks at. */
export type SignalPart = "value" | "integral" | "derivative";
export interface LoopSignal {
  device: string; // device id or role
  channel: string;
  index?: number; // the component of a numeric vector channel
  zero?: "start" | { mean_ms: number };
  detrend_s?: number;
  smooth_ms?: number;
}
export type Term =
  // feedback on one part of one signal; `of` defaults to "value", `setpoint` to 0
  | { signal: string; of?: SignalPart; setpoint?: LoopNumber; gain: LoopNumber; clamp?: number }
  // feedforward: gain × `feed`; `gain` defaults to 1
  | { feed: LoopNumber; gain?: LoopNumber };
export interface LoopOutput {
  device: string;
  command: string;
  args?: Record<string, Value>; // the command's other arguments, the same on every refresh
  terms: Term[];
  limit?: [number, number];
}
export type GuardOp = "gt" | "lt" | "abs_gt";
export interface Guard {
  name: string;
  signal: string;
  of?: SignalPart; // default "value"
  op: GuardOp;
  value: number;
  for_ms?: number;
}
export interface LoopSpec {
  rate_hz: number;
  duration_ms: number;
  attention_ms?: number; // default 15000
  signals: Record<string, LoopSignal>;
  params?: Record<string, number>;
  outputs: LoopOutput[];
  guards?: Guard[];
  trace_hz?: number; // default 10, at most 20
}
export type LoopEndReason =
  | "completed"
  | "guard"
  | "preempted"
  | "unattended"
  | "overrun"
  | "input_lost"
  | "not_still"
  | "timeout";
export interface LoopEnd {
  reason: LoopEndReason;
  guard?: string; // the guard's name, with reason "guard"
}
/** What makes a command a loop output: the numeric argument a loop refreshes, and how long one refresh may last. */
export interface LoopDrives {
  arg: string;
  max_hold_ms: number;
}
/**
 * A loop checked against the robot and ready to run: every default filled in, each output with the argument it
 * drives, its hold time and its bounds. Devices are named by their ids, whatever the spec called them.
 * It is plain JSON (finite numbers, arrays in a stated order), so an executor on a device takes it as it is.
 */
export interface LoopPlan {
  rate_hz: number;
  period_ms: number; // 1000 / rate_hz
  duration_ms: number; // after the cut to the robot's limit
  attention_ms: number;
  trace_hz: number;
  /** In the order of the spec's `signals`: the order of a tick's inputs. */
  signals: {
    name: string;
    device: string;
    channel: string;
    index?: number;
    zero: "none" | "start" | "mean";
    mean_ms: number; // 0 unless zero is "mean"
    noise: number; // the channel's declared noise, 0 for an exact channel
    detrend_s: number; // 0 = no detrend
    smooth_ms: number; // 0 = no smoothing
  }[];
  params: Record<string, number>;
  /** In the order of the spec's `outputs`. */
  outputs: {
    device: string;
    command: string;
    arg: string; // the argument a tick refreshes
    args: Record<string, Value>;
    hold_ms: number; // how long the device lets one refresh last
    min: number; // the output's bounds: `limit` cut to the range of `arg`
    max: number;
    terms: Term[];
  }[];
  guards: Guard[];
  /** What planning cut, as for a command (§0.2). */
  clamps: Clamp[];
  notes: string[];
}
export interface LoopReport {
  state: "running" | "ended";
  reason?: LoopEndReason;
  guard?: string;
  runs_on: "host" | "device";
  rate_hz: number;
  age_ms: number;
  remaining_ms: number;
  ticks: number;
  overruns: number;
  period_ms: { p50: number; p95: number; max: number };
  signals: Record<string, LoopSignalStats>;
  outputs: LoopOutputStats[];
  params: Record<string, number>;
  trace: LoopTrace;
  notes?: string[];
}
export interface LoopSignalStats {
  last: number;
  min: number;
  max: number;
  mean: number;
  integral: number;
  derivative: number;
}
export interface LoopOutputStats {
  device: string;
  command: string;
  last: number;
  min: number;
  max: number;
  mean_abs: number;
  saturated_pct: number;
}
/** `t_ms`, one array per signal name, and `out<i>` per output; all of the same length, at most 200. */
export type LoopTrace = { t_ms: number[] } & Record<string, number[]>;
