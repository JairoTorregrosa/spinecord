// Program library: save, verify on a twin, run rules on hardware, approval, retirement.
import { beforeAll, describe, expect, it } from "bun:test";
import type { RobotProfile } from "../../protocol/types.ts";
import { profileHash } from "../../protocol/validate.ts";
import {
  DEVICES,
  FakeRuntime,
  PATIENT,
  PROFILE,
  SIM_WORLD,
  TOKENS,
  http,
  rid,
  sleep,
  sql,
  tool,
  resetRelay,
} from "./harness.ts";

beforeAll(resetRelay);

const BODY = {
  seq: [
    { call: { tool: "drive", args: { distance_cm: 20 } } },
    { wait_ms: 100 },
    { call: { tool: "command_device", args: { device: "speaker", command: "beep" } } },
  ],
};
const save = (name: string, body: unknown = BODY, extra: Record<string, unknown> = {}, token: string = TOKENS.a) =>
  tool(token, "save_program", { name, description: `test ${name}`, body, request_id: rid(), ...extra });
const twin = (id: string, limits: Partial<RobotProfile["limits"]> = {}) =>
  FakeRuntime.connect(id, { backend: "sim", devices: [...DEVICES, SIM_WORLD], profile: PROFILE(id, limits) });
const state = async (name: string, version = 1) => {
  const r = await tool(TOKENS.a, "get_program", { name, version });
  return r.envelope.ok ? r.envelope.data.state : r.envelope.error.code;
};

describe("save_program", () => {
  it("stores a draft with computed requires; a new save is a new version; a retry is the same version", async () => {
    const request_id = rid();
    const first = await tool(TOKENS.a, "save_program", {
      name: "square_one",
      description: "d",
      body: BODY,
      success: { device: "ev3.S1", channel: "pressed", op: "eq", value: true },
      request_id,
    });
    expect(first.envelope).toMatchObject({
      ok: true,
      data: {
        name: "square_one",
        version: 1,
        state: "draft",
        author: "user-a",
        pass_rate: 0.8,
        requires: ["ev3.S1", "motor_pair", "speaker"],
      },
    });
    expect(first.envelope.robot).toBeUndefined();
    const args = {
      name: "square_one",
      description: "d",
      body: BODY,
      success: { device: "ev3.S1", channel: "pressed", op: "eq", value: true },
      request_id,
    };
    expect((await tool(TOKENS.a, "save_program", args)).envelope).toEqual(first.envelope);
    // the same request_id with another body is another action: refused, and nothing is saved
    const reused = await tool(TOKENS.a, "save_program", { ...args, description: "changed" });
    expect(reused.envelope).toMatchObject({
      ok: false,
      error: { code: "invalid_argument", message: expect.stringContaining("request_id") },
    });
    expect((await save("square_one")).envelope).toMatchObject({ ok: true, data: { version: 2 } });
    const list = await tool(TOKENS.b, "list_programs", { query: "square" });
    expect(list.envelope.ok && list.envelope.data.map((p: { version: number }) => p.version)).toEqual([2, 1]);
    const latest = await tool(TOKENS.b, "get_program", { name: "square_one" });
    expect(latest.envelope).toMatchObject({ ok: true, data: { version: 2, body: BODY, runs: [] } });
    expect((await tool(TOKENS.a, "get_program", { name: "nope_nope" })).envelope).toMatchObject({
      ok: false,
      error: { code: "invalid_argument" },
    });
  });

  it("rejects bodies over the caps or with a wrong shape, naming the path", async () => {
    const cases: [unknown, RegExp][] = [
      [{ repeat: { times: 51, body: { wait_ms: 1 } } }, /body\.repeat\.times: integer 1\.\.50/],
      [
        {
          while: { cond: { device: "a", channel: "b", op: "lt", value: 1 }, body: { wait_ms: 1 }, max_iterations: 201 },
        },
        /max_iterations: integer 1\.\.200/,
      ],
      [{ wait_ms: 10001 }, /wait_ms: integer 0\.\.10000/],
      [
        { seq: [{ call: { tool: "stop", args: {} } }] },
        /body\.seq\[0\]\.call\.tool: must be one of drive, turn, arc, command_device, wait_until/,
      ],
      [
        { seq: [{ call: { tool: "drive", args: { distance_cm: 1, robot_id: "a1" } } }] },
        /call\.args\.robot_id: must be omitted inside programs/,
      ],
      [
        { if: { cond: { device: "a", channel: "b", op: "changed", value: 1 }, then: { wait_ms: 1 } } },
        /body\.if\.cond/,
      ],
      [{ seq: Array.from({ length: 500 }, () => ({ wait_ms: 1 })) }, /more than 500 nodes/],
      [{ wait_ms: 1, fail: "x" }, /exactly one key/],
    ];
    for (const [body, rule] of cases) {
      const r = await save("too_much", body);
      expect(r.envelope.ok).toBe(false);
      if (!r.envelope.ok) {
        expect(r.envelope.error.code).toBe("invalid_argument");
        expect(r.envelope.error.message).toMatch(rule);
      }
      await sleep(10);
    }
    expect((await tool(TOKENS.a, "list_programs", { query: "too_much" })).envelope).toMatchObject({
      ok: true,
      data: [],
    });
    const contains = await save("press_enter", {
      while: {
        cond: { device: "ev3.buttons", channel: "pressed", op: "contains", value: "enter" },
        body: { wait_ms: 50 },
        max_iterations: 3,
      },
    });
    expect(contains.envelope).toMatchObject({ ok: true, data: { requires: ["ev3.buttons"] } });
  });
});

