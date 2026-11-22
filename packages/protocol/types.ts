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
}
export type BackendKind = "ev3" | "sim";

// ---------- Robot profile (§3) ----------
export interface Drivetrain {
  type: "differential";
  pair_device: string; // device exposing the `run_pair` command (EV3: synced motors B+C)
  wheel_diameter_cm: number;
  axle_track_cm: number;
  forward_sign: 1 | -1;
}
// The ONLY source of motion limits. Providers are constructed with these (no separate provider bounds for speed).
export interface Limits {
  max_speed_pct: number;
  max_command_ms: number;
  max_drive_cm: number;
  max_turn_deg: number;
  max_program_ms: number;
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
export type RobotActivity = "idle" | "acting" | "stopping" | "running_program" | "fault";
export const LINK_TRANSITIONS: Record<RobotLink, readonly RobotLink[]> = {
  offline: ["handshaking"],
  handshaking: ["online", "offline"],
  online: ["offline", "handshaking"],
};
export const ACTIVITY_TRANSITIONS: Record<RobotActivity, readonly RobotActivity[]> = {
  idle: ["acting", "running_program", "stopping", "fault"],
  acting: ["idle", "stopping", "fault"],
  running_program: ["idle", "stopping", "fault"],
  stopping: ["idle", "fault"],
  fault: ["idle", "stopping"],
};
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
  | "internal"
  | "misconfigured";
/** The codes a caller may send again as they are (CONTRACT §7). The one list: the runtime and the drivers read it. */
export const RETRYABLE: readonly ErrorCode[] = ["robot_offline", "busy", "timeout", "stale_image"];
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
      this.cause ??= from.cause ?? from;
    } else this.cause ??= from;
    return this;
  }
}
/** A short random id for one unexpected failure. Not a secret: it joins a message to a log line. */
export const newTraceId = (): string => Math.random().toString(36).slice(2, 10).padEnd(8, "0");
/** The stack of an error and of what caused it, for the log. */
export function stackOf(e: unknown): string {
  const parts: string[] = [];
  for (let at = e, depth = 0; at !== undefined && at !== null && depth < 4; depth++) {
    parts.push(at instanceof Error ? (at.stack ?? `${at.name}: ${at.message}`) : String(at));
    at = at instanceof Error ? at.cause : undefined;
  }
  return parts.join("\ncaused by: ");
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
