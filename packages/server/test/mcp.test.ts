// MCP surface, auth and config.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it } from "bun:test";
import { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION, TOOLS } from "../../protocol/tools.ts";
import { assertSupported, validate } from "../src/schema.ts";
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
        outputSchema: t.outputSchema,
        annotations: t.annotations,
      })),
    ).toEqual(
      TOOLS.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        outputSchema: t.output,
        annotations: t.annotations,
      })),
    );
    // nothing internal leaks
    for (const t of tools)
      expect(Object.keys(t).sort()).toEqual([
        "annotations",
        "description",
        "inputSchema",
        "name",
        "outputSchema",
        "title",
      ]);
    await c.close();
  });

  it("every outputSchema is an object-rooted envelope a strict client accepts", () => {
    const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
    const walk = (schema: unknown, where: string): void => {
      if (typeof schema !== "object" || schema === null) return;
      const s = schema as Record<string, unknown>;
      for (const [name, child] of Object.entries((s.properties as Record<string, unknown> | undefined) ?? {})) {
        if (!NAME.test(name)) throw new Error(`${where}: property name "${name}" does not match ${NAME}`);
        walk(child, `${where}.${name}`);
      }
      walk(s.items, `${where}[]`);
      walk(s.additionalProperties, `${where}.*`);
    };
    for (const t of TOOLS) {
      const where = `${t.name}.output`;
      assertSupported(t.output, where); // only keywords the relay validator enforces, so the harness check is complete
      expect(t.output.type).toBe("object");
      for (const k of ["anyOf", "oneOf", "allOf", "$ref"]) expect(t.output).not.toHaveProperty(k);
      expect(Object.keys(t.output.properties).sort()).toEqual(["data", "error", "next", "ok", "robot"]);
      expect(t.output.required).toEqual(["ok", "next"]);
      // the two fixed parts are the same for every tool; only `data` differs
      expect(t.output.properties.error).toEqual(TOOLS[0]!.output.properties.error!);
      expect(t.output.properties.robot).toEqual(TOOLS[0]!.output.properties.robot!);
      expect(["object", "array"]).toContain(t.output.properties.data!.type as string);
      walk(t.output, where);
    }
  });

  it("a result is the envelope as structuredContent plus a text block (summary line, then the JSON); a tool error sets isError", async () => {
    const c = await client(TOKENS.a);
    await c.listTools(); // the SDK client now validates every structuredContent against the advertised outputSchema
    const ok = await c.callTool({ name: "list_robots", arguments: {} });
    expect(ok.isError).toBeFalsy();
    const content = ok.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    const [summary, json, ...rest] = content[0]!.text.split("\n");
    expect(rest).toEqual([]);
    expect(summary).toMatch(/^list_robots ok \d+ item\(s\) next=describe_robot$/);
    const e = ok.structuredContent as { data: { id: string }[] };
    expect(JSON.parse(json!)).toEqual(e);
    expect(Object.keys(e).sort()).toEqual(["data", "next", "ok"]);
    expect(e.data.map((r) => r.id)).toContain("a1");
    expect(e.data.map((r) => r.id)).not.toContain("b1");

    const bad = await c.callTool({ name: "read_all", arguments: { robot_id: "a2" } });
    expect(bad.isError).toBe(true);
    // the error envelope fits the same schema (checked first: toMatchObject rewrites the fields it matches)
    expect(validate(TOOLS.find((t) => t.name === "read_all")!.output, bad.structuredContent)).toBeNull();
    const text = (bad.content as { text: string }[])[0]!.text.split("\n");
    expect(text[0]).toMatch(/^read_all error robot_offline \(retryable\): .* robot=a2 link=offline activity=\w+ next=/);
    expect(JSON.parse(text[1]!)).toEqual(bad.structuredContent);
    expect(bad.structuredContent).toMatchObject({
      ok: false,
      robot: { id: "a2", link: "offline" },
      error: { code: "robot_offline", retryable: true },
      next: expect.any(Array),
    });

    // a tool the catalog does not have still answers with an envelope; its long message is cut in the summary only
    const ghost = await c.callTool({ name: "fly", arguments: {} });
    expect(ghost.isError).toBe(true);
    const [line, full] = (ghost.content as { text: string }[])[0]!.text.split("\n");
    expect(line).toMatch(/^fly error invalid_argument: name: unknown tool "fly"; tools: .*… next=fly$/);
    expect(line!.length).toBeLessThan(260);
    expect(JSON.parse(full!).error.message).toContain("stop_all");
    expect(ghost.structuredContent).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    await c.close();
  });

  it("the SDK client accepts the structuredContent of acting, sensing and program tools", async () => {
    const rt = await FakeRuntime.connect("a9");
    const c = await client(TOKENS.a);
    await c.listTools();
    const seen: string[] = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await c.callTool({ name, arguments: args }); // throws if structuredContent fails the outputSchema
      expect(r.structuredContent).toMatchObject({ ok: !r.isError });
      expect(validate(TOOLS.find((t) => t.name === name)!.output, r.structuredContent)).toBeNull();
      seen.push(name);
      return r.structuredContent as { ok: boolean; data: any };
    };
    // data shaped like the real runtime's (packages/runtime), including a program with a failed step
    const moved = { requested: { distance_cm: 5 }, applied: { distance_cm: 5 }, measured: { distance_cm: 4.8 } };
    const value = { device: "ev3.pair", channel: "left_deg", value: 0, unit: "deg", ts: 1 };
    const answers: Record<string, unknown> = {
      read_all: { readings: [value, { ...value, value: null, error: "mode_switch_required" }], ms: 3 },
      read_device: [value],
      sample_device: { samples: [], min: null, max: null, mean: null, last: null, rate_hz: 10 },
      wait_until: { met: false, after_ms: 50, readings: [value] },
      drive: { ...moved, clamped: false, reason: "condition_met", chunks: 2, ms: 40 },
      turn: { ...moved, clamped: true, reason: "clamped", problem: "x", chunks: 1, ms: 40 },
    };
    rt.answer = (f) => ({ ok: true, data: answers[f.tool] ?? { reason: "completed" } });
    await call("list_robots", {});
    await call("read_all", { robot_id: "a9" });
    await call("read_device", { robot_id: "a9", device: "ev3.pair" });
    await call("sample_device", { robot_id: "a9", device: "ev3.pair", channel: "left_deg", duration_ms: 100 });
    const cond = { device: "ev3.pair", channel: "left_deg", op: "gt", value: 5 };
    await call("wait_until", { robot_id: "a9", condition: cond, timeout_ms: 50 });
    const drove = await call("drive", { robot_id: "a9", distance_cm: 5, until: cond, request_id: rid() });
    expect(drove).toMatchObject({ ok: true, data: { reason: "condition_met", measured: { distance_cm: 4.8 } } });
    await call("turn", { robot_id: "a9", angle_deg: 400, request_id: rid() });
    await call("stop", { robot_id: "a9" });
    await call("start_episode", { robot_id: "a9", label: "schemas", request_id: rid() });
    await call("mark_episode", { robot_id: "a9", kind: "checkpoint", request_id: rid() });
    await call("end_episode", { robot_id: "a9", outcome: "done", metrics: { score: 1 }, request_id: rid() });
    const name = `schemas_${Date.now().toString(36)}`;
    const saved = await call("save_program", {
      name,
      description: "waits",
      body: { wait_ms: 1 },
      request_id: rid(),
    });
    expect(saved).toMatchObject({ ok: true, data: { name, version: 1, state: "draft" } });
    await call("list_programs", { query: name });
    await call("get_program", { name });
    // a failed step carries a typed error object (ProgramStep in packages/runtime)
    const step = { path: "body", tool: "drive", ok: false, error: { code: "busy", message: "x" }, ms: 1 };
    const failed = { outcome: "failed", reason: "x", steps: [step], steps_dropped: 0, ms: 2 };
    const runSchema = TOOLS.find((t) => t.name === "run_program")!.output;
    expect(validate(runSchema, { ok: true, data: failed, next: [] })).toBeNull();
    expect(
      validate(runSchema, { ok: true, data: { ...failed, steps: [{ ...step, error: "busy" }] }, next: [] }),
    ).toMatch(/steps\[0\]\.error: must be of type object/);
    await call("run_program", { robot_id: "a9", name, request_id: rid() }); // hardware refuses a draft: an error envelope
    await call("retire_program", { name, version: 1, request_id: rid() });
    expect(seen).toHaveLength(16);
    await c.close();
    rt.close();
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
