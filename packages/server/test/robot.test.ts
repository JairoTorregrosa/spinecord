// The robot's state machines: link, activity, control, call, episode, provider.
import { beforeAll, describe, expect, it } from "bun:test";
import {
  FakeOrgan,
  FakeRuntime,
  GAS,
  PATIENT,
  PROFILE,
  TOKENS,
  evict,
  http,
  logged,
  open,
  rid,
  sleep,
  sql,
  tool,
  until,
  resetRelay,
} from "./harness.ts";

beforeAll(resetRelay);

const drive = (robot_id: string, request_id = rid(), token: string = TOKENS.a) =>
  tool(token, "drive", { robot_id, distance_cm: 10, request_id });
const robot = async (id: string) => {
  const r = await tool(TOKENS.admin, "list_robots");
  return r.envelope.ok ? r.envelope.data.find((x: { id: string }) => x.id === id) : null;
};
const calls = (robot_id: string) =>
  sql<{ tool: string; state: string; code: string | null; request_id: string | null; moving: number }>(
    "SELECT tool, state, code, request_id, moving, episode_id FROM calls WHERE robot_id=?1 ORDER BY created_at, rowid",
    robot_id,
  );

describe("dispatch", () => {
  it("a robot tool goes to the runtime without robot_id/request_id and returns its data with state and next", async () => {
    const rt = await FakeRuntime.connect("a10");
    rt.answer = () => ({
      ok: true,
      data: {
        requested: { distance_cm: 10 },
        measured: { distance_cm: 9.6 },
        clamped: false,
        reason: "completed",
        ms: 400,
      },
    });
    const r = await drive("a10");
    expect(r.isError).toBe(false);
    expect(r.envelope).toMatchObject({
      ok: true,
      robot: { id: "a10", backend: "ev3", link: "online", activity: "idle", control: "owner", episode: "none" },
      data: { measured: { distance_cm: 9.6 } },
    });
    expect(r.envelope.next.length).toBeGreaterThan(0);
    expect(rt.calls).toHaveLength(1);
    expect(rt.calls[0]).toMatchObject({
      t: "call",
      tool: "drive",
      args: { distance_cm: 10 },
      deadline_ms: 900, // max_command_ms 600 + margin 200 + the runtime's stop_worst_ms 100
      activity: "acting",
    });
    await tool(TOKENS.a, "read_all", { robot_id: "a10" });
    expect(rt.calls[1]).toMatchObject({ tool: "read_all", activity: "idle" });
    expect(rt.calls[0]!.args).not.toHaveProperty("robot_id");
    expect(rt.calls[0]!.args).not.toHaveProperty("request_id");
    expect(await calls("a10")).toMatchObject([
      { tool: "drive", state: "completed", code: null, moving: 1 },
      { tool: "read_all", state: "completed" },
    ]);
    rt.close();
  });

  it("a runtime error keeps its code; the call ends failed", async () => {
    const rt = await FakeRuntime.connect("a11");
    rt.answer = () => ({ ok: false, error: { code: "unsupported", message: "this robot has no drivetrain" } });
    const r = await drive("a11");
    expect(r.envelope).toMatchObject({
      ok: false,
      error: { code: "unsupported", message: "this robot has no drivetrain", retryable: false },
      robot: { activity: "idle" },
    });
    expect(await calls("a11")).toMatchObject([{ state: "failed", code: "unsupported" }]);
    rt.close();
  });
});

