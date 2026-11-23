// The per-robot state machine, in-process: a mock provider whose stop can be made to fail, and a twin whose
// simulated brick is read directly.
import { describe, expect, test } from "bun:test";
import { ACTIVITY_TRANSITIONS, RuntimeError, type RobotProfile } from "../../../packages/protocol/types";
import { firstViolation } from "../../../packages/protocol/schema";
import { TOOLS } from "../../../packages/protocol/tools";
import { realClock } from "../../../packages/runtime/clock";
import { MockProvider } from "../../../packages/runtime/mock";
import { createRuntime } from "../../../packages/runtime/runtime";
import { EXAMPLE, loadConfig } from "../src/config";
import { LocalRobot } from "../src/robot";
import { buildFleet, keepAttached } from "../src/sources";
import { logCall } from "../src/mcp";
import { NEXT_ERR, NEXT_OK, TOOL, callTool } from "../src/tools";
import { until } from "./client";

const PROFILE: RobotProfile = {
  id: "m1",
  roles: {},
  notes: [],
  limits: { max_speed_pct: 80, max_command_ms: 10000, max_program_ms: 20000, max_loop_ms: 30000 },
  drivetrain: {
    type: "differential",
    pair_device: "mock.pair",
    wheel_diameter_cm: 5.6,
    axle_track_cm: 12,
    forward_sign: 1,
    max_drive_cm: 100,
    max_turn_deg: 360,
  },
};
async function mockRobot() {
  const mock = new MockProvider({ clock: realClock });
  const transitions: string[] = [];
  const robot = new LocalRobot({
    id: "m1",
    onTransition: (fsm, from, to) => {
      if (fsm === "activity") {
        // every transition the robot makes is in the contract's table
        expect(ACTIVITY_TRANSITIONS[from as keyof typeof ACTIVITY_TRANSITIONS]).toContain(to as never);
        transitions.push(`${from}→${to}`);
      }
    },
  });
  await robot.attach(createRuntime({ profile: PROFILE, providers: [mock], clock: realClock }));
  const tool = async (name: string, args: Record<string, unknown> = {}) =>
    (await callTool([robot], name, { robot_id: "m1", ...args })).envelope;
  return { mock, robot, tool, transitions };
}

describe("attach", () => {
  const attachWith = async (stops: boolean[]) => {
    const mock = new MockProvider({ clock: realClock });
    const orig = mock.stop.bind(mock);
    let n = 0;
    mock.stop = async () => {
      mock.stopVerified = stops[Math.min(n++, stops.length - 1)]!;
      return orig();
    };
    const robot = new LocalRobot({ id: "m1" });
    await robot.attach(createRuntime({ profile: PROFILE, providers: [mock], clock: realClock }));
    return { robot, stops: () => n };
  };
  test("a bridge that misses its first stop is online and idle when a second stop is verified", async () => {
    const { robot, stops } = await attachWith([false, true]);
    expect(robot.listing()).toMatchObject({ link: "online", activity: "idle", fault_reason: null });
    expect(stops()).toBe(2);
  });
  test("a bridge that misses two stops is online and idle when the third is verified", async () => {
    const { robot, stops } = await attachWith([false, false, true]);
    expect(robot.listing()).toMatchObject({ link: "online", activity: "idle" });
    expect(stops()).toBe(3);
  });
  test("a robot whose three stops at connection are unverified is online in fault", async () => {
    const { robot, stops } = await attachWith([false]);
    expect(robot.listing()).toMatchObject({ link: "online", activity: "fault" });
    expect(robot.listing().fault_reason).toContain("could not be verified");
    expect(stops()).toBe(3);
  });
  test("a verified first stop is the only one", async () => {
    const { robot, stops } = await attachWith([true]);
    expect(robot.listing()).toMatchObject({ link: "online", activity: "idle" });
    expect(stops()).toBe(1);
  });
});

