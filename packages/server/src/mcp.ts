// The MCP surface: the catalog from packages/protocol/tools.ts, served verbatim through the low-level Server
// so the JSON Schemas pass through unchanged. One server per request (stateless), closed over the caller.

import { Server, createMcpHandler } from "@modelcontextprotocol/server";
import { type OutputSchema, SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION, TOOLS } from "../../protocol/tools.ts";
import type { Envelope } from "../../protocol/types.ts";
import type { Config, ToolPrincipal } from "./config.ts";
import { callTool } from "./dispatch.ts";

/** tools/list payload: name, title, description, inputSchema, outputSchema, annotations. `scope` and `mutating` stay internal. */
export const LISTED_TOOLS = TOOLS.map((t) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: t.input,
  outputSchema: t.output,
  annotations: t.annotations,
}));

const OUTPUT: ReadonlyMap<string, OutputSchema> = new Map(TOOLS.map((t) => [t.name, t.output]));
const FACTS = ["reason", "outcome", "met", "motors_stopped", "state", "control", "success_rate"];

const MAX_MESSAGE = 200;

/** Line 1 of the text block: what happened, for a reader that does not parse the JSON below it. Short, never a newline. */
export function summarize(tool: string, e: Envelope<unknown>): string {
  const robot = e.robot ? ` robot=${e.robot.id} link=${e.robot.link} activity=${e.robot.activity}` : "";
  const next = e.next.length ? ` next=${e.next.join(",")}` : "";
  let what = "";
  if (!e.ok) {
    const m = e.error.message;
    // the full message is in the JSON on the next line
    what = ` ${e.error.code}${e.error.retryable ? " (retryable)" : ""}: ${m.length > MAX_MESSAGE ? `${m.slice(0, MAX_MESSAGE)}…` : m}`;
  } else if (Array.isArray(e.data)) what = ` ${e.data.length} item(s)`;
  else if (typeof e.data === "object" && e.data !== null) {
    const d = e.data as Record<string, unknown>;
    what = FACTS.filter((k) => ["string", "number", "boolean"].includes(typeof d[k]))
      .map((k) => ` ${k}=${String(d[k])}`)
      .join("");
  }
  return `${tool} ${e.ok ? "ok" : "error"}${what}${robot}${next}`.replace(/\s+/g, " ");
}

export function buildServer(env: Env, cfg: Config, who: ToolPrincipal, trace_id: string): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  server.setRequestHandler("tools/list", async () => ({ tools: LISTED_TOOLS as never }));
  server.setRequestHandler("tools/call", async (request) => {
    const name = request.params.name;
    const out = await callTool(env, cfg, who, name, request.params.arguments, trace_id);
    // CONTRACT §7: the envelope is structuredContent; the text block is a summary line, then the same JSON on the last line
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
      { type: "text", text: `${summarize(name, out.envelope)}\n${JSON.stringify(out.envelope)}` },
    ];
    if (out.image) content.push({ type: "image", data: out.image.b64, mimeType: out.image.mime });
    return server.projectCallToolResult(
      { content, structuredContent: out.envelope, isError: !out.envelope.ok },
      OUTPUT.get(name),
    );
  });
  return server;
}

export function serveMcp(
  request: Request,
  env: Env,
  cfg: Config,
  who: ToolPrincipal,
  trace_id: string,
): Promise<Response> {
  return createMcpHandler(() => buildServer(env, cfg, who, trace_id)).fetch(request);
}