describe("idempotency and rate limit", () => {
  it("a retry with the same request_id returns the stored result and does not dispatch again", async () => {
    const rt = await FakeRuntime.connect("a12");
    let n = 0;
    rt.answer = () => ({ ok: true, data: { reason: "completed", run: ++n } });
    const request_id = rid();
    const first = await drive("a12", request_id);
    const again = await drive("a12", request_id);
    expect(again.envelope).toEqual(first.envelope);
    expect(first.envelope).toMatchObject({ ok: true, data: { run: 1 } });
    expect(rt.toolCalls("drive")).toHaveLength(1);
    const other = await drive("a12");
    expect(other.envelope).toMatchObject({ ok: true, data: { run: 2 } });
    // the same request_id for a different action is refused, not replayed and not executed
    const reused = await tool(TOKENS.a, "drive", { robot_id: "a12", distance_cm: 55, request_id });
    expect(reused.envelope).toMatchObject({
      ok: false,
      error: { code: "invalid_argument", message: expect.stringContaining("request_id") },
    });
    expect(rt.toolCalls("drive")).toHaveLength(2);
    expect((await calls("a12")).map((c) => c.state)).toEqual(["completed", "deduplicated", "completed", "rejected"]);
    rt.close();
  });

  it("a retry that arrives while the first call is still running joins it", async () => {
    const rt = await FakeRuntime.connect("a13", { profile: PROFILE("a13", PATIENT) });
    rt.answer = () => "hang";
    const request_id = rid();
    const first = drive("a13", request_id);
    await rt.called("drive");
    const second = drive("a13", request_id);
    await sleep(50);
    rt.send({
      t: "result",
      call_id: rt.calls[0]!.call_id,
      ok: true,
      data: { reason: "completed", measured: { distance_cm: 10 } },
    });
    const [a, b] = await Promise.all([first, second]);
    expect(b.envelope).toEqual(a.envelope);
    expect(a.envelope.ok).toBe(true);
    expect(rt.calls).toHaveLength(1);
    rt.close();
  });

  it("a call rejected before it could act is not stored: the same request_id may be retried", async () => {
    const request_id = rid();
    const offline = await drive("a14", request_id);
    expect(offline.envelope).toMatchObject({ ok: false, error: { code: "robot_offline" } });
    const rt = await FakeRuntime.connect("a14");
    const retry = await drive("a14", request_id);
    expect(retry.envelope.ok).toBe(true);
    expect(rt.calls).toHaveLength(1);
    rt.close();
  });

  it("more than 5 mutating calls per second on one robot are rate_limited", async () => {
    const rt = await FakeRuntime.connect("a15");
    const outs = await Promise.all(
      Array.from({ length: 8 }, () =>
        tool(TOKENS.a, "command_device", { robot_id: "a15", device: "speaker", command: "beep", request_id: rid() }),
      ),
    );
    const limited = outs.filter((o) => !o.envelope.ok && o.envelope.error.code === "rate_limited");
    expect(outs.filter((o) => o.envelope.ok)).toHaveLength(5);
    expect(limited).toHaveLength(3);
    expect(limited[0]!.envelope).toMatchObject({ error: { retryable: true, retry_after_ms: expect.any(Number) } });
    expect(rt.calls).toHaveLength(5);
    // reads are not limited
    const reads = await Promise.all(Array.from({ length: 8 }, () => tool(TOKENS.a, "read_all", { robot_id: "a15" })));
    expect(reads.every((o) => o.envelope.ok)).toBe(true);
    rt.close();
  });
});