describe("activity", () => {
  test("a move goes idle → acting → idle; a program idle → running_program → idle", async () => {
    const { tool, transitions } = await mockRobot();
    expect(await tool("drive", { distance_cm: 2, speed_pct: 80 })).toMatchObject({ ok: true });
    expect(await tool("run_program", { body: { wait_ms: 10 } })).toMatchObject({ ok: true });
    expect(transitions).toEqual(["idle→acting", "acting→idle", "idle→running_program", "running_program→idle"]);
  });

  test("an unverified stop puts the robot in fault; only stop and reset_fault act there", async () => {
    const { mock, robot, tool } = await mockRobot();
    mock.stopVerified = false;
    const stop = await tool("stop");
    expect(stop).toMatchObject({
      ok: true,
      data: { motors_stopped: false, activity: "fault" },
      robot: { activity: "fault" },
    });
    expect(robot.listing().fault_reason).toContain("could not be verified");
    expect(await tool("drive", { distance_cm: 2 })).toMatchObject({
      ok: false,
      error: { code: "fault", retryable: false },
      next: ["read_all", "reset_fault"],
    });
    expect(await tool("command_device", { device: "mock.speaker", command: "beep", args: {} })).toMatchObject({
      ok: false,
      error: { code: "fault" },
    });
    expect(await tool("read_all")).toMatchObject({ ok: true, robot: { activity: "fault" } });
    // the stop still cannot be verified: the fault stays
    expect(await tool("reset_fault")).toMatchObject({ ok: false, error: { code: "stop_unverified" } });
    mock.stopVerified = true;
    // a verified stop does not leave fault by itself
    expect(await tool("stop")).toMatchObject({ ok: true, data: { motors_stopped: true, activity: "fault" } });
    expect(await tool("reset_fault")).toMatchObject({
      ok: true,
      data: { activity: "idle" },
      robot: { activity: "idle" },
    });
    expect(await tool("drive", { distance_cm: 2, speed_pct: 80 })).toMatchObject({ ok: true });
  });

  test("reset_fault outside fault is illegal_state and names the state", async () => {
    const { tool } = await mockRobot();
    const e = await tool("reset_fault");
    expect(e).toMatchObject({ ok: false, error: { code: "illegal_state" } });
    expect(!e.ok && e.error.message).toContain("idle");
  });

  test("a stop that fails while a move runs: the move ends preempted and the robot is in fault, not idle", async () => {
    const { mock, tool } = await mockRobot();
    const move = tool("drive", { distance_cm: 60, speed_pct: 10 });
    await until("the move to start", () => mock.log.length > 0 || mock.left !== 0);
    mock.stopVerified = false;
    const [stop, moved] = await Promise.all([tool("stop"), move]);
    expect(stop).toMatchObject({ data: { motors_stopped: false, activity: "fault" } });
    expect(moved).toMatchObject({ ok: true, data: { reason: "preempted" } });
    expect(await tool("read_all")).toMatchObject({ robot: { activity: "fault" } });
  });

  for (const order of ["stop first", "reset_fault first"] as const) {
    const both = (tool: (name: string) => Promise<any>) =>
      order === "stop first"
        ? Promise.all([tool("stop"), tool("reset_fault")]).then(([stop, reset]) => ({ stop, reset }))
        : Promise.all([tool("reset_fault"), tool("stop")]).then(([reset, stop]) => ({ stop, reset }));

    test(`reset_fault and stop in parallel, ${order}: reset_fault answers the state the robot ends in`, async () => {
      const { mock, robot, tool } = await mockRobot();
      mock.stopVerified = false;
      await tool("stop");
      mock.stopVerified = true;
      mock.stopDelayMs = 30;
      const { reset } = await both(tool);
      expect(reset).toMatchObject({ ok: true, data: { activity: "idle" }, robot: { activity: "idle" } });
      expect(robot.view().activity).toBe("idle");
    });

    test(`reset_fault and stop in parallel, ${order}, stop unverified: reset_fault fails and the robot is in fault`, async () => {
      const { mock, robot, tool } = await mockRobot();
      mock.stopVerified = false;
      await tool("stop");
      mock.stopDelayMs = 30;
      const { stop, reset } = await both(tool);
      expect(stop).toMatchObject({ ok: true, data: { motors_stopped: false, activity: "fault" } });
      expect(reset).toMatchObject({ ok: false, error: { code: "stop_unverified" }, robot: { activity: "fault" } });
      expect(robot.view().activity).toBe("fault");
    });
  }

  test("reset_fault sent with a stop from idle answers illegal_state for idle", async () => {
    const { tool } = await mockRobot();
    const [, reset] = await Promise.all([tool("stop"), tool("reset_fault")]);
    expect(reset).toMatchObject({ ok: false, error: { code: "illegal_state" }, robot: { activity: "idle" } });
    expect(!reset.ok && reset.error.message).toContain("is idle");
  });

  test("stops sent in parallel are one stop", async () => {
    const { mock, tool } = await mockRobot();
    const before = mock.stops;
    const all = await Promise.all([tool("stop"), tool("stop"), tool("stop")]);
    for (const e of all) expect(e).toMatchObject({ ok: true, data: { motors_stopped: true, activity: "idle" } });
    expect(mock.stops - before).toBe(1);
  });

  test("a command that does not move runs while a move is in flight", async () => {
    const { mock, tool } = await mockRobot();
    const move = tool("drive", { distance_cm: 30, speed_pct: 10 });
    await until("the move to start", () => mock.log.length > 0 || mock.left !== 0);
    expect(await tool("command_device", { device: "mock.speaker", command: "beep", args: {} })).toMatchObject({
      ok: true,
      robot: { activity: "acting" },
    });
    await tool("stop");
    await move;
  });
});

