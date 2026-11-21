// The MCP surface: the catalog from packages/protocol/tools.ts, served verbatim through the low-level Server
// so the JSON Schemas pass through unchanged. One server per request (stateless), closed over the caller.

import { Server, createMcpHandler } from "@modelcontextprotocol/server";
import { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION, TOOLS } from "../../protocol/tools.ts";
import type { Config, Principal } from "./config.ts";
import { callTool } from "./dispatch.ts";

/** tools/list payload: name, title, description, inputSchema, annotations. `scope` and `mutating` stay internal. */
export const LISTED_TOOLS = TOOLS.map((t) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: t.input,
  annotations: t.annotations,
}));

export function buildServer(env: Env, cfg: Config, who: Principal, trace_id: string): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  server.setRequestHandler("tools/list", async () => ({ tools: LISTED_TOOLS as never }));
  server.setRequestHandler("tools/call", async (request) => {
    const out = await callTool(env, cfg, who, request.params.name, request.params.arguments, trace_id);
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
      { type: "text", text: JSON.stringify(out.envelope) },
    ];
    if (out.image) content.push({ type: "image", data: out.image.b64, mimeType: out.image.mime });
    return server.projectCallToolResult({ content, isError: !out.envelope.ok }, undefined);
  });
  return server;
}

export function serveMcp(request: Request, env: Env, cfg: Config, who: Principal, trace_id: string): Promise<Response> {
  return createMcpHandler(() => buildServer(env, cfg, who, trace_id)).fetch(request);
}
