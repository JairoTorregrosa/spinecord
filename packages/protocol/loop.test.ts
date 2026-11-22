import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type LoopContext,
  type LoopState,
  type LoopStep,
  planLoop,
  recordTick,
  setParams,
  startLoop,
  startStats,
  stepLoop,
  takeStats,
} from "./loop";
import { type LoopEnd, type LoopSpec, RuntimeError } from "./types";
import { validateLoop } from "./validate";

const NUM = { type: "number" } as const;
const POWER = { drives: { arg: "power_pct", max_hold_ms: 250 }, range: [-100, 100] as [number, number] };
const SPEED = { drives: { arg: "speed_pct", max_hold_ms: 250 }, range: [-100, 100] as [number, number] };
const base = (over: Partial<LoopSpec> = {}): LoopSpec => ({
  rate_hz: 50,
  duration_ms: 10_000,
  signals: { x: { device: "s", channel: "c" } },
  outputs: [{ device: "m", command: "power", terms: [{ signal: "x", gain: 1 }] }],
  ...over,
});
const ctx = (over: Partial<LoopContext> = {}): LoopContext => ({
  signals: { x: NUM },
  outputs: [POWER],
  max_rate_hz: 100,
  max_loop_ms: 60_000,
  ...over,
});
function refusal(fn: () => unknown): RuntimeError {
  try {
    fn();
  } catch (e) {
    if (e instanceof RuntimeError) return e;
    throw e;
  }
  throw new Error("expected a RuntimeError");
}
/** The specs of docs/loops.md, as printed there. */
const examples = [
  ...readFileSync(join(import.meta.dir, "..", "..", "docs", "loops.md"), "utf8").matchAll(/```json\r?\n([\s\S]*?)```/g),
].map((m) => JSON.parse(m[1]!) as LoopSpec);
const [C1, C2, C3, C4] = examples as [LoopSpec, LoopSpec, LoopSpec, LoopSpec];

// ---------- Golden vectors ----------
interface GoldenCase {
  name: string;
  spec: unknown;
  ctx: LoopContext;
  ticks: {
    set?: { params: Record<string, number>; ramp_ms?: number };
    inputs: Record<string, number | null>;
    dt: number;
    expect: { outputs: number[]; guard?: string; end?: LoopEnd };
  }[];
}
const golden = JSON.parse(readFileSync(join(import.meta.dir, "loop-golden.json"), "utf8")) as { cases: GoldenCase[] };

describe("golden vectors", () => {
  for (const c of golden.cases)
    test(c.name, () => {
      const plan = planLoop(c.spec, c.ctx);
      let state = startLoop(plan);
      c.ticks.forEach((tick, k) => {
        if (tick.set) state = setParams(state, tick.set.params, tick.set.ramp_ms ?? 0);
        const step = stepLoop(
          state,
          plan.signals.map((s) => tick.inputs[s.name] ?? null),
          tick.dt,
        );
        state = step.state;
        expect(step.outputs.length).toBe(tick.expect.outputs.length);
        step.outputs.forEach((u, i) => {
          if (Math.abs(u - tick.expect.outputs[i]!) > 1e-9)
            throw new Error(`tick ${k} output ${i}: ${u}, expected ${tick.expect.outputs[i]}`);
        });
        expect({ tick: k, guard: step.guard, end: step.end }).toEqual({
          tick: k,
          guard: tick.expect.guard,
          end: tick.expect.end,
        });
      });
    });
  test("the cases cover every term kind, zero mode, filter, guard and limit", () => {
    const specs = golden.cases.map((c) => c.spec as LoopSpec);
    const terms = specs.flatMap((s) => s.outputs.flatMap((o) => o.terms));
    const signals = specs.flatMap((s) => Object.values(s.signals));
    const guards = specs.flatMap((s) => s.guards ?? []);
    const ends = golden.cases.flatMap((c) => c.ticks.map((t) => t.expect.end?.reason));
    expect(terms.some((t) => "feed" in t)).toBe(true);
    for (const of of ["value", "integral", "derivative"] as const) {
      expect(terms.some((t) => "signal" in t && (t.of ?? "value") === of)).toBe(true);
      expect(guards.some((g) => (g.of ?? "value") === of)).toBe(true);
    }
    expect(terms.some((t) => "clamp" in t)).toBe(true);
    expect(signals.some((s) => s.zero === "start")).toBe(true);
    expect(signals.some((s) => typeof s.zero === "object")).toBe(true);
    expect(signals.some((s) => s.detrend_s !== undefined)).toBe(true);
    expect(signals.some((s) => s.smooth_ms !== undefined)).toBe(true);
    for (const op of ["gt", "lt", "abs_gt"]) expect(guards.some((g) => g.op === op)).toBe(true);
    expect(guards.some((g) => g.for_ms !== undefined)).toBe(true);
    expect(specs.some((s) => s.outputs.some((o) => o.limit))).toBe(true);
    for (const reason of ["guard", "input_lost", "not_still"] as const) expect(ends).toContain(reason);
    expect(golden.cases.some((c) => c.ticks.some((t) => t.set?.ramp_ms))).toBe(true);
  });
});

