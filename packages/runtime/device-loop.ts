// The runtime's side of a loop that runs on a device (CONTRACT §4, §5a): the provider hands the plan to the device,
// which owns the ticks, the duration, the overrun rule and the guards, and pushes telemetry. This file owns the
// report built from that telemetry, the first cause of the end, and the bound on the end brake; the attention
// window and the backstop belong to apps/local, as for the host executor.
//   states  starting → running → ended     the first end wins, whoever asks: the device (the law, the duration,
//                                           an overrun, the watchdog), a stop, the attention window, the backstop
//   a refused start ends the loop at once: `accepted` rejects with the device's error and `ended` resolves
import { setParams, startLoop } from "../protocol/loop";
import type {
  LoopEnd,
  LoopEvent,
  LoopOutputStats,
  LoopOutputWindow,
  LoopPlan,
  LoopReport,
  LoopSignalStats,
  LoopSignalWindow,
  LoopTelemetry,
  LoopTrace,
  Provider,
  ProviderLoop,
} from "../protocol/types";
import { LOOP_TRACE_POINTS } from "../protocol/loop";
import type { Clock } from "./clock";
import { LOOP_START_TICKS } from "./host-loop";

export type DeviceProviderLoop = Extract<ProviderLoop, { runs_on: "device" }>;

/** What apps/local holds of a running loop, whichever executor runs it. */
export interface RuntimeLoop {
  readonly plan: LoopPlan;
  readonly runs_on: "host" | "device";
  /** Resolves once the executor has the loop; rejects with its typed refusal (the loop has then ended). */
  readonly accepted: Promise<void>;
  /** Resolves when the first ticks have run or the loop has ended, whichever is first. */
  readonly started: Promise<void>;
  /** Resolves with why the loop ended, once every driven device was braked or the brake's bound passed. */
  readonly ended: Promise<LoopEnd>;
  readonly running: boolean;
  readonly end: LoopEnd | null;
  readonly brakeFailed: string | null;
  readonly driven: string[];
  /** Changes params on a tick boundary; throws invalid_argument at once for a name or a value the law refuses. */
  set(params: Record<string, number>, ramp_ms: number): Promise<void> | void;
  stop(end: LoopEnd): Promise<void>;
  counts(): { ticks: number; overruns: number; ms: number };
  report(): LoopReport;
}

export interface DeviceLoopOptions {
  plan: LoopPlan;
  provider: Provider & { loop: DeviceProviderLoop };
  clock: Clock;
  /** How long the device's end brake may take, ms (the runtime's stop_worst_ms); past it the loop ends all the same. */
  endWithinMs: number;
}

type Handle = Awaited<ReturnType<DeviceProviderLoop["start"]>>;

const quantile = (sorted: number[], q: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]! : 0;
const round2 = (x: number): number => Math.round(x * 100) / 100;
const emptySignal = (): LoopSignalWindow => ({ n: 0, min: 0, max: 0, sum: 0, last: 0, integral: 0, derivative: 0 });
const emptyOutput = (): LoopOutputWindow => ({ n: 0, min: 0, max: 0, sum: 0, last: 0, cut: 0 });

export class DeviceLoop implements RuntimeLoop {
  readonly plan: LoopPlan;
  readonly runs_on = "device" as const;
  readonly accepted: Promise<void>;
  readonly started: Promise<void>;
  readonly ended: Promise<LoopEnd>;
  private readonly o: DeviceLoopOptions;
  private handle: Handle | null = null;
  private end_: LoopEnd | null = null;
  private endRun: Promise<void> | null = null;
  private brakeError: string | null = null;
  private failure: string | null = null;
  private final: LoopReport | null = null;
  private resolveStarted!: () => void;
  private resolveEnded!: (e: LoopEnd) => void;
  /** Resolves when the device has said the loop ended (or the link closed, or it was never taken). */
  private readonly deviceDone: Promise<void>;
  private resolveDeviceDone!: () => void;
  private ticks = 0;
  private overruns = 0;
  private ageMs = 0;
  private ageAt: number | null = null;
  private periods: number[] = [];
  private signals: LoopSignalWindow[];
  private outputs: LoopOutputWindow[];
  private trace: LoopTrace;
  private params: Record<string, number>;

