// Loops on the twin (CONTRACT §1, §5a, §6): the host executor over the simulated brick through the real EV3 provider,
// the `looping` activity, the attention window, the backstop, cancellation and the call log. Everything runs
// in-process on one virtual clock, so a loaded machine slows a test without changing what the robot does.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateSchema } from "../../../packages/protocol/schema";
import type { LoopSpec } from "../../../packages/protocol/types";
import { FakeClock } from "../../../packages/runtime/clock";
import { createRuntime } from "../../../packages/runtime/runtime";
import type { DeviceSpec, Provider, RobotProfile } from "../../../packages/protocol/types";
import { LocalRobot } from "../src/robot";
import { EXAMPLE, REPO, loadConfig } from "../src/config";
import { callLine } from "../src/mcp";
import { buildFleet } from "../src/sources";
import { TOOL, callTool } from "../src/tools";
import { ARM } from "./arm";

/** The specs of docs/loops.md, as printed there. */
const [, C2, , C4] = [
  ...readFileSync(join(REPO, "docs", "loops.md"), "utf8").matchAll(/```json\r?\n([\s\S]*?)```/g),
].map((m) => JSON.parse(m[1]!) as LoopSpec) as [LoopSpec, LoopSpec, LoopSpec, LoopSpec];
const LINE_OVAL = join(REPO, "packages", "sim-world", "examples", "line-oval.json");

async function twin(argv: string[]) {
  const clock = new FakeClock();
  const logs: Record<string, unknown>[] = [];
  const fleet = await buildFleet(loadConfig(argv), { log: (ev, f) => void logs.push({ ev, ...f }), clock });
  const robot = fleet.robots[0]!;
  const brick = fleet.bricks.get(robot.id)!;
  /** One call; its envelope must match the output schema the server lists for the tool. */
  const call = async (name: string, args: Record<string, unknown> = {}, cancel?: AbortSignal) => {
    const out = await callTool(fleet.robots, name, { robot_id: robot.id, ...args }, cancel);
    expect(validateSchema(TOOL.get(name)!.output, out.envelope, name)).toEqual([]);
    return out;
  };
  const tool = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).envelope as any;
  const read = async (device: string, channel: string) =>
    (await tool("read_device", { device, channels: [channel] })).data.readings[0].value as number;
  const loopEnds = () => logs.filter((l) => l.ev === "loop_end");
  return { clock, fleet, robot, brick, call, tool, read, logs, loopEnds };
}
type Twin = Awaited<ReturnType<typeof twin>>;
const arm = () => twin(["--twin", ARM]);
const base = (world = LINE_OVAL) => twin(["--twin", EXAMPLE.robot, "--world", world]);
/** supervise_loop with wait_ms until the loop has ended. */
async function superviseToEnd(t: Twin, every_ms = 5000) {
  for (;;) {
    const r = await t.tool("supervise_loop", { wait_ms: every_ms });
    if (r.data.state === "ended") return r;
  }
}

describe("C2 on the twin: following the line of line-oval.json", () => {
  test("a model starts C2 as printed, supervises it with wait_ms, and the robot follows the line for a lap", async () => {
    const t = await base();
    try {
      // the oval's length, from the world file
      const line = (JSON.parse(readFileSync(LINE_OVAL, "utf8")).lines[0].points as [number, number][]).map(
        ([x, y]) => ({ x, y }),
      );
      const lap = line.reduce(
        (sum, p, i) => sum + Math.hypot(line[(i + 1) % line.length]!.x - p.x, line[(i + 1) % line.length]!.y - p.y),
        0,
      );
      const started = await t.tool("run_loop", { ...C2 });
      expect(started).toMatchObject({
        ok: true,
        robot: { activity: "looping" },
        data: { state: "running", runs_on: "host", rate_hz: 50, ticks: 20, overruns: 0 },
        next: ["supervise_loop", "stop"],
      });
      // the touch sensor updates at 20 Hz: the plan says so
      expect(started.data.notes.join(" ")).toContain("signal bumper");
      // the distance from the axle to the line, densely, while the loop runs (reads run while looping)
      let worst = 0;
      let travel = 0;
      let watching = true;
      const watch = (async () => {
        while (watching) {
          worst = Math.max(worst, await t.read("sim.world", "line_distance_cm"));
          travel = await t.read("sim.world", "line_travel_cm");
          if (travel > lap) break;
          await t.clock.sleep(50);
        }
      })();
      const reports: any[] = [];
      while (travel <= lap) {
        const r = await t.tool("supervise_loop", { wait_ms: 2000 });
        reports.push(r.data);
        expect(r.data.state).toBe("running");
      }
      watching = false;
      await watch;
      expect(travel).toBeGreaterThan(lap);
      expect(worst).toBeLessThan(4);
      expect(reports.every((r) => r.overruns === 0)).toBe(true);
      const stopped = await t.tool("stop");
      expect(stopped).toMatchObject({ ok: true, data: { motors_stopped: true, activity: "idle" } });
      const end = await t.tool("supervise_loop");
      expect(end.data).toMatchObject({ state: "ended", reason: "preempted", remaining_ms: 0 });
    } finally {
      await t.fleet.shutdown();
    }
  }, 60_000);
});