describe("verify_program", () => {
  it("runs the trials on the twin with a world reset before each, and moves draft → verified", async () => {
    await save("line_follow");
    const rt = await twin("s1-sim");
    rt.answer = (c) =>
      c.tool === "run_program"
        ? { ok: true, data: { outcome: "succeeded", steps: [], ms: 5 } }
        : { ok: true, data: { reason: "completed" } };
    const r = await tool(TOKENS.a, "verify_program", {
      name: "line_follow",
      robot_id: "s1-sim",
      trials: 3,
      request_id: rid(),
    });
    expect(r.envelope).toMatchObject({
      ok: true,
      data: {
        success_rate: 1,
        state: "verified",
        verified_on: { twin_id: "s1-sim", profile_hash: profileHash(PROFILE("s1-sim")) },
        outcomes: [{ trial: 1, outcome: "succeeded" }, { trial: 2 }, { trial: 3 }],
      },
      robot: { backend: "sim", activity: "idle" },
    });
    expect(rt.calls.map((c) => c.tool)).toEqual([
      "command_device",
      "run_program",
      "command_device",
      "run_program",
      "command_device",
      "run_program",
    ]);
    expect(rt.calls[0]!.args).toEqual({ device: "sim.world", command: "reset", args: {} });
    expect(rt.calls[1]!.args).toMatchObject({ name: "line_follow", version: 1, body: BODY });
    expect(rt.calls[1]!.deadline_ms).toBe(1300); // the profile's max_program_ms + margin 200 + stop_worst_ms 100
    expect(await state("line_follow")).toBe("verified");
    const got = await tool(TOKENS.a, "get_program", { name: "line_follow" });
    expect(got.envelope).toMatchObject({
      ok: true,
      data: { success_rate: 1, runs: [{ backend: "sim", outcome: "succeeded" }, {}, {}] },
    });
    // only a draft can be verified
    const again = await tool(TOKENS.a, "verify_program", {
      name: "line_follow",
      robot_id: "s1-sim",
      trials: 1,
      request_id: rid(),
    });
    expect(again.envelope).toMatchObject({
      ok: false,
      error: { code: "illegal_state", message: expect.stringContaining("verified") },
    });
    rt.close();
  });

  it("below pass_rate the program stays draft", async () => {
    await save("flaky_one", BODY, { pass_rate: 0.75 });
    const rt = await twin("s2-sim");
    let n = 0;
    rt.answer = (c) =>
      c.tool === "run_program"
        ? { ok: true, data: { outcome: ++n % 2 ? "succeeded" : "failed", reason: "bumped", steps: [], ms: 5 } }
        : { ok: true, data: {} };
    const r = await tool(TOKENS.a, "verify_program", {
      name: "flaky_one",
      robot_id: "s2-sim",
      trials: 4,
      request_id: rid(),
    });
    expect(r.envelope).toMatchObject({
      ok: true,
      data: {
        success_rate: 0.5,
        state: "draft",
        outcomes: [{ outcome: "succeeded" }, { outcome: "failed", reason: "bumped" }, {}, {}],
      },
    });
    expect(await state("flaky_one")).toBe("draft");
    rt.close();
  });

  it("a program that touches a device the twin lacks moves to needs_review without running; an admin approves it", async () => {
    await save("sniff_gas", {
      seq: [
        {
          call: {
            tool: "wait_until",
            args: { condition: { device: "mcu1.gas", channel: "ppm", op: "gt", value: 400 }, timeout_ms: 1000 },
          },
        },
      ],
    });
    const rt = await twin("s3-sim");
    const r = await tool(TOKENS.a, "verify_program", {
      name: "sniff_gas",
      robot_id: "s3-sim",
      trials: 2,
      request_id: rid(),
    });
    expect(r.envelope).toMatchObject({
      ok: true,
      data: { success_rate: null, outcomes: [], state: "needs_review", missing: ["mcu1.gas"] },
    });
    expect(rt.calls).toHaveLength(0);

    const hw = await FakeRuntime.connect("a9");
    const refused = await tool(TOKENS.a, "run_program", { robot_id: "a9", name: "sniff_gas", request_id: rid() });
    expect(refused.envelope).toMatchObject({
      ok: false,
      error: { code: "program_not_runnable", message: expect.stringContaining("needs_review") },
    });

    expect((await http("/api/programs/sniff_gas/1/approve", { method: "POST", token: TOKENS.a })).status).toBe(403);
    const approved = await http("/api/programs/sniff_gas/1/approve", { method: "POST", token: TOKENS.admin });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ ok: true, data: { state: "approved" } });
    expect((await http("/api/programs/sniff_gas/1/approve", { method: "POST", token: TOKENS.admin })).status).toBe(409);
    hw.answer = () => ({ ok: true, data: { outcome: "succeeded", steps: [], ms: 3 } });
    expect(
      (await tool(TOKENS.a, "run_program", { robot_id: "a9", name: "sniff_gas", request_id: rid() })).envelope,
    ).toMatchObject({ ok: true, data: { outcome: "succeeded" } });
    const listed = (await (await http("/api/programs?state=approved", { token: TOKENS.admin })).json()) as {
      data: { name: string }[];
    };
    expect(listed.data.map((p) => p.name)).toContain("sniff_gas");
    rt.close();
    hw.close();
  });

  it("verify_program needs a twin, and stop aborts the trial loop", async () => {
    await save("long_walk");
    const hw = await FakeRuntime.connect("a1");
    expect(
      (await tool(TOKENS.a, "verify_program", { name: "long_walk", robot_id: "a1", trials: 1, request_id: rid() }))
        .envelope,
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
    hw.close();

    const rt = await twin("s4-sim", PATIENT);
    rt.answer = (c) => (c.tool === "run_program" ? "hang" : { ok: true, data: {} });
    const verifying = tool(TOKENS.a, "verify_program", {
      name: "long_walk",
      robot_id: "s4-sim",
      trials: 5,
      request_id: rid(),
    });
    await rt.called("run_program");
    expect((await tool(TOKENS.a, "stop", { robot_id: "s4-sim" })).envelope).toMatchObject({
      ok: true,
      data: { motors_stopped: true },
    });
    const r = await verifying;
    expect(r.envelope).toMatchObject({
      ok: true,
      data: { success_rate: null, state: "draft" },
      robot: { activity: "idle" },
    });
    expect(rt.toolCalls("run_program")).toHaveLength(1);
    expect(await state("long_walk")).toBe("draft");
    rt.close();
  });
});

