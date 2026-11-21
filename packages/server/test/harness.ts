// Test harness: the Worker runs in Miniflare (started once per process by setup.ts); the tests reach it over
// loopback HTTP, and a fake runtime / fake organ speak the wire protocol (CONTRACT §8) over a real WebSocket
// to the robot's Durable Object.

import type { DeviceSpec, Envelope, RobotProfile } from "../../protocol/types.ts";
import { TOOLS } from "../../protocol/tools.ts";
import { profileHash } from "../../protocol/validate.ts";
import { firstViolation as validate } from "../../protocol/schema.ts";

const OUTPUT = new Map(TOOLS.map((t) => [t.name, t.output]));

const relay = (globalThis as { __RELAY__?: { url: string; migrations: string[]; logs: string[] } }).__RELAY__;
if (!relay)
  throw new Error(
    "the relay is not running: run `bun test` from packages/server so bunfig.toml preloads test/setup.ts",
  );
export const BASE: string = relay.url;
const LOGS: string[] = relay.logs;
/** a, b, admin call tools; rt / rtB are the runtimes of user-a's robots / of b1; organ attaches organs (setup.ts). */
export const TOKENS = {
  a: "token-user-a",
  b: "token-user-b",
  admin: "token-admin",
  rt: "token-runtime",
  rtB: "token-runtime-b",
  organ: "token-organ",
} as const;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/**
 * Waits until the worker has printed a log line (src/log.ts) with this event and these fields. A barrier for
 * state that only lives in the Durable Object's memory, e.g. a call that reached the queue.
 */
export async function logged(ev: string, fields: Record<string, unknown>): Promise<void> {
  const want = Object.entries({ ev, ...fields });
  await until(`worker log ${JSON.stringify({ ev, ...fields })}`, () =>
    LOGS.some((line) => {
      if (!line.startsWith("{")) return false;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line);
      } catch {
        return false;
      }
      return want.every(([k, v]) => o[k] === v);
    }),
  );
}

/** One request to the worker. `env` overrides bindings for this request only (null removes one). */
export const http = (
  path: string,
  init: RequestInit & { token?: string } = {},
  env?: Record<string, string | null>,
): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (env) headers.set("x-test-env", JSON.stringify(env));
  return fetch(`${BASE}${path}`, { ...init, headers });
};

async function testHook<T>(name: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/__test/${name}`, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`/__test/${name} answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}
/** Rows from the worker's D1 database. */
export const sql = <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> =>
  testHook<T[]>("sql", { sql: query, params });
/** The Miniflare instance is shared by the whole process: each test file starts from no Durable Objects and an empty database. */
export const resetRelay = async (): Promise<void> => void (await testHook("reset", { migrations: relay.migrations }));
/** Evicts a robot's Durable Object from memory; its WebSockets hibernate. */
export const evict = async (robot_id: string): Promise<void> => void (await testHook("evict", { robot_id }));

