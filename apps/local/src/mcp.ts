// The MCP surface over stdio: protocol's TOOLS through the low-level Server, so the JSON Schemas pass
// unchanged. Every result is the envelope as structuredContent plus a text block (summary line, then the same JSON).
// Every call writes one line to stderr (CONTRACT §6, "Call log").
import { Server } from "@modelcontextprotocol/server";
import { SERVER_INSTRUCTIONS, TOOLS, SERVER_NAME, SERVER_VERSION } from "../../../packages/protocol/tools";
import { firstViolation } from "../../../packages/protocol/schema";
import { newTraceId, stackOf, type Envelope, type InternalFailure } from "../../../packages/protocol/types";
import type { LocalRobot } from "./robot";
import { log } from "./stderr";
import { TOOL, callTool, summarize } from "./tools";

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
const logInternal = (tool: unknown, args: unknown, f: InternalFailure): void =>
  log("internal", {
    ts: new Date().toISOString(),
    trace_id: f.trace_id,
    tool: short(tool, LOG_NAME_MAX),
    robot_id: robotOf(args),
    message: short(f.message, LOG_STACK_MAX),
    stack: short(f.stack ?? "", LOG_STACK_MAX),
  });

export function buildServer(robots: readonly LocalRobot[]): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  server.setRequestHandler("tools/list", async () => ({ tools: LISTED_TOOLS as never }));
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const name = request.params.name;
    const args = request.params.arguments;
    const t0 = performance.now();
    // the client's notifications/cancelled aborts this signal: a moving call is then stopped, any other aborted
    const out = await callTool(robots, name, args, ctx.mcpReq.signal);
    const ms = performance.now() - t0;
    for (const f of out.internal) logInternal(name, args, f);
    const output = TOOL.get(name)?.output;
    // what leaves this process matches what tools/list advertised, or the call fails here, loudly
    const mismatch = output ? firstViolation(output, out.envelope) : null;
    if (mismatch) {
      const trace_id = newTraceId();
      const e = new Error(`${name}: the result does not match its outputSchema: ${mismatch} (trace_id ${trace_id})`);
      logInternal(name, args, { trace_id, message: e.message, stack: stackOf(e) });
      log("call", {
        ...callLine(name, args, out.envelope, ms, out.moved, trace_id),
        ok: false,
        code: "internal",
      });
      throw e;
    }
    log("call", { ...callLine(name, args, out.envelope, ms, out.moved, out.internal[0]?.trace_id ?? null) });
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
