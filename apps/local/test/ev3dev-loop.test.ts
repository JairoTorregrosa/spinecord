// A loop on an ev3dev brick end to end, with no brick: run_loop → supervise_loop → the report, stop and Esc, through
// the real tools, runtime, provider, ssh code path (bench/fake-ssh.ts) and bridge, on a fake sysfs tree. The loop
// runs on the brick's executor (the bridge), so these tests run on real time: 10 Hz, so that a loaded machine
// cannot end a loop by overrun ahead of the test's own stop. POSIX sh and a local python3, like ev3dev.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRobotFile } from "../../../packages/driver-ev3/robot-file";
import { FakeBrick } from "../../../packages/driver-ev3dev/test/fake-brick";
import { validateSchema } from "../../../packages/protocol/schema";
import { EXAMPLE } from "../src/config";
import { buildFleet, type Fleet } from "../src/sources";
import { TOOL, callTool } from "../src/tools";
import { sleep, until } from "./client";

const python3 = Bun.which("python3");
const runs = process.platform !== "win32" && python3 !== null;
if (!runs) console.warn("SKIPPED: the ev3dev loop test needs a POSIX sh and python3 on PATH");

/** C4 of docs/loops.md on motor B, at 10 Hz: B's angle steers B's power. */
const ARM_HOLD = {
  rate_hz: 10,
  duration_ms: 30_000,
  signals: { angle: { device: "ev3.B", channel: "position_deg" } },
  params: { target: 45 },
  outputs: [
    {
      device: "ev3.B",
      command: "power",
      limit: [-60, 60],
      terms: [
        { signal: "angle", setpoint: "target", gain: -2.0 },
        { signal: "angle", of: "integral", setpoint: "target", gain: -4.0, clamp: 10 },
        { signal: "angle", of: "derivative", gain: -0.05 },
      ],
    },
  ],
  guards: [{ name: "out_of_range", signal: "angle", op: "abs_gt", value: 200 }],
};

/** C2 of docs/loops.md as printed there, but at 10 Hz. */
const C2 = {
  ...(JSON.parse(
    [
      ...readFileSync(join(import.meta.dir, "..", "..", "..", "docs", "loops.md"), "utf8").matchAll(
        /```json\r?\n([\s\S]*?)```/g,
      ),
    ][1]![1]!,
  ) as Record<string, unknown>),
  rate_hz: 10,
};

