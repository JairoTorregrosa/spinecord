import { describe, expect, test } from "bun:test";
import { isLoopSpec, LOOP_CAPS, validateCondition, validateLoop, validateProgram } from "./validate";

test("accepts a valid program", () => {
  const body = {
    seq: [
      {
        call: {
          tool: "drive",
          args: { distance_cm: 20, until: { device: "front", channel: "distance_cm", op: "lt", value: 10 } },
        },
      },
      { repeat: { times: 3, body: { wait_ms: 100 } } },
    ],
  };
  expect(validateProgram(body)).toEqual([]);
});
test("rejects caps and shapes with paths", () => {
  expect(validateProgram({ wait_ms: 1.5 })[0]!.path).toBe("body.wait_ms");
  expect(validateProgram({ repeat: { times: 0, body: { wait_ms: 1 } } })[0]!.path).toBe("body.repeat.times");
  expect(validateProgram({ call: { tool: "drive", args: { robot_id: "x" } } })[0]!.message).toContain("omitted");
  expect(validateProgram({ jump: 1 })[0]!.message).toContain("unknown node");
});
test("condition rules", () => {
  expect(validateCondition({ device: "b", channel: "pressed", op: "contains", value: "enter" })).toEqual([]);
  expect(validateCondition({ device: "b", channel: "x", op: "changed", value: 1 }).length).toBe(1);
  expect(validateCondition({ device: "b", channel: "x", op: "lt", value: "a" }).length).toBe(1);
  let deep: unknown = { device: "d", channel: "c", op: "eq", value: 1 };
  for (let i = 0; i < 9; i++) deep = { not: deep };
  expect(validateCondition(deep)[0]!.message).toContain("nesting");
});

// ---------- Loops ----------
const loop = (): Record<string, any> => ({
  rate_hz: 50,
  duration_ms: 30_000,
  attention_ms: 10_000,
  trace_hz: 10,
  signals: {
    light: { device: "color", channel: "reflected_pct", smooth_ms: 20, detrend_s: 5 },
    rgb: { device: "color", channel: "rgb", index: 1, zero: "start" },
    rate: { device: "gyro", channel: "rate_deg_s", zero: { mean_ms: 1000 } },
  },
  params: { edge: 35, speed: 20, k: 0.5 },
  outputs: [
    {
      device: "left_wheel",
      command: "run_time",
      args: { brake: false },
      limit: [-40, 40],
      terms: [
        { feed: "speed" },
        { feed: 2, gain: "k" },
        { signal: "light", setpoint: "edge", gain: "k" },
        { signal: "light", of: "integral", setpoint: 35, gain: 0.1, clamp: 10 },
        { signal: "rate", of: "derivative", gain: 0.02 },
      ],
    },
    { device: "right_wheel", command: "run_time", terms: [{ signal: "rgb", of: "value", gain: -1 }] },
  ],
  guards: [
    { name: "lost", signal: "light", op: "gt", value: 85, for_ms: 1500 },
    { name: "tilt", signal: "rate", of: "integral", op: "abs_gt", value: 45 },
    { name: "dark", signal: "light", of: "derivative", op: "lt", value: -500 },
  ],
});
const many = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));
const named = <T>(n: number, make: (i: number) => T): Record<string, T> =>
  Object.fromEntries(many(n, (i) => [`n${i}`, make(i)]));
const signal = () => ({ device: "d", channel: "c" });
const term = () => ({ feed: 1 });
const guard = (i: number) => ({ name: `g${i}`, signal: "light", op: "gt", value: i });

test("accepts a loop that uses every field, and one that uses the fewest", () => {
  expect(validateLoop(loop())).toEqual([]);
  expect(isLoopSpec(loop())).toBe(true);
  expect(
    validateLoop({
      rate_hz: 12.5,
      duration_ms: 1,
      signals: { x: signal() },
      outputs: [{ device: "m", command: "power", terms: [{ signal: "x", gain: 1 }] }],
    }),
  ).toEqual([]);
});
test("accepts a loop at every cap", () => {
  const spec = loop();
  spec.signals = { light: signal(), ...named(LOOP_CAPS.max_signals - 1, signal) };
  spec.params = named(LOOP_CAPS.max_params, (i) => i);
  spec.outputs = many(LOOP_CAPS.max_outputs, (i) => ({
    device: `m${i}`,
    command: "power",
    terms: many(LOOP_CAPS.max_terms, term),
  }));
  spec.guards = many(LOOP_CAPS.max_guards, guard);
  spec.trace_hz = LOOP_CAPS.max_trace_hz;
  spec.rate_hz = LOOP_CAPS.min_rate_hz;
  spec.params.n0 = -LOOP_CAPS.max_magnitude;
  spec.outputs[0].terms[0] = { signal: "light", of: "integral", setpoint: 1e6, gain: -1e6, clamp: 1e6 };
  spec.guards[0] = { name: "g".repeat(LOOP_CAPS.max_name), signal: "light", op: "lt", value: -1e6 };
  spec.signals.light = {
    device: "d".repeat(LOOP_CAPS.max_text),
    channel: "c".repeat(LOOP_CAPS.max_text),
    smooth_ms: 1e6,
  };
  expect(validateLoop(spec)).toEqual([]);
});

