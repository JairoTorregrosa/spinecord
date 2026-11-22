// The law of a loop (CONTRACT §5a): pure, no I/O, no clock. An executor plans a loop once (planLoop), then
// calls stepLoop once per tick with the readings and the measured time since the previous tick.
// A port of this file in another language computes the same numbers, tick for tick: loop-golden.json holds both
// to that. Hence only + − × ÷ here, in a fixed order, and arrays wherever an order matters.
import {
  type ChannelSpec,
  type Guard,
  type LoopDrives,
  type LoopEnd,
  type LoopNumber,
  type LoopOutputStats,
  type LoopPlan,
  type LoopSpec,
  type LoopSignalStats,
  type LoopTrace,
  RuntimeError,
  type SignalPart,
} from "./types";
import { validateLoop } from "./validate";

// ---------- Planning ----------
/** What a plan needs to know of a channel. */
export type LoopChannel = Pick<ChannelSpec, "type" | "range" | "active" | "noise" | "length" | "max_rate_hz">;
/** What a plan needs from the robot. Whoever holds the devices fills it in. */
export interface LoopContext {
  /** By signal name: the channel the signal reads. */
  signals: Record<string, LoopChannel>;
  /** By output index: what the command declares for loops, and the schema range of the argument it names. */
  outputs: { drives?: LoopDrives; range?: [number, number] }[];
  /** The fastest rate of the executor this loop runs on. */
  max_rate_hz: number;
  /** The robot's limit on the life of a loop. */
  max_loop_ms: number;
}

export const LOOP_DEFAULTS = { attention_ms: 15_000, trace_hz: 10 } as const;
export const LOOP_HOLD = { periods: 3, min_ms: 30 } as const;
/** Ticks in a row without a value that end a loop. */
export const LOOP_LOST_TICKS = 3;
/** A `zero: {mean_ms}` measurement saw motion when its readings spread more than this many times the channel's noise. */
export const LOOP_STILL_NOISES = 4;
export const LOOP_TRACE_POINTS = 200;

const refuse = (message: string, next?: string[]): RuntimeError => {
  const e = new RuntimeError("invalid_argument", message);
  if (next) e.next = next;
  return e;
};
const cut = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/**
 * Checks a loop against the robot and returns it ready to run. Throws a RuntimeError for everything the
 * executor could not honor; nothing is slowed, switched or dropped silently.
 */