describe("C4 on the twin: holding a free motor at an angle", () => {
  test("it holds its target after a step disturbance, and moves to a new target over a ramp", async () => {
    const t = await arm();
    try {
      const started = await t.tool("run_loop", { ...C4, attention_ms: 120000 });
      expect(started).toMatchObject({ ok: true, data: { state: "running", rate_hz: 50 } });
      // C4 asks for ±60 %; the arm's motors take ±40 (max_speed_pct): planning cut the limit to the command's range
      await t.tool("supervise_loop", { wait_ms: 3000 });
      const held = await t.read("ev3.A", "position_deg");
      expect(Math.abs(held - 45)).toBeLessThanOrEqual(1);
      // a hand turns the shaft 30° away: the loop brings it back
      t.brick.turnShaft("A", 30);
      const pushed = await t.read("ev3.A", "position_deg");
      expect(pushed - held).toBeGreaterThanOrEqual(29);
      const after = await t.tool("supervise_loop", { wait_ms: 3000 });
      expect(after.data.signals.angle.max).toBeGreaterThan(60); // the smoothed angle saw the push
      expect(Math.abs((await t.read("ev3.A", "position_deg")) - 45)).toBeLessThanOrEqual(1);
      // a new target over a ramp: the arm follows and holds
      const moved = await t.tool("supervise_loop", { params: { target: 90 }, ramp_ms: 1000, wait_ms: 4000 });
      expect(moved.data.params).toEqual({ target: 90 });
      expect(Math.abs((await t.read("ev3.A", "position_deg")) - 90)).toBeLessThanOrEqual(1);
      // only the driven motor turned
      expect(t.brick.tacho("B")).toBe(0);
    } finally {
      await t.fleet.shutdown();
    }
  }, 60_000);
});