describe("backstop", () => {
  test("a move whose driver never answers ends as timeout, with the robot stopped and idle", async () => {
    const mock = new MockProvider({ clock: realClock });
    // a driver that takes the command and never resolves, not even when aborted
    mock.command = () => new Promise(() => {});
    const robot = new LocalRobot({ id: "m1", deadlineMarginMs: 50 });
    const limits = { ...PROFILE.limits, max_command_ms: 100 };
    await robot.attach(createRuntime({ profile: { ...PROFILE, limits }, providers: [mock], clock: realClock }));
    const stops = mock.stops;
    const e = (await callTool([robot], "drive", { robot_id: "m1", distance_cm: 5 })).envelope;
    expect(e).toMatchObject({ ok: false, error: { code: "timeout", retryable: false }, robot: { activity: "idle" } });
    expect(!e.ok && e.error.message).toContain("read the robot");
    expect(mock.stops).toBe(stops + 1);
  });
});

describe("backstop without a link", () => {
  test("a hung move whose robot went offline ends as timeout; the robot attaches again and moves", async () => {
    const mock = new MockProvider({ clock: realClock });
    let taken = false;
    mock.command = () => {
      taken = true;
      return new Promise(() => {});
    };
    const robot = new LocalRobot({ id: "m1", deadlineMarginMs: 50 });
    const limits = { ...PROFILE.limits, max_command_ms: 100 };
    await robot.attach(createRuntime({ profile: { ...PROFILE, limits }, providers: [mock], clock: realClock }));
    const move = callTool([robot], "drive", { robot_id: "m1", distance_cm: 5 });
    await until("the driver to take the command", () => taken);
    robot.detach("the cable was pulled");
    // the link comes back while the hung call is still in flight: attach waits for that call's claim to end
    const back = robot.attach(
      createRuntime({ profile: PROFILE, providers: [new MockProvider({ clock: realClock })], clock: realClock }),
    );
    expect((await move).envelope).toMatchObject({ ok: false, error: { code: "timeout" } });
    await back;
    expect(robot.view()).toMatchObject({ link: "online", activity: "idle" });
    expect(
      (await callTool([robot], "drive", { robot_id: "m1", distance_cm: 2, speed_pct: 80 })).envelope,
    ).toMatchObject({
      ok: true,
    });
  });
});

describe("link", () => {
  test("a robot without a runtime is offline: calls answer robot_offline with what to do", async () => {
    const robot = new LocalRobot({ id: "m1", connect: "Open the page." });
    const e = (await callTool([robot], "read_all", { robot_id: "m1" })).envelope;
    expect(e).toMatchObject({
      ok: false,
      error: { code: "robot_offline", retryable: true },
      robot: { link: "offline", backend: null },
    });
    expect(!e.ok && e.error.message).toContain("Open the page.");
    expect((await callTool([robot], "stop", { robot_id: "m1" })).envelope).toMatchObject({
      error: { code: "robot_offline" },
    });
    expect(robot.listing()).toMatchObject({ link: "offline", connect: "Open the page." });
  });

  test("detach mid-move: the call ends, the robot is offline and idle, and attaches again", async () => {
    const { mock, robot, tool } = await mockRobot();
    const move = tool("drive", { distance_cm: 60, speed_pct: 10 });
    await until("the move to start", () => mock.log.length > 0 || mock.left !== 0);
    robot.detach("the cable was pulled");
    await move;
    expect(robot.view()).toMatchObject({ link: "offline", activity: "idle" });
    await robot.attach(
      createRuntime({ profile: PROFILE, providers: [new MockProvider({ clock: realClock })], clock: realClock }),
    );
    expect(await tool("drive", { distance_cm: 2, speed_pct: 80 })).toMatchObject({
      ok: true,
      robot: { link: "online" },
    });
  });
});

