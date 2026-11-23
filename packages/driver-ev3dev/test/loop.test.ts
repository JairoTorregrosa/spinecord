// The loop executor on the brick (CONTRACT §5a, issue #29 step 8) against a fake sysfs tree and the local Python:
// the law's port held to the golden vectors, the Python 3.5 rules, and the real bridge process running loops
// (its ticks on held attributes, telemetry, ends, the watchdog, the guard's deadman when the bridge is killed or
// stopped), probing them, and the provider's version gate. Loops here run at 20 Hz: a loaded machine slows a
// tick, and a slow tick must not end a loop by overrun before the test's own stop, kill or silence does.
import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { recordTick, startLoop, startStats, setParams, stepLoop, takeStats } from "../../protocol/loop";
import type { LoopPlan } from "../../protocol/types";
import { RuntimeError } from "../../protocol/types";
import {
  BRICK_WATCHDOG_MS,
  EV3DEV_LOOP_RATE_HZ,
  Ev3devProvider,
  EXAMPLE_EV3DEV_HARDWARE,
  GUARD_DEADMAN_MS,
  MIN_LOOP_BRIDGE_VERSION,
  type Ev3devProviderOptions,
  type LineTransport,
} from "../src/provider";
import { BRIDGE_FILE } from "../src/ssh";
import { FakeBrick, findPython } from "./fake-brick";

const BRIDGE_RUNS_HERE = process.platform !== "win32";
const python = findPython();
if (!python) console.warn("SKIPPED: the loop tests of the ev3dev bridge need a local Python 3 (python3 or python).");
const pyTest = test.skipIf(!python);
const brickTest = test.skipIf(!BRIDGE_RUNS_HERE || !python);
const GOLDEN = join(import.meta.dir, "..", "..", "protocol", "loop-golden.json");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("the law on the brick", () => {
  pyTest("the golden vectors through the bridge's port give what loop.ts gives, within the vectors' tolerance", () => {
    const r = spawnSync(python!, [join(import.meta.dir, "law_check.py"), BRIDGE_FILE, GOLDEN], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout) as {
      cases: number;
      ticks: number;
      failures: string[];
      stats: Record<string, { signals: Window[]; outputs: Window[]; trace: Record<string, number[]> }>;
    };
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as {
      cases: {
        name: string;
        plan: LoopPlan;
        ticks: {
          set?: { params: Record<string, number>; ramp_ms?: number };
          inputs: Record<string, number | null>;
          dt: number;
        }[];
      }[];
    };
    expect(out.failures).toEqual([]);
    expect(out.cases).toBe(golden.cases.length);
    expect(out.ticks).toBe(golden.cases.reduce((n, c) => n + c.ticks.length, 0));
    // the statistics a report is built from: the bridge's windows add up to what loop.ts's recordTick collects
    for (const c of golden.cases) {
      let state = startLoop(c.plan);
      const stats = startStats(c.plan);
      for (const tick of c.ticks) {
        if (tick.set) state = setParams(state, tick.set.params, tick.set.ramp_ms ?? 0);
        state = stepLoop(
          state,
          c.plan.signals.map((s) => tick.inputs[s.name] ?? null),
          tick.dt,
        ).state;
        recordTick(stats, state);
      }
      const ts = takeStats(stats);
      const py = out.stats[c.name]!;
      c.plan.signals.forEach((p, i) => {
        const w = py.signals[i]!;
        const want = ts.signals[p.name]!;
        const got = {
          last: w.last,
          min: w.n ? w.min : w.last,
          max: w.n ? w.max : w.last,
          mean: w.n ? w.sum / w.n : w.last,
          integral: w.integral,
          derivative: w.derivative,
        };
        for (const k of Object.keys(want) as (keyof typeof want)[])
          expect(Math.abs(got[k] - want[k])).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(want[k])));
      });
      ts.outputs.forEach((want, i) => {
        const w = py.outputs[i]!;
        expect(Math.abs((w.n ? w.sum / w.n : Math.abs(w.last)) - want.mean_abs)).toBeLessThanOrEqual(1e-9);
        expect(w.n ? (100 * (w.cut ?? 0)) / w.n : 0).toBeCloseTo(want.saturated_pct, 9);
      });
      expect(Object.keys(py.trace).sort()).toEqual(Object.keys(ts.trace).sort());
      for (const key of Object.keys(ts.trace)) {
        expect(py.trace[key]!.length).toBe(ts.trace[key]!.length);
        py.trace[key]!.forEach((x, k) => expect(Math.abs(x - ts.trace[key]![k]!)).toBeLessThanOrEqual(1e-6));
      }
    }
  });

  pyTest("the bridge holds nothing newer than Python 3.5, and the check refuses each construct it looks for", () => {
    const run = (args: string[]) =>
      JSON.parse(
        spawnSync(python!, [join(import.meta.dir, "py35_check.py"), ...args], { encoding: "utf8", windowsHide: true })
          .stdout,
      );
    const self = run(["--self-test"]) as Record<string, boolean>;
    expect(Object.keys(self).length).toBeGreaterThanOrEqual(10);
    for (const [construct, refused] of Object.entries(self))
      expect({ construct, refused }).toEqual({ construct, refused: true });
    // the bridge and its guard's source, and the check that runs on the brick's Python in CI
    const files = [BRIDGE_FILE, join(import.meta.dir, "law_check.py"), join(import.meta.dir, "py35_check.py")];
    const out = run(files) as { checked: string[]; problems: string[] };
    expect(out.problems).toEqual([]);
    expect(out.checked).toContain(`${BRIDGE_FILE}:GUARD_SOURCE`);
  });
});