describe("the looping activity", () => {
  test("run_loop → supervise_loop → the report; moving calls answer busy and name supervise_loop and stop; reads run", async () => {
    const t = await base();
    try {
      const started = await t.call("run_loop", { ...C2 });
      expect(started.moved).toBe(true);
      expect(t.robot.view().activity).toBe("looping");
      const report = await t.tool("supervise_loop", { params: { speed: 15 } });
      expect(report).toMatchObject({
        ok: true,
        robot: { activity: "looping" },
        data: { state: "running", params: { speed: 15 } },
      });
      expect(Object.keys(report.data.signals)).toEqual(["light", "bumper"]);
      expect(report.data.outputs.map((o: any) => o.device)).toEqual(["ev3.B", "ev3.C"]);
      expect(report.data.remaining_ms).toBeLessThan(30000);

      for (const [name, args] of [
        ["drive", { distance_cm: 5 }],
        ["run_program", { body: { wait_ms: 10 } }],
        ["run_loop", { ...C2 }],
        ["command_device", { device: "arm", command: "run_degrees", args: { degrees: 10, speed_pct: 20 } }],
      ] as const) {
        const e = await t.tool(name, args);
        expect(e).toMatchObject({
          ok: false,
          error: { code: "busy", retryable: true },
          robot: { activity: "looping" },
        });
        expect(e.error.message).toContain("supervise_loop");
        expect(e.next.slice(0, 2)).toEqual(["supervise_loop", "stop"]);
      }
      // a command that does not move runs, except on a device the loop drives
      expect(
        await t.tool("command_device", { device: "ev3.led", command: "set", args: { pattern: "green" } }),
      ).toMatchObject({ ok: true });
      const driven = await t.tool("command_device", { device: "left_wheel", command: "brake" });
      expect(driven).toMatchObject({ ok: false, error: { code: "busy" } });
      expect(driven.error.message).toContain("driven by the loop");
      // reads run; a read that needs a mode switch does not
      expect(await t.tool("read_all")).toMatchObject({ ok: true, robot: { activity: "looping" } });
      expect(await t.tool("read_device", { device: "color", channels: ["ambient_pct"] })).toMatchObject({
        ok: false,
        error: { code: "busy" },
      });
      // stop ends the loop: preempted, idle, every motor reads 0
      const stopped = await t.tool("stop");
      expect(stopped).toMatchObject({ ok: true, data: { motors_stopped: true, activity: "idle" } });
      for (const m of ["ev3.B", "ev3.C"]) expect(await t.read(m, "speed_deg_s")).toBe(0);
      expect(t.brick.busy()).toBe(false);
      const ended = await t.tool("supervise_loop");
      expect(ended).toMatchObject({
        ok: true,
        robot: { activity: "idle" },
        data: { state: "ended", reason: "preempted" },
      });
      expect(t.loopEnds()).toMatchObject([{ robot_id: "r1-sim", reason: "preempted", guard: null, runs_on: "host" }]);
      // the final report stays until the next loop; a new loop starts from idle
      expect((await t.tool("supervise_loop")).data.state).toBe("ended");
      expect(await t.tool("drive", { distance_cm: 2 })).toMatchObject({ ok: true });
    } finally {
      await t.fleet.shutdown();
    }
  }, 60_000);

  test("a refused loop sends nothing and leaves the robot idle: a rate over the maximum, an inactive channel", async () => {
    const t = await base();
    try {
      const sent = t.brick.log.length;
      const fast = await t.tool("run_loop", { ...C2, rate_hz: 200 });
      expect(fast).toMatchObject({ ok: false, error: { code: "invalid_argument" }, robot: { activity: "idle" } });
      expect(fast.error.message).toContain("above the maximum of 100 Hz");
      const inactive = await t.tool("run_loop", {
        ...C2,
        signals: { ...C2.signals, light: { device: "color", channel: "ambient_pct" } },
      });
      expect(inactive).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
      expect(inactive.next[0]).toBe("read_device");
      const noDrives = await t.tool("run_loop", {
        ...C2,
        outputs: [{ ...C2.outputs[0]!, command: "run_degrees" }],
      });
      expect(noDrives).toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect(t.brick.log.length).toBe(sent);
      expect(t.robot.view().activity).toBe("idle");
      const none = await t.tool("supervise_loop");
      expect(none).toMatchObject({ ok: false, error: { code: "illegal_state" } });
      expect(none.next[0]).toBe("run_loop");
      const d = await t.tool("describe_robot");
      expect(d.data.loop).toEqual({ runs_on: "host", max_rate_hz: 100 });
      expect(d.data.limits.max_loop_ms).toBe(60000);
      const motor = await t.tool("describe_device", { device: "ev3.B" });
      expect(motor.data.commands.filter((c: any) => c.drives).map((c: any) => [c.name, c.drives])).toEqual([
        ["run_time", { arg: "speed_pct", max_hold_ms: 250 }],
        ["power", { arg: "power_pct", max_hold_ms: 250 }],
      ]);
    } finally {
      await t.fleet.shutdown();
    }
  }, 60_000);

  test("power runs as a command too: one operation, or chunks for a longer ms; over max_speed_pct it is refused", async () => {
    const t = await arm();
    try {
      const one = await t.tool("command_device", {
        device: "ev3.A",
        command: "power",
        args: { power_pct: 30, ms: 100 },
      });
      expect(one).toMatchObject({ ok: true, data: { reason: "completed", chunks: 1 } });
      expect(one.data.measured.degrees).toBeGreaterThan(0);
      const long = await t.tool("command_device", {
        device: "ev3.A",
        command: "power",
        args: { power_pct: -30, ms: 600 },
      });
      expect(long).toMatchObject({ ok: true, data: { reason: "completed", chunks: 3 } });
      expect(long.data.measured.degrees).toBeLessThan(0);
      expect(t.brick.busy()).toBe(false);
      // the arm's max_speed_pct is 40: the schema's range, checked before anything is sent
      const over = await t.tool("command_device", {
        device: "ev3.A",
        command: "power",
        args: { power_pct: 80, ms: 100 },
      });
      expect(over).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
      expect(over.error.message).toContain("must be <= 40");
    } finally {
      await t.fleet.shutdown();
    }
  }, 60_000);

  test("Esc on run_loop (notifications/cancelled) ends the loop with a verified stop", async () => {
    const t = await arm();
    try {
      const esc = new AbortController();
      void t.clock.sleep(150).then(() => esc.abort());
      const out = await t.call("run_loop", { ...C4 }, esc.signal);
      expect(out.envelope).toMatchObject({
        ok: true,
        robot: { activity: "idle" },
        data: { state: "ended", reason: "preempted" },
      });
      expect(t.logs.filter((l) => l.ev === "cancelled")).toEqual([
        { ev: "cancelled", robot_id: "arm-sim", tool: "run_loop", action: "stop" },
      ]);
      expect(t.brick.busy()).toBe(false);
      expect(await t.read("ev3.A", "speed_deg_s")).toBe(0);
    } finally {
      await t.fleet.shutdown();
    }
  }, 60_000);

  test("Esc on supervise_loop ends the loop with a verified stop", async () => {
    const t = await arm();
    try {
      await t.tool("run_loop", { ...C4 });
      const esc = new AbortController();
      void t.clock.sleep(500).then(() => esc.abort());
      const out = await t.call("supervise_loop", { wait_ms: 10000 }, esc.signal);
      expect(out.envelope).toMatchObject({
        ok: true,
        robot: { activity: "idle" },
        data: { state: "ended", reason: "preempted" },
      });
      expect(t.logs.filter((l) => l.ev === "cancelled")).toMatchObject([{ tool: "supervise_loop", action: "stop" }]);
      expect(t.brick.busy()).toBe(false);
    } finally {
      await t.fleet.shutdown();
    }
  }, 60_000);

  test("the attention window ends a loop no one supervises; a pending supervise_loop holds it open", async () => {
    const t = await arm();
    try {
      // supervised with wait_ms longer than the window: the loop runs on
      await t.tool("run_loop", { ...C4, attention_ms: 1000 });
      const waited = await t.tool("supervise_loop", { wait_ms: 3000 });
      expect(waited.data.state).toBe("running");
      // then nobody: it ends attention_ms after the latest answer
      const t0 = t.clock.now();
      await t.clock.sleep(5000);
      const end = await t.tool("supervise_loop");
      expect(end).toMatchObject({ robot: { activity: "idle" }, data: { state: "ended", reason: "unattended" } });
      expect(t.loopEnds()).toMatchObject([{ reason: "unattended" }]);
      const last = t.logs.filter((l) => l.ev === "activity" && l.to === "stopping").at(-1)!;
      expect(last).toMatchObject({ from: "looping" });
      expect(end.data.age_ms).toBeGreaterThanOrEqual(3000 + 1000);
      expect(t.clock.now() - t0).toBeGreaterThanOrEqual(1000);
      expect(t.brick.busy()).toBe(false);
    } finally {
      await t.fleet.shutdown();
    }
  }, 60_000);

  test("a guard ends the loop with its name, braked; the call log and the loop_end line say why", async () => {
    const t = await arm();
    try {
      const started = await t.call("run_loop", { ...C4, attention_ms: 120000 });
      // the call line of run_loop: moved, no reason while the loop runs
      expect(callLine("run_loop", { robot_id: "arm-sim" }, started.envelope, 1, started.moved, null)).toMatchObject({
        ok: true,
        reason: null,
        moved: true,
      });
      await t.tool("supervise_loop", { wait_ms: 1000 });
      t.brick.turnShaft("A", 400); // past out_of_range (|angle| > 200)
      const end = await superviseToEnd(t, 1000);
      expect(end).toMatchObject({
        robot: { activity: "idle" },
        data: { state: "ended", reason: "guard", guard: "out_of_range" },
      });
      expect(end.data.trace.angle.at(-1)).toBeGreaterThan(200);
      expect(end.data.trace.out0.at(-1)).toBe(0);
      const line = callLine("supervise_loop", { robot_id: "arm-sim" }, end, 1, false, null);
      expect(line).toMatchObject({ reason: "guard", moved: false });
      expect(t.loopEnds()).toEqual([
        {
          ev: "loop_end",
          ts: expect.any(String),
          robot_id: "arm-sim",
          reason: "guard",
          guard: "out_of_range",
          runs_on: "host",
          ticks: expect.any(Number),
          overruns: 0,
          ms: expect.any(Number),
        },
      ]);
      expect(t.brick.busy()).toBe(false);
    } finally {
      await t.fleet.shutdown();
    }
  }, 60_000);

  test("duration_ms ends the loop with completed; a loop that is cut to max_loop_ms says so", async () => {
    const t = await arm();
    try {
      const started = await t.tool("run_loop", { ...C4, duration_ms: 2000, attention_ms: 120000 });
      expect(started.data.remaining_ms).toBeLessThanOrEqual(2000);
      const end = await superviseToEnd(t, 1000);
      expect(end.data).toMatchObject({ state: "ended", reason: "completed", age_ms: 2000, remaining_ms: 0 });
      expect(t.robot.view().activity).toBe("idle");
      const long = await t.tool("run_loop", { ...C4, duration_ms: 90000 });
      expect(long.data.notes).toContain("duration_ms was cut from 90000 to 60000, the robot's max_loop_ms");
      await t.tool("stop");
    } finally {
      await t.fleet.shutdown();
    }
  }, 60_000);
});

