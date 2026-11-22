// One tool call, from arguments to the CONTRACT §7 envelope. The catalog is protocol's TOOLS, served
// verbatim; the work is the runtime's; this file validates the arguments, finds the robot and wraps the answer.
import { firstViolation, assertSupported } from "../../../packages/protocol/schema";
import { TOOLS, type ToolDef } from "../../../packages/protocol/tools";
import {
  RuntimeError,
  newTraceId,
  stackOf,
  type InternalFailure,
  type ErrorCode,
  type ImagePayload,
  type Envelope,
  type ToolError,
} from "../../../packages/protocol/types";
import { LocalError, shuttingDown, type LocalRobot } from "./robot";

export const TOOL: ReadonlyMap<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]));
// fail at start if the catalog uses a schema keyword the validator would not enforce
for (const t of TOOLS) assertSupported(t.input, `tool ${t.name}.input`);

/** The tools that need a drivetrain: a robot without one is never pointed at them. */
const DRIVETRAIN_TOOLS = ["drive", "turn", "arc"];
/** Suggested next tools after a success. Every name is a served tool (tested). */
export const NEXT_OK: Record<string, string[]> = {
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
  run_program: ["read_all", "stop"],
};
export const NEXT_ERR: Partial<Record<ErrorCode, string[]>> = {
  unknown_robot: ["list_robots"],
  unknown_device: ["describe_robot"],
  unknown_channel: ["describe_device"],
  unknown_command: ["describe_device"],
  unsupported: ["describe_robot"],
  robot_offline: ["list_robots"],
  // the call in flight ends by itself: look first, and stop only to end it early
  busy: ["read_all", "stop"],
  // reset_fault outside fault: the robot needs no reset, it takes every other tool
  illegal_state: ["read_all"],
  fault: ["read_all", "reset_fault"],
  timeout: ["read_all", "stop"],
  stop_unverified: ["read_all", "reset_fault"],
  stale_image: ["describe_robot"],
  condition_unreadable: ["read_all", "describe_device"],
  internal: ["list_robots"],
};
function next(tool: string, error?: ToolError, afterMove = false, fix: string[] = []): string[] {
  if (!error) return NEXT_OK[tool] ?? ["list_robots"];
  const base = NEXT_ERR[error.code] ?? [];
  // a move that had started: look at the robot first, never send the move again blindly
  if (afterMove) return [...new Set(["read_all", ...base])];
  // retryable and argument errors: the same tool is the obvious next step, after the tools that fix the error
  const same = (error.retryable || error.code === "invalid_argument") && TOOL.has(tool) ? [tool] : [];
  return [...new Set([...fix.filter((t) => TOOL.has(t)), ...same, ...base])];
}

/** `next` after a success on this robot: without a drivetrain it names no drivetrain tool (CONTRACT §3). */
function nextFor(robot: LocalRobot, tool: string): string[] {
  const all = next(tool);
  if (robot.runtime()?.profile().drivetrain) return all;
  const kept = all.filter((t) => !DRIVETRAIN_TOOLS.includes(t));
  return kept.includes("command_device") || !all.some((t) => DRIVETRAIN_TOOLS.includes(t))
    ? kept
    : [...kept, "command_device"];
}

export interface Out {
  envelope: Envelope<unknown>;
  image?: ImagePayload;
  /** For the call log (CONTRACT §6): a moving operation was sent to the robot, or may have been. */
  moved: boolean;
  /** For the call log: the unexpected failures behind this answer, each under the trace id its message carries. */
  internal: InternalFailure[];
}
const fail = (
  tool: string,
  error: ToolError,
  robot?: LocalRobot,
  more: { afterMove?: boolean; fix?: string[]; moved?: boolean; internal?: InternalFailure[] } = {},
): Out => ({
  envelope: {
    ok: false,
    ...(robot ? { robot: robot.view() } : {}),
    error,
    next: next(tool, error, more.afterMove, more.fix),
  },
  moved: more.moved ?? false,
  internal: more.internal ?? [],
});