describe("activity", () => {
  it("a moving tool needs idle: busy while acting, and reset_fault outside fault is illegal_state", async () => {
    const rt = await FakeRuntime.connect("a16", { profile: PROFILE("a16", PATIENT) });
    rt.answer = (c) => (c.tool === "drive" ? "hang" : { ok: true, data: {} });
    const long = drive("a16");
    await rt.called("drive");
    const second = await tool(TOKENS.a, "turn", { robot_id: "a16", angle_deg: 90, request_id: rid() });
    expect(second.envelope).toMatchObject({
      ok: false,
      error: { code: "busy", retryable: true, retry_after_ms: expect.any(Number) },
      robot: { activity: "acting" },
    });
    const reset = await tool(TOKENS.a, "reset_fault", { robot_id: "a16", request_id: rid() });
    expect(reset.envelope).toMatchObject({
      ok: false,
      error: { code: "illegal_state", message: expect.stringContaining("acting") },
    });
    // read tools work in every online state and do not wait behind the move
    const read = await tool(TOKENS.a, "read_all", { robot_id: "a16" });
    expect(read.envelope).toMatchObject({ ok: true, robot: { activity: "acting" } });
    expect(rt.toolCalls("turn")).toHaveLength(0);
    rt.send({ t: "result", call_id: rt.toolCalls("drive")[0]!.call_id, ok: true, data: { reason: "completed" } });
    expect((await long).envelope).toMatchObject({ ok: true, robot: { activity: "idle" } });
    rt.close();
  });

  it("3 consecutive stalled results put the robot in fault; only stop and reset_fault act there", async () => {
    const rt = await FakeRuntime.connect("a17");
    rt.answer = (c) =>
      c.tool === "drive" ? { ok: true, data: { reason: "stalled" } } : { ok: true, data: { activity: "idle" } };
    expect((await drive("a17")).envelope.robot?.activity).toBe("idle");
    expect((await drive("a17")).envelope.robot?.activity).toBe("idle");
    expect((await drive("a17")).envelope.robot?.activity).toBe("fault");
    const refused = await drive("a17");
    expect(refused.envelope).toMatchObject({
      ok: false,
      error: { code: "fault", message: expect.stringContaining("stalled") },
    });
    const beep = await tool(TOKENS.a, "command_device", {
      robot_id: "a17",
      device: "speaker",
      command: "beep",
      request_id: rid(),
    });
    expect(beep.envelope).toMatchObject({ ok: false, error: { code: "fault" } });
    await sleep(1000); // stay under 5 mutating calls per second
    const stop = await tool(TOKENS.a, "stop", { robot_id: "a17" });
    expect(stop.envelope).toMatchObject({ ok: true, data: { motors_stopped: true, activity: "fault" } });
    const reset = await tool(TOKENS.a, "reset_fault", { robot_id: "a17", request_id: rid() });
    expect(reset.envelope).toMatchObject({ ok: true, robot: { activity: "idle" } });
    expect((await drive("a17")).envelope.robot?.activity).toBe("idle");
    rt.close();
  });

  it("reset_fault that the runtime cannot verify leaves the robot in fault", async () => {
    const rt = await FakeRuntime.connect("a18");
    rt.send({ t: "hb", ts: Date.now(), fault: "brick reported an error" });
    await until("fault", async () => (await robot("a18")).activity === "fault");
    expect((await robot("a18")).fault_reason).toContain("brick reported an error");
    rt.answer = () => ({ ok: false, error: { code: "stop_unverified", message: "motor B still turning" } });
    const reset = await tool(TOKENS.a, "reset_fault", { robot_id: "a18", request_id: rid() });
    expect(reset.envelope).toMatchObject({
      ok: false,
      error: { code: "stop_unverified" },
      robot: { activity: "fault" },
    });
    rt.close();
  });

  it("a battery device reporting low puts the robot in fault", async () => {
    const rt = await FakeRuntime.connect("b1", { token: TOKENS.rtB });
    // every heartbeat carries it: the link stays up, and a plain heartbeat would report the battery fine again
    rt.hb = { battery_low: true };
    await until("fault", async () => (await robot("b1")).activity === "fault");
    expect(await robot("b1")).toMatchObject({
      battery_low: true,
      fault_reason: expect.stringContaining("battery low"),
    });
    expect(
      (await tool(TOKENS.b, "drive", { robot_id: "b1", distance_cm: 5, request_id: rid() })).envelope,
    ).toMatchObject({ ok: false, error: { code: "fault", message: expect.stringContaining("battery") } });
    rt.close();
    await until("offline", async () => (await robot("b1")).link === "offline");
  });

  it("a call that outlives its deadline is aborted, the robot is stopped, and the call ends timed_out", async () => {
    const rt = await FakeRuntime.connect("a19");
    rt.answer = () => "hang";
    rt.reportOnAbort = false;
    const request_id = rid();
    const r = await drive("a19", request_id); // budget 600 ms (profile) + twice the grace (200 ms margin + 100 ms stop)
    expect(r.envelope).toMatchObject({
      ok: false,
      error: { code: "timeout", retryable: false }, // it may have moved: nothing invites driving again
      robot: { activity: "idle" },
    });
    expect(r.envelope.next).not.toContain("drive");
    expect(rt.aborts).toEqual([rt.calls[0]!.call_id]);
    expect(rt.stops).toBe(1);
    expect(await calls("a19")).toMatchObject([{ tool: "drive", state: "timed_out", code: "timeout" }]);
    // the same request_id replays the stored result and reaches the robot once
    expect((await drive("a19", request_id)).envelope).toEqual(r.envelope);
    expect(rt.toolCalls("drive")).toHaveLength(1);
    // a runtime that aborts the move at its deadline itself: still not retryable, whatever it claims
    rt.answer = () => ({
      ok: false,
      error: { code: "timeout", message: "drive exceeded its deadline", retryable: true },
    });
    expect((await drive("a19")).envelope).toMatchObject({ ok: false, error: { code: "timeout", retryable: false } });
    rt.close();
  });
});