describe("run_program", () => {
  it("on hardware a draft is refused; after verification it runs with the stored body; on a twin a draft runs", async () => {
    await save("park_it");
    const hw = await FakeRuntime.connect("a2");
    hw.answer = () => ({
      ok: true,
      data: {
        outcome: "succeeded",
        steps: [{ path: "seq[0]", tool: "drive", ok: true, reason: "completed", ms: 3 }],
        ms: 9,
      },
    });
    const draft = await tool(TOKENS.a, "run_program", { robot_id: "a2", name: "park_it", request_id: rid() });
    expect(draft.isError).toBe(true);
    expect(draft.envelope).toMatchObject({
      ok: false,
      error: { code: "program_not_runnable", retryable: false, message: expect.stringContaining("draft") },
      robot: { activity: "idle" },
      next: expect.arrayContaining(["verify_program"]),
    });
    expect(hw.calls).toHaveLength(0);

    const rt = await twin("s5-sim");
    rt.answer = () => ({ ok: true, data: { outcome: "succeeded", steps: [], ms: 5 } });
    expect(
      (await tool(TOKENS.a, "run_program", { robot_id: "s5-sim", name: "park_it", request_id: rid() })).envelope,
    ).toMatchObject({ ok: true, data: { outcome: "succeeded" } });
    expect(
      (await tool(TOKENS.a, "verify_program", { name: "park_it", robot_id: "s5-sim", trials: 1, request_id: rid() }))
        .envelope,
    ).toMatchObject({ ok: true, data: { state: "verified" } });

    const run = await tool(TOKENS.a, "run_program", { robot_id: "a2", name: "park_it", request_id: rid() });
    expect(run.envelope).toMatchObject({
      ok: true,
      data: { outcome: "succeeded", steps: [{ tool: "drive" }] },
      robot: { activity: "idle" },
    });
    expect(hw.calls).toHaveLength(1);
    expect(hw.calls[0]).toMatchObject({
      tool: "run_program",
      args: { name: "park_it", version: 1, body: BODY },
      deadline_ms: 1300,
    });
    const runs = await sql(
      "SELECT robot_id, backend, outcome FROM program_runs WHERE name='park_it' AND robot_id='a2'",
    );
    expect(runs).toEqual([{ robot_id: "a2", backend: "ev3", outcome: "succeeded" }]);

    // a robot built differently (other limits → other profile_hash) does not inherit the verification
    const other = await FakeRuntime.connect("a3", {
      profile: { ...PROFILE("a3"), limits: { ...PROFILE("a3").limits, max_speed_pct: 90 } },
    });
    const mismatch = await tool(TOKENS.a, "run_program", { robot_id: "a3", name: "park_it", request_id: rid() });
    expect(mismatch.envelope).toMatchObject({
      ok: false,
      error: { code: "program_not_runnable", message: expect.stringMatching(/verified on s5-sim.*profile_hash/) },
    });
    expect(other.calls).toHaveLength(0);
    other.close();
    rt.close();
    hw.close();
  });

  it("activity is running_program while it runs, and a retired program runs nowhere", async () => {
    await save("spin_spin");
    const rt = await twin("s6-sim", PATIENT);
    rt.answer = (c) => (c.tool === "run_program" ? "hang" : { ok: true, data: {} });
    const running = tool(TOKENS.a, "run_program", { robot_id: "s6-sim", name: "spin_spin", request_id: rid() });
    await rt.called("run_program");
    expect((await tool(TOKENS.a, "read_all", { robot_id: "s6-sim" })).envelope.robot).toMatchObject({
      activity: "running_program",
    });
    expect(
      (await tool(TOKENS.a, "drive", { robot_id: "s6-sim", distance_cm: 1, request_id: rid() })).envelope,
    ).toMatchObject({ ok: false, error: { code: "busy" } });
    rt.send({ t: "result", call_id: rt.calls[0]!.call_id, ok: true, data: { outcome: "failed", steps: [], ms: 1 } });
    expect((await running).envelope).toMatchObject({
      ok: true,
      data: { outcome: "failed" },
      robot: { activity: "idle" },
    });

    expect(
      (await tool(TOKENS.b, "retire_program", { name: "spin_spin", version: 1, request_id: rid() })).envelope,
    ).toMatchObject({ ok: false, error: { code: "unauthorized", message: expect.stringContaining("user-a") } });
    expect(
      (await tool(TOKENS.a, "retire_program", { name: "spin_spin", version: 1, request_id: rid() })).envelope,
    ).toMatchObject({ ok: true, data: { state: "retired" } });
    expect(
      (await tool(TOKENS.admin, "retire_program", { name: "spin_spin", version: 1, request_id: rid() })).envelope,
    ).toMatchObject({ ok: false, error: { code: "illegal_state", message: expect.stringContaining("retired") } });
    expect(
      (await tool(TOKENS.a, "run_program", { robot_id: "s6-sim", name: "spin_spin", request_id: rid() })).envelope,
    ).toMatchObject({
      ok: false,
      error: { code: "program_not_runnable", message: expect.stringContaining("retired") },
    });
    expect(
      (await tool(TOKENS.a, "verify_program", { name: "spin_spin", robot_id: "s6-sim", trials: 1, request_id: rid() }))
        .envelope,
    ).toMatchObject({ ok: false, error: { code: "illegal_state" } });
    rt.close();
  });
});