/** `cancel`: the client's cancellation of this call (MCP notifications/cancelled). */
export async function callTool(
  robots: readonly LocalRobot[],
  name: string,
  args: unknown,
  cancel?: AbortSignal,
): Promise<Out> {
  const def = TOOL.get(name);
  if (!def)
    return fail(name, {
      code: "invalid_argument",
      message: `Unknown tool "${name}". Tools: ${[...TOOL.keys()].join(", ")}.`,
      retryable: false,
    });
  const input = (args ?? {}) as Record<string, unknown>;
  const violation = firstViolation(def.input, input);
  if (violation) return fail(name, { code: "invalid_argument", message: `${name}: ${violation}`, retryable: false });
  if (robots.some((r) => r.shuttingDown)) {
    const e = shuttingDown();
    return fail(name, { code: e.code, message: e.message, retryable: false });
  }
  if (name === "list_robots")
    return {
      envelope: { ok: true, data: { robots: robots.map((r) => r.listing()) }, next: next(name) },
      moved: false,
      internal: [],
    };
  const robot = robots.find((r) => r.id === input.robot_id);
  if (!robot)
    return fail(name, {
      code: "unknown_robot",
      message: `No robot "${String(input.robot_id)}" here. Robots: ${robots.map((r) => r.id).join(", ")}.`,
      retryable: false,
    });
  try {
    const { robot_id: _robot, request_id: _label, ...rest } = input;
    const result = await robot.call(name, rest, cancel);
    return {
      envelope: { ok: true, robot: robot.view(), data: result.data, next: nextFor(robot, name) },
      ...(result.image ? { image: result.image } : {}),
      moved: result.moved === true,
      internal: result.internal ?? [],
    };
  } catch (e) {
    // not a contract error: a bug here. The message carries it; nothing is hidden behind a default.
    const typed =
      e instanceof RuntimeError
        ? e
        : new RuntimeError("internal", `${name} failed unexpectedly: ${String((e as Error)?.message ?? e)}`).from(e);
    // every internal error has a trace id in its message, and the log has its stack under that id
    const internal: InternalFailure[] = [];
    if (typed.code === "internal") {
      const fresh = typed.trace_id === undefined;
      typed.trace_id ??= newTraceId();
      const message = fresh ? `${typed.message} (trace_id ${typed.trace_id})` : typed.message;
      internal.push({ trace_id: typed.trace_id, message, stack: stackOf(typed) });
      typed.message = message;
    }
    const afterMove = typed instanceof LocalError && typed.afterMove;
    const error: ToolError = {
      code: typed.code,
      message: typed.message,
      retryable: typed.retryable,
      ...(typed instanceof LocalError && typed.retry_after_ms !== undefined
        ? { retry_after_ms: typed.retry_after_ms }
        : {}),
      ...(typed.measured ? { measured: typed.measured } : {}),
    };
    // a call the backstop ended never said what it sent: it counts as moved
    return fail(name, error, robot, { afterMove, fix: typed.next, moved: typed.moved ?? afterMove, internal });
  }
}

const FACTS = ["reason", "outcome", "met", "motors_stopped", "activity"];
const LISTS = ["robots", "readings", "samples", "steps"];
const MAX_MESSAGE = 200;
/** Line 1 of the text block: what happened, for a reader that does not parse the JSON below it. Never a newline. */
export function summarize(tool: string, e: Envelope<unknown>): string {
  const robot = e.robot ? ` robot=${e.robot.id} link=${e.robot.link} activity=${e.robot.activity}` : "";
  const after = e.next.length ? ` next=${e.next.join(",")}` : "";
  let what = "";
  if (!e.ok) {
    const m = e.error.message;
    what = ` ${e.error.code}${e.error.retryable ? " (retryable)" : ""}: ${m.length > MAX_MESSAGE ? `${m.slice(0, MAX_MESSAGE)}…` : m}`;
  } else if (typeof e.data === "object" && e.data !== null) {
    const d = e.data as Record<string, unknown>;
    what =
      FACTS.filter((k) => ["string", "number", "boolean"].includes(typeof d[k]))
        .map((k) => ` ${k}=${String(d[k])}`)
        .join("") +
      LISTS.filter((k) => Array.isArray(d[k]))
        .map((k) => ` ${k}=${(d[k] as unknown[]).length}`)
        .join("") +
      // a note changes what the reason means (e.g. a target below the smallest move: completed, nothing moved)
      (typeof d.note === "string"
        ? ` note: ${d.note.length > MAX_MESSAGE ? `${d.note.slice(0, MAX_MESSAGE)}…` : d.note}`
        : "");
  }
  return `${tool} ${e.ok ? "ok" : "error"}${what}${robot}${after}`.replace(/\s+/g, " ");
}