describe("stop", () => {
  it("stop preempts a long call: stop and abort go out at once, the call ends preempted, the robot is idle", async () => {
    const rt = await FakeRuntime.connect("a20", { profile: PROFILE("a20", PATIENT) });
    rt.answer = (c) => (c.tool === "drive" ? "hang" : { ok: true, data: {} });
    const long = drive("a20");
    await rt.called("drive");
    // a non-moving command waits in the serial queue behind the move
    const queued = tool(TOKENS.a, "command_device", {
      robot_id: "a20",
      device: "speaker",
      command: "beep",
      request_id: rid(),
    });
    await logged("queued", { robot_id: "a20", tool: "command_device" });
    // the move would run for a minute: a stop that answers at all did not wait for it
    const stop = await tool(TOKENS.a, "stop", { robot_id: "a20" });
    expect(stop.envelope).toMatchObject({
      ok: true,
      data: { motors_stopped: true, activity: "idle" },
      robot: { activity: "idle" },
    });
    expect(rt.stops).toBe(1);
    expect(rt.aborts).toEqual([rt.toolCalls("drive")[0]!.call_id]);
    const moved = await long;
    expect(moved.envelope).toMatchObject({
      ok: true,
      data: { reason: "preempted", measured: { distance_cm: 3 } },
      robot: { activity: "idle" },
    });
    // the queued call was flushed, never sent: the robot does not act after a stop
    expect((await queued).envelope).toMatchObject({ ok: false, error: { code: "busy" } });
    expect(rt.toolCalls("command_device")).toHaveLength(0);
    const log = await calls("a20");
    expect(log.find((c) => c.tool === "drive")).toMatchObject({ state: "preempted" });
    expect(log.find((c) => c.tool === "command_device")).toMatchObject({ state: "preempted" });
    expect(log.find((c) => c.tool === "stop")).toMatchObject({ state: "completed" });
    // after the stop the robot acts again
    rt.answer = () => ({ ok: true, data: { reason: "completed" } });
    expect((await drive("a20")).envelope.ok).toBe(true);
    expect(rt.toolCalls("drive")).toHaveLength(2);
    rt.close();
  });

  it("any principal that can see the robot may stop it, even without control", async () => {
    const rt = await FakeRuntime.connect("a21");
    await tool(TOKENS.admin, "take_control", { robot_id: "a21", request_id: rid() });
    const denied = await drive("a21");
    expect(denied.envelope).toMatchObject({
      ok: false,
      error: { code: "not_in_control" },
      robot: { control: "admin" },
    });
    const stop = await tool(TOKENS.a, "stop", { robot_id: "a21" });
    expect(stop.envelope).toMatchObject({ ok: true, data: { motors_stopped: true } });
    rt.close();
  });

  it("a stop the runtime does not confirm within the window is stop_unverified and the robot is in fault", async () => {
    const rt = await FakeRuntime.connect("a22");
    rt.stopVerdict = null; // heartbeats keep coming, but only {t:"stopped"} verifies a stop
    const started = Date.now();
    const silent = await tool(TOKENS.a, "stop", { robot_id: "a22" });
    // the window is the runtime's announced stop_worst_ms (100) + the margin (200 in tests, 500 deployed)
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(silent.isError).toBe(true);
    expect(silent.envelope).toMatchObject({
      ok: false,
      error: { code: "stop_unverified" },
      robot: { activity: "fault" },
    });
    rt.stopVerdict = false; // the runtime says it could not verify
    const said = await tool(TOKENS.a, "stop", { robot_id: "a22" });
    expect(said.envelope).toMatchObject({
      ok: false,
      error: { code: "stop_unverified" },
      robot: { activity: "fault" },
    });
    rt.stopVerdict = true;
    rt.wrongStopId = true; // an answer to some other stop verifies nothing
    expect((await tool(TOKENS.a, "stop", { robot_id: "a22" })).envelope).toMatchObject({
      ok: false,
      error: { code: "stop_unverified" },
    });
    rt.wrongStopId = false;
    // answered with the right stop_id it is verified (ok), and stop alone does not clear a fault
    expect((await tool(TOKENS.a, "stop", { robot_id: "a22" })).envelope).toMatchObject({
      ok: true,
      data: { motors_stopped: true, activity: "fault" },
    });
    expect(
      rt.frames.filter((f) => f.t === "stop").every((f) => typeof f.stop_id === "string" && f.stop_id.length > 8),
    ).toBe(true);
    rt.close();
  });

  it("two stops at once share one stop; stop on an offline robot says so", async () => {
    // the runtime holds its answer (inside a long announced window) until the relay has both stops
    const rt = await FakeRuntime.connect("a23", { hello: { stop_worst_ms: 60_000 } });
    rt.stopVerdict = null;
    const both = Promise.all([
      tool(TOKENS.a, "stop", { robot_id: "a23" }),
      tool(TOKENS.admin, "stop", { robot_id: "a23" }),
    ]);
    await logged("stop_joined", { robot_id: "a23" });
    // the log line and the {t:"stop"} frame travel on different channels: the frame may still be on its way
    const frame = await rt.frame("stop");
    expect(rt.frames.filter((f) => f.t === "stop")).toHaveLength(1);
    rt.send({ t: "stopped", stop_id: frame.stop_id, motors_stopped: true });
    const [x, y] = await both;
    expect(x.envelope.ok && y.envelope.ok).toBe(true);
    expect(y.envelope).toEqual(x.envelope);
    expect(rt.stops).toBe(1);
    rt.close();
    await until("offline", async () => (await robot("a23")).link === "offline");
    expect((await tool(TOKENS.a, "stop", { robot_id: "a23" })).envelope).toMatchObject({
      ok: false,
      error: { code: "robot_offline" },
    });
  });
});