export function planLoop(spec: unknown, ctx: LoopContext): LoopPlan {
  if (!finite(ctx.max_rate_hz) || ctx.max_rate_hz <= 0 || !finite(ctx.max_loop_ms) || ctx.max_loop_ms < 1)
    throw new RuntimeError("misconfigured", "a loop needs max_rate_hz above 0 and max_loop_ms of at least 1");
  const issues = validateLoop(spec);
  if (issues.length) throw refuse(issues.map((i) => `${i.path}: ${i.message}`).join("; "));
  const loop = spec as LoopSpec;

  if (loop.rate_hz > ctx.max_rate_hz)
    throw refuse(`loop.rate_hz: ${loop.rate_hz} is above the maximum of ${ctx.max_rate_hz} Hz where this loop runs`);
  const period_ms = 1000 / loop.rate_hz;
  const notes: string[] = [];
  const clamps: LoopPlan["clamps"] = [];
  let duration_ms = loop.duration_ms;
  if (duration_ms > ctx.max_loop_ms) {
    duration_ms = Math.floor(ctx.max_loop_ms);
    clamps.push({ arg: "duration_ms", requested: loop.duration_ms, applied: duration_ms, target: true });
  }

  const signals: LoopPlan["signals"] = Object.entries(loop.signals).map(([name, s]) => {
    const path = `loop.signals.${name}`;
    const where = `channel ${s.channel} of ${s.device}`;
    const ch = Object.hasOwn(ctx.signals, name) ? ctx.signals[name] : undefined;
    if (!ch) throw new RuntimeError("unknown_channel", `${path}: ${where} is not a channel of the robot`);
    if (ch.active === false)
      throw refuse(
        `${path}: ${where} is not active and a loop never switches a sensor mode. Nothing was sent. ` +
          `Read the channel by name with read_device while the robot is idle, then start the loop.`,
        ["read_device"],
      );
    if (ch.type === "vector") {
      if (s.index === undefined) throw refuse(`${path}.index: required, ${where} is a vector`);
      if (ch.length !== undefined && s.index >= ch.length)
        throw refuse(`${path}.index: ${s.index} is outside ${where}, a vector of ${ch.length}`);
    } else if (ch.type !== "number" && ch.type !== "boolean")
      throw refuse(`${path}.channel: ${where} is of type ${ch.type}; a loop reads number, boolean and vector channels`);
    else if (s.index !== undefined) throw refuse(`${path}.index: ${where} is of type ${ch.type} and takes no index`);
    const mean_ms = typeof s.zero === "object" ? s.zero.mean_ms : 0;
    if (mean_ms >= duration_ms) throw refuse(`${path}.zero.mean_ms: must be under the loop's ${duration_ms} ms`);
    if (ch.max_rate_hz !== undefined && ch.max_rate_hz < loop.rate_hz)
      notes.push(
        `signal ${name}: ${where} updates at ${ch.max_rate_hz} Hz, under the loop's ${loop.rate_hz} Hz; ` +
          `it holds its value between updates`,
      );
    return {
      name,
      device: s.device,
      channel: s.channel,
      ...(s.index === undefined ? {} : { index: s.index }),
      zero: s.zero === undefined ? "none" : s.zero === "start" ? "start" : "mean",
      mean_ms,
      noise: finite(ch.noise) ? ch.noise : 0,
      detrend_s: s.detrend_s ?? 0,
      smooth_ms: s.smooth_ms ?? 0,
    };
  });

  const outputs: LoopPlan["outputs"] = loop.outputs.map((o, i) => {
    const path = `loop.outputs[${i}]`;
    const where = `command ${o.command} of ${o.device}`;
    const drives = ctx.outputs[i]?.drives;
    const range = ctx.outputs[i]?.range;
    if (!drives)
      throw new RuntimeError("unsupported", `${path}.command: ${where} declares no drives, so no loop can refresh it`);
    if (!range || !finite(range[0]) || !finite(range[1]) || range[0] > range[1])
      throw new RuntimeError(
        "unsupported",
        `${path}.command: ${where} declares no minimum and maximum for ${drives.arg}, so a loop output has no range`,
      );
    const args = o.args ?? {};
    if (drives.arg in args)
      throw refuse(`${path}.args.${drives.arg}: the loop computes ${drives.arg} every tick; leave it out of args`);
    const [lo, hi] = o.limit ?? range;
    return {
      device: o.device,
      command: o.command,
      arg: drives.arg,
      args,
      hold_ms: Math.min(Math.max(Math.ceil(LOOP_HOLD.periods * period_ms), LOOP_HOLD.min_ms), drives.max_hold_ms),
      min: cut(lo, range[0], range[1]),
      max: cut(hi, range[0], range[1]),
      terms: o.terms,
    };
  });

  return {
    rate_hz: loop.rate_hz,
    period_ms,
    duration_ms,
    attention_ms: loop.attention_ms ?? LOOP_DEFAULTS.attention_ms,
    trace_hz: loop.trace_hz ?? LOOP_DEFAULTS.trace_hz,
    signals,
    params: { ...loop.params },
    outputs,
    guards: loop.guards ?? [],
    clamps,
    notes,
  };
}

// ---------- The law ----------
/** One signal between two ticks. */
export interface SignalState {
  seen: boolean; // a reading has arrived
  missed: number; // ticks in a row without a value
  raw: number; // the latest reading
  offset: number; // what `zero` subtracts
  zeroed: boolean; // false while a `zero: {mean_ms}` measurement runs
  mean: { t_ms: number; n: number; sum: number; min: number; max: number };
  gap_ms: number; // time since the previous reading
  trend: number; // the running mean `detrend_s` subtracts
  value: number;
  integral: number; // the sum of value × dt since the law's first tick: what a guard's `integral` reads
  derivative: number;
}
/**
 * Everything a loop carries from one tick to the next. Plain JSON. `settling` lasts while a signal measures its
 * mean: every output is 0 and the law has not started.
 */
export interface LoopState {
  plan: LoopPlan;
  phase: "settling" | "running" | "ended";
  ticks: number;
  law_ticks: number; // ticks on which the law ran: 0 while settling
  t_ms: number; // the sum of dt after the first tick
  params: Record<string, number>;
  ramps: Record<string, { from: number; to: number; ramp_ms: number; t_ms: number }>;
  signals: SignalState[]; // in the plan's order
  integrals: number[][]; // per output, per term: the accumulator of a term of integral, else 0
  held_ms: number[]; // per guard: how long it has held in a row, -1 while it does not hold
  outputs: number[]; // what the latest tick refreshed
  cut: boolean[]; // per output: the latest tick cut it to its bounds
  end?: LoopEnd;
}
export interface LoopStep {
  state: LoopState;
  /** One value per output of the plan, in its order. All 0 while settling and on the tick that ends the loop. */
  outputs: number[];
  /** The name of the guard that ended the loop on this tick. */
  guard?: string;
  /** Present on the tick that ends the loop: reason guard, input_lost or not_still. */
  end?: LoopEnd;
}