// ---------- Planning ----------
describe("planLoop", () => {
  test("fills in the defaults and keeps the spec's order", () => {
    const plan = planLoop(C1, {
      signals: { pitch_rate: { ...NUM, noise: 1 }, left: NUM, right: NUM },
      outputs: [POWER, POWER],
      max_rate_hz: 100,
      max_loop_ms: 120_000,
    });
    expect(plan.signals.map((s) => s.name)).toEqual(["pitch_rate", "left", "right"]);
    expect(plan.signals[0]).toMatchObject({ zero: "mean", mean_ms: 1000, noise: 1, detrend_s: 20, smooth_ms: 0 });
    expect(plan.signals[1]).toMatchObject({ zero: "start", mean_ms: 0, noise: 0, smooth_ms: 20 });
    expect(plan).toMatchObject({
      period_ms: 10,
      duration_ms: 60_000,
      attention_ms: 10_000,
      trace_hz: 10,
      clamps: [],
      notes: [],
    });
    expect(plan.outputs[0]).toMatchObject({ arg: "power_pct", args: {}, hold_ms: 30, min: -100, max: 100 });
    expect(planLoop(base(), ctx())).toMatchObject({ attention_ms: 15_000, trace_hz: 10, params: {}, guards: [] });
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });
  test("a spec that fails validation is invalid_argument and names the field", () => {
    const e = refusal(() => planLoop(base({ rate_hz: 0 }), ctx()));
    expect(e.code).toBe("invalid_argument");
    expect(e.message).toContain("loop.rate_hz");
  });
  test("a rate above the maximum is refused and the message names the maximum", () => {
    const e = refusal(() => planLoop(base({ rate_hz: 100 }), ctx({ max_rate_hz: 50 })));
    expect(e.code).toBe("invalid_argument");
    expect(e.message).toContain("loop.rate_hz");
    expect(e.message).toContain("50 Hz");
    expect(planLoop(base({ rate_hz: 50 }), ctx({ max_rate_hz: 50 })).rate_hz).toBe(50);
  });
  test("an inactive channel is refused with next starting at read_device", () => {
    const e = refusal(() => planLoop(base(), ctx({ signals: { x: { ...NUM, active: false } } })));
    expect(e.code).toBe("invalid_argument");
    expect(e.next?.[0]).toBe("read_device");
    expect(e.message).toContain("loop.signals.x");
    expect(planLoop(base(), ctx({ signals: { x: { ...NUM, active: true } } })).signals.length).toBe(1);
  });
  test("a channel that is not numeric is refused", () => {
    for (const type of ["string", "image"] as const) {
      const e = refusal(() => planLoop(base(), ctx({ signals: { x: { type } } })));
      expect(e.code).toBe("invalid_argument");
      expect(e.message).toContain("loop.signals.x.channel");
    }
    expect(planLoop(base(), ctx({ signals: { x: { type: "boolean" } } })).signals.length).toBe(1);
  });
  test("a vector channel takes an index inside its length, and only a vector does", () => {
    const vector = { signals: { x: { type: "vector" as const, length: 3 } } };
    const indexed = (index: number) => base({ signals: { x: { device: "s", channel: "c", index } } });
    expect(planLoop(indexed(2), ctx(vector)).signals[0]!.index).toBe(2);
    for (const e of [
      refusal(() => planLoop(base(), ctx(vector))),
      refusal(() => planLoop(indexed(3), ctx(vector))),
      refusal(() => planLoop(indexed(0), ctx())),
    ]) {
      expect(e.code).toBe("invalid_argument");
      expect(e.message).toContain("loop.signals.x.index");
    }
  });
  test("a channel the robot does not have is unknown_channel", () => {
    expect(refusal(() => planLoop(base(), ctx({ signals: {} }))).code).toBe("unknown_channel");
    const inherited = base({
      signals: { constructor: { device: "s", channel: "c" } },
      outputs: [{ device: "m", command: "power", terms: [{ feed: 1 }] }],
    });
    expect(refusal(() => planLoop(inherited, ctx({ signals: {} }))).code).toBe("unknown_channel");
  });
  test("a command without drives, or without a range for its argument, is unsupported", () => {
    for (const outputs of [[{}], [], [{ drives: POWER.drives }]]) {
      const e = refusal(() => planLoop(base(), ctx({ outputs })));
      expect(e.code).toBe("unsupported");
      expect(e.message).toContain("loop.outputs[0].command");
    }
  });
  test("args may not hold the argument the loop computes", () => {
    const spec = (args: Record<string, number>) =>
      base({ outputs: [{ device: "m", command: "power", args, terms: [{ feed: 1 }] }] });
    const e = refusal(() => planLoop(spec({ power_pct: 5 }), ctx()));
    expect(e.code).toBe("invalid_argument");
    expect(e.message).toContain("loop.outputs[0].args.power_pct");
    expect(planLoop(spec({ ms: 100 }), ctx()).outputs[0]!.args).toEqual({ ms: 100 });
  });
  test("hold_ms is 3 periods, at least 30 ms, at most max_hold_ms", () => {
    const hold = (rate_hz: number, max_hold_ms: number) =>
      planLoop(base({ rate_hz }), ctx({ outputs: [{ drives: { arg: "power_pct", max_hold_ms }, range: [-100, 100] }] }))
        .outputs[0]!.hold_ms;
    expect(hold(50, 250)).toBe(60);
    expect(hold(100, 250)).toBe(30);
    expect(hold(200 / 3, 250)).toBe(45);
    expect(planLoop(base({ rate_hz: 200 }), ctx({ max_rate_hz: 200 })).outputs[0]!.hold_ms).toBe(30);
    expect(hold(5, 250)).toBe(250);
    expect(hold(50, 0)).toBe(0);
  });
  test("duration is cut to max_loop_ms and the cut is reported", () => {
    const plan = planLoop(base({ duration_ms: 90_000 }), ctx());
    expect(plan.duration_ms).toBe(60_000);
    expect(plan.clamps).toEqual([{ arg: "duration_ms", requested: 90_000, applied: 60_000, target: true }]);
    const e = refusal(() =>
      planLoop(
        base({ duration_ms: 90_000, signals: { x: { device: "s", channel: "c", zero: { mean_ms: 70_000 } } } }),
        ctx(),
      ),
    );
    expect(e.message).toContain("loop.signals.x.zero.mean_ms");
  });
  test("an output's bounds are its limit cut to the range of the driven argument", () => {
    const bounds = (limit: [number, number] | undefined) => {
      const o = planLoop(
        base({ outputs: [{ device: "m", command: "power", terms: [{ feed: 1 }], ...(limit ? { limit } : {}) }] }),
        ctx(),
      ).outputs[0]!;
      return [o.min, o.max];
    };
    expect(bounds(undefined)).toEqual([-100, 100]);
    expect(bounds([-40, 40])).toEqual([-40, 40]);
    expect(bounds([-400, 40])).toEqual([-100, 40]);
    expect(bounds([200, 300])).toEqual([100, 100]);
  });
  test("a channel slower than the loop is named in notes", () => {
    const plan = planLoop(base(), ctx({ signals: { x: { ...NUM, max_rate_hz: 20 } } }));
    expect(plan.notes.length).toBe(1);
    expect(plan.notes[0]).toContain("signal x");
  });
  test("a context without limits is misconfigured", () => {
    expect(refusal(() => planLoop(base(), ctx({ max_rate_hz: 0 }))).code).toBe("misconfigured");
  });
});

