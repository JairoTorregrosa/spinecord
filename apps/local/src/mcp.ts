// The MCP surface over stdio: protocol's LOCAL_TOOLS through the low-level Server, so the JSON Schemas pass
// unchanged. Every result is the envelope as structuredContent plus a text block (summary line, then the same JSON).
import { Server } from "@modelcontextprotocol/server";
import { LOCAL_SERVER_INSTRUCTIONS, LOCAL_TOOLS, SERVER_NAME, SERVER_VERSION } from "../../../packages/protocol/tools";
import { firstViolation } from "../../../packages/protocol/schema";
import type { LocalRobot } from "./robot";
import { TOOL, callTool, summarize } from "./tools";

export const LISTED_TOOLS = LOCAL_TOOLS.map((t) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: t.input,
  outputSchema: t.output,
  annotations: t.annotations,
}));

export function buildServer(robots: readonly LocalRobot[]): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: LOCAL_SERVER_INSTRUCTIONS },
  );
  server.setRequestHandler("tools/list", async () => ({ tools: LISTED_TOOLS as never }));
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const name = request.params.name;
    // the client's notifications/cancelled aborts this signal: a moving call is then stopped, any other aborted
    const out = await callTool(robots, name, request.params.arguments, ctx.mcpReq.signal);
    const output = TOOL.get(name)?.output;
    // what leaves this process matches what tools/list advertised, or the call fails here, loudly
    const mismatch = output ? firstViolation(output, out.envelope) : null;
    if (mismatch) throw new Error(`${name}: the result does not match its outputSchema: ${mismatch}`);
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
