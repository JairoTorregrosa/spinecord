// MCP surface, auth and config.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it } from "bun:test";
import { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION, TOOLS } from "../../protocol/tools.ts";
import { BASE, DEVICES, FakeRuntime, PROFILE, TOKENS, http, resetRelay, rid, tool } from "./harness.ts";

beforeAll(resetRelay);

async function client(token: string): Promise<Client> {
  const c = new Client({ name: "test", version: "0.0.0" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return c;
}

describe("MCP surface", () => {
  it("tools/list equals TOOLS verbatim, with the contract's name, version and instructions", async () => {
    const c = await client(TOKENS.a);
    expect(c.getServerVersion()).toMatchObject({ name: SERVER_NAME, version: SERVER_VERSION });
    expect(c.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    const { tools } = await c.listTools();
    expect<unknown>(
      tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      })),
    ).toEqual(
      TOOLS.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        annotations: t.annotations,
      })),
    );
    // nothing internal leaks
    for (const t of tools)
      expect(Object.keys(t).sort()).toEqual(["annotations", "description", "inputSchema", "name", "title"]);
    await c.close();
  });

  it("a result is one text block with the envelope; a tool error sets isError", async () => {
    const c = await client(TOKENS.a);
    const ok = await c.callTool({ name: "list_robots", arguments: {} });
    expect(ok.isError).toBeFalsy();
    const content = ok.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    const e = JSON.parse(content[0]!.text);
    expect(Object.keys(e).sort()).toEqual(["data", "next", "ok"]);
    expect(e.data.map((r: { id: string }) => r.id)).toContain("a1");
    expect(e.data.map((r: { id: string }) => r.id)).not.toContain("b1");

    const bad = await c.callTool({ name: "read_all", arguments: { robot_id: "a2" } });
    expect(bad.isError).toBe(true);
    expect(JSON.parse((bad.content as { text: string }[])[0]!.text)).toMatchObject({
      ok: false,
      robot: { id: "a2", link: "offline" },
      error: { code: "robot_offline", retryable: true },
      next: expect.any(Array),
    });
    await c.close();
  });

  it("an image from the runtime becomes one image block; a stale frame is stale_image", async () => {
    const rt = await FakeRuntime.connect("a3");
    let age = 100;
    // CONTRACT §2: image channels return Reading.image
    rt.answer = () => ({
      ok: true,
      data: [
        {
          device: "cam1.frame",
          channel: "frame",
          value: null,
          ts: 1,
          image: { mime: "image/jpeg", b64: "AAAA", age_ms: age },
        },
      ],
    });
    const fresh = await tool(TOKENS.a, "read_device", { robot_id: "a3", device: "cam", channels: ["frame"] });
    expect(fresh.content).toHaveLength(2);
    expect(fresh.content[1]).toEqual({ type: "image", data: "AAAA", mimeType: "image/jpeg" });
    expect(fresh.envelope).toMatchObject({
      ok: true,
      data: [{ channel: "frame", value: null, image: { mime: "image/jpeg", age_ms: 100 } }],
    });
    expect(fresh.content[0].text).not.toContain("AAAA"); // the pixels travel once, as the image block
    age = 1600;
    const stale = await tool(TOKENS.a, "read_device", { robot_id: "a3", device: "cam", channels: ["frame"] });
    expect(stale.isError).toBe(true);
    expect(stale.content).toHaveLength(1);
    expect(stale.envelope).toMatchObject({ ok: false, error: { code: "stale_image", retryable: true } });
    rt.close();
  });
});

describe("input validation", () => {
  it("invalid_argument names the field and the rule, before anything is dispatched", async () => {
    const rt = await FakeRuntime.connect("a4");
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["drive", { robot_id: "a4", request_id: rid() }, /distance_cm: is required/],
      ["drive", { robot_id: "a4", distance_cm: "far", request_id: rid() }, /distance_cm: must be of type number/],
      [
        "drive",
        { robot_id: "a4", distance_cm: 5, speed_pct: 150, request_id: rid() },
        /speed_pct: must be <= 100 \(maximum\)/,
      ],
      ["drive", { robot_id: "a4", distance_cm: 5, request_id: rid(), warp: 9 }, /warp: unknown field/],
      ["sample_device", { robot_id: "a4", device: "x", channel: "y", duration_ms: 50 }, /duration_ms: must be >= 100/],
      [
        "command_device",
        { robot_id: "a4", device: "ev3.pair", command: "run_pair", args: { left_deg: "x" }, request_id: rid() },
        /args\.left_deg: must be of type number/,
      ],
    ];
    for (const [name, args, rule] of cases) {
      const r = await tool(TOKENS.a, name, args);
      expect(r.isError).toBe(true);
      expect(r.envelope.ok).toBe(false);
      if (!r.envelope.ok) {
        expect(r.envelope.error.code).toBe("invalid_argument");
        expect(r.envelope.error.message).toMatch(rule);
      }
      expect(r.envelope.robot).toMatchObject({ id: "a4" });
    }
    const bad = await tool(TOKENS.a, "save_program", {
      name: "Bad Name",
      description: "x",
      body: {},
      request_id: rid(),
    });
    expect(bad.envelope).toMatchObject({
      ok: false,
      error: { code: "invalid_argument", message: expect.stringMatching(/name: must match pattern/) },
    });
    expect(rt.calls).toHaveLength(0);
    rt.close();
  });

  it("unknown device and unknown command list the valid ones", async () => {
    const rt = await FakeRuntime.connect("a5");
    const d = await tool(TOKENS.a, "command_device", {
      robot_id: "a5",
      device: "ev3.claw",
      command: "open",
      request_id: rid(),
    });
    expect(d.envelope).toMatchObject({
      ok: false,
      error: { code: "unknown_device", message: expect.stringContaining("ev3.pair, ev3.speaker") },
    });
    const c = await tool(TOKENS.a, "command_device", {
      robot_id: "a5",
      device: "speaker",
      command: "sing",
      request_id: rid(),
    });
    expect(c.envelope).toMatchObject({
      ok: false,
      error: { code: "unknown_command", message: expect.stringContaining("beep") },
    });
    expect(rt.calls).toHaveLength(0);
    rt.close();
  });
});