// ---------- One tick ----------
describe("stepLoop", () => {
  const run = (spec: LoopSpec, inputs: (number | null)[][], dt = 20, c = ctx()): LoopStep[] => {
    let state = startLoop(planLoop(spec, c));
    return inputs.map((x) => {
      const step = stepLoop(state, x, dt);
      state = step.state;
      return step;
    });
  };
  test("is deterministic and leaves the state it was given as it was", () => {
    const plan = planLoop(C4, { ...ctx(), signals: { angle: NUM } });
    const start = startLoop(plan);
    const frozen = JSON.stringify(start);
    const a = stepLoop(stepLoop(start, [3], 20).state, [9], 20);
    const b = stepLoop(stepLoop(start, [3], 20).state, [9], 20);
    expect(JSON.stringify(start)).toBe(frozen);
    expect(a).toEqual(b);
    expect(JSON.parse(JSON.stringify(a.state))).toEqual(a.state);
  });
  test("the first tick's dt is not read", () => {
    const spec = base({
      outputs: [{ device: "m", command: "power", terms: [{ signal: "x", of: "integral", gain: 1 }] }],
    });
    const plan = planLoop(spec, ctx());
    expect(stepLoop(startLoop(plan), [5], 1000).outputs).toEqual([0]);
    expect(stepLoop(startLoop(plan), [5], 1000).state.t_ms).toBe(0);
  });
  test("a reading that is not a finite number counts as no value", () => {
    const steps = run(base(), [[1], [Number.NaN], [Number.POSITIVE_INFINITY], [Number.NaN]]);
    expect(steps.map((s) => s.end?.reason)).toEqual([undefined, undefined, undefined, "input_lost"]);
    expect(steps[2]!.outputs).toEqual([1]);
  });
  test("a signal that never had a value holds every output at 0 until the loop is lost", () => {
    const steps = run(base({ outputs: [{ device: "m", command: "power", terms: [{ feed: 9 }] }] }), [
      [null],
      [null],
      [null],
    ]);
    expect(steps.map((s) => s.outputs)).toEqual([[0], [0], [0]]);
    expect(steps[2]!.end).toEqual({ reason: "input_lost" });
  });
  test("an ended loop stays ended", () => {
    const spec = base({ guards: [{ name: "high", signal: "x", op: "gt", value: 1 }] });
    const [first] = run(spec, [[5]]);
    expect(first!.guard).toBe("high");
    const again = stepLoop(first!.state, [0], 20);
    expect(again.outputs).toEqual([0]);
    expect(again.end).toEqual({ reason: "guard", guard: "high" });
    expect(again.state).toBe(first!.state);
  });
  test("a boolean channel arrives as 0 or 1 and a guard reads it", () => {
    const spec = base({ guards: [{ name: "pressed", signal: "x", op: "gt", value: 0.5 }] });
    expect(run(spec, [[0], [0], [1]], 20, ctx({ signals: { x: { type: "boolean" } } })).map((s) => s.guard)).toEqual([
      undefined,
      undefined,
      "pressed",
    ]);
  });
  test("a negative or missing dt is refused", () => {
    const state = stepLoop(startLoop(planLoop(base(), ctx())), [0], 20).state;
    expect(refusal(() => stepLoop(state, [0], -1)).code).toBe("invalid_argument");
    expect(refusal(() => stepLoop(state, [0], Number.NaN)).code).toBe("invalid_argument");
  });
  test("an output that is not a finite number is an internal error, never a value", () => {
    const spec = base({
      outputs: [
        {
          device: "m",
          command: "power",
          terms: [
            { signal: "x", gain: 1e308 },
            { signal: "x", gain: -1e308 },
          ],
        },
      ],
    });
    expect(refusal(() => run(spec, [[1e10]])).code).toBe("internal");
  });
});

