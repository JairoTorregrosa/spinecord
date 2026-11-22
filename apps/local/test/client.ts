// A minimal MCP client for the tests: it starts `bun apps/local/main.ts` and speaks JSON-RPC over its stdio,
// one JSON object per line. It keeps every stdout line (the tests assert that each is JSON-RPC) and every stderr
// line, and checks each tool result against the outputSchema the server itself listed.
import { join } from "node:path";
import { firstViolation } from "../../../packages/protocol/schema";
import type { LocalEnvelope } from "../../../packages/protocol/types";

export const MAIN = join(import.meta.dir, "..", "main.ts");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

type Rpc = { jsonrpc: "2.0"; id?: number; method?: string; result?: any; error?: any };
export interface ToolOut {
  envelope: LocalEnvelope<any>;
  isError: boolean;
  content: any[];
}

async function lines(stream: ReadableStream<Uint8Array>, each: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    const parts = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
    rest = parts.pop() ?? "";
    for (const line of parts) each(line);
  }
  if (rest) each(rest);
}

export async function startServer(args: string[] = []) {
  const child = Bun.spawn([process.execPath, MAIN, ...args], {
    // not the repo: the server finds its files by itself
    cwd: import.meta.dir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const waiting = new Map<number, (m: Rpc) => void>();
  const pumps = Promise.all([
    lines(child.stdout, (line) => {
      stdout.push(line);
      let m: Rpc;
      try {
        m = JSON.parse(line) as Rpc;
      } catch {
        return; // the test that reads `stdout` reports it
      }
      if (typeof m.id === "number") waiting.get(m.id)?.(m);
    }),
    lines(child.stderr, (line) => void stderr.push(line)),
  ]);
  let id = 0;
  const rpc = (method: string, params: unknown = {}): Promise<Rpc> =>
    new Promise((resolve) => {
      const mine = ++id;
      waiting.set(mine, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params })}\n`);
    });
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "spinecord-test", version: "0" },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = (await rpc("tools/list")).result.tools as { name: string; outputSchema: unknown }[];
  const output = new Map(listed.map((t) => [t.name, t.outputSchema]));

  /** One tools/call. Throws when the result breaks CONTRACT §7 or the tool's advertised outputSchema. */
  async function tool(name: string, args: Record<string, unknown> = {}): Promise<ToolOut> {
    const res = await rpc("tools/call", { name, arguments: args });
    if (res.error) throw new Error(`${name}: JSON-RPC error ${JSON.stringify(res.error)}`);
    const envelope = res.result.structuredContent as LocalEnvelope<any>;
    const text = (res.result.content[0].text as string).split("\n");
    if (text.length !== 2 || JSON.stringify(JSON.parse(text[1]!)) !== JSON.stringify(envelope))
      throw new Error(`${name}: the text block must be a summary line plus the envelope JSON`);
    const schema = output.get(name);
    if (!schema) throw new Error(`${name}: no outputSchema was listed`);
    const invalid = firstViolation(schema, envelope);
    if (invalid) throw new Error(`${name}: structuredContent does not match its outputSchema: ${invalid}`);
    if ((res.result.isError === true) !== !envelope.ok) throw new Error(`${name}: isError must be the opposite of ok`);
    return { envelope, isError: res.result.isError === true, content: res.result.content };
  }

  return {
    child,
    init: init.result,
    listed,
    stdout,
    stderr,
    rpc,
    tool,
    /** JSON events from stderr ({"ev": ...}). */
    events: (ev: string) =>
      stderr
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => e.ev === ev),
    /** Closes stdin (the client went away) and waits for the exit code. */
    async closeStdin(): Promise<number> {
      await child.stdin.end();
      const code = await child.exited;
      await pumps;
      return code;
    },
    async exited(): Promise<number> {
      const code = await child.exited;
      await pumps;
      return code;
    },
  };
}
export type TestServer = Awaited<ReturnType<typeof startServer>>;

/** True once a wheel of the twin reads a speed: a move is really under way. */
export async function wheelsTurning(s: TestServer, robot_id: string): Promise<boolean> {
  const r = await s.tool("read_device", { robot_id, device: "ev3.B", channels: ["speed_deg_s"] });
  return r.envelope.ok && Math.abs(r.envelope.data[0].value) > 0;
}
export async function wheelSpeeds(s: TestServer, robot_id: string): Promise<number[]> {
  const all = await s.tool("read_all", { robot_id });
  if (!all.envelope.ok) throw new Error("read_all failed");
  return (all.envelope.data.readings as { channel: string; value: number }[])
    .filter((r) => r.channel === "speed_deg_s")
    .map((r) => r.value);
}
