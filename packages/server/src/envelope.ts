// Envelope helpers (CONTRACT §7): typed errors, `next` suggestions, the call FSM table.

import { TOOLS, type ToolDef } from "../../protocol/tools.ts";
import type { Envelope, ErrorCode, ImagePayload, RobotStateView, ToolError } from "../../protocol/types.ts";
import { assertSupported } from "./schema.ts";

export const TOOL: ReadonlyMap<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]));
// fail at init if the catalog uses a schema keyword the validator would not enforce
for (const t of TOOLS) assertSupported(t.input, `tools.ts ${t.name}.input`);

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  "robot_offline",
  "busy",
  "timeout",
  "provider_stale",
  "stale_image",
  "rate_limited",
]);

/** A typed failure. Thrown inside the relay, turned into an error envelope at the edge. */
export class ToolFail extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retry_after_ms?: number,
    readonly retryable?: boolean,
  ) {
    super(message);
  }
  toError(): ToolError {
    return toolError(this.code, this.message, this.retry_after_ms, this.retryable);
  }
}
export const toolError = (
  code: ErrorCode,
  message: string,
  retry_after_ms?: number,
  retryable?: boolean,
): ToolError => ({
  code,
  message,
  retryable: retryable ?? RETRYABLE.has(code),
  ...(retry_after_ms !== undefined ? { retry_after_ms } : {}),
});

/** Asserts a transition against a contract table. Illegal → `illegal_state` naming the current state. */
export function assertTransition<S extends string>(
  fsm: string,
  table: Record<S, readonly S[]>,
  from: S,
  to: S,
  hint = "",
): void {
  if (!table[from].includes(to))
    throw new ToolFail(
      "illegal_state",
      `${fsm}: cannot go ${from} → ${to}; current state is ${from}, allowed next: ${table[from].join(", ") || "none"}.${hint ? ` ${hint}` : ""}`,
    );
}

const NEXT_OK: Record<string, string[]> = {
  list_robots: ["describe_robot"],
  describe_robot: ["read_all", "describe_device", "drive"],
  describe_device: ["read_device", "command_device"],
  read_device: ["read_all", "drive", "command_device"],
  read_all: ["drive", "turn", "command_device"],
  sample_device: ["read_device", "drive"],
  wait_until: ["read_all", "drive"],
  drive: ["read_all", "turn", "stop"],
  turn: ["read_all", "drive", "stop"],
  arc: ["read_all", "drive", "stop"],
  command_device: ["read_device", "read_all", "stop"],
  stop: ["read_all", "describe_robot"],
  reset_fault: ["read_all", "drive"],
  save_program: ["verify_program", "get_program"],
  list_programs: ["get_program", "run_program"],
  get_program: ["verify_program", "run_program"],
  verify_program: ["run_program", "get_program"],
  run_program: ["read_all", "stop"],
  retire_program: ["list_programs"],
  start_episode: ["drive", "mark_episode", "end_episode"],
  mark_episode: ["end_episode"],
  end_episode: ["start_episode", "save_program"],
  take_control: ["drive", "release_control"],
  release_control: ["list_robots"],
  stop_all: ["list_robots"],
};
const NEXT_ERR: Partial<Record<ErrorCode, string[]>> = {
  unauthorized: ["list_robots"],
  unknown_robot: ["list_robots"],
  unknown_device: ["describe_robot"],
  unknown_channel: ["describe_device"],
  unknown_command: ["describe_device"],
  unsupported: ["describe_robot"],
  robot_offline: ["list_robots"],
  busy: ["stop"],
  not_in_control: ["list_robots", "read_all"],
  illegal_state: ["list_robots"],
  fault: ["read_all", "reset_fault"],
  timeout: ["read_all", "stop"],
  stop_unverified: ["read_all", "reset_fault"],
  provider_stale: ["describe_robot"],
  stale_image: ["describe_robot"],
  program_not_runnable: ["get_program", "verify_program"],
  internal: ["list_robots"],
};

export function nextFor(tool: string, error?: ToolError): string[] {
  if (!error) return NEXT_OK[tool] ?? ["list_robots"];
  const base = NEXT_ERR[error.code] ?? [];
  // retryable and argument errors: the same tool is the obvious next step
  return error.retryable || error.code === "invalid_argument" ? [...new Set([tool, ...base])] : base;
}

/** What a tool call produces: the envelope (one text block) and, when an image channel was read, one image. */
export interface Out {
  envelope: Envelope<unknown>;
  image?: ImagePayload;
}
export const okOut = (tool: string, data: unknown, robot?: RobotStateView, image?: ImagePayload): Out => ({
  envelope: { ok: true, ...(robot ? { robot } : {}), data, next: nextFor(tool) },
  ...(image ? { image } : {}),
});
export const errOut = (tool: string, error: ToolError, robot?: RobotStateView): Out => ({
  envelope: { ok: false, ...(robot ? { robot } : {}), error, next: nextFor(tool, error) },
});