describe("setParams", () => {
  const spec = base({
    params: { a: 1, b: 10 },
    outputs: [{ device: "m", command: "power", terms: [{ feed: "a" }, { feed: "b" }] }],
  });
  const first = (): LoopState => stepLoop(startLoop(planLoop(spec, ctx())), [0], 20).state;
  test("changes every named param on the same tick", () => {
    const state = setParams(first(), { a: 2, b: 20 });
    expect(state.params).toEqual({ a: 2, b: 20 });
    expect(stepLoop(state, [0], 20).outputs).toEqual([22]);
  });
  test("a ramp moves a param linearly over loop time and ends on the value", () => {
    let state = setParams(first(), { a: 5 }, 80);
    const seen: number[] = [];
    for (let k = 0; k < 6; k++) {
      state = stepLoop(state, [0], 20).state;
      seen.push(state.params.a!);
    }
    expect(seen).toEqual([2, 3, 4, 5, 5, 5]);
    expect(state.ramps).toEqual({});
  });
  test("a set without a ramp ends the ramp of the same param", () => {
    const state = setParams(setParams(first(), { a: 5 }, 80), { a: 7 });
    expect(stepLoop(state, [0], 20).state.params.a).toBe(7);
  });
  test("leaves the state it was given as it was, and keeps integrals and filters", () => {
    const state = first();
    const frozen = JSON.stringify(state);
    const next = setParams(state, { a: 3 }, 100);
    expect(JSON.stringify(state)).toBe(frozen);
    expect(next.signals).toBe(state.signals);
    expect(next.integrals).toBe(state.integrals);
  });
  test("refuses an unknown name, a value that is no number and a negative ramp", () => {
    for (const fn of [
      () => setParams(first(), { c: 1 }),
      () => setParams(first(), { toString: 1 }),
      () => setParams(first(), { constructor: 1 }),
      () => setParams(first(), { a: Number.NaN }),
      () => setParams(first(), { a: 1 }, -5),
    ])
      expect(refusal(fn).code).toBe("invalid_argument");
    expect(refusal(() => setParams(first(), { c: 1 })).message).toContain("params.c");
  });
});