describe("link", () => {
  it("heartbeat loss: the robot goes offline, the in-flight call fails robot_offline, a moving robot is in fault", async () => {
    const rt = await FakeRuntime.connect("a24", { profile: PROFILE("a24", PATIENT) });
    rt.answer = () => "hang";
    const long = drive("a24");
    await rt.called("drive");
    rt.heartbeat = false;
    const r = await long;
    expect(r.envelope).toMatchObject({
      ok: false,
      error: { code: "robot_offline", retryable: true },
      robot: { link: "offline", activity: "fault" },
    });
    await until("socket closed by the relay", () => rt.closed !== null);
    expect(rt.closed?.code).toBe(4000);
    expect(await calls("a24")).toMatchObject([{ tool: "drive", state: "failed", code: "robot_offline" }]);
    expect((await tool(TOKENS.a, "read_all", { robot_id: "a24" })).envelope).toMatchObject({
      ok: false,
      error: { code: "robot_offline" },
    });
    // it comes back: still in fault until someone looks and resets
    const back = await FakeRuntime.connect("a24");
    expect(await robot("a24")).toMatchObject({ link: "online", activity: "fault" });
    expect((await tool(TOKENS.a, "reset_fault", { robot_id: "a24", request_id: rid() })).envelope).toMatchObject({
      ok: true,
      robot: { activity: "idle" },
    });
    back.close();
  });

  it("the relay sends heartbeats; a socket that never says hello is closed; an idle robot that disconnects stays idle", async () => {
    const rt = await FakeRuntime.connect("a25");
    await until("relay heartbeats", () => rt.frames.filter((f) => f.t === "hb").length >= 3);
    rt.close();
    await until("offline", async () => (await robot("a25")).link === "offline");
    expect(await robot("a25")).toMatchObject({ activity: "idle" });

    const ws = await open("/ws/robot?robot_id=a25");
    let closed = 0;
    ws.addEventListener("close", (e) => {
      closed = e.code;
    });
    expect(await robot("a25")).toMatchObject({ link: "handshaking" });
    await until("mute socket closed", () => closed !== 0);
    expect(closed).toBe(4001);
    expect(await robot("a25")).toMatchObject({ link: "offline" });
  });

  it("a new hello for the same robot replaces the old socket", async () => {
    const old = await FakeRuntime.connect("a26");
    const fresh = await FakeRuntime.connect("a26");
    await until("old socket closed", () => old.closed !== null);
    expect(old.closed).toMatchObject({ code: 4002 });
    expect(await robot("a26")).toMatchObject({ link: "online" });
    await drive("a26");
    expect(old.calls).toHaveLength(0);
    expect(fresh.calls).toHaveLength(1);
    fresh.close();
  });

  it("without ?robot_id= the worker reads it from hello and bridges the socket", async () => {
    const rt = await FakeRuntime.connect("a27", { path: "/ws/robot" });
    expect(rt.welcomed).toBe(true);
    expect((await drive("a27")).envelope.ok).toBe(true);
    expect(rt.calls).toHaveLength(1);
    rt.close();
    await until("offline", async () => (await robot("a27")).link === "offline");
    const ghost = await FakeRuntime.connect("nobody", { path: "/ws/robot" });
    expect(ghost.closed?.code).toBe(4001);
  });
});