describe("a twin in this process", () => {
  test("shutdown mid-move leaves the simulated motors stopped", async () => {
    const fleet = await buildFleet(loadConfig([]), { log: () => {} });
    const robot = fleet.robots[0]!;
    const brick = fleet.bricks.get(robot.id)!;
    const move = callTool(fleet.robots, "drive", { robot_id: robot.id, distance_cm: 40, speed_pct: 20 });
    await until("the simulated wheels to turn", () => {
      brick.tick();
      return brick.busy();
    });
    expect(await fleet.shutdown()).toEqual([{ robot_id: robot.id, motors_stopped: true }]);
    brick.tick();
    expect(brick.busy()).toBe(false);
    const at = brick.tacho("B");
    await new Promise((r) => setTimeout(r, 150));
    brick.tick();
    expect(brick.tacho("B")).toBe(at); // nothing turns after the stop
    await move;
  });

  test("a distance sensor that fails mid-drive ends `until` with a typed error, wheels stopped, measured so far", async () => {
    // silent: plugged in, no values (condition_unreadable). unplugged: the port leaves the registry (unknown_device).
    for (const failure of ["silent", "unplugged"] as const) {
      const fleet = await buildFleet(loadConfig([]), { log: () => {} });
      const robot = fleet.robots[0]!;
      const brick = fleet.bricks.get(robot.id)!;
      const move = callTool(fleet.robots, "drive", {
        robot_id: robot.id,
        distance_cm: 40,
        speed_pct: 20,
        until: { device: "distance", channel: "distance_cm", op: "lt", value: 10 },
      });
      await until("the simulated wheels to turn", () => {
        brick.tick();
        return brick.tacho("B") > 20;
      });
      if (failure === "silent") brick.silenceSensor(4);
      else brick.unplugSensor(4);
      const { envelope } = await move;
      expect(envelope.ok).toBe(false);
      if (envelope.ok) throw new Error("unreachable");
      expect(envelope.error.retryable).toBe(false);
      if (failure === "silent") {
        expect(envelope.error.code).toBe("condition_unreadable");
        expect(envelope.error.message).toContain("ev3.S4.distance_cm returned no value in 3 polls in a row");
        expect(envelope.next[0]).toBe("read_all");
      } else expect(["unknown_device", "condition_unreadable"]).toContain(envelope.error.code);
      expect(envelope.robot).toMatchObject({ link: "online", activity: "idle" });
      const measured = envelope.error.measured!;
      expect(measured.distance_cm as number).toBeGreaterThan(0);
      expect(measured.distance_cm as number).toBeLessThan(20); // 40 cm were asked
      brick.tick();
      expect(brick.busy()).toBe(false);
      const at = brick.tacho("B");
      expect(measured.left_deg).toBe(at);
      await new Promise((r) => setTimeout(r, 150));
      brick.tick();
      expect(brick.tacho("B")).toBe(at); // nothing turns after the error
      // the robot keeps working
      const all = await callTool(fleet.robots, "read_all", { robot_id: robot.id });
      expect(all.envelope.ok).toBe(true);
      const again = await callTool(fleet.robots, "drive", { robot_id: robot.id, distance_cm: 2 });
      expect(again.envelope).toMatchObject({ ok: true, data: { reason: "completed" } });
      await fleet.shutdown();
    }
  });

  test("the example files exist where a bare start looks for them", async () => {
    expect(await Bun.file(EXAMPLE.robot).exists()).toBe(true);
    expect(await Bun.file(EXAMPLE.world).exists()).toBe(true);
  });
});