// ---------- Statistics ----------
describe("report statistics", () => {
  const spec = base({
    rate_hz: 100,
    trace_hz: 20,
    signals: { x: { device: "s", channel: "c" } },
    outputs: [{ device: "m", command: "power", limit: [-3, 3], terms: [{ signal: "x", gain: 1 }] }],
  });
  test("signals, outputs and saturation since the previous report", () => {
    const plan = planLoop(spec, ctx());
    const stats = startStats(plan);
    let state = startLoop(plan);
    for (const x of [1, 2, -5, 4]) {
      state = stepLoop(state, [x], 10).state;
      recordTick(stats, state);
    }
    const report = takeStats(stats);
    expect(report.signals.x).toMatchObject({ last: 4, min: -5, max: 4, mean: 0.5, derivative: 900 });
    expect(report.signals.x!.integral).toBeCloseTo(0.01, 12);
    expect(report.outputs).toEqual([
      { device: "m", command: "power", last: 3, min: -3, max: 3, mean_abs: 2.25, saturated_pct: 50 },
    ]);
    // a window without a tick repeats the latest values
    expect(takeStats(stats).signals.x).toMatchObject({ last: 4, min: 4, max: 4, mean: 4, derivative: 900 });
    state = stepLoop(state, [0], 10).state;
    recordTick(stats, state);
    expect(takeStats(stats).outputs[0]).toMatchObject({ last: 0, min: 0, max: 0, mean_abs: 0, saturated_pct: 0 });
  });
  test("the trace is sampled at trace_hz, returns the points since the previous report, and keeps at most 200", () => {
    const plan = planLoop(spec, ctx());
    const stats = startStats(plan);
    let state = startLoop(plan);
    const tick = (n: number) => {
      for (let k = 0; k < n; k++) {
        state = stepLoop(state, [state.ticks], 10).state;
        recordTick(stats, state);
      }
    };
    tick(21); // t = 0..200 ms at 20 Hz: 0, 50, 100, 150, 200
    const first = takeStats(stats).trace;
    expect(first.t_ms).toEqual([0, 50, 100, 150, 200]);
    expect(first.x).toEqual([0, 5, 10, 15, 20]);
    expect(first.out0).toEqual([0, 3, 3, 3, 3]);
    tick(10);
    expect(takeStats(stats).trace.t_ms).toEqual([250, 300]);
    tick(5 * 250);
    const long = takeStats(stats).trace;
    expect(Object.keys(long).sort()).toEqual(["out0", "t_ms", "x"]);
    for (const key of Object.keys(long)) expect(long[key]!.length).toBe(200);
    expect(long.t_ms[199]).toBe(state.t_ms);
    expect(long.t_ms[199]! - long.t_ms[0]!).toBe(199 * 50);
  });
  test("the tick that ends a loop is counted, with its reading, outputs at 0 and a point in the trace", () => {
    const plan = planLoop({ ...spec, guards: [{ name: "high", signal: "x", op: "gt", value: 5 }] }, ctx());
    const stats = startStats(plan);
    let state = startLoop(plan);
    for (const x of [2, 2, 10]) {
      state = stepLoop(state, [x], 10).state;
      recordTick(stats, state);
    }
    expect(state.end).toEqual({ reason: "guard", guard: "high" });
    const report = takeStats(stats);
    expect(report.signals.x).toMatchObject({ last: 10, max: 10, derivative: 800 });
    expect(report.outputs[0]).toMatchObject({ last: 0, min: 0, max: 2 });
    expect(report.trace).toEqual({ t_ms: [0, 20], x: [2, 10], out0: [2, 0] });
  });
  test("a loop that ends while it settles leaves the statistics empty", () => {
    const plan = planLoop(base({ signals: { x: { device: "s", channel: "c", zero: { mean_ms: 40 } } } }), ctx());
    const stats = startStats(plan);
    let state = startLoop(plan);
    for (const x of [0, 50, 0]) {
      state = stepLoop(state, [x], 20).state;
      recordTick(stats, state);
    }
    expect(state.end).toEqual({ reason: "not_still" });
    expect(takeStats(stats).trace.t_ms).toEqual([]);
  });
  test("ticks earlier than the law's first are not counted", () => {
    const plan = planLoop(base({ signals: { x: { device: "s", channel: "c", zero: { mean_ms: 40 } } } }), ctx());
    const stats = startStats(plan);
    let state = startLoop(plan);
    for (const x of [7, 7, 7, 9]) {
      state = stepLoop(state, [x], 20).state;
      recordTick(stats, state);
    }
    const report = takeStats(stats);
    // 7 and 7 are the mean; the third tick is the law's first, with value 0
    expect(report.signals.x).toMatchObject({ last: 2, min: 0, max: 2, mean: 1 });
    expect(report.trace.t_ms).toEqual([40]);
  });
});