describe("auth", () => {
  it("a wrong or missing token is refused with 401 and never reaches a tool", async () => {
    for (const token of ["nope", "", "token-user-a "]) {
      const res = await http("/mcp", {
        method: "POST",
        ...(token ? { headers: { Authorization: `Bearer ${token}x` } } : {}),
        body: "{}",
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    }
    expect((await http("/api/robots", { token: "nope" })).status).toBe(401);
  });

  it("a user token cannot use another principal's robot; an unknown robot is unknown_robot", async () => {
    const other = await tool(TOKENS.b, "read_all", { robot_id: "a1" });
    expect(other.envelope).toMatchObject({
      ok: false,
      error: { code: "unauthorized", message: expect.stringContaining("b1") },
    });
    const stop = await tool(TOKENS.b, "stop", { robot_id: "a1" });
    expect(stop.envelope).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    const ghost = await tool(TOKENS.a, "read_all", { robot_id: "zz9" });
    expect(ghost.envelope).toMatchObject({ ok: false, error: { code: "unknown_robot" } });
  });

  it("a runtime with a wrong token, another principal's token or an unbounded command is refused", async () => {
    const wrong = await FakeRuntime.connect("a6", { token: "not-a-token" });
    expect(wrong.welcomed).toBe(false);
    expect(wrong.closed).toMatchObject({ code: 4001, reason: expect.stringContaining("unauthorized") });
    const foreign = await FakeRuntime.connect("a6", { token: TOKENS.b });
    expect(foreign.closed?.code).toBe(4001);
    const unbounded = structuredClone(DEVICES);
    delete (unbounded[0]!.commands[0] as { bound?: unknown }).bound;
    const loose = await FakeRuntime.connect("a6", { devices: unbounded });
    expect(loose.closed).toMatchObject({ code: 4001, reason: expect.stringContaining("bound") });
    const lied = await FakeRuntime.connect("a6", { hello: { profile_hash: "0000000000000000" } });
    expect(lied.closed).toMatchObject({ code: 4001, reason: expect.stringContaining("profile_hash") });
    const vague = await FakeRuntime.connect("a6", { hello: { stop_worst_ms: undefined } });
    expect(vague.closed).toMatchObject({ code: 4001, reason: expect.stringContaining("stop_worst_ms") });
    const list = await tool(TOKENS.a, "list_robots");
    expect(list.envelope.ok && list.envelope.data.find((r: { id: string }) => r.id === "a6")).toMatchObject({
      link: "offline",
      backend: null,
      battery_low: null,
    });
  });

  it("admin-only tools refuse a user token and work for an admin", async () => {
    for (const [name, args] of [
      ["take_control", { robot_id: "a7", request_id: rid() }],
      ["release_control", { robot_id: "a7", request_id: rid() }],
      ["stop_all", {}],
    ] as const) {
      const r = await tool(TOKENS.a, name, args);
      expect(r.isError).toBe(true);
      expect(r.envelope).toMatchObject({ ok: false, error: { code: "unauthorized", retryable: false } });
    }
    expect((await http("/api/robots", { token: TOKENS.a })).status).toBe(403);
    const taken = await tool(TOKENS.admin, "take_control", { robot_id: "a7", request_id: rid() });
    expect(taken.envelope).toMatchObject({ ok: true, data: { control: "admin" }, robot: { control: "admin" } });
    const all = await tool(TOKENS.admin, "stop_all");
    expect(all.envelope.ok && all.envelope.data.map((r: { robot_id: string }) => r.robot_id)).toEqual(
      expect.arrayContaining(["a1", "b1"]),
    );
  });

  it("missing or malformed PRINCIPALS makes every request 503 misconfigured", async () => {
    const broken = [
      undefined,
      "",
      "not json",
      "{}",
      "[]",
      JSON.stringify([{ principal_id: "x", role: "user", token_sha256: "plaintext", robot_ids: [] }]),
      JSON.stringify([{ principal_id: "x", role: "boss", token_sha256: "a".repeat(64), robot_ids: [] }]),
    ];
    for (const PRINCIPALS of broken) {
      const bad = { PRINCIPALS: PRINCIPALS ?? null };
      for (const path of ["/health", "/mcp", "/api/robots", "/ws/robot?robot_id=a1"]) {
        const res = await http(path, { token: TOKENS.admin }, bad);
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ ok: false, error: { code: "misconfigured" } });
      }
    }
    expect((await http("/health", {}, { HB_TIMEOUT_MS: "soon" })).status).toBe(503);
    expect((await http("/health")).status).toBe(200);
  });

  it("the profile a runtime announces is stored for the robot", async () => {
    const rt = await FakeRuntime.connect("a8", { profile: { ...PROFILE("a8"), notes: ["color sensor points down"] } });
    const res = await http("/api/robots", { token: TOKENS.admin });
    const body = (await res.json()) as { data: { id: string; owner_principals: string[]; link: string }[] };
    expect(body.data.find((r) => r.id === "a8")).toMatchObject({
      link: "online",
      backend: "ev3",
      owner_principals: ["user-a"],
    });
    rt.close();
  });
});