describe("the backstop behind a loop", () => {
  test("a loop whose tick never answers is ended at duration_ms + 2 s + stop_worst_ms, with reason timeout", async () => {
    const clock = new FakeClock();
    let ticks = 0;
    const motor: DeviceSpec = {
      id: "h.m",
      provider: "h",
      kind: "motor",
      roles: [],
      description: "a motor",
      channels: [{ name: "position_deg", type: "number", description: "encoder" }],
      commands: [
        {
          name: "power",
          description: "timed power",
          moves: true,
          bound: { kind: "ms", params: ["ms"], max: 250 },
          params: { type: "object", properties: { power_pct: { type: "number", minimum: -100, maximum: 100 } } },
          drives: { arg: "power_pct", max_hold_ms: 250 },
        },
      ],
    };
    let stops = 0;
    const hangs: Provider = {
      id: "h",
      backend: "sim",
      stop_worst_ms: 100,
      devices: async () => [structuredClone(motor)],
      read: async () => [],
      command: async () => {
        throw new Error("not used");
      },
      stop: async () => {
        stops++;
        return { motors_stopped: true };
      },
      // the 30th tick goes out and its answer never comes back
      loop: {
        runs_on: "host",
        max_rate_hz: 100,
        tick: (_w, reads) => (++ticks >= 30 ? new Promise(() => {}) : Promise.resolve(reads.map(() => 0))),
        end: async () => {},
      },
    };
    const profile: RobotProfile = {
      id: "h1",
      roles: {},
      notes: [],
      limits: { max_speed_pct: 80, max_command_ms: 10000, max_program_ms: 20000, max_loop_ms: 30000 },
    };
    const ends: unknown[] = [];
    const robot = new LocalRobot({ id: "h1", clock, onLoopEnd: (l) => ends.push(l) });
    await robot.attach(createRuntime({ profile, providers: [hangs], clock }));
    const tool = async (name: string, args: Record<string, unknown> = {}) =>
      (await callTool([robot], name, { robot_id: "h1", ...args })).envelope as any;
    const t0 = clock.now();
    const spec = {
      rate_hz: 50,
      duration_ms: 1000,
      signals: { x: { device: "h.m", channel: "position_deg" } },
      outputs: [{ device: "h.m", command: "power", terms: [{ signal: "x", gain: 1 }] }],
    };
    expect(await tool("run_loop", spec)).toMatchObject({ ok: true, data: { state: "running" } });
    const end = await tool("supervise_loop", { wait_ms: 10000 });
    expect(end).toMatchObject({ robot: { activity: "idle" }, data: { state: "ended", reason: "timeout" } });
    // from the loop's start: its duration, the margin, and the stop's worst case (the provider's + the runtime's 50)
    expect(clock.now() - t0).toBe(1000 + 2000 + 150);
    expect(stops).toBeGreaterThanOrEqual(2); // the stop at attach, and the one that ended the loop
    expect(ends).toMatchObject([{ reason: "timeout", ticks: 29 }]);
  }, 30_000);
});