// ---------- The examples of docs/loops.md ----------
describe("docs/loops.md", () => {
  test("every example is a valid loop", () => {
    expect(examples.length).toBe(4);
    for (const spec of examples) expect(validateLoop(spec)).toEqual([]);
    const wheels = { outputs: [SPEED, SPEED], max_rate_hz: 50, max_loop_ms: 60_000 };
    expect(planLoop(C3, { ...wheels, signals: { wall: NUM } }).outputs.map((o) => [o.min, o.max, o.hold_ms])).toEqual([
      [0, 40, 150],
      [0, 40, 150],
    ]);
  });
});

// ---------- Plants: the law against simulated physics ----------
const DEG = 180 / Math.PI;

/**
 * A linearized inverted pendulum on two wheels. State: body angle and rate (rad, forward positive), wheel
 * position and speed along the floor (m). Input: motor power in percent, which becomes torque between body and
 * wheels (with the motors' back-EMF); the same torque pushes the body the other way.
 */
function pendulum() {
  const m = 0.6,
    l = 0.09,
    inertia = 0.002; // body: kg, m from the axle to its center of mass, kg m² about it
  const wheels = 0.1,
    r = 0.028; // kg (wheels and rotors, as mass on the floor), wheel radius in m
  const stall = 0.8,
    back = 0.045; // N m at 100 % for both motors, N m per rad/s
  const s = { angle: 0, rate: 0, x: 0, v: 0 };
  return {
    s,
    /** What the encoders read, in degrees: the wheels' angle against the body. */
    encoder: () => (s.x / r - s.angle) * DEG,
    step(power_pct: number, push_nm: number, dt_s: number) {
      const torque = (stall * power_pct) / 100 - back * (s.v / r - s.rate);
      // (wheels + m) x'' + m l angle'' = torque / r ;  m l x'' + (inertia + m l²) angle'' = m g l angle − torque + push
      const a = wheels + m,
        b = m * l,
        d = inertia + m * l * l;
      const f = torque / r,
        t = m * 9.81 * l * s.angle - torque + push_nm;
      s.rate += ((a * t - b * f) / (a * d - b * b)) * dt_s;
      s.v += ((d * f - b * t) / (a * d - b * b)) * dt_s;
      s.angle += s.rate * dt_s;
      s.x += s.v * dt_s;
    },
  };
}