let rpc = 0;
export type ToolOut = { envelope: Envelope<any>; isError: boolean; content: any[] };
/** One MCP tools/call as raw JSON-RPC over Streamable HTTP. */
export async function tool(token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolOut> {
  const res = await http("/mcp", {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
  });
  if (res.status !== 200) throw new Error(`/mcp answered ${res.status}: ${await res.text()}`);
  const text = await res.text();
  const body = JSON.parse(
    res.headers.get("content-type")?.includes("event-stream")
      ? (
          text
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .pop() as string
        ).slice(5)
      : text,
  );
  if (body.error) throw new Error(`JSON-RPC error: ${JSON.stringify(body.error)}`);
  // CONTRACT §7: the envelope travels as structuredContent and again as the last line of the text block
  const envelope = body.result.structuredContent as Envelope<any>;
  const lines = (body.result.content[0].text as string).split("\n");
  if (lines.length !== 2 || JSON.stringify(JSON.parse(lines[1]!)) !== JSON.stringify(envelope))
    throw new Error(`${name}: the text block must be a summary line plus the envelope JSON: ${lines.join("\\n")}`);
  // every call of every test checks the advertised outputSchema against what the relay really returned
  const output = OUTPUT.get(name);
  const invalid = output ? validate(output, envelope) : null;
  if (invalid) throw new Error(`${name}: structuredContent does not match its outputSchema: ${invalid}`);
  return {
    envelope,
    isError: body.result.isError === true,
    content: body.result.content,
  };
}

export const rid = () => crypto.randomUUID();

export const PROFILE = (id: string, limits: Partial<RobotProfile["limits"]> = {}): RobotProfile => ({
  id,
  roles: { drive_pair: "ev3.pair", speaker: "ev3.speaker" },
  limits: {
    max_speed_pct: 60,
    max_command_ms: 600,
    max_drive_cm: 100,
    max_turn_deg: 360,
    max_program_ms: 1000,
    ...limits,
  },
  notes: [],
});
/**
 * Limits for a test that holds a call open ("hang") while it does other things: the relay's deadline for that
 * call is real time, so with the short default limits it would race the test's own round trips.
 */
export const PATIENT = { max_command_ms: 60_000, max_program_ms: 60_000 } as const;
export const DEVICES: DeviceSpec[] = [
  {
    id: "ev3.pair",
    provider: "ev3",
    kind: "motor_pair",
    roles: ["drive_pair"],
    description: "pair",
    channels: [{ name: "left_deg", type: "number", description: "" }],
    commands: [
      {
        name: "run_pair",
        description: "",
        moves: true,
        bound: { kind: "degrees", params: ["left_deg"], max: 3600 },
        params: {
          type: "object",
          properties: { left_deg: { type: "number" } },
          required: ["left_deg"],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    id: "ev3.speaker",
    provider: "ev3",
    kind: "speaker",
    roles: ["speaker"],
    description: "speaker",
    channels: [],
    commands: [
      {
        name: "beep",
        description: "",
        moves: false,
        bound: { kind: "instant", max: 0 },
        params: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "speak",
        description: "",
        moves: false,
        bound: { kind: "ms", max: 1500 }, // blocks until the speech ends, at most this long
        params: {
          type: "object",
          properties: { text: { type: "string", maxLength: 200 } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    ],
  },
];
export const SIM_WORLD: DeviceSpec = {
  id: "sim.world",
  provider: "sim",
  kind: "sim_world",
  roles: [],
  description: "world",
  channels: [],
  commands: [
    {
      name: "reset",
      description: "",
      moves: true,
      bound: { kind: "instant", max: 0 },
      params: { type: "object", properties: {} },
    },
  ],
};

type CallFrame = { t: "call"; call_id: string; tool: string; args: any; deadline_ms: number };
type Answer =
  | { ok: true; data: unknown; image?: unknown }
  | { ok: false; error: { code: string; message: string; retryable?: boolean } }
  | "hang";

/** Opens a WebSocket to the worker; resolves once the upgrade is accepted. */
export function open(path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}${path}`);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error(`${path} refused the WebSocket upgrade`)), { once: true });
  });
}

export class FakeRuntime {
  calls: CallFrame[] = [];
  frames: any[] = [];
  aborts: string[] = [];
  stops = 0;
  closed: { code: number; reason: string } | null = null;
  welcomed = false;
  private waiters: { tool: string; n: number; resolve: (c: CallFrame) => void }[] = [];
  private frameWaiters: { t: string; n: number; resolve: (f: any) => void }[] = [];
  /** what the runtime answers to a call; "hang" = keep working until aborted */
  answer: (c: CallFrame) => Answer = () => ({ ok: true, data: { reason: "completed" } });
  /** verdict of the next stop; null = say nothing (stop cannot be verified) */
  stopVerdict: boolean | null = true;
  /** when aborted, report what was done so far */
  reportOnAbort = true;
  wrongStopId = false;
  heartbeat = true;
  /** extra fields on every heartbeat, e.g. { battery_low: true } */
  hb: Record<string, unknown> = {};
  private hanging = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => this.on(JSON.parse(ev.data as string)));
    ws.addEventListener("close", (ev) => {
      this.closed = { code: ev.code, reason: ev.reason };
      clearInterval(this.timer);
    });
    this.timer = setInterval(() => this.heartbeat && this.send({ t: "hb", ts: Date.now(), ...this.hb }), 40);
  }

  static async connect(
    robot_id: string,
    o: {
      token?: string;
      backend?: string;
      devices?: DeviceSpec[];
      profile?: RobotProfile;
      path?: string;
      hello?: Record<string, unknown>;
    } = {},
  ): Promise<FakeRuntime> {
    const rt = new FakeRuntime(await open(o.path ?? `/ws/robot?robot_id=${robot_id}`));
    const profile = o.profile ?? PROFILE(robot_id);
    rt.send({
      t: "hello",
      v: 2,
      robot_id,
      token: o.token ?? TOKENS.rt,
      backend: o.backend ?? "ev3",
      profile,
      profile_hash: profileHash(profile),
      stop_worst_ms: 100,
      devices: o.devices ?? DEVICES,
      ...o.hello,
    });
    await until("welcome or refusal", () => rt.welcomed || rt.closed !== null);
    return rt;
  }

  send(m: unknown): void {
    try {
      this.ws.send(JSON.stringify(m));
    } catch {}
  }
  private on(m: any): void {
    this.frames.push(m);
    this.frameWaiters = this.frameWaiters.filter((w) => {
      const got = this.frames.filter((f) => f.t === w.t)[w.n - 1];
      if (got) w.resolve(got);
      return !got;
    });
    if (m.t === "welcome") this.welcomed = true;
    if (m.t === "call") {
      this.calls.push(m);
      this.waiters = this.waiters.filter((w) => {
        const got = this.toolCalls(w.tool)[w.n - 1];
        if (got) w.resolve(got);
        return !got;
      });
      const a = this.answer(m);
      if (a === "hang") this.hanging.add(m.call_id);
      else this.send({ t: "result", call_id: m.call_id, ...a });
    }
    if (m.t === "abort") {
      this.aborts.push(m.call_id);
      if (this.hanging.delete(m.call_id) && this.reportOnAbort)
        this.send({
          t: "result",
          call_id: m.call_id,
          ok: true,
          data: { reason: "preempted", measured: { distance_cm: 3 } },
        });
    }
    if (m.t === "stop") {
      this.stops++;
      if (this.stopVerdict !== null)
        this.send({ t: "stopped", stop_id: this.wrongStopId ? "other" : m.stop_id, motors_stopped: this.stopVerdict });
    }
  }
  /**
   * Resolves with the n-th {t:"call"} frame for this tool, as soon as it has arrived. The relay sets the robot's
   * activity before it sends the frame, so a moving call that arrived means the robot is acting.
   */
  called(tool: string, n = 1): Promise<CallFrame> {
    const got = this.toolCalls(tool)[n - 1];
    if (got) return Promise.resolve(got);
    return new Promise((resolve) => this.waiters.push({ tool, n, resolve }));
  }
  /**
   * Resolves with the n-th frame of type `t`, as soon as it has arrived. A worker log line (`logged`) and an HTTP
   * reply travel on other channels than this socket: neither says that a frame the relay sent has arrived here.
   */
  frame(t: string, n = 1): Promise<any> {
    const got = this.frames.filter((f) => f.t === t)[n - 1];
    if (got) return Promise.resolve(got);
    return new Promise((resolve) => this.frameWaiters.push({ t, n, resolve }));
  }
  toolCalls(tool: string): CallFrame[] {
    return this.calls.filter((c) => c.tool === tool);
  }
  close(): void {
    clearInterval(this.timer);
    this.ws.close(1000, "bye");
  }
}

export class FakeOrgan {
  frames: any[] = [];
  closed: { code: number; reason: string } | null = null;
  welcomed = false;
  heartbeat = true;
  private timer: ReturnType<typeof setInterval>;
  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data as string);
      this.frames.push(m);
      if (m.t === "welcome") this.welcomed = true;
      if (m.t === "req")
        ws.send(
          JSON.stringify({
            t: "res",
            req_id: m.req_id,
            ok: true,
            data: m.op === "stop" ? { motors_stopped: true } : [{ device: m.device, channel: "ppm", value: 7, ts: 1 }],
          }),
        );
    });
    ws.addEventListener("close", (ev) => {
      this.closed = { code: ev.code, reason: ev.reason };
      clearInterval(this.timer);
    });
    this.timer = setInterval(() => this.heartbeat && ws.send(JSON.stringify({ t: "hb", ts: Date.now() })), 40);
  }
  static async connect(
    robot_id: string,
    organ_id: string,
    devices: unknown[],
    token: string = TOKENS.organ,
  ): Promise<FakeOrgan> {
    const o = new FakeOrgan(await open(`/ws/organ?robot_id=${robot_id}`));
    o.ws.send(JSON.stringify({ t: "hello", v: 2, robot_id, token, organ_id, devices }));
    await until("organ welcome or refusal", () => o.welcomed || o.closed !== null);
    return o;
  }
  close(): void {
    clearInterval(this.timer);
    this.ws.close(1000, "bye");
  }
}

export const GAS = (organ_id: string): DeviceSpec => ({
  id: `${organ_id}.gas`,
  provider: organ_id,
  kind: "gas",
  roles: [],
  description: "gas",
  channels: [{ name: "ppm", type: "number", description: "" }],
  commands: [],
});