describe("a loop on an ev3dev brick", () => {
  const home = mkdtempSync(join(tmpdir(), "spinecord-local-home-"));
  // touch on 1 (sensor0) and color on 3 (sensor1), as the example robot names them
  const brick = runs
    ? new FakeBrick({
        motors: [{ port: "B" }, { port: "C" }],
        sensors: [
          { port: 1, driver: "lego-ev3-touch", mode: "TOUCH", modes: ["TOUCH"], values: [0] },
          {
            port: 3,
            driver: "lego-ev3-color",
            mode: "COL-REFLECT",
            modes: ["COL-REFLECT", "COL-AMBIENT", "COL-COLOR", "RGB-RAW"],
            values: [35],
          },
        ],
        battery_uv: 7900000,
      })
    : null;
  let fleet: Fleet | null = null;
  const logs: Record<string, unknown>[] = [];
  afterAll(async () => {
    await fleet?.shutdown();
    delete process.env.BENCH_FAKE_HOME;
    delete process.env.SYSFS_ROOT;
    brick?.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  const start = async (): Promise<Fleet> => {
    if (fleet) return fleet;
    Object.assign(process.env, { BENCH_FAKE_HOME: home, SYSFS_ROOT: brick!.root });
    const robot = parseRobotFile(await Bun.file(EXAMPLE.robot).json(), EXAMPLE.robot);
    fleet = await buildFleet(
      {
        port: 0,
        robots: [
          {
            source: "ev3dev",
            id: "dev",
            robot,
            hardware: { low_battery_v: 6.5, max_tone_ms: 5000, speech_volume_pct: 80 },
            ssh: {
              host: "fake-brick",
              user: "robot",
              sshCommand: join(import.meta.dir, "..", "..", "..", "bench", "fake-ssh.ts"),
            },
            installBridge: true,
          },
        ],
      },
      { log: (ev, f) => void logs.push({ ev, ...f }) },
    );
    await until(
      "dev is online",
      async () => {
        const out = (await callTool(fleet!.robots, "list_robots", {})).envelope as {
          data: { robots: { id: string; link: string }[] };
        };
        return out.data.robots.find((r) => r.id === "dev")?.link === "online";
      },
      30_000,
    );
    return fleet;
  };
  /** Each test starts online, idle, with the arm at 0 and the sensors at rest, also when it is tried again. */
  const fresh = async () => {
    await start();
    await callTool(fleet!.robots, "stop", { robot_id: "dev" });
    for (const m of [0, 1]) brick!.setMotorInPlace(m, "position", 0);
    brick!.setSensorInPlace(0, "value0", 0);
    brick!.setSensorInPlace(1, "value0", 35);
  };
  /** One call; its envelope must match the output schema the server lists for the tool. */
  const call = async (name: string, args: Record<string, unknown> = {}, cancel?: AbortSignal) => {
    const out = await callTool(fleet!.robots, name, { robot_id: "dev", ...args }, cancel);
    expect(validateSchema(TOOL.get(name)!.output, out.envelope, name)).toEqual([]);
    return out.envelope as any;
  };

  test.skipIf(!runs)(
    "run_loop → supervise_loop → the report, on the brick's executor; stop ends it with every motor at 0",
    async () => {
      await fresh();
      expect((await call("describe_robot")).data.loop).toEqual({ runs_on: "device", max_rate_hz: 50 });
      // the brick's motor B can be a loop output: power and run_time declare drives
      const b = (await call("describe_device", { device: "ev3.B" })).data;
      expect(b.commands.find((c: { name: string }) => c.name === "power").drives).toEqual({
        arg: "power_pct",
        max_hold_ms: 200,
      });
      // a rate over the brick's maximum is refused, and nothing is sent
      const fast = await call("run_loop", { ...ARM_HOLD, rate_hz: 100 });
      expect(fast).toMatchObject({ ok: false, error: { code: "invalid_argument" }, robot: { activity: "idle" } });
      expect(fast.error.message).toContain("maximum of 50 Hz");
      expect(brick!.motorLine(0, "command")).toBe("stop"); // the stop of the handshake, and nothing since

      const started = await call("run_loop", ARM_HOLD);
      expect(started).toMatchObject({
        ok: true,
        robot: { activity: "looping" },
        data: { state: "running", runs_on: "device", rate_hz: 10, params: { target: 45 } },
      });
      expect(started.data.ticks).toBeGreaterThanOrEqual(20);
      expect(brick!.motorLine(0, "command")).toBe("run-direct");
      // B at 0 under a target of 45: the value term alone gives +90, cut to the limit of 60
      expect(started.data.outputs[0]).toMatchObject({ device: "ev3.B", command: "power", last: 60, max: 60 });
      expect(started.data.signals.angle).toMatchObject({ last: 0 });
      expect(started.data.trace.t_ms.length).toBeGreaterThan(0);
      // while it runs: reads run, a moving call is busy and names supervise_loop and stop
      expect((await call("read_device", { device: "ev3.B", channels: ["power_pct"] })).data.readings[0].value).toBe(60);
      const busy = await call("drive", { distance_cm: 3 });
      expect(busy).toMatchObject({ ok: false, error: { code: "busy" } });
      expect(busy.next.slice(0, 2)).toEqual(["supervise_loop", "stop"]);
      // the arm moves to 40 under the loop: the brick's held descriptor sees it on the next tick
      brick!.setMotorInPlace(0, "position", 40);
      const steered = await call("supervise_loop", { params: { target: 40 }, wait_ms: 2500 });
      expect(steered).toMatchObject({ ok: true, data: { state: "running", params: { target: 40 } } });
      expect(steered.data.signals.angle.last).toBe(40);
      expect(steered.data.ticks).toBeGreaterThan(started.data.ticks);
      expect(steered.data.period_ms.p50).toBeGreaterThan(90);
      expect(steered.data.period_ms.p50).toBeLessThan(110);
      // at the target the value term is 0; the integral holds what it gathered, within its clamp
      expect(Math.abs(steered.data.outputs[0].last)).toBeLessThanOrEqual(60);

      const stop = await call("stop");
      expect(stop).toMatchObject({ ok: true, data: { motors_stopped: true, activity: "idle" } });
      const ended = await call("supervise_loop");
      expect(ended).toMatchObject({
        ok: true,
        robot: { activity: "idle" },
        data: { state: "ended", reason: "preempted", runs_on: "device", remaining_ms: 0 },
      });
      expect([brick!.motorLine(0, "command"), brick!.motor(0, "stop_action")]).toEqual(["stop", "brake"]);
      expect(
        (await call("read_device", { device: "ev3.B", channels: ["speed_deg_s", "power_pct"] })).data.readings,
      ).toMatchObject([{ value: 0 }, { value: 0 }]);
      expect(logs.filter((l) => l.ev === "loop_end")).toMatchObject([
        { robot_id: "dev", reason: "preempted", runs_on: "device" },
      ]);
      brick!.setMotorInPlace(0, "position", 0);
    },
    // the loop runs on real time in a bridge process: a shared runner that holds it off for more than a period
    // can end it by the rate rule (overrun) mid-test, which is the rule working; such a run is tried again
    { timeout: 60_000, retry: 2 },
  );

  test.skipIf(!runs)(
    "Esc on supervise_loop (notifications/cancelled) ends the loop with a verified stop",
    async () => {
      await fresh();
      expect(await call("run_loop", ARM_HOLD)).toMatchObject({ ok: true, data: { state: "running" } });
      const esc = new AbortController();
      void sleep(300).then(() => esc.abort());
      const out = await call("supervise_loop", { wait_ms: 10_000 }, esc.signal);
      expect(out).toMatchObject({
        ok: true,
        robot: { activity: "idle" },
        data: { state: "ended", reason: "preempted", runs_on: "device" },
      });
      expect(logs.filter((l) => l.ev === "cancelled").at(-1)).toMatchObject({ tool: "supervise_loop", action: "stop" });
      expect(brick!.motorLine(0, "command")).toBe("stop");
      expect((await call("read_device", { device: "ev3.B", channels: ["speed_deg_s"] })).data.readings[0].value).toBe(
        0,
      );
    },
    // the loop runs on real time in a bridge process: a shared runner that holds it off for more than a period
    // can end it by the rate rule (overrun) mid-test, which is the rule working; such a run is tried again
    { timeout: 60_000, retry: 2 },
  );

  test.skipIf(!runs)(
    "a guard ends the loop on the brick: the report names it, the robot takes the path of stop",
    async () => {
      await fresh();
      expect(await call("run_loop", ARM_HOLD)).toMatchObject({ ok: true });
      brick!.setMotorInPlace(0, "position", 250);
      let r: any;
      for (let i = 0; i < 20; i++) {
        r = await call("supervise_loop", { wait_ms: 1000 });
        if (r.data.state === "ended") break;
      }
      expect(r).toMatchObject({
        robot: { activity: "idle" },
        data: { state: "ended", reason: "guard", guard: "out_of_range", runs_on: "device" },
      });
      expect(r.data.trace.angle.at(-1)).toBe(250);
      expect(r.data.trace.out0.at(-1)).toBe(0);
      expect(brick!.motorLine(0, "command")).toBe("stop");
      brick!.setMotorInPlace(0, "position", 0);
    },
    // the loop runs on real time in a bridge process: a shared runner that holds it off for more than a period
    // can end it by the rate rule (overrun) mid-test, which is the rule working; such a run is tried again
    { timeout: 60_000, retry: 2 },
  );

  test.skipIf(!runs)(
    "C2 on the brick: both wheels on run_time, steered by the color sensor; the bumper's guard ends it",
    async () => {
      await fresh();
      const started = await call("run_loop", C2);
      expect(started).toMatchObject({ ok: true, data: { state: "running", runs_on: "device", rate_hz: 10 } });
      // on the edge: both wheels at the feed speed, refreshed as timed runs (hold_ms: 3 periods, 300 ms at 10 Hz)
      expect(started.data.outputs.map((o: { device: string; last: number }) => [o.device, o.last])).toEqual([
        ["ev3.B", 20],
        ["ev3.C", 20],
      ]);
      expect([brick!.motorLine(0, "command"), brick!.motor(0, "time_sp")]).toEqual(["run-timed", "300"]);
      // brighter than the edge: the left wheel speeds up, the right one slows down
      brick!.setSensorInPlace(1, "value0", 55);
      const brighter = await call("supervise_loop", { params: { speed: 15 }, wait_ms: 1000 });
      expect(brighter.data.signals.light.last).toBe(55);
      expect(brighter.data.outputs[0].last).toBeCloseTo(15 + 0.5 * 20, 1);
      expect(brighter.data.outputs[1].last).toBeCloseTo(15 - 0.5 * 20, 1);
      brick!.setSensorInPlace(0, "value0", 1);
      let r: any = brighter;
      for (let i = 0; i < 20 && r.data.state !== "ended"; i++) r = await call("supervise_loop", { wait_ms: 1000 });
      expect(r).toMatchObject({
        robot: { activity: "idle" },
        data: { state: "ended", reason: "guard", guard: "bumper" },
      });
      expect([brick!.motorLine(0, "command"), brick!.motorLine(1, "command")]).toEqual(["stop", "stop"]);
      brick!.setSensorInPlace(0, "value0", 0);
      brick!.setSensorInPlace(1, "value0", 35);
    },
    // the loop runs on real time in a bridge process: a shared runner that holds it off for more than a period
    // can end it by the rate rule (overrun) mid-test, which is the rule working; such a run is tried again
    { timeout: 60_000, retry: 2 },
  );
});