export function startLoop(plan: LoopPlan): LoopState {
  return {
    plan,
    phase: "settling",
    ticks: 0,
    law_ticks: 0,
    t_ms: 0,
    params: { ...plan.params },
    ramps: {},
    signals: plan.signals.map((s) => ({
      seen: false,
      missed: 0,
      raw: 0,
      offset: 0,
      zeroed: s.zero !== "mean",
      mean: { t_ms: 0, n: 0, sum: 0, min: 0, max: 0 },
      gap_ms: 0,
      trend: 0,
      value: 0,
      integral: 0,
      derivative: 0,
    })),
    integrals: plan.outputs.map((o) => o.terms.map(() => 0)),
    held_ms: plan.guards.map(() => -1),
    outputs: plan.outputs.map(() => 0),
    cut: plan.outputs.map(() => false),
  };
}

/**
 * Changes named params between two ticks, all of them at once. With `ramp_ms` each moves there linearly over
 * that much loop time. Integrals and filters keep their state.
 */
export function setParams(state: LoopState, params: Record<string, number>, ramp_ms = 0): LoopState {
  if (!finite(ramp_ms) || ramp_ms < 0) throw refuse("ramp_ms: number of at least 0");
  const next = { ...state, params: { ...state.params }, ramps: { ...state.ramps } };
  for (const [name, to] of Object.entries(params)) {
    const from = next.params[name];
    if (!Object.hasOwn(next.params, name) || from === undefined)
      throw refuse(`params.${name}: no param "${name}"; params: ${Object.keys(state.params).join(", ") || "none"}`);
    if (!finite(to)) throw refuse(`params.${name}: must be a finite number`);
    if (ramp_ms > 0) next.ramps[name] = { from, to, ramp_ms, t_ms: 0 };
    else {
      next.params[name] = to;
      delete next.ramps[name];
    }
  }
  return next;
}

const part = (s: SignalState, of: SignalPart | undefined): number =>
  of === "integral" ? s.integral : of === "derivative" ? s.derivative : s.value;
const holds = (g: Guard, x: number): boolean =>
  g.op === "gt" ? x > g.value : g.op === "lt" ? x < g.value : (x < 0 ? -x : x) > g.value;

/**
 * One tick. `inputs` holds one reading per signal of the plan, in its order (null = no value this tick);
 * `dt_ms` is the measured time since the previous tick, and is not read on the first tick.
 * The state passed in is left as it was.
 */
