// Mirrors CONTRACT.md v2. Change CONTRACT.md first.
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
  approx?: string; // honest note on accuracy, e.g. "IR proximity is ~0.7 cm per unit"
  description: string;
}
export type BoundKind = "degrees" | "ms" | "instant";
export interface CommandSpec {
  name: string;
  description: string;
  params: JsonSchema; // JSON Schema (object). Validated by the relay before dispatch.
  // every listed param is capped at max; relay rejects manifests without a bound. A command with moves false and
  // kind "ms" may block up to max (a speaker's speak): runtime and relay wait that long for its answer.
  bound: { kind: BoundKind; params?: string[]; max: number };
  moves: boolean; // true → subject to activity FSM, control, stop, rate limit
}
export interface DeviceSpec {
  id: string; // "<provider>.<local>", e.g. "ev3.B", "ev3.S3", "cam1.frame"
  provider: string; // "ev3", "sim", or an organ_id
  kind: string; // open vocabulary; known kinds listed in CONTRACT.md §2.2
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

// ---------- Provider interface (implemented by packages/driver-ev3, packages/driver-ev3dev and packages/sim-world; organs speak it over the wire) ----------
export type StopReason = "completed" | "condition_met" | "timeout" | "clamped" | "stalled" | "preempted";
export interface CommandResult {
  requested: Record<string, Value>;
  measured: Record<string, Value>;
  clamped: boolean;
  reason: StopReason;
  ms: number;
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
}
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
  // the runtime then re-reads devices() and announces {t:"devices"} to the relay.
  onDevicesChanged?(cb: () => void): () => void;
}
export type BackendKind = "ev3" | "sim" | "organ";

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
export type Control = "owner" | "admin"; // owner = the principal(s) the robot is assigned to
export type CallState =
  | "received"
  | "rejected"
  | "deduplicated"
  | "queued"
  | "dispatched"
  | "completed"
  | "failed"
  | "timed_out"
  | "preempted";
export type EpisodeState = "none" | "running" | "ended";
export type ProviderState = "announced" | "active" | "stale" | "gone";
export type ProgramState = "draft" | "verified" | "needs_review" | "approved" | "retired";

export const CALL_TERMINAL: readonly CallState[] = [
  "rejected",
  "deduplicated",
  "completed",
  "failed",
  "timed_out",
  "preempted",
];
export const CALL_TRANSITIONS: Record<CallState, readonly CallState[]> = {
  received: ["rejected", "deduplicated", "queued", "dispatched"],
  queued: ["dispatched", "preempted", "timed_out", "failed"],
  dispatched: ["completed", "failed", "timed_out", "preempted"],
  rejected: [],
  deduplicated: [],
  completed: [],
  failed: [],
  timed_out: [],
  preempted: [],
};
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
export const CONTROL_TRANSITIONS: Record<Control, readonly Control[]> = { owner: ["admin"], admin: ["owner"] };
export const EPISODE_TRANSITIONS: Record<EpisodeState, readonly EpisodeState[]> = {
  none: ["running"],
  running: ["ended"],
  ended: ["running"],
};
export const PROVIDER_TRANSITIONS: Record<ProviderState, readonly ProviderState[]> = {
  announced: ["active", "gone"],
  active: ["stale", "gone"],
  stale: ["active", "gone"],
  gone: [],
};
export const PROGRAM_TRANSITIONS: Record<ProgramState, readonly ProgramState[]> = {
  draft: ["verified", "needs_review", "retired"],
  needs_review: ["approved", "retired"],
  verified: ["retired"],
  approved: ["retired"],
  retired: [],
};

export interface RobotStateView {
  id: string;
  backend: BackendKind | null;
  link: RobotLink;
  activity: RobotActivity;
  control: Control;
  episode: EpisodeState;
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
export interface Program {
  name: string;
  version: number;
  description: string;
  body: ProgramNode;
  success?: Condition; // checked after body; absent → "completed" counts as success
  requires: string[]; // device kinds or roles it touches (computed on save)
  pass_rate: number; // default 0.8
  state: ProgramState;
  success_rate?: number;
  verified_on?: { twin_id: string; profile_hash: string; at: number }; // hardware run requires robot.profile_hash === profile_hash
  author: string; // principal_id
}

// ---------- Episodes (§6) ----------
export interface EpisodeSummary {
  id: string;
  robot_id: string;
  label: string;
  tags: string[];
  state: EpisodeState;
  started_at: number;
  ended_at?: number;
  elapsed_ms: number;
  calls: number;
  moving_calls: number;
  stops: number;
  errors: number;
  marks: { at: number; kind: string; note: string }[];
  outcome?: string;
  metrics?: Record<string, number>;
}

// ---------- Envelope (§7) ----------
export type ErrorCode =
  | "unauthorized"
  | "unknown_robot"
  | "unknown_device"
  | "unknown_channel"
  | "unknown_command"
  | "unsupported"
  | "robot_offline"
  | "busy"
  | "not_in_control"
  | "illegal_state"
  | "invalid_argument"
  | "fault"
  | "timeout"
  | "stop_unverified"
  | "provider_stale"
  | "stale_image"
  | "program_not_runnable"
  | "rate_limited"
  | "internal"
  | "misconfigured";
export interface ToolError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retry_after_ms?: number;
}
export type Envelope<T> =
  | { ok: true; robot?: RobotStateView; data: T; next: string[] }
  | { ok: false; robot?: RobotStateView; error: ToolError; next: string[] };