// One row per rule: what breaks a valid loop, and the path the refusal names.
const REFUSALS: [rule: string, path: string, mutate: (s: Record<string, any>) => unknown][] = [
  ["a spec that is no object", "loop", () => "fast"],
  ["an unknown key", "loop", (s) => void (s.robot_id = "r1")],
  ["rate_hz missing", "loop.rate_hz", (s) => void delete s.rate_hz],
  ["rate_hz of 0", "loop.rate_hz", (s) => void (s.rate_hz = 0)],
  ["rate_hz that is no number", "loop.rate_hz", (s) => void (s.rate_hz = "50")],
  ["duration_ms missing", "loop.duration_ms", (s) => void delete s.duration_ms],
  ["duration_ms that is no integer", "loop.duration_ms", (s) => void (s.duration_ms = 1.5)],
  ["duration_ms of 0", "loop.duration_ms", (s) => void (s.duration_ms = 0)],
  ["attention_ms of 0", "loop.attention_ms", (s) => void (s.attention_ms = 0)],
  ["attention_ms that is no integer", "loop.attention_ms", (s) => void (s.attention_ms = 0.5)],
  ["trace_hz above 20", "loop.trace_hz", (s) => void (s.trace_hz = 21)],
  ["trace_hz of 0", "loop.trace_hz", (s) => void (s.trace_hz = 0)],
  ["params that is no object", "loop.params", (s) => void (s.params = [1])],
  ["17 params", "loop.params", (s) => void (s.params = { ...s.params, ...named(14, (i) => i) })],
  ["a param name starting with a digit", "loop.params.1st", (s) => void (s.params["1st"] = 1)],
  [
    "a param named __proto__",
    "loop.params.__proto__",
    (s) => void (s.params = JSON.parse('{"edge":35,"speed":20,"k":0.5,"__proto__":1}')),
  ],
  ["a param that is no number", "loop.params.edge", (s) => void (s.params.edge = "35")],
  ["a param that is not finite", "loop.params.edge", (s) => void (s.params.edge = Number.POSITIVE_INFINITY)],
  ["signals missing", "loop.signals", (s) => void delete s.signals],
  ["no signal", "loop.signals", (s) => void (s.signals = {})],
  ["9 signals", "loop.signals", (s) => void Object.assign(s.signals, named(6, signal))],
  ["a signal name with a dash", "loop.signals.left-wheel", (s) => void (s.signals["left-wheel"] = signal())],
  [
    "a signal named __proto__",
    "loop.signals.__proto__",
    (s) =>
      void (s.signals = JSON.parse(
        JSON.stringify(s.signals).replace(/}$/, ',"__proto__":{"device":"d","channel":"c"}}'),
      )),
  ],
  ["a signal named t_ms", "loop.signals.t_ms", (s) => void (s.signals.t_ms = signal())],
  ["a signal named out0", "loop.signals.out0", (s) => void (s.signals.out0 = signal())],
  ["a signal that is no object", "loop.signals.light", (s) => void (s.signals.light = "color")],
  ["a signal with an unknown key", "loop.signals.light", (s) => void (s.signals.light.gain = 2)],
  ["a signal without device", "loop.signals.light.device", (s) => void delete s.signals.light.device],
  ["a signal without channel", "loop.signals.light.channel", (s) => void (s.signals.light.channel = "")],
  ["a negative index", "loop.signals.rgb.index", (s) => void (s.signals.rgb.index = -1)],
  ["an index that is no integer", "loop.signals.rgb.index", (s) => void (s.signals.rgb.index = 0.5)],
  ["a zero that is neither form", "loop.signals.rgb.zero", (s) => void (s.signals.rgb.zero = "mean")],
  [
    "a zero object with another key",
    "loop.signals.rate.zero",
    (s) => void (s.signals.rate.zero = { mean_ms: 100, x: 1 }),
  ],
  ["mean_ms of 0", "loop.signals.rate.zero.mean_ms", (s) => void (s.signals.rate.zero.mean_ms = 0)],
  ["mean_ms that is no integer", "loop.signals.rate.zero.mean_ms", (s) => void (s.signals.rate.zero.mean_ms = 10.5)],
  [
    "mean_ms of the whole duration",
    "loop.signals.rate.zero.mean_ms",
    (s) => void (s.signals.rate.zero.mean_ms = 30_000),
  ],
  ["detrend_s of 0", "loop.signals.light.detrend_s", (s) => void (s.signals.light.detrend_s = 0)],
  ["smooth_ms below 0", "loop.signals.light.smooth_ms", (s) => void (s.signals.light.smooth_ms = -20)],
  ["outputs missing", "loop.outputs", (s) => void delete s.outputs],
  ["no output", "loop.outputs", (s) => void (s.outputs = [])],
  [
    "5 outputs",
    "loop.outputs",
    (s) => void s.outputs.push(...many(3, (i) => ({ device: `m${i}`, command: "power", terms: [term()] }))),
  ],
  ["an output that is no object", "loop.outputs[1]", (s) => void (s.outputs[1] = "right_wheel")],
  ["an output with an unknown key", "loop.outputs[0]", (s) => void (s.outputs[0].gain = 1)],
  ["an output without device", "loop.outputs[0].device", (s) => void delete s.outputs[0].device],
  ["two outputs on one device", "loop.outputs[1].device", (s) => void (s.outputs[1].device = "left_wheel")],
  ["an output without command", "loop.outputs[0].command", (s) => void delete s.outputs[0].command],
  ["args that is no object", "loop.outputs[0].args", (s) => void (s.outputs[0].args = [1])],
  ["a limit of one number", "loop.outputs[0].limit", (s) => void (s.outputs[0].limit = [40])],
  ["a limit with lo above hi", "loop.outputs[0].limit", (s) => void (s.outputs[0].limit = [40, -40])],
  ["a limit that is not finite", "loop.outputs[0].limit", (s) => void (s.outputs[0].limit = [0, Number.NaN])],
  ["terms missing", "loop.outputs[1].terms", (s) => void delete s.outputs[1].terms],
  ["no term", "loop.outputs[1].terms", (s) => void (s.outputs[1].terms = [])],
  ["17 terms", "loop.outputs[1].terms", (s) => void (s.outputs[1].terms = many(17, term))],
  ["a term that is no object", "loop.outputs[0].terms[0]", (s) => void (s.outputs[0].terms[0] = 5)],
  [
    "a term with neither signal nor feed",
    "loop.outputs[0].terms[0]",
    (s) => void (s.outputs[0].terms[0] = { gain: 1 }),
  ],
  ["a term with both signal and feed", "loop.outputs[0].terms[2]", (s) => void (s.outputs[0].terms[2].feed = "speed")],
  ["a feed term with an unknown key", "loop.outputs[0].terms[0]", (s) => void (s.outputs[0].terms[0].setpoint = 1)],
  ["a feed that names no param", "loop.outputs[0].terms[0].feed", (s) => void (s.outputs[0].terms[0].feed = "pace")],
  [
    "a feed that is neither number nor name",
    "loop.outputs[0].terms[0].feed",
    (s) => void (s.outputs[0].terms[0].feed = true),
  ],
  ["a feed gain that names no param", "loop.outputs[0].terms[1].gain", (s) => void (s.outputs[0].terms[1].gain = "kk")],
  ["a feedback term with an unknown key", "loop.outputs[0].terms[2]", (s) => void (s.outputs[0].terms[2].limit = 1)],
  [
    "a term on a signal that does not exist",
    "loop.outputs[0].terms[2].signal",
    (s) => void (s.outputs[0].terms[2].signal = "lihgt"),
  ],
  ["a term of an unknown part", "loop.outputs[0].terms[2].of", (s) => void (s.outputs[0].terms[2].of = "rate")],
  ["a term without gain", "loop.outputs[0].terms[2].gain", (s) => void delete s.outputs[0].terms[2].gain],
  ["a gain that names no param", "loop.outputs[0].terms[2].gain", (s) => void (s.outputs[0].terms[2].gain = "k_left")],
  ["a gain that is not finite", "loop.outputs[0].terms[4].gain", (s) => void (s.outputs[0].terms[4].gain = Number.NaN)],
  [
    "a setpoint that names no param",
    "loop.outputs[0].terms[2].setpoint",
    (s) => void (s.outputs[0].terms[2].setpoint = "middle"),
  ],
  [
    "a setpoint that is neither number nor name",
    "loop.outputs[0].terms[3].setpoint",
    (s) => void (s.outputs[0].terms[3].setpoint = null),
  ],
  ["a clamp of 0", "loop.outputs[0].terms[3].clamp", (s) => void (s.outputs[0].terms[3].clamp = 0)],
  [
    "a clamp on a term that is no integral",
    "loop.outputs[0].terms[2].clamp",
    (s) => void (s.outputs[0].terms[2].clamp = 10),
  ],
  ["rate_hz under 0.1", "loop.rate_hz", (s) => void (s.rate_hz = 0.05)],
  ["a param beyond ±1e6", "loop.params.edge", (s) => void (s.params.edge = -1e6 - 1)],
  ["a gain beyond ±1e6", "loop.outputs[0].terms[4].gain", (s) => void (s.outputs[0].terms[4].gain = 1e308)],
  ["a setpoint beyond ±1e6", "loop.outputs[0].terms[3].setpoint", (s) => void (s.outputs[0].terms[3].setpoint = 2e6)],
  ["a feed beyond ±1e6", "loop.outputs[0].terms[1].feed", (s) => void (s.outputs[0].terms[1].feed = -2e6)],
  ["a clamp beyond 1e6", "loop.outputs[0].terms[3].clamp", (s) => void (s.outputs[0].terms[3].clamp = 2e6)],
  ["a guard value beyond ±1e6", "loop.guards[0].value", (s) => void (s.guards[0].value = 1e7)],
  ["detrend_s beyond 1e6", "loop.signals.light.detrend_s", (s) => void (s.signals.light.detrend_s = 1e7)],
  ["smooth_ms beyond 1e6", "loop.signals.light.smooth_ms", (s) => void (s.signals.light.smooth_ms = 1e7)],
  [
    "a signal name of 33 characters",
    `loop.signals.${"s".repeat(33)}`,
    (s) => void (s.signals["s".repeat(33)] = signal()),
  ],
  [
    "a signal device of 65 characters",
    "loop.signals.light.device",
    (s) => void (s.signals.light.device = "d".repeat(65)),
  ],
  ["a channel of 65 characters", "loop.signals.light.channel", (s) => void (s.signals.light.channel = "c".repeat(65))],
  ["an output device of 65 characters", "loop.outputs[0].device", (s) => void (s.outputs[0].device = "d".repeat(65))],
  ["a command of 65 characters", "loop.outputs[0].command", (s) => void (s.outputs[0].command = "c".repeat(65))],
  ["a guard name with a space", "loop.guards[0].name", (s) => void (s.guards[0].name = "line lost")],
  ["a guard name of 33 characters", "loop.guards[0].name", (s) => void (s.guards[0].name = "g".repeat(33))],
  ["a guard named __proto__", "loop.guards[0].name", (s) => void (s.guards[0].name = "__proto__")],
  ["a guard name that is no string", "loop.guards[0].name", (s) => void (s.guards[0].name = 7)],
  ["guards that is no array", "loop.guards", (s) => void (s.guards = { lost: {} })],
  ["9 guards", "loop.guards", (s) => void (s.guards = many(9, guard))],
  ["a guard that is no object", "loop.guards[0]", (s) => void (s.guards[0] = "lost")],
  ["a guard with an unknown key", "loop.guards[0]", (s) => void (s.guards[0].setpoint = 1)],
  ["a guard without name", "loop.guards[0].name", (s) => void delete s.guards[0].name],
  ["two guards of one name", "loop.guards[1].name", (s) => void (s.guards[1].name = "lost")],
  ["a guard on a signal that does not exist", "loop.guards[0].signal", (s) => void (s.guards[0].signal = "dark")],
  ["a guard of an unknown part", "loop.guards[1].of", (s) => void (s.guards[1].of = "sum")],
  ["a guard with an op of conditions", "loop.guards[0].op", (s) => void (s.guards[0].op = "gte")],
  ["a guard without value", "loop.guards[0].value", (s) => void delete s.guards[0].value],
  ["a guard value that names a param", "loop.guards[0].value", (s) => void (s.guards[0].value = "edge")],
  ["for_ms of 0", "loop.guards[0].for_ms", (s) => void (s.guards[0].for_ms = 0)],
  ["for_ms that is no integer", "loop.guards[0].for_ms", (s) => void (s.guards[0].for_ms = 1.5)],
];
const NAMES_LOST = ["params that is no object", "signals missing", "no signal"];
describe("validateLoop refuses", () => {
  for (const [rule, path, mutate] of REFUSALS)
    test(rule, () => {
      const spec = loop();
      const issues = validateLoop(mutate(spec) ?? spec);
      // the names a refused block would have declared are refused where they are used, after it
      if (NAMES_LOST.includes(rule)) expect(issues[0]!.path).toBe(path);
      else expect(issues.map((i) => i.path)).toEqual([path]);
      expect(issues[0]!.message.length).toBeGreaterThan(0);
      expect(isLoopSpec(mutate(loop()) ?? spec)).toBe(false);
    });
});