interface Window {
  n: number;
  min: number;
  max: number;
  sum: number;
  last: number;
  integral: number;
  derivative: number;
  cut?: number;
}

// ---------------------------------------------------------------- the bridge process, line by line

type Line = Record<string, unknown>;
/** The real bridge on a fake tree, spoken to in its own JSON lines, with a heartbeat that the test can pause. */
class RawBridge {
  readonly proc: ChildProcess;
  readonly lines: Line[] = [];
  private buf = "";
  private beat: ReturnType<typeof setInterval>;
  private nextId = 100;
  constructor(readonly brick: FakeBrick) {
    this.proc = spawn(python!, ["-u", BRIDGE_FILE, "--root", brick.root], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...brick.env() },
    });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (d: string) => {
      this.buf += d;
      let k: number;
      while ((k = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, k);
        this.buf = this.buf.slice(k + 1);
        try {
          this.lines.push(JSON.parse(line) as Line);
        } catch {
          /* not a line of the bridge */
        }
      }
    });
    this.proc.stderr!.on("data", () => {});
    this.beat = setInterval(() => this.send({ op: "hb" }), 200);
  }
  send(msg: Line): void {
    try {
      this.proc.stdin!.write(`${JSON.stringify(msg)}\n`);
    } catch {
      /* the process is gone */
    }
  }
  silence(): void {
    clearInterval(this.beat);
  }
  async next(pred: (l: Line) => boolean, ms = 8000): Promise<Line> {
    const t0 = Date.now();
    for (;;) {
      const found = this.lines.find(pred);
      if (found) return found;
      if (Date.now() - t0 > ms)
        throw new Error(`no such line within ${ms} ms; lines: ${JSON.stringify(this.lines.slice(-5))}`);
      await sleep(5);
    }
  }
  async call(msg: Line, ms = 8000): Promise<Line> {
    const id = this.nextId++;
    this.send({ ...msg, id });
    return this.next((l) => l.id === id, ms);
  }
  async hello(): Promise<Line> {
    const r = await this.call(
      {
        op: "hello",
        config: {
          bounds: { max_speed_pct: 60, max_op_ms: 3000, low_battery_v: 6.5, max_tone_ms: 1000, speech_volume_pct: 100 },
        },
      },
      30_000,
    );
    expect(r).toMatchObject({ ok: true, bridge: String(MIN_LOOP_BRIDGE_VERSION), guard: true });
    return r;
  }
  close(): void {
    clearInterval(this.beat);
    try {
      this.proc.kill("SIGCONT");
      this.proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

const opened: { brick: FakeBrick; bridge?: RawBridge; provider?: Ev3devProvider }[] = [];
afterEach(async () => {
  for (const o of opened.splice(0)) {
    o.bridge?.close();
    await o.provider?.close().catch(() => {});
    await sleep(50);
    o.brick.dispose();
  }
});

/** Motor B (motor0) and C (motor1); a touch sensor on 1 (sensor0); an ultrasonic sensor on 3 (sensor1), in mode cm. */
function rig() {
  const brick = new FakeBrick({
    motors: [{ port: "B" }, { port: "C" }],
    sensors: [
      { port: 1, driver: "lego-ev3-touch", mode: "TOUCH", modes: ["TOUCH"], values: [0] },
      {
        port: 3,
        driver: "lego-ev3-us",
        mode: "US-DIST-CM",
        modes: ["US-DIST-CM", "US-DIST-IN"],
        values: [420],
        decimals: 1,
      },
    ],
    battery_uv: 7900000,
  });
  const bridge = new RawBridge(brick);
  opened.push({ brick, bridge });
  return { brick, bridge };
}

/** A planned loop of the bridge's local names: B's position steers B's power. */
function plan(over: Partial<LoopPlan> = {}, output: Partial<LoopPlan["outputs"][number]> = {}): LoopPlan {
  return {
    rate_hz: 20,
    period_ms: 50,
    duration_ms: 20_000,
    attention_ms: 15_000,
    trace_hz: 10,
    signals: [
      {
        name: "angle",
        device: "B",
        channel: "position_deg",
        zero: "none",
        mean_ms: 0,
        noise: 0,
        detrend_s: 0,
        smooth_ms: 0,
      },
      {
        name: "far",
        device: "S3",
        channel: "distance_cm",
        zero: "none",
        mean_ms: 0,
        noise: 2,
        detrend_s: 0,
        smooth_ms: 0,
      },
    ],
    params: { target: 45 },
    outputs: [
      {
        device: "B",
        command: "power",
        arg: "power_pct",
        args: {},
        hold_ms: 150,
        min: -60,
        max: 60,
        terms: [{ signal: "angle", setpoint: "target", gain: -2 }],
        ...output,
      },
    ],
    guards: [],
    clamps: [],
    notes: [],
    ...over,
  };
}
const commandOf = (brick: FakeBrick, i = 0) => brick.motorLine(i, "command");

describe("the bridge runs a loop", () => {
  brickTest(
    "a loop ticks on held attributes: run-direct with the deadman armed, telemetry, params, and stop brakes it",
    async () => {
      const { brick, bridge } = rig();
      await bridge.hello();
      const started = await bridge.call({ op: "loop_start", plan: plan() });
      expect(started).toMatchObject({ ok: true, loop: started.id });
      // one telemetry line every 0.5 s, and one on the 20th tick, after which run_loop answers
      const first = await bridge.next((l) => l.ev === "loop" && l.loop === started.id);
      expect(first).toMatchObject({ overruns: 0, params: { target: 45 } });
      const n = Number(first.ticks);
      expect(await bridge.next((l) => l.ev === "loop" && l.ticks === 20)).toMatchObject({ loop: started.id });
      expect(commandOf(brick)).toBe("run-direct");
      // the law: B at 0 under a target of 45 with gain -2 → +90, cut to the output's 60
      expect(brick.motorLine(0, "duty_cycle_sp")).toBe("60");
      const w = first.signals as Window[];
      expect(w[0]).toMatchObject({ n, last: 0 });
      expect(w[1]).toMatchObject({ n, last: 42 });
      expect((first.outputs as Window[])[0]).toMatchObject({ n, last: 60, cut: n });
      expect((first.periods as number[]).length).toBe(n - 1);
      expect((first.trace as Record<string, number[]>).out0!.every((u) => u === 60)).toBe(true);
      // a reading through the held descriptor: B moves to 40, so the output is (40 − 45) × −2 = 10
      brick.setMotorInPlace(0, "position", 40);
      await bridge.next(() => brick.motorLine(0, "duty_cycle_sp") === "10", 3000);
      // params change on a tick boundary; an unknown one is refused
      expect(await bridge.call({ op: "loop_set", loop: started.id, params: { target: 30 }, ramp_ms: 0 })).toMatchObject(
        {
          ok: true,
          params: { target: 30 },
        },
      );
      await bridge.next(() => brick.motorLine(0, "duty_cycle_sp") === "-20", 3000);
      expect(await bridge.call({ op: "loop_set", loop: started.id, params: { nope: 1 } })).toMatchObject({
        ok: false,
        code: "invalid_argument",
      });
      // a command on the driven motor is busy; a read of it runs, and says the power applied
      expect(
        await bridge.call({ op: "command", device: "B", command: "run_time", args: { ms: 100, speed_pct: 20 } }),
      ).toMatchObject({
        ok: false,
        code: "busy",
      });
      expect(await bridge.call({ op: "read", device: "B", channels: ["power_pct"] })).toMatchObject({
        ok: true,
        readings: [{ channel: "power_pct", value: -20 }],
      });
      // a second loop is busy
      expect(await bridge.call({ op: "loop_start", plan: plan({}, { device: "C" }) })).toMatchObject({
        ok: false,
        code: "busy",
      });
      const stop = await bridge.call({ op: "stop" });
      expect(stop).toMatchObject({ ok: true, motors_stopped: true });
      const end = await bridge.next((l) => l.ev === "loop_end");
      expect(end).toMatchObject({ loop: started.id, reason: "preempted" });
      expect(end).not.toHaveProperty("brake_error");
      expect([commandOf(brick), brick.motor(0, "stop_action")]).toEqual(["stop", "brake"]);
      expect(await bridge.call({ op: "read", device: "B", channels: ["power_pct"] })).toMatchObject({
        readings: [{ value: 0 }],
      });
    },
    30_000,
  );

  brickTest(
    "a guard ends the loop on the tick that reads it, braked; abort ends one with preempted",
    async () => {
      const { brick, bridge } = rig();
      await bridge.hello();
      const guarded = plan({
        guards: [{ name: "too_close", signal: "far", op: "lt", value: 10 }],
      });
      const a = await bridge.call({ op: "loop_start", plan: guarded });
      await bridge.next((l) => l.ev === "loop" && l.loop === a.id);
      brick.setSensorInPlace(1, "value0", 50); // 5.0 cm
      const end = await bridge.next((l) => l.ev === "loop_end" && l.loop === a.id, 5000);
      expect(end).toMatchObject({ reason: "guard", guard: "too_close" });
      expect(commandOf(brick)).toBe("stop");
      brick.setSensorInPlace(1, "value0", 420);
      // run_time as an output: run-timed refreshed for the hold time, then abort
      const b = await bridge.call({
        op: "loop_start",
        plan: plan({}, { command: "run_time", arg: "speed_pct", hold_ms: 150 }),
      });
      await bridge.next((l) => l.ev === "loop" && l.loop === b.id);
      expect([brick.motorLine(0, "command"), brick.motor(0, "time_sp"), brick.motorLine(0, "speed_sp")]).toEqual([
        "run-timed",
        "150",
        String(Math.round(0.6 * 1050)),
      ]);
      bridge.send({ op: "abort", target: b.id });
      expect(await bridge.next((l) => l.ev === "loop_end" && l.loop === b.id)).toMatchObject({ reason: "preempted" });
      expect(commandOf(brick)).toBe("stop");
    },
    30_000,
  );

  brickTest(
    "a refused loop sends nothing: a channel that is not active, a motor that is busy, a command no loop drives",
    async () => {
      const { brick, bridge } = rig();
      await bridge.hello();
      const inactive = plan({
        signals: [
          {
            name: "inches",
            device: "S3",
            channel: "distance_cm",
            zero: "none",
            mean_ms: 0,
            noise: 0,
            detrend_s: 0,
            smooth_ms: 0,
          },
        ],
        outputs: [{ ...plan().outputs[0]!, terms: [{ signal: "inches", gain: 1 }] }],
      });
      brick.setSensor(1, "mode", "US-DIST-IN");
      const r = await bridge.call({ op: "loop_start", plan: inactive });
      expect(r).toMatchObject({ ok: false, code: "invalid_argument" });
      expect(String(r.message)).toContain("never switches a sensor mode");
      brick.setSensor(1, "mode", "US-DIST-CM");
      expect(await bridge.call({ op: "loop_start", plan: plan({}, { command: "run_to_position" }) })).toMatchObject({
        ok: false,
        code: "unsupported",
      });
      expect([commandOf(brick), brick.motorLine(0, "duty_cycle_sp")]).toEqual(["", "0"]);
    },
    30_000,
  );

  brickTest(
    "the watchdog ends a loop: 1 s without a line from the computer, the motors brake and loop_end says timeout",
    async () => {
      const { brick, bridge } = rig();
      await bridge.hello();
      const a = await bridge.call({ op: "loop_start", plan: plan() });
      await bridge.next((l) => l.ev === "loop" && l.loop === a.id);
      bridge.silence();
      const t0 = Date.now();
      const dog = await bridge.next((l) => l.ev === "watchdog", 5000);
      expect(dog).toMatchObject({ cause: "silence", watchdog_ms: BRICK_WATCHDOG_MS });
      expect(await bridge.next((l) => l.ev === "loop_end" && l.loop === a.id, 2000)).toMatchObject({
        reason: "timeout",
      });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(BRICK_WATCHDOG_MS - 300);
      expect([commandOf(brick), brick.motor(0, "stop_action")]).toEqual(["stop", "brake"]);
    },
    30_000,
  );

  brickTest(
    "killing the bridge mid-loop: the guard brakes every motor",
    async () => {
      const { brick, bridge } = rig();
      await bridge.hello();
      const a = await bridge.call({ op: "loop_start", plan: plan() });
      await bridge.next((l) => l.ev === "loop" && l.loop === a.id);
      expect(commandOf(brick)).toBe("run-direct");
      bridge.proc.kill("SIGKILL");
      await bridge.next(() => commandOf(brick) === "stop" && commandOf(brick, 1) === "stop", 5000);
      expect([brick.motor(0, "stop_action"), brick.motor(1, "stop_action")]).toEqual(["brake", "brake"]);
    },
    30_000,
  );

  brickTest(
    `a bridge stopped mid-loop: the guard brakes within 300 ms, and once it runs again it ends the loop and drives nothing`,
    async () => {
      const { brick, bridge } = rig();
      await bridge.hello();
      const a = await bridge.call({ op: "loop_start", plan: plan() });
      // a loop older than a second, so the rate rule judges the late tick that follows the stop
      await bridge.next((l) => l.ev === "loop" && l.loop === a.id);
      await bridge.next((l) => l.ev === "loop" && l.loop === a.id && Number(l.ticks) > 25, 5000);
      expect(commandOf(brick)).toBe("run-direct");
      const stoppedAt = Date.now();
      bridge.proc.kill("SIGSTOP");
      await bridge.next(() => commandOf(brick) === "stop", 3000);
      // when the guard wrote the brake, on the file's own clock
      const brakedAt = statSync(join(brick.motorDir(0), "command")).mtimeMs;
      expect(brakedAt - stoppedAt).toBeLessThanOrEqual(300);
      expect(brakedAt - stoppedAt).toBeGreaterThanOrEqual(GUARD_DEADMAN_MS - 60);
      expect(brick.motor(0, "stop_action")).toBe("brake");
      const duty = brick.motorLine(0, "duty_cycle_sp");
      await sleep(500 - (Date.now() - stoppedAt)); // under the watchdog's second: the computer's lines are queued
      bridge.proc.kill("SIGCONT");
      // its first look at the time ends the loop: the tick is late; no run command is written again, and no power
      const seen = new Set<string>();
      const watch = setInterval(() => seen.add(`${commandOf(brick)} ${brick.motorLine(0, "duty_cycle_sp")}`), 2);
      expect(await bridge.next((l) => l.ev === "loop_end" && l.loop === a.id, 5000)).toMatchObject({
        reason: "overrun",
      });
      await sleep(200);
      clearInterval(watch);
      expect([...seen].every((s) => s === `stop ${duty}` || s === "stop 0")).toBe(true);
      expect(commandOf(brick)).toBe("stop");
    },
    30_000,
  );

  brickTest(
    "motor.power outside a loop is run-direct with the deadman armed: a stopped bridge is braked by the guard",
    async () => {
      const { brick, bridge } = rig();
      await bridge.hello();
      const done = bridge.call({ op: "command", device: "C", command: "power", args: { power_pct: 30, ms: 2000 } });
      await bridge.next(() => commandOf(brick, 1) === "run-direct", 3000);
      expect(brick.motorLine(1, "duty_cycle_sp")).toBe("30");
      const stoppedAt = Date.now();
      bridge.proc.kill("SIGSTOP");
      await bridge.next(() => commandOf(brick, 1) === "stop", 3000);
      expect(statSync(join(brick.motorDir(1), "command")).mtimeMs - stoppedAt).toBeLessThanOrEqual(300);
      bridge.proc.kill("SIGCONT");
      // the operation goes on to its time and answers; nothing turned the fake motor
      expect(await done).toMatchObject({ ok: true, result: { reason: "stalled", measured: { degrees: 0 } } });
      expect(commandOf(brick, 1)).toBe("stop");
    },
    30_000,
  );

  brickTest(
    "loop_probe runs the ticks back to back with every output written as 0 and no run command",
    async () => {
      const { brick, bridge } = rig();
      await bridge.hello();
      const r = await bridge.call({ op: "loop_probe", plan: plan(), ticks: 300 }, 20_000);
      expect(r).toMatchObject({ ok: true, probe: { ticks: 300, signals: 2, outputs: 1 } });
      const p = r.probe as Record<string, number>;
      expect(p.p50_ms).toBeLessThanOrEqual(p.p99_ms);
      expect(p.p99_ms).toBeLessThanOrEqual(p.max_ms);
      expect([10, 20, 25, 50, 100, 200]).toContain(p.max_rate_hz);
      expect([commandOf(brick), brick.motorLine(0, "duty_cycle_sp")]).toEqual(["", "0"]);
      // the motor is free again
      expect(await bridge.call({ op: "read", device: "B", channels: ["position_deg"] })).toMatchObject({ ok: true });
      expect(await bridge.call({ op: "loop_probe", plan: plan(), ticks: 0 })).toMatchObject({
        ok: false,
        code: "invalid_argument",
      });
    },
    30_000,
  );
});

// ---------------------------------------------------------------- the provider

describe("the provider's loop", () => {
  /** A bridge that answers every hello with this version and a motor on B. */
  const answering = (bridge: string) => {
    let onLine: (line: string) => void = () => {};
    const sent: string[] = [];
    const transport: LineTransport = {
      open: async () => {},
      close: async () => {},
      onLine: (cb) => {
        onLine = cb;
      },
      onClose: () => {},
      send(line) {
        const msg = JSON.parse(line) as { op: string; id?: number };
        sent.push(msg.op);
        if (msg.op !== "hello") return;
        const hello = {
          id: msg.id,
          ok: true,
          bridge,
          guard: true,
          watchdog_ms: BRICK_WATCHDOG_MS,
          motors: [
            {
              port: "B",
              address: "ev3-ports:outB",
              driver_name: "lego-ev3-l-motor",
              count_per_rot: 360,
              max_speed: 1050,
              commands: null,
              stop_actions: null,
            },
          ],
          sensors: [],
          unknown: [],
          ports: [],
          capabilities: {},
          speech: null,
        };
        queueMicrotask(() => onLine(JSON.stringify(hello)));
      },
    };
    return { transport, sent };
  };
  const OPTS: Ev3devProviderOptions = {
    limits: { max_speed_pct: 60, max_command_ms: 15000 },
    hardware: EXAMPLE_EV3DEV_HARDWARE,
  };
  const localPlan = (device = "ev3.B"): LoopPlan => {
    const p = plan();
    return {
      ...p,
      signals: [{ ...p.signals[0]!, device }],
      outputs: [{ ...p.outputs[0]!, device }],
    };
  };

  test("the provider runs loops on the device at 50 Hz until probed; only a loop and power need version 7", async () => {
    expect([MIN_LOOP_BRIDGE_VERSION, EV3DEV_LOOP_RATE_HZ]).toEqual([7, 50]);
    for (const [version, loops] of [
      ["6", false],
      ["7", true],
    ] as const) {
      const { transport, sent } = answering(version);
      const provider = new Ev3devProvider(transport, OPTS);
      expect(provider.loop).toMatchObject({ runs_on: "device", max_rate_hz: 50 });
      const b = (await provider.devices()).find((d) => d.id === "ev3.B")!;
      expect(b.commands.some((c) => c.name === "power")).toBe(loops);
      expect(b.channels.some((c) => c.name === "power_pct")).toBe(loops);
      expect(b.commands.find((c) => c.name === "run_time")!.drives).toEqual(
        loops ? { arg: "speed_pct", max_hold_ms: 3000 } : undefined,
      );
      if (loops)
        expect(b.commands.find((c) => c.name === "power")!.drives).toEqual({
          arg: "power_pct",
          max_hold_ms: GUARD_DEADMAN_MS,
        });
      let refused: unknown = null;
      try {
        provider.loop.check!(localPlan());
      } catch (e) {
        refused = e;
      }
      if (loops) expect(refused).toBeNull();
      else {
        expect(refused).toBeInstanceOf(RuntimeError);
        expect((refused as RuntimeError).code).toBe("misconfigured");
        expect((refused as RuntimeError).message).toContain("needs bridge version 7");
        expect((refused as RuntimeError).message).toContain("--install-bridge");
      }
      // a refused plan, and one with a command no loop drives on the brick, send nothing
      const run = provider.loop.start(localPlan(), () => {}).catch((e: unknown) => e);
      if (!loops) expect(((await run) as RuntimeError).code).toBe("misconfigured");
      else for (let t0 = Date.now(); !sent.includes("loop_start") && Date.now() - t0 < 5000;) await sleep(5);
      expect(sent.filter((op) => op === "loop_start").length).toBe(loops ? 1 : 0);
      await provider.close();
    }
  });

  brickTest(
    "probeLoop measures the brick and sets the link's max_rate_hz; a new link starts from 50 again",
    async () => {
      const brick = new FakeBrick({ motors: [{ port: "B" }, { port: "C" }], sensors: [] });
      const provider = new Ev3devProvider(brick.transport(python!), { ...OPTS, pair: { left: "B", right: "C" } });
      opened.push({ brick, provider });
      const probe = await provider.probeLoop({ ticks: 200 });
      expect(probe).toMatchObject({ ticks: 200, signals: 4, outputs: 2 });
      expect(provider.loop.max_rate_hz).toBe(probe.max_rate_hz);
      expect([brick.motorLine(0, "command"), brick.motorLine(1, "command")]).toEqual(["", ""]);
    },
    60_000,
  );
});