// ---------- Runtime (§4): runs next to the hardware (robot page or headless runner) ----------
// The runtime executes robot-local tools so that `until` conditions and programs react in milliseconds,
// not relay round trips. The relay owns auth, FSMs, idempotency, episodes and the program library.
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
export interface RuntimeResult {
  data: unknown;
  image?: ImagePayload;
}
export class RuntimeError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
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

// ---------- Wire protocol (§8) ----------
// Robot runtime <-> relay at /ws/robot
export type RuntimeToRelay =
  | {
      t: "hello";
      v: 2;
      robot_id: string;
      token: string;
      backend: BackendKind;
      profile: RobotProfile;
      profile_hash: string;
      devices: DeviceSpec[];
      stop_worst_ms: number;
      fw?: string;
    }
  | { t: "result"; call_id: string; ok: true; data: unknown; image?: ImagePayload }
  | { t: "result"; call_id: string; ok: false; error: { code: ErrorCode; message: string; retryable?: boolean } }
  | { t: "devices"; devices: DeviceSpec[] }
  // organ_res.data by op: read → Reading[], command → CommandResult, stop → { motors_stopped: boolean }
  | {
      t: "organ_req";
      req_id: string;
      organ_id: string;
      op: "read" | "command" | "stop";
      device?: string;
      channels?: string[];
      allow_mode_switch?: boolean;
      command?: string;
      args?: Record<string, Value>;
    }
  | { t: "stopped"; stop_id: string; motors_stopped: boolean } // reply to {t:"stop", stop_id}
  // battery_low = any device of kind battery reports low=true. echo = the `ts` of the last relay heartbeat and how
  // long the runtime held it before this frame: the relay measures the round trip as now - echo.ts - echo.held_ms.
  | { t: "hb"; ts: number; battery_low?: boolean; fault?: string; echo?: { ts: number; held_ms: number } };
export type RelayToRuntime =
  | { t: "welcome"; session_id: string }
  // deadline_ms is a duration and a backstop, never the limit: it is the tool's own budget (max_command_ms,
  // max_program_ms, timeout_ms, duration_ms) plus a margin for the round trip and a verified stop, so the runtime's
  // own limit ends the call first and answers with data (reason "timeout", met:false, the samples).
  // activity = relay-owned state when dispatched; the runtime allows mode-switching reads only when "idle".
  | {
      t: "call";
      call_id: string;
      tool: RobotTool;
      args: Record<string, unknown>;
      deadline_ms: number;
      activity: RobotActivity;
    }
  | { t: "abort"; call_id: string }
  | { t: "stop"; stop_id: string }
  | { t: "organs"; organs: { organ_id: string; state: ProviderState; devices: DeviceSpec[] }[] }
  | {
      t: "organ_res";
      req_id: string;
      ok: boolean;
      data?: unknown;
      image?: ImagePayload;
      error?: { code: ErrorCode; message: string };
    }
  | { t: "hb"; ts: number };
// Organ = any external device provider (phone page, microcontroller, webcam) <-> relay at /ws/organ
export type OrganToRelay =
  | { t: "hello"; v: 2; robot_id: string; token: string; organ_id: string; devices: DeviceSpec[] }
  | { t: "devices"; devices: DeviceSpec[] }
  | { t: "res"; req_id: string; ok: true; data: unknown; image?: ImagePayload }
  | { t: "res"; req_id: string; ok: false; error: { code: ErrorCode; message: string } }
  | { t: "hb"; ts: number };
export type RelayToOrgan =
  | { t: "welcome"; session_id: string }
  | {
      t: "req";
      req_id: string;
      op: "read" | "command" | "stop";
      device?: string;
      channels?: string[];
      allow_mode_switch?: boolean;
      command?: string;
      args?: Record<string, Value>;
    }
  | { t: "stop" }
  | { t: "hb"; ts: number };