describe("balancing: C1 on an inverted pendulum on wheels", () => {
  // C1 with the gains of this plant (docs/loops.md): the printed ones are starting points for a real robot.
  const TUNED = { rate: 0.4, angle: 14, wheel: 0.1, wheel_speed: 0.1 };
  const withGains = (g: typeof TUNED): LoopSpec => ({
    ...C1,
    outputs: C1.outputs.map((o) => ({
      ...o,
      terms: o.terms.map((t) => {
        if ("feed" in t) return t;
        if (t.signal === "pitch_rate") return { ...t, gain: t.of === "integral" ? g.angle : g.rate };
        return { ...t, gain: t.of === "derivative" ? g.wheel_speed : g.wheel };
      }),
    })),
  });
  /**
   * The robot is held still for the gyro's second of zeroing, then let go with a shove of 20 deg/s, and pushed
   * again at 6 s. The gyro has an offset of 1.5 deg/s, the encoders count whole degrees from arbitrary values.
   */
  function balance(spec: LoopSpec, travel?: { deg: number; at_ms: number; ramp_ms: number }) {
    const plan = planLoop(spec, {
      signals: { pitch_rate: { ...NUM, noise: 1 }, left: NUM, right: NUM },
      outputs: [POWER, POWER],
      max_rate_hz: 100,
      max_loop_ms: 120_000,
    });
    const robot = pendulum();
    let state = startLoop(plan);
    const out = {
      max_angle_deg: 0,
      max_x_cm: 0,
      saturated: 0,
      trace: [] as string[],
      angle_deg: 0,
      x_cm: 0,
      encoder_deg: 0,
      end: undefined as LoopEnd | undefined,
    };
    const RELEASE = 1010;
    for (let t = 0; t <= RELEASE + 10_000 && !out.end; t += 10) {
      if (t === RELEASE) robot.s.rate = 20 / DEG;
      if (travel && t === travel.at_ms) state = setParams(state, { travel: travel.deg }, travel.ramp_ms);
      const encoder = Math.round(robot.encoder());
      const step = stepLoop(state, [robot.s.rate * DEG + 1.5, encoder + 500, encoder - 40], 10);
      state = step.state;
      out.end = step.end;
      if (t < RELEASE) expect(step.outputs).toEqual([0, 0]);
      else {
        const power = (step.outputs[0]! + step.outputs[1]!) / 2;
        if (Math.abs(power) >= 100) out.saturated++;
        const push = t >= 6000 && t < 6100 ? 0.05 : 0;
        for (let k = 0; k < 10; k++) robot.step(power, push, 0.001);
      }
      out.max_angle_deg = Math.max(out.max_angle_deg, Math.abs(robot.s.angle * DEG));
      out.max_x_cm = Math.max(out.max_x_cm, Math.abs(robot.s.x * 100));
      if (t % 1000 === 0)
        out.trace.push(`${t / 1000}s ${(robot.s.angle * DEG).toFixed(2)}deg ${(robot.s.x * 100).toFixed(1)}cm`);
    }
    return { ...out, angle_deg: robot.s.angle * DEG, x_cm: robot.s.x * 100, encoder_deg: robot.encoder() };
  }

  test("the law holds the robot upright for 10 s through a shove and a push", () => {
    const run = balance(withGains(TUNED));
    if (process.env.LOOP_TRACE) console.log("balancer", JSON.stringify(run));
    expect(run.end).toBeUndefined();
    expect(run.max_angle_deg).toBeLessThan(5);
    expect(Math.abs(run.angle_deg)).toBeLessThan(1);
    expect(run.max_x_cm).toBeLessThan(5);
    expect(run.saturated).toBe(0);
  });
  test("with its gains zeroed the same robot falls and the guard says so", () => {
    const run = balance(withGains({ rate: 0, angle: 0, wheel: 0, wheel_speed: 0 }));
    expect(run.end).toEqual({ reason: "guard", guard: "fallen" });
    expect(Math.abs(run.angle_deg)).toBeGreaterThan(40);
  });
  test("a ramp of travel rolls the balanced robot there", () => {
    const run = balance(withGains(TUNED), { deg: 360, at_ms: 2000, ramp_ms: 3000 });
    expect(run.end).toBeUndefined();
    expect(run.max_angle_deg).toBeLessThan(8);
    expect(Math.abs(run.encoder_deg - 360)).toBeLessThan(20);
  });
});

describe("line following: C2 on a robot at the edge of a line", () => {
  /**
   * A differential robot beside the left edge of a dark line. `y` is how far the axle's middle is to the left of the
   * edge (cm), `heading` its angle against the line (rad, left positive, small: its sine is taken as the angle). The light sensor rides ahead of the axle
   * and reads brighter the further left of the edge it is. `bend` is the line's curvature (1/cm, left positive).
   */
  function follow(
    spec: LoopSpec,
    opts: { bend?: number; bend_from_ms?: number; press_at_ms?: number; steer?: boolean } = {},
  ) {
    const TRACK = 12,
      AHEAD = 8,
      CM_S_PER_PCT = 0.4,
      PCT_PER_CM = 12; // cm, cm, wheel speed, edge gradient
    const plan = planLoop(spec, {
      signals: { light: { ...NUM, range: [0, 100] }, bumper: { type: "boolean" } },
      outputs: [SPEED, SPEED],
      max_rate_hz: 50,
      max_loop_ms: 60_000,
    });
    let state = startLoop(plan);
    const s = { y: 1.5, heading: 0 };
    let end: LoopEnd | undefined;
    let worst = 0,
      light = 0,
      travelled = 0;
    for (let t = 0; t <= 12_000 && !end; t += 20) {
      const edge = state.params.edge!;
      light = Math.min(95, Math.max(5, edge + PCT_PER_CM * (s.y + AHEAD * s.heading)));
      const step = stepLoop(
        state,
        [Math.round(light), opts.press_at_ms !== undefined && t >= opts.press_at_ms ? 1 : 0],
        20,
      );
      state = step.state;
      end = step.end;
      if (end) break;
      if (t >= 2000) worst = Math.max(worst, Math.abs(light - edge));
      const [left, right] = opts.steer === false ? [20, 20] : (step.outputs as [number, number]);
      const bend = opts.bend_from_ms !== undefined && t >= opts.bend_from_ms ? (opts.bend ?? 1 / 60) : 0;
      for (let k = 0; k < 20; k++) {
        const v = ((left + right) / 2) * CM_S_PER_PCT;
        s.heading += (((right - left) * CM_S_PER_PCT) / TRACK - v * bend) * 0.001;
        s.y += v * s.heading * 0.001;
        travelled += v * 0.001;
      }
    }
    return { end, worst, light, travelled, edge: state.params.edge! };
  }
  test("the law holds the edge on a straight line and through a bend", () => {
    const run = follow(C2, { bend_from_ms: 5000 });
    if (process.env.LOOP_TRACE) console.log("line", JSON.stringify(run));
    expect(run.end).toBeUndefined();
    expect(run.worst).toBeLessThan(12);
    expect(Math.abs(run.light - run.edge)).toBeLessThan(8);
    expect(run.travelled).toBeGreaterThan(80);
  });
  test("without steering the same robot leaves the line and line_lost ends the loop", () => {
    const run = follow(C2, { bend: -1 / 60, bend_from_ms: 1000, steer: false });
    expect(run.end).toEqual({ reason: "guard", guard: "line_lost" });
  });
  test("the bumper ends the loop on the tick it is pressed", () => {
    const run = follow(C2, { press_at_ms: 3000 });
    expect(run.end).toEqual({ reason: "guard", guard: "bumper" });
    expect(run.travelled).toBeGreaterThan(20);
    expect(run.travelled).toBeLessThan(26);
  });
});