  constructor(o: DeviceLoopOptions) {
    this.o = o;
    this.plan = o.plan;
    this.params = { ...o.plan.params };
    this.signals = o.plan.signals.map(emptySignal);
    this.outputs = o.plan.outputs.map(emptyOutput);
    this.trace = this.emptyTrace();
    this.started = new Promise((resolve) => (this.resolveStarted = resolve));
    this.ended = new Promise((resolve) => (this.resolveEnded = resolve));
    this.deviceDone = new Promise((resolve) => (this.resolveDeviceDone = resolve));
    this.accepted = o.provider.loop
      .start(o.plan, (ev) => this.onEvent(ev))
      .then(
        (h) => {
          this.handle = h;
          void h.ended.then((e) => this.onEvent({ t: "end", end: e }));
          // a stop that came while the device was taking the loop: its end goes out now
          if (this.end_) void h.end().catch(() => {});
        },
        (e: unknown) => {
          this.failure = `the device refused the loop: ${String((e as Error)?.message ?? e)}`;
          this.onEvent({ t: "end", end: { reason: "input_lost" } });
          throw e;
        },
      );
    // a refusal is the caller's to read through `accepted`; the loop's own bookkeeping goes on without it
    this.accepted.catch(() => {});
  }

  get running(): boolean {
    return this.end_ === null;
  }
  get end(): LoopEnd | null {
    return this.end_;
  }
  get brakeFailed(): string | null {
    return this.brakeError;
  }
  get driven(): string[] {
    return this.plan.outputs.map((o) => o.device);
  }

  async set(params: Record<string, number>, ramp_ms: number): Promise<void> {
    if (!this.running) return;
    // the law's own checks, at once: an unknown name or a value out of range is refused before anything is sent
    setParams({ ...startLoop(this.plan), params: { ...this.params } }, params, ramp_ms);
    await this.accepted;
    try {
      await this.handle!.set(params, ramp_ms);
    } catch (e) {
      // a loop that ended while the params were on their way has nothing left to change: its report says why
      if (this.running) throw e;
      return;
    }
    if (ramp_ms === 0 && this.running) Object.assign(this.params, params);
  }

  stop(end: LoopEnd): Promise<void> {
    if (this.endRun) return this.endRun;
    this.end_ = end;
    this.ageMs = this.age();
    this.ageAt = null;
    this.resolveStarted();
    this.endRun = (async () => {
      void this.handle?.end().catch(() => {});
      const late = new AbortController();
      const done = await Promise.race([
        this.deviceDone.then(() => true),
        this.o.clock.sleep(this.o.endWithinMs, late.signal).then(() => false),
      ]);
      late.abort();
      if (!done && !this.brakeError) this.brakeError = `no answer from the device within ${this.o.endWithinMs} ms`;
      this.resolveEnded(this.end_!);
    })();
    return this.endRun;
  }

  private onEvent(ev: LoopEvent): void {
    if (ev.t === "telemetry") {
      this.take(ev.telemetry);
      if (this.ticks >= LOOP_START_TICKS) this.resolveStarted();
      return;
    }
    if (ev.telemetry) this.take(ev.telemetry);
    if (ev.brake_error) this.brakeError ??= ev.brake_error;
    if (ev.failure) this.failure ??= ev.failure;
    const first = this.end_ === null;
    if (first) {
      this.end_ = ev.end;
      this.ageMs = this.age();
      this.ageAt = null;
      this.resolveStarted();
    }
    this.resolveDeviceDone();
    if (first) this.endRun = Promise.resolve().then(() => this.resolveEnded(this.end_!));
  }

  /** Adds one telemetry line to what the next report covers. */
  private take(t: LoopTelemetry): void {
    if (this.end_ && this.ageAt === null && this.final) return;
    this.ticks = t.ticks;
    this.overruns = t.overruns;
    if (this.end_ === null) {
      this.ageMs = t.age_ms;
      this.ageAt = this.o.clock.now();
    } else this.ageMs = Math.max(this.ageMs, t.age_ms);
    this.periods.push(...t.periods);
    t.signals.forEach((w, i) => this.merge(this.signals[i], w));
    t.outputs.forEach((w, i) => this.merge(this.outputs[i], w));
    t.signals.forEach((w, i) => {
      const s = this.signals[i];
      if (s) Object.assign(s, { last: w.last, integral: w.integral, derivative: w.derivative });
    });
    t.outputs.forEach((w, i) => {
      const s = this.outputs[i];
      if (s) s.last = w.last;
    });
    for (const key of Object.keys(this.trace)) this.trace[key]!.push(...(t.trace[key] ?? []));
    const extra = this.trace.t_ms.length - LOOP_TRACE_POINTS;
    if (extra > 0) for (const key of Object.keys(this.trace)) this.trace[key]!.splice(0, extra);
    this.params = { ...t.params };
  }