describe("shutdown", () => {
  test("two twins, one with a slower stop: a drive sent during shutdown is refused and no wheel turns", async () => {
    const twin = (id: string) => ({ source: "twin" as const, id, robot: example.robot, world: example.world, seed: 1 });
    const example = loadConfig([]).robots[0] as Extract<
      ReturnType<typeof loadConfig>["robots"][number],
      { source: "twin" }
    >;
    const fleet = await buildFleet({ port: 0, robots: [twin("slow-sim"), twin("fast-sim")] }, { log: () => {} });
    const [slow, fast] = fleet.robots as [LocalRobot, LocalRobot];
    const rt = slow.runtime()!;
    const stop = rt.stop.bind(rt);
    let fastStopped = false;
    const fastRt = fast.runtime()!;
    const fastStop = fastRt.stop.bind(fastRt);
    fastRt.stop = async () => {
      const r = await fastStop();
      fastStopped = true;
      return r;
    };
    rt.stop = async () => {
      await new Promise((r) => setTimeout(r, 300));
      return stop();
    };
    const ending = fleet.shutdown();
    // refused from the moment shutdown is asked for, before any stop has been issued
    const early = (await callTool(fleet.robots, "drive", { robot_id: "fast-sim", distance_cm: 20 })).envelope;
    await until("the fast twin's stop to be verified", () => fastStopped);
    const late = (await callTool(fleet.robots, "drive", { robot_id: "fast-sim", distance_cm: 20 })).envelope;
    for (const e of [early, late]) {
      expect(e).toMatchObject({ ok: false, error: { code: "robot_offline", retryable: false } });
      expect(!e.ok && e.error.message).toContain("shutting down");
      expect(e.next).not.toContain("drive");
    }
    expect((await callTool(fleet.robots, "list_robots", {})).envelope).toMatchObject({
      ok: false,
      error: { code: "robot_offline", retryable: false },
    });
    expect(await ending).toEqual([
      { robot_id: "slow-sim", motors_stopped: true },
      { robot_id: "fast-sim", motors_stopped: true },
    ]);
    for (const brick of fleet.bricks.values()) {
      brick.tick();
      expect(brick.busy()).toBe(false);
      const at = brick.tacho("B");
      await new Promise((r) => setTimeout(r, 100));
      brick.tick();
      expect(brick.tacho("B")).toBe(at);
    }
    // and it stays refused once the process is on its way out
    expect((await callTool(fleet.robots, "read_all", { robot_id: "slow-sim" })).envelope).toMatchObject({
      ok: false,
      error: { code: "robot_offline", retryable: false },
    });
  });

  test("stop on a robot without a link rejects, it does not throw", async () => {
    const robot = new LocalRobot({ id: "m1" });
    let thrown = false;
    let pending: Promise<unknown> | undefined;
    try {
      pending = robot.stop();
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(false);
    await expect(pending!).rejects.toMatchObject({ code: "robot_offline" });
  });
});

describe("next", () => {
  test("every suggested tool is a served tool, and every served tool has suggestions", () => {
    const served = new Set(TOOLS.map((t) => t.name));
    expect(Object.keys(NEXT_OK).sort()).toEqual([...served].sort());
    for (const names of [...Object.values(NEXT_OK), ...Object.values(NEXT_ERR)])
      for (const name of names) expect(served.has(name)).toBe(true);
  });
  test("busy suggests the same call, then a look, and stop last; illegal_state suggests a look", async () => {
    const { mock, tool } = await mockRobot();
    const move = tool("drive", { distance_cm: 60, speed_pct: 10 });
    await until("the move to start", () => mock.log.length > 0 || mock.left !== 0);
    expect(await tool("turn", { angle_deg: 10 })).toMatchObject({
      ok: false,
      error: { code: "busy", retryable: true },
      next: ["turn", "read_all", "stop"],
    });
    await tool("stop");
    await move;
    // reset_fault outside fault: nothing to reset, so the suggestion is to read the robot
    expect(await tool("reset_fault")).toMatchObject({
      ok: false,
      error: { code: "illegal_state" },
      next: ["read_all"],
    });
  });
  test("a condition on a channel that is not active names the tool that fixes it first, then the same tool", async () => {
    const { mock, tool } = await mockRobot();
    const until = { device: "mock.color", channel: "ambient_pct", op: "lt", value: 5 };
    const refused = await tool("drive", { distance_cm: 10, until });
    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_argument" }, robot: { activity: "idle" } });
    expect(refused.next.slice(0, 2)).toEqual(["read_device", "drive"]);
    expect(!refused.ok && refused.error.message).toContain("nothing was sent and nothing moved");
    expect(mock.log.length).toBe(0);
  });
});

describe("a brick that loses a reply", () => {
  const lost = () => new RuntimeError("timeout", "ev3 no_reply: the brick did not reply within 300 ms", true);
  test("mid-move: the answer is not retryable and starts with a read, so a script that retries never repeats the move", async () => {
    const { mock, robot } = await mockRobot();
    const command = mock.command.bind(mock);
    let ops = 0;
    mock.command = async (device, name, args, signal) => {
      if (name === "run_pair" && ++ops === 2) throw lost();
      return command(device, name, args, signal);
    };
    const out = await callTool([robot], "drive", { robot_id: "m1", distance_cm: 40, speed_pct: 30 });
    expect(out.envelope).toMatchObject({
      ok: false,
      error: { code: "timeout", retryable: false },
      robot: { link: "online", activity: "idle" },
    });
    expect(out.envelope.next[0]).toBe("read_all");
    expect(out.envelope.next).not.toContain("drive");
    expect(!out.envelope.ok && out.envelope.error.message).toContain("may have partly happened");
    expect(out.moved).toBe(true);
    expect(mock.left).toBeGreaterThan(0); // the first operation did run
  });
  test("on a read: retryable, and the same read is the next step", async () => {
    const { mock, robot } = await mockRobot();
    mock.read = async () => {
      throw lost();
    };
    const out = await callTool([robot], "read_device", { robot_id: "m1", device: "mock.color" });
    expect(out.envelope).toMatchObject({ ok: false, error: { code: "timeout", retryable: true } });
    expect(out.envelope.next[0]).toBe("read_device");
    expect(out.moved).toBe(false);
  });
});

describe("the call log", () => {
  type Line = Record<string, unknown>;
  const collect = () => {
    const lines: { ev: string; fields: Line }[] = [];
    return { lines, write: (ev: string, fields: Line = {}) => void lines.push({ ev, fields }) };
  };
  const FIELDS = ["ts", "tool", "robot_id", "ok", "code", "reason", "ms", "trace_id", "moved"];
  const logged = async (
    robot: LocalRobot,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ out: Awaited<ReturnType<typeof callTool>>; lines: { ev: string; fields: Line }[] }> => {
    const { lines, write } = collect();
    const out = await callTool([robot], name, args);
    // what the log is about is an answer a client accepts: it matches the outputSchema the tool lists
    const schema = TOOL.get(name)?.output;
    if (schema) expect(firstViolation(schema, out.envelope)).toBeNull();
    logCall(name, args, out, 12.4, undefined, write);
    return { out, lines };
  };

  test("one line per call with the same fields, whatever the outcome; never arguments, data or an image", async () => {
    const { robot } = await mockRobot();
    const moved = await logged(robot, "drive", { robot_id: "m1", distance_cm: 5, request_id: "label-7" });
    expect(moved.lines).toEqual([
      {
        ev: "call",
        fields: {
          ts: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
          tool: "drive",
          robot_id: "m1",
          ok: true,
          code: null,
          reason: "completed",
          ms: 12,
          trace_id: null,
          moved: true,
        },
      },
    ]);
    expect(Object.keys(moved.lines[0]!.fields)).toEqual(FIELDS);
    expect(JSON.stringify(moved.lines)).not.toContain("label-7");
    const read = await logged(robot, "read_all", { robot_id: "m1" });
    expect(read.lines[0]!.fields).toMatchObject({ tool: "read_all", ok: true, reason: null, moved: false });
    const frame = await logged(robot, "read_device", { robot_id: "m1", device: "mock.camera", channels: ["frame"] });
    expect(frame.out.image).toBeDefined();
    expect(JSON.stringify(frame.lines).length).toBeLessThan(300);
    const program = await logged(robot, "run_program", { robot_id: "m1", body: { wait_ms: 5 } });
    expect(program.lines[0]!.fields).toMatchObject({ reason: "succeeded", moved: false });
    const tiny = await logged(robot, "turn", { robot_id: "m1", angle_deg: 0.3 });
    expect(tiny.lines[0]!.fields).toMatchObject({ ok: true, code: null, reason: "completed", moved: false });
    const until = { device: "no.such", channel: "x", op: "eq", value: 1 };
    const refused = await logged(robot, "turn", { robot_id: "m1", angle_deg: 20, until });
    expect(refused.lines[0]!.fields).toMatchObject({ ok: false, code: "unknown_device", reason: null, moved: false });
    const nobody = await logged(robot, "read_all", { robot_id: "x".repeat(500) });
    expect(nobody.lines[0]!.fields).toMatchObject({ ok: false, code: "unknown_robot", robot_id: `${"x".repeat(64)}…` });
    const unknown = await logged(robot, "y".repeat(500), {});
    expect(unknown.lines[0]!.fields).toMatchObject({ tool: `${"y".repeat(64)}…`, robot_id: null, moved: false });
    for (const l of [read, frame, program, tiny, refused, nobody, unknown])
      expect(Object.keys(l.lines[0]!.fields)).toEqual(FIELDS);
  });

  test("an internal error: the id in the message the caller reads is the id of the logged stack", async () => {
    const { mock, robot } = await mockRobot();
    const command = mock.command.bind(mock);
    let ops = 0;
    mock.command = async (device, name, args, signal) => {
      if (name === "run_pair" && ++ops === 2) throw new TypeError("boom in the driver");
      return command(device, name, args, signal);
    };
    const { out, lines } = await logged(robot, "drive", { robot_id: "m1", distance_cm: 40, speed_pct: 30 });
    expect(out.envelope).toMatchObject({ ok: false, error: { code: "internal", retryable: false } });
    const message = !out.envelope.ok ? out.envelope.error.message : "";
    const trace_id = /\(trace_id ([a-z0-9]{8})\)/.exec(message)?.[1];
    expect(trace_id).toBeDefined();
    expect(lines.map((l) => l.ev)).toEqual(["internal", "call"]);
    expect(lines[0]!.fields).toMatchObject({ trace_id, tool: "drive", robot_id: "m1", message });
    // the stack starts where it went wrong, then the error it was reported as
    expect(lines[0]!.fields.stack).toMatch(
      /^TypeError: boom in the driver\n[\s\S]*chunked[\s\S]*reported as: Error: drive failed unexpectedly/,
    );
    expect(lines[1]!.fields).toMatchObject({ ok: false, code: "internal", trace_id, moved: true });
  });

  test("an internal error a driver typed itself gets a trace id too", async () => {
    const { mock, robot } = await mockRobot();
    mock.read = async () => {
      throw new RuntimeError("internal", "ev3 bad_reply: wrong counter");
    };
    const { out, lines } = await logged(robot, "read_device", { robot_id: "m1", device: "mock.color" });
    const message = !out.envelope.ok ? out.envelope.error.message : "";
    const trace_id = /^ev3 bad_reply: wrong counter \(trace_id ([a-z0-9]{8})\)$/.exec(message)?.[1];
    expect(trace_id).toBeDefined();
    expect(lines[0]).toMatchObject({ ev: "internal", fields: { trace_id } });
    expect(lines[1]).toMatchObject({ ev: "call", fields: { code: "internal", trace_id, moved: false } });
  });

  test("a program step that failed unexpectedly: the program answers with data and the log has the stack", async () => {
    const { mock, robot } = await mockRobot();
    mock.command = async () => {
      throw new TypeError("boom in a step");
    };
    const body = { call: { tool: "drive", args: { distance_cm: 5 } } };
    const { out, lines } = await logged(robot, "run_program", { robot_id: "m1", body });
    expect(out.envelope).toMatchObject({ ok: true, data: { outcome: "failed" } });
    const step = (out.envelope as { data: { steps: { error: { trace_id: string } }[] } }).data.steps[0]!;
    expect(lines.map((l) => l.ev)).toEqual(["internal", "call"]);
    expect(lines[0]!.fields).toMatchObject({ trace_id: step.error.trace_id });
    expect(lines[0]!.fields.stack).toContain("boom in a step");
    expect(lines[1]!.fields).toMatchObject({ ok: true, reason: "failed", trace_id: step.error.trace_id });
  });

  test("a result that breaks its outputSchema is logged as the internal error the client gets", () => {
    const { lines, write } = collect();
    const broken = { trace_id: "abcd1234", message: "drive: the result does not match", stack: "Error: …" };
    logCall(
      "drive",
      { robot_id: "m1" },
      { envelope: { ok: true, data: { reason: "completed" }, next: [] }, moved: true, internal: [] },
      3,
      broken,
      write,
    );
    expect(lines[0]).toMatchObject({ ev: "internal", fields: { trace_id: "abcd1234" } });
    expect(lines[1]!.fields).toMatchObject({ ok: false, code: "internal", reason: null, trace_id: "abcd1234" });
  });
});

describe("a link that can close", () => {
  test("a link that closes during the handshake leaves the robot offline, and the next link brings it online", async () => {
    const robot = new LocalRobot({ id: "m1", connect: "check the link" });
    const events: string[] = [];
    let opened = 0;
    const link = keepAttached(
      robot,
      () => {
        const first = ++opened === 1;
        const mock = new MockProvider({ clock: realClock });
        let gone: (reason: string) => void = () => {};
        if (first)
          // the link dies while the handshake's stop is on its way: nothing can be verified through it
          mock.stop = async () => {
            gone("the peer went away");
            return { motors_stopped: false };
          };
        return {
          runtime: createRuntime({ profile: PROFILE, providers: [mock], clock: realClock }),
          onClose: (cb) => void (gone = cb),
          close: async () => {},
        };
      },
      { log: (ev) => void events.push(ev), reconnectMs: 10 },
    );
    try {
      await expect(link.connect()).rejects.toThrow("closed during the handshake");
      expect(robot.listing()).toMatchObject({ link: "offline", connect: "check the link" });
      await link.connect();
      expect(robot.listing()).toMatchObject({ link: "online", connect: null });
      expect(opened).toBe(2);
    } finally {
      link.end();
    }
  });

  test("start does not wait: the robot is offline while what a link needs first fails, online when it holds", async () => {
    const robot = new LocalRobot({ id: "m1", connect: "check the link" });
    const events: string[] = [];
    let reachable = false;
    let opened = 0;
    const link = keepAttached(
      robot,
      async () => {
        opened++;
        // what an ev3dev source does before a link: copy the bridge, which needs the brick
        if (!reachable) throw new Error("ssh: connect to host: Connection refused");
        return {
          runtime: createRuntime({
            profile: PROFILE,
            providers: [new MockProvider({ clock: realClock })],
            clock: realClock,
          }),
          onClose: () => {},
          close: async () => {},
        };
      },
      { log: (ev) => void events.push(ev), reconnectMs: 10 },
    );
    try {
      link.start();
      expect(robot.listing()).toMatchObject({ link: "offline", connect: "check the link" });
      await until("three failed attempts", () => opened >= 3);
      expect(robot.listing()).toMatchObject({
        link: "offline",
        connect: "check the link The last attempt failed: ssh: connect to host: Connection refused",
      });
      expect(events).toEqual(expect.arrayContaining(["attach_failed"]));
      expect(events).not.toContain("ready");
      reachable = true;
      await until("the robot is online", () => robot.listing().link === "online");
      expect(robot.listing()).toMatchObject({ link: "online", connect: null });
      await until("ready is logged", () => events.includes("ready"));
      const attempts = opened;
      await new Promise((r) => setTimeout(r, 50));
      expect(opened).toBe(attempts); // a link that holds is not opened again
    } finally {
      link.end();
    }
  });

  test("a link that closes later puts the robot offline until a new one holds", async () => {
    const robot = new LocalRobot({ id: "m1", connect: "check the link" });
    const events: string[] = [];
    const closers: ((reason: string) => void)[] = [];
    const link = keepAttached(
      robot,
      () => ({
        runtime: createRuntime({
          profile: PROFILE,
          providers: [new MockProvider({ clock: realClock })],
          clock: realClock,
        }),
        onClose: (cb) => void closers.push(cb),
        close: async () => {},
      }),
      { log: (ev) => void events.push(ev), reconnectMs: 10 },
    );
    try {
      await link.connect();
      closers[0]!("the peer went away");
      expect(robot.listing()).toMatchObject({ link: "offline", connect: "check the link" });
      await until("the robot is online again", () => robot.listing().link === "online");
      expect(events).toEqual(["gone", "ready"]);
    } finally {
      link.end();
    }
  });

  test("why an attempt failed shows in list_robots until an attempt succeeds", async () => {
    const robot = new LocalRobot({ id: "m1", connect: "check the link" });
    const closers: ((reason: string) => void)[] = [];
    let refuse: "no" | "misconfigured" | "robot_offline" = "no";
    const link = keepAttached(
      robot,
      () => {
        const mock = new MockProvider({ clock: realClock });
        const code = refuse;
        if (code !== "no")
          mock.devices = async () => {
            throw new RuntimeError(
              code,
              code === "misconfigured" ? "the bridge is version 2, this driver expects 3; reinstall it" : "ssh refused",
            );
          };
        return {
          runtime: createRuntime({ profile: PROFILE, providers: [mock], clock: realClock }),
          onClose: (cb) => void closers.push(cb),
          close: async () => {},
        };
      },
      { log: () => {}, reconnectMs: 10 },
    );
    try {
      await link.connect();
      refuse = "robot_offline";
      closers[0]!("the peer went away");
      await until("a failed attempt", () => (robot.listing().connect ?? "").includes("last attempt failed"));
      expect(robot.listing()).toMatchObject({
        link: "offline",
        connect: "check the link The last attempt failed: ssh refused",
      });
      // a configuration the attempts cannot change: the hint says a person must act, not that it comes back
      refuse = "misconfigured";
      await until("a misconfigured attempt", () => (robot.listing().connect ?? "").includes("reinstall it"));
      expect(robot.listing().connect).toBe(
        "This robot does not come online by itself: every attempt fails until this is fixed. the bridge is version 2, this driver expects 3; reinstall it",
      );
      refuse = "no";
      await until("the robot is online again", () => robot.listing().link === "online");
      expect(robot.listing().connect).toBeNull();
    } finally {
      link.end();
    }
  });
});