describe("durable state", () => {
  it("after the object is evicted: the link is rebuilt from the socket, control and the idempotency cache survive", async () => {
    const rt = await FakeRuntime.connect("b1", { token: TOKENS.rtB });
    await tool(TOKENS.b, "reset_fault", { robot_id: "b1", request_id: rid() }); // whatever an earlier test left
    const request_id = rid();
    const first = await drive("b1", request_id, TOKENS.b);
    expect(first.envelope.ok).toBe(true);
    await tool(TOKENS.admin, "take_control", { robot_id: "b1", request_id: rid() });

    await evict("b1");

    expect(await robot("b1")).toMatchObject({ link: "online", control: "admin", activity: "idle", backend: "ev3" });
    const again = await drive("b1", request_id, TOKENS.b);
    expect(again.envelope).toEqual(first.envelope);
    expect(rt.toolCalls("drive")).toHaveLength(1);
    // the hibernated socket still works both ways
    expect((await tool(TOKENS.b, "read_all", { robot_id: "b1" })).envelope.ok).toBe(true);
    expect(rt.toolCalls("read_all")).toHaveLength(1);
    rt.close();
  });
});

describe("control", () => {
  it("owner ↔ admin: both transitions stop the robot first; repeating one is illegal_state", async () => {
    const rt = await FakeRuntime.connect("a28");
    const release = await tool(TOKENS.admin, "release_control", { robot_id: "a28", request_id: rid() });
    expect(release.envelope).toMatchObject({
      ok: false,
      error: { code: "illegal_state", message: expect.stringContaining("owner") },
    });
    const adminDrive = await drive("a28", rid(), TOKENS.admin);
    expect(adminDrive.envelope).toMatchObject({
      ok: false,
      error: { code: "not_in_control", message: expect.stringContaining("take_control") },
    });

    const take = await tool(TOKENS.admin, "take_control", { robot_id: "a28", request_id: rid() });
    expect(take.envelope).toMatchObject({ ok: true, data: { control: "admin", stop: { motors_stopped: true } } });
    expect(rt.stops).toBe(1);
    expect((await tool(TOKENS.admin, "take_control", { robot_id: "a28", request_id: rid() })).envelope).toMatchObject({
      ok: false,
      error: { code: "illegal_state" },
    });
    await sleep(1000); // stay under 5 mutating calls per second
    expect((await drive("a28")).envelope).toMatchObject({ ok: false, error: { code: "not_in_control" } });
    expect((await tool(TOKENS.a, "read_all", { robot_id: "a28" })).envelope.ok).toBe(true);
    expect((await drive("a28", rid(), TOKENS.admin)).envelope.ok).toBe(true);

    await sleep(1000); // stay under 5 mutating calls per second
    const res = await http("/api/robots/a28/control", {
      method: "POST",
      token: TOKENS.admin,
      body: JSON.stringify({ to: "owner" }),
    });
    expect(res.status).toBe(200);
    expect(rt.stops).toBe(2);
    expect((await drive("a28")).envelope.ok).toBe(true);
    expect(
      (
        await http("/api/robots/a28/control", {
          method: "POST",
          token: TOKENS.admin,
          body: JSON.stringify({ to: "owner" }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await http("/api/robots/a28/control", {
          method: "POST",
          token: TOKENS.admin,
          body: JSON.stringify({ to: "me" }),
        })
      ).status,
    ).toBe(400);
    rt.close();
    // two 1 s rate-limit waits plus the round trips: more than bun's 5 s default on a slow runner
  }, 20_000);
});

describe("episodes", () => {
  it("none → running → ended → running, with counters taken from the call log", async () => {
    const rt = await FakeRuntime.connect("a29");
    expect(
      (await tool(TOKENS.a, "mark_episode", { robot_id: "a29", kind: "checkpoint", request_id: rid() })).envelope,
    ).toMatchObject({ ok: false, error: { code: "illegal_state", message: expect.stringContaining("none") } });
    expect(
      (await tool(TOKENS.a, "end_episode", { robot_id: "a29", outcome: "x", request_id: rid() })).envelope,
    ).toMatchObject({ ok: false, error: { code: "illegal_state" } });
    await drive("a29"); // before the episode: not counted

    await sleep(1000); // stay under 5 mutating calls per second
    const start = await tool(TOKENS.a, "start_episode", {
      robot_id: "a29",
      label: "first try",
      tags: ["t1"],
      request_id: rid(),
    });
    expect(start.envelope).toMatchObject({
      ok: true,
      data: { state: "running", label: "first try" },
      robot: { episode: "running" },
    });
    expect(
      (await tool(TOKENS.a, "start_episode", { robot_id: "a29", label: "again", request_id: rid() })).envelope,
    ).toMatchObject({ ok: false, error: { code: "illegal_state", message: expect.stringContaining("running") } });

    await drive("a29");
    await tool(TOKENS.a, "read_all", { robot_id: "a29" });
    await tool(TOKENS.a, "command_device", { robot_id: "a29", device: "speaker", command: "beep", request_id: rid() });
    await sleep(1000); // stay under 5 mutating calls per second
    await tool(TOKENS.a, "stop", { robot_id: "a29" });
    await tool(TOKENS.a, "turn", { robot_id: "a29", request_id: rid() }); // invalid_argument → an error
    const mark = await tool(TOKENS.a, "mark_episode", {
      robot_id: "a29",
      kind: "intervention",
      note: "picked it up",
      request_id: rid(),
    });
    expect(mark.envelope).toMatchObject({
      ok: true,
      data: { state: "running", marks: [{ kind: "intervention", note: "picked it up" }] },
    });

    await sleep(1000); // stay under 5 mutating calls per second
    const end = await tool(TOKENS.a, "end_episode", {
      robot_id: "a29",
      outcome: "reached",
      metrics: { cm: 42 },
      request_id: rid(),
    });
    expect(end.envelope).toMatchObject({
      ok: true,
      robot: { episode: "ended" },
      data: {
        label: "first try",
        tags: ["t1"],
        state: "ended",
        calls: 5,
        moving_calls: 1,
        stops: 1,
        errors: 1,
        outcome: "reached",
        metrics: { cm: 42 },
        marks: [{ kind: "intervention" }],
      },
    });
    expect(end.envelope.ok && end.envelope.data.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(
      (await tool(TOKENS.a, "start_episode", { robot_id: "a29", label: "second", request_id: rid() })).envelope,
    ).toMatchObject({ ok: true, robot: { episode: "running" } });

    const api = (await (await http("/api/episodes?robot_id=a29", { token: TOKENS.admin })).json()) as {
      data: { label: string; calls: number }[];
    };
    expect(api.data.map((e) => e.label)).toEqual(["second", "first try"]);
    const log = (await (await http("/api/calls?robot_id=a29&limit=3", { token: TOKENS.admin })).json()) as {
      data: unknown[];
    };
    expect(log.data).toHaveLength(3);
    rt.close();
    // three 1 s rate-limit waits plus about 15 round trips: more than bun's 5 s default on a slow runner
  }, 20_000);
});

describe("organs", () => {
  it("announced → active → stale → gone; requests are proxied to the organ and the organ set is pushed to the runtime", async () => {
    const rt = await FakeRuntime.connect("a30");
    const organs = () =>
      rt.frames.filter((f) => f.t === "organs").at(-1)?.organs as
        | { organ_id: string; state: string; devices: unknown[] }[]
        | undefined;
    const organ = await FakeOrgan.connect("a30", "mcu1", [GAS("mcu1")]);
    expect(organ.welcomed).toBe(true);
    await until("active pushed", () => organs()?.[0]?.state === "active");
    expect(organs()).toMatchObject([{ organ_id: "mcu1", devices: [{ id: "mcu1.gas", kind: "gas" }] }]);
    expect(rt.frames.some((f) => f.t === "organs" && f.organs[0]?.state === "announced")).toBe(true);

    rt.send({ t: "organ_req", req_id: "q1", organ_id: "mcu1", op: "read", device: "mcu1.gas", channels: ["ppm"] });
    await until("organ_res", () => rt.frames.some((f) => f.t === "organ_res" && f.req_id === "q1"));
    expect(rt.frames.find((f) => f.t === "organ_res")).toMatchObject({
      ok: true,
      data: [{ channel: "ppm", value: 7 }],
    });
    expect(organ.frames.find((f) => f.t === "req")).toMatchObject({ req_id: "q1", op: "read", device: "mcu1.gas" });
    rt.send({ t: "organ_req", req_id: "qs", organ_id: "mcu1", op: "stop" });
    await until("organ stop", () => rt.frames.some((f) => f.req_id === "qs"));
    expect(rt.frames.find((f) => f.req_id === "qs")).toMatchObject({ ok: true, data: { motors_stopped: true } });
    expect(organ.frames.find((f) => f.req_id === "qs")).toMatchObject({ t: "req", op: "stop" });
    rt.send({ t: "organ_req", req_id: "q2", organ_id: "nose", op: "read", device: "nose.x" });
    await until("unknown organ", () => rt.frames.some((f) => f.req_id === "q2"));
    expect(rt.frames.find((f) => f.req_id === "q2")).toMatchObject({ ok: false, error: { code: "unknown_device" } });

    // stop reaches organs too
    await tool(TOKENS.a, "stop", { robot_id: "a30" });
    // the stop is answered by the runtime; the organ's frame travels on its own socket
    await until("stop frame at the organ", () => organ.frames.some((f) => f.t === "stop"));

    organ.heartbeat = false;
    await until("stale", () => organs()?.[0]?.state === "stale");
    rt.send({ t: "organ_req", req_id: "q3", organ_id: "mcu1", op: "read", device: "mcu1.gas" });
    await until("stale answer", () => rt.frames.some((f) => f.req_id === "q3"));
    expect(rt.frames.find((f) => f.req_id === "q3")).toMatchObject({ ok: false, error: { code: "provider_stale" } });
    organ.heartbeat = true;
    await until("active again", () => organs()?.[0]?.state === "active");
    organ.heartbeat = false;
    await until("gone", () => organs()?.[0]?.state === "gone" || organs()?.length === 0, 4000);
    await until("organ socket closed", () => organ.closed !== null);
    expect((await robot("a30")).organs).toEqual([]);

    // an organ may only announce its own devices, each with bounded commands
    const liar = await FakeOrgan.connect("a30", "cam1", [GAS("ev3")]);
    expect(liar.closed).toMatchObject({ code: 4001, reason: expect.stringContaining("cam1") });
    const stranger = await FakeOrgan.connect("a30", "cam1", [GAS("cam1")], TOKENS.b);
    expect(stranger.closed?.code).toBe(4001);
    rt.close();
    // waits out the stale and gone windows (ORGAN_GONE_MS 1000) twice over: more than bun's 5 s default on a slow runner
  }, 20_000);
});