  private merge(into: LoopSignalWindow | LoopOutputWindow | undefined, w: LoopSignalWindow | LoopOutputWindow): void {
    if (!into || !w.n) return;
    into.min = into.n === 0 || w.min < into.min ? w.min : into.min;
    into.max = into.n === 0 || w.max > into.max ? w.max : into.max;
    into.sum += w.sum;
    into.n += w.n;
    if ("cut" in into && "cut" in w) into.cut += w.cut;
  }

  private emptyTrace(): LoopTrace {
    const trace: LoopTrace = { t_ms: [] };
    for (const s of this.plan.signals) trace[s.name] = [];
    this.plan.outputs.forEach((_, i) => (trace[`out${i}`] = []));
    return trace;
  }

  /** Loop time since the first tick, ms: the device's latest, and the time since it said it while it runs. */
  private age(): number {
    if (this.ageAt === null) return this.ageMs;
    return Math.min(this.plan.duration_ms, this.ageMs + Math.max(0, this.o.clock.now() - this.ageAt));
  }

  counts(): { ticks: number; overruns: number; ms: number } {
    return { ticks: this.ticks, overruns: this.overruns, ms: Math.round(this.age()) };
  }

  /** The report since the previous one (CONTRACT §5a); once ended, the first report after the end is the final one. */
  report(): LoopReport {
    if (this.final) return structuredClone(this.final);
    const signals: Record<string, LoopSignalStats> = {};
    this.plan.signals.forEach((p, i) => {
      const w = this.signals[i]!;
      signals[p.name] = {
        last: w.last,
        min: w.n ? w.min : w.last,
        max: w.n ? w.max : w.last,
        mean: w.n ? w.sum / w.n : w.last,
        integral: w.integral,
        derivative: w.derivative,
      };
    });
    const outputs: LoopOutputStats[] = this.plan.outputs.map((o, i) => {
      const w = this.outputs[i]!;
      return {
        device: o.device,
        command: o.command,
        last: w.last,
        min: w.n ? w.min : w.last,
        max: w.n ? w.max : w.last,
        mean_abs: w.n ? w.sum / w.n : Math.abs(w.last),
        saturated_pct: w.n ? (100 * w.cut) / w.n : 0,
      };
    });
    const sorted = this.periods.slice().sort((a, b) => a - b);
    const trace = this.trace;
    this.periods = [];
    this.signals = this.signals.map((w) => ({
      ...emptySignal(),
      last: w.last,
      integral: w.integral,
      derivative: w.derivative,
    }));
    this.outputs = this.outputs.map((w) => ({ ...emptyOutput(), last: w.last }));
    this.trace = this.emptyTrace();
    const end = this.end_;
    const age = this.age();
    const notes = [
      ...this.plan.notes,
      ...this.plan.clamps.map((c) => `${c.arg} was cut from ${c.requested} to ${c.applied}, the robot's max_loop_ms`),
      ...(this.failure ? [`the executor failed: ${this.failure}`] : []),
      ...(this.brakeError ? [`the brake at the end of the loop failed: ${this.brakeError}`] : []),
    ];
    const report: LoopReport = {
      state: end ? "ended" : "running",
      ...(end ? { reason: end.reason } : {}),
      ...(end?.guard !== undefined ? { guard: end.guard } : {}),
      runs_on: "device",
      rate_hz: this.plan.rate_hz,
      age_ms: Math.round(age),
      remaining_ms: end ? 0 : Math.max(0, Math.round(this.plan.duration_ms - age)),
      ticks: this.ticks,
      overruns: this.overruns,
      period_ms: {
        p50: round2(quantile(sorted, 0.5)),
        p95: round2(quantile(sorted, 0.95)),
        max: round2(sorted.at(-1) ?? 0),
      },
      signals,
      outputs,
      params: { ...this.params },
      trace,
      ...(notes.length ? { notes } : {}),
    };
    // the final report waits for the device's own end, so it holds the ticks up to the brake
    if (end && this.endRun) this.final = structuredClone(report);
    return report;
  }
}