export function stepLoop(state: LoopState, inputs: readonly (number | null)[], dt_ms: number): LoopStep {
  const plan = state.plan;
  const zeros = plan.outputs.map(() => 0);
  if (state.phase === "ended") return { state, outputs: zeros, ...(state.end ? { end: state.end } : {}) };
  if (!finite(dt_ms) || dt_ms < 0) throw refuse("dt_ms: number of at least 0");
  const dt = state.ticks === 0 ? 0 : dt_ms;
  const s: LoopState = {
    ...state,
    ticks: state.ticks + 1,
    t_ms: state.t_ms + dt,
    params: { ...state.params },
    ramps: {},
    signals: state.signals.map((x) => ({ ...x, mean: { ...x.mean } })),
    integrals: state.integrals.map((x) => x.slice()),
    held_ms: state.held_ms.slice(),
    outputs: zeros.slice(),
    cut: plan.outputs.map(() => false),
  };
  const ended = (end: LoopEnd): LoopStep => {
    s.phase = "ended";
    s.end = end;
    s.outputs = zeros.slice();
    s.cut = zeros.map(() => false);
    return { state: s, outputs: zeros, ...(end.guard === undefined ? {} : { guard: end.guard }), end };
  };

  // params on their way to a new value
  for (const [name, r] of Object.entries(state.ramps)) {
    const t = r.t_ms + dt;
    if (t >= r.ramp_ms) s.params[name] = r.to;
    else {
      s.params[name] = r.from + ((r.to - r.from) * t) / r.ramp_ms;
      s.ramps[name] = { ...r, t_ms: t };
    }
  }

  // readings, and the measurements of `zero`
  const fresh: boolean[] = [];
  for (let i = 0; i < plan.signals.length; i++) {
    const p = plan.signals[i]!;
    const sig = s.signals[i]!;
    const x = inputs[i];
    fresh[i] = finite(x);
    if (!finite(x)) {
      sig.missed++;
      if (sig.missed >= LOOP_LOST_TICKS) return ended({ reason: "input_lost" });
    } else {
      sig.missed = 0;
      sig.raw = x;
      if (!sig.seen && p.zero === "start") sig.offset = x;
    }
    if (sig.zeroed) {
      if (finite(x)) sig.seen = true;
      continue;
    }
    // zero mean: readings count from the signal's first one until mean_ms have passed
    const m = sig.mean;
    if (sig.seen) m.t_ms += dt;
    if (m.t_ms < p.mean_ms) {
      if (finite(x)) {
        m.min = m.n === 0 || x < m.min ? x : m.min;
        m.max = m.n === 0 || x > m.max ? x : m.max;
        m.sum += x;
        m.n++;
        sig.seen = true;
      }
    } else {
      if (m.max - m.min > LOOP_STILL_NOISES * p.noise) return ended({ reason: "not_still" });
      sig.offset = m.sum / m.n;
      sig.zeroed = true;
    }
  }
  if (!s.signals.every((x) => x.seen && x.zeroed)) return { state: s, outputs: zeros };

  // signals: zero, detrend, smooth, then the derivative and the integral of the value
  const first = s.phase === "settling";
  s.phase = "running";
  s.law_ticks++;
  for (let i = 0; i < plan.signals.length; i++) {
    const p = plan.signals[i]!;
    const sig = s.signals[i]!;
    let v = sig.raw - sig.offset;
    if (first) {
      if (p.detrend_s > 0) {
        sig.trend = v;
        v = 0;
      }
      sig.value = v;
      sig.gap_ms = 0;
      continue;
    }
    sig.gap_ms += dt;
    if (fresh[i] && sig.gap_ms > 0) {
      const gap = sig.gap_ms;
      if (p.detrend_s > 0) {
        sig.trend += ((v - sig.trend) * gap) / (p.detrend_s * 1000 + gap);
        v -= sig.trend;
      }
      if (p.smooth_ms > 0) v = sig.value + ((v - sig.value) * gap) / (p.smooth_ms + gap);
      sig.derivative = ((v - sig.value) * 1000) / gap;
      sig.value = v;
      sig.gap_ms = 0;
    }
    sig.integral += (sig.value * dt) / 1000;
  }
  const law_dt = first ? 0 : dt;
  const signalOf = (name: string): SignalState => s.signals[plan.signals.findIndex((x) => x.name === name)]!;
  const num = (x: LoopNumber | undefined, absent: number): number =>
    x === undefined ? absent : typeof x === "number" ? x : s.params[x]!;

  // the law: every output is the sum of its terms, cut to its bounds
  for (let i = 0; i < plan.outputs.length; i++) {
    const o = plan.outputs[i]!;
    let u = 0;
    for (let j = 0; j < o.terms.length; j++) {
      const t = o.terms[j]!;
      if ("feed" in t) {
        u += num(t.gain, 1) * num(t.feed, 0);
        continue;
      }
      const sig = signalOf(t.signal);
      const setpoint = num(t.setpoint, 0);
      if (t.of === "integral") {
        let acc = s.integrals[i]![j]! + ((sig.value - setpoint) * law_dt) / 1000;
        if (t.clamp !== undefined) acc = cut(acc, -t.clamp, t.clamp);
        s.integrals[i]![j] = acc;
        u += num(t.gain, 0) * acc;
      } else u += num(t.gain, 0) * (part(sig, t.of) - setpoint);
    }
    if (!Number.isFinite(u))
      throw new RuntimeError("internal", `loop output ${i} (${o.command} of ${o.device}) is not a finite number`);
    s.cut[i] = u < o.min || u > o.max;
    s.outputs[i] = cut(u, o.min, o.max);
  }

  // guards, in their order: the first that holds long enough ends the loop on this tick
  for (let i = 0; i < plan.guards.length; i++) {
    const g = plan.guards[i]!;
    if (!holds(g, part(signalOf(g.signal), g.of))) {
      s.held_ms[i] = -1;
      continue;
    }
    s.held_ms[i] = s.held_ms[i]! < 0 ? 0 : s.held_ms[i]! + law_dt;
    if (g.for_ms === undefined || s.held_ms[i]! >= g.for_ms) return ended({ reason: "guard", guard: g.name });
  }
  return { state: s, outputs: s.outputs.slice() };
}

