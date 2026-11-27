// The MCP surface over stdio: protocol's TOOLS through the low-level Server, so the JSON Schemas pass
// unchanged. Every result is the envelope as structuredContent plus a text block (summary line, then the same JSON).
// Every call writes one line to stderr (CONTRACT §6, "Call log").
import { Server } from "@modelcontextprotocol/server";
import { SERVER_INSTRUCTIONS, TOOLS, SERVER_NAME, SERVER_VERSION } from "../../../packages/protocol/tools";
import { firstViolation } from "../../../packages/protocol/schema";
import { newTraceId, stackOf, type Envelope, type InternalFailure } from "../../../packages/protocol/types";
import type { LocalRobot } from "./robot";
import { log } from "./stderr";
import { TOOL, callTool, summarize, type Out } from "./tools";

export const LISTED_TOOLS = TOOLS.map((t) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: t.input,
  outputSchema: t.output,
  annotations: t.annotations,
}));

/** Longest text a log line takes from a caller or from an error: names are short, a stack is cut. */
export const LOG_NAME_MAX = 64;
export const LOG_STACK_MAX = 4000;
const short = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  return v.length > max ? `${v.slice(0, max)}…` : v;
};
/** The one argument the log takes from a call: which robot it addressed. */
const robotOf = (args: unknown): string | null =>
  short(
    typeof args === "object" && args !== null ? (args as { robot_id?: unknown }).robot_id : undefined,
    LOG_NAME_MAX,
  );

/** One line of the call log: what a call was and how it ended. Never its arguments, its data or an image. */
export interface CallLine {
  ts: string;
  tool: string | null;
  robot_id: string | null;
  ok: boolean;
  code: string | null;
  reason: string | null;
  ms: number;
  trace_id: string | null;
  moved: boolean;
}
/**
 * The call-log line of one answered call. `reason` is the result's own `reason` (why a move or a wait ended);
 * run_program gives its `outcome` there, since its `reason` is free text.
 */
export function callLine(
  tool: unknown,
  args: unknown,
  envelope: Envelope<unknown>,
  ms: number,
  moved: boolean,
  trace_id: string | null,
): CallLine {
  const data = envelope.ok && typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
  const d = data as { reason?: unknown; outcome?: unknown };
  return {
    ts: new Date().toISOString(),
    tool: short(tool, LOG_NAME_MAX),
    robot_id: robotOf(args),
    ok: envelope.ok,
    code: envelope.ok ? null : envelope.error.code,
    reason: short(typeof d.outcome === "string" ? d.outcome : d.reason, LOG_NAME_MAX),
    ms: Math.round(ms),
    trace_id,
    moved,
  };
}
/**
 * Writes what one answered call leaves in the log: an `internal` line per unexpected failure behind it, with
 * the stack, then its `call` line. `broken` is a failure of this layer (the result did not match its schema):
 * the call is then logged as the internal error the client gets.
 */
export function logCall(
  tool: unknown,
  args: unknown,
  out: Pick<Out, "envelope" | "moved" | "internal">,
  ms: number,
  broken?: InternalFailure,
  write: typeof log = log,
): void {
  const failures = broken ? [...out.internal, broken] : out.internal;
  for (const f of failures)
    write("internal", {
      ts: new Date().toISOString(),
      trace_id: f.trace_id,
      tool: short(tool, LOG_NAME_MAX),
      robot_id: robotOf(args),
      message: short(f.message, LOG_STACK_MAX),
      stack: short(f.stack ?? "", LOG_STACK_MAX),
    });
  const line = callLine(tool, args, out.envelope, ms, out.moved, failures.at(-1)?.trace_id ?? null);
  write("call", { ...(broken ? { ...line, ok: false, code: "internal", reason: null } : line) });
}

/** Longest argument text a watcher gets from one call. */
export const WATCH_ARGS_MAX = 600;
/**
 * Someone who watches the calls as they happen (the 3D view shows them next to the twin). It gets each call when
 * it begins, with its arguments cut to WATCH_ARGS_MAX characters of JSON, and when it ends, with its summary line.
 * A watcher that throws changes nothing of the call.
 */
export interface CallWatcher {
  callStarted(call: { n: number; tool: string; robot_id: string | null; args: string }): void;
  callEnded(call: {
    n: number;
    tool: string;
    robot_id: string | null;
    ok: boolean;
    code: string | null;
    summary: string;
    ms: number;
  }): void;
}

export function buildServer(robots: readonly LocalRobot[], watcher?: CallWatcher): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  server.setRequestHandler("tools/list", async () => ({ tools: LISTED_TOOLS as never }));
  let calls = 0;
  const watch = (f: (w: CallWatcher) => void): void => {
    if (!watcher) return;
    try {
      f(watcher);
    } catch {
      // a watcher is a display: what it does never changes the call
    }
  };
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const name = request.params.name;
    const args = request.params.arguments;
    const n = ++calls;
    const robot_id = robotOf(args);
    watch((w) => {
      const text = JSON.stringify(args ?? {});
      w.callStarted({
        n,
        tool: name,
        robot_id,
        args: text.length > WATCH_ARGS_MAX ? `${text.slice(0, WATCH_ARGS_MAX)}…` : text,
      });
    });
    const t0 = performance.now();
    // the client's notifications/cancelled aborts this signal: a moving call is then stopped, any other aborted
    const out = await callTool(robots, name, args, ctx.mcpReq.signal);
    const ms = performance.now() - t0;
    const output = TOOL.get(name)?.output;
    // what leaves this process matches what tools/list advertised, or the call fails here, loudly
    const mismatch = output ? firstViolation(output, out.envelope) : null;
    if (mismatch) {
      const trace_id = newTraceId();
      const e = new Error(`${name}: the result does not match its outputSchema: ${mismatch} (trace_id ${trace_id})`);
      logCall(name, args, out, ms, { trace_id, message: e.message, stack: stackOf(e) });
      watch((w) =>
        w.callEnded({ n, tool: name, robot_id, ok: false, code: "internal", summary: e.message, ms: Math.round(ms) }),
      );
      throw e;
    }
    logCall(name, args, out, ms);
    watch((w) =>
      w.callEnded({
        n,
        tool: name,
        robot_id,
        ok: out.envelope.ok,
        code: out.envelope.ok ? null : out.envelope.error.code,
        summary: summarize(name, out.envelope),
        ms: Math.round(ms),
      }),
    );
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
      { type: "text", text: `${summarize(name, out.envelope)}\n${JSON.stringify(out.envelope)}` },
    ];
    if (out.image) content.push({ type: "image", data: out.image.b64, mimeType: out.image.mime });
    return server.projectCallToolResult(
      { content, structuredContent: out.envelope, isError: !out.envelope.ok },
      output,
    );
  });
  return server;
}