describe("holding an arm: C4 on a motor with a load", () => {
  /** A motor arm: power sets the speed it settles to (10 deg/s per percent, 50 ms), a load takes power away. */
  function hold(
    spec: LoopSpec,
    events: { load_at_ms?: number; target?: { deg: number; at_ms: number; ramp_ms: number } },
  ) {
    const plan = planLoop(spec, { signals: { angle: NUM }, outputs: [POWER], max_rate_hz: 50, max_loop_ms: 60_000 });
    let state = startLoop(plan);
    const s = { angle: 0, speed: 0 };
    const at: Record<number, number> = {};
    let end: LoopEnd | undefined;
    let pushed = 0,
      max_power = 0;
    for (let t = 0; t <= 12_000 && !end; t += 20) {
      if (events.target && t === events.target.at_ms)
        state = setParams(state, { target: events.target.deg }, events.target.ramp_ms);
      const step = stepLoop(state, [Math.round(s.angle)], 20);
      state = step.state;
      end = step.end;
      max_power = Math.max(max_power, Math.abs(step.outputs[0]!));
      const load = events.load_at_ms !== undefined && t >= events.load_at_ms ? 25 : 0;
      for (let k = 0; k < 20; k++) {
        s.speed += (((step.outputs[0]! - load) * 10 - s.speed) / 0.05) * 0.001;
        s.angle += s.speed * 0.001;
      }
      if (events.load_at_ms !== undefined && t >= events.load_at_ms) pushed = Math.max(pushed, Math.abs(s.angle - 45));
      if (t % 1000 === 0) at[t] = s.angle;
    }
    return { end, at, pushed, max_power, angle: s.angle };
  }
  test("the arm reaches its target, is pushed off by a load, and returns", () => {
    const run = hold(C4, { load_at_ms: 4000 });
    if (process.env.LOOP_TRACE) console.log("arm", JSON.stringify(run));
    expect(run.end).toBeUndefined();
    expect(Math.abs(run.at[3000]! - 45)).toBeLessThan(1.5);
    expect(run.pushed).toBeGreaterThan(5);
    expect(Math.abs(run.at[8000]! - 45)).toBeLessThan(1.5);
    expect(Math.abs(run.angle - 45)).toBeLessThan(1.5);
    expect(run.max_power).toBeLessThanOrEqual(60);
  });
  test("a ramp of the target moves the arm and it keeps holding", () => {
    const run = hold(C4, { target: { deg: 90, at_ms: 3000, ramp_ms: 1000 } });
    expect(run.end).toBeUndefined();
    expect(Math.abs(run.at[5000]! - 90)).toBeLessThan(1.5);
    expect(Math.abs(run.angle - 90)).toBeLessThan(1.5);
  });
  test("an arm driven the wrong way runs out of range and the guard ends the loop", () => {
    const wrong: LoopSpec = {
      ...C4,
      outputs: C4.outputs.map((o) => ({
        ...o,
        terms: o.terms.map((t) => ("signal" in t && typeof t.gain === "number" ? { ...t, gain: -t.gain } : t)),
      })),
    };
    expect(hold(wrong, {}).end).toEqual({ reason: "guard", guard: "out_of_range" });
  });
});