// ---------- What a report says of the ticks ----------
interface Window {
  n: number;
  min: number;
  max: number;
  sum: number;
}
/** Collects the ticks of a loop between two reports. */
export interface LoopStats {
  plan: LoopPlan;
  signals: (Window & { last: number; integral: number; derivative: number })[];
  outputs: (Window & { last: number; cut: number })[];
  trace: LoopTrace;
  next_trace_ms: number;
}
export function startStats(plan: LoopPlan): LoopStats {
  const empty = (): Window => ({ n: 0, min: 0, max: 0, sum: 0 });
  return {
    plan,
    signals: plan.signals.map(() => ({ ...empty(), last: 0, integral: 0, derivative: 0 })),
    outputs: plan.outputs.map(() => ({ ...empty(), last: 0, cut: 0 })),
    trace: emptyTrace(plan),
    next_trace_ms: 0,
  };
}
function emptyTrace(plan: LoopPlan): LoopTrace {
  const trace: LoopTrace = { t_ms: [] };
  for (const s of plan.signals) trace[s.name] = [];
  plan.outputs.forEach((_, i) => (trace[`out${i}`] = []));
  return trace;
}
const add = (w: Window, x: number, weight: number): void => {
  w.min = w.n === 0 || x < w.min ? x : w.min;
  w.max = w.n === 0 || x > w.max ? x : w.max;
  w.sum += weight;
  w.n++;
};
/**
 * Takes in the tick that produced `state`, once per tick. Settling ticks are not counted. The tick that ends a
 * loop is, with its outputs at 0, and it always has a point in the trace: a report shows the reading that
 * ended the loop.
 */
export function recordTick(stats: LoopStats, state: LoopState): void {
  if (state.law_ticks === 0) return;
  const { plan, trace } = stats;
  state.signals.forEach((sig, i) => {
    const w = stats.signals[i]!;
    add(w, sig.value, sig.value);
    w.last = sig.value;
    w.integral = sig.integral;
    w.derivative = sig.derivative;
  });
  state.outputs.forEach((u, i) => {
    const w = stats.outputs[i]!;
    add(w, u, u < 0 ? -u : u);
    w.last = u;
    if (state.cut[i]) w.cut++;
  });
  if (state.t_ms < stats.next_trace_ms && state.phase !== "ended") return;
  const every_ms = 1000 / plan.trace_hz;
  while (stats.next_trace_ms <= state.t_ms) stats.next_trace_ms += every_ms;
  trace.t_ms.push(state.t_ms);
  plan.signals.forEach((p, i) => trace[p.name]!.push(state.signals[i]!.value));
  plan.outputs.forEach((_, i) => trace[`out${i}`]!.push(state.outputs[i]!));
  if (trace.t_ms.length > LOOP_TRACE_POINTS) for (const key of Object.keys(trace)) trace[key]!.shift();
}
/**
 * The statistics and the trace since the previous call, and a fresh window. A window without a tick repeats the
 * latest value of each signal and output.
 */
export function takeStats(stats: LoopStats): {
  signals: Record<string, LoopSignalStats>;
  outputs: LoopOutputStats[];
  trace: LoopTrace;
} {
  const signals: Record<string, LoopSignalStats> = {};
  stats.plan.signals.forEach((p, i) => {
    const w = stats.signals[i]!;
    signals[p.name] = {
      last: w.last,
      min: w.n ? w.min : w.last,
      max: w.n ? w.max : w.last,
      mean: w.n ? w.sum / w.n : w.last,
      integral: w.integral,
      derivative: w.derivative,
    };
    Object.assign(w, { n: 0, min: 0, max: 0, sum: 0 });
  });
  const outputs = stats.plan.outputs.map((o, i) => {
    const w = stats.outputs[i]!;
    const out: LoopOutputStats = {
      device: o.device,
      command: o.command,
      last: w.last,
      min: w.n ? w.min : w.last,
      max: w.n ? w.max : w.last,
      mean_abs: w.n ? w.sum / w.n : w.last < 0 ? -w.last : w.last,
      saturated_pct: w.n ? (100 * w.cut) / w.n : 0,
    };
    Object.assign(w, { n: 0, min: 0, max: 0, sum: 0, cut: 0 });
    return out;
  });
  const trace = stats.trace;
  stats.trace = emptyTrace(stats.plan);
  return { signals, outputs, trace };
}
