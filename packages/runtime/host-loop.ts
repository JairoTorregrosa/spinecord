// The host executor of a loop (CONTRACT §4, §5a): one timer on the runtime's clock with absolute deadlines (tick n is
// due at start + n × period). Each tick refreshes every output with what the law computed on the previous tick and
// reads every input, in one exchange per provider, then steps the law (packages/protocol/loop.ts). It owns the ticks,
// the duration, the overrun rule and the report; the attention window and the backstop belong to apps/local.
//   states  running → ended          the first end wins, whoever asks: the law, the duration, an overrun, a lost
//                                    input, a stop, the attention window, the backstop
//   every end brakes every driven device first, then resolves `ended`
import {
  recordTick,
  setParams,
  startLoop,
  startStats,
  stepLoop,
  takeStats,
  type LoopState,
  type LoopStats,
} from "../protocol/loop";
import type {
  LoopEnd,
  LoopPlan,
  LoopRead,
  LoopReport,
  LoopWrite,
  Provider,
  ProviderLoop,
  Value,
} from "../protocol/types";
import type { Clock } from "./clock";

/** Ticks after which run_loop answers (CONTRACT §5a, Supervision). */
export const LOOP_START_TICKS = 20;
/** Ticks in a row later than one period that end a loop with `overrun`. */
export const LOOP_LATE_IN_A_ROW = 3;
/** Share of the ticks of any second that may come later than one period. */
export const LOOP_LATE_SHARE = 0.05;

export type HostProviderLoop = Extract<ProviderLoop, { runs_on: "host" }>;
/** One provider's share of a tick: which outputs it refreshes and which signals it reads, by index in the plan. */
export interface HostLoopPart {
  provider: Provider & { loop: HostProviderLoop };
  outputs: number[];
  signals: number[];
}
export interface HostLoopOptions {
  plan: LoopPlan;
  parts: HostLoopPart[];
  clock: Clock;
  /** Is this device still in the registry? A signal whose device left it ends the loop with input_lost. */
  attached(device: string): boolean;
}

const quantile = (sorted: number[], q: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]! : 0;
const round2 = (x: number): number => Math.round(x * 100) / 100;

export class HostLoop {
  readonly plan: LoopPlan;
  /** Resolves when the first LOOP_START_TICKS ticks have run or the loop has ended, whichever is first. */
  readonly started: Promise<void>;
  /** Resolves with why the loop ended, once every driven device was braked. */
  readonly ended: Promise<LoopEnd>;
  private readonly o: HostLoopOptions;
  private state: LoopState;
  private readonly stats: LoopStats;
  private end_: LoopEnd | null = null;
  private endRun: Promise<void> | null = null;
  private brakeError: string | null = null;
  private failure: string | null = null;
  private final: LoopReport | null = null;
  private readonly wake = new AbortController();
  private resolveStarted!: () => void;
  private resolveEnded!: (e: LoopEnd) => void;
  private ticks = 0;
  private overruns = 0;
  private firstAt: number | null = null;
  private endedAt: number | null = null;
  /** Measured time between two ticks since the previous report, ms. */
  private periods: number[] = [];
  /** Ticks of the last second: when each was sent and whether it was late. */
  private readonly recent: { at: number; late: boolean }[] = [];

  constructor(o: HostLoopOptions) {
    this.o = o;
    this.plan = o.plan;
    this.state = startLoop(o.plan);
    this.stats = startStats(o.plan);
    this.started = new Promise((resolve) => (this.resolveStarted = resolve));
    this.ended = new Promise((resolve) => (this.resolveEnded = resolve));
    void this.run();
  }

  get running(): boolean {
    return this.end_ === null;
  }
  /** Why the loop ended; null while it runs. */
  get end(): LoopEnd | null {
    return this.end_;
  }
  /** The devices the loop drives, by id. */
  get driven(): string[] {
    return this.plan.outputs.map((o) => o.device);
  }

  /** Changes params on the next tick boundary (loop.ts setParams); throws invalid_argument for an unknown name. */
  set(params: Record<string, number>, ramp_ms: number): void {
    if (!this.running) return;
    this.state = setParams(this.state, params, ramp_ms);
  }

  /**
   * Ends the loop: the first call decides the reason, later ones join it. No tick is sent after this call returns;
   * the driven devices are braked ahead of anything else, then `ended` resolves.
   */
  stop(end: LoopEnd): Promise<void> {
    if (this.endRun) return this.endRun;
    this.end_ = end;
    this.endedAt = this.o.clock.now();
    this.wake.abort();
    this.resolveStarted();
    this.endRun = (async () => {
      const results = await Promise.allSettled(
        this.o.parts.map((p) => p.provider.loop.end(p.outputs.map((i) => this.plan.outputs[i]!.device))),
      );
      const failed = results.find((r) => r.status === "rejected");
      if (failed) this.brakeError = String((failed.reason as Error)?.message ?? failed.reason);
      this.resolveEnded(end);
    })();
    return this.endRun;
  }

  /** Loop time since the first tick, ms. */
  private age(): number {
    if (this.firstAt === null) return 0;
    return (this.endedAt ?? this.o.clock.now()) - this.firstAt;
  }

  /** What the log keeps of a loop: how many ticks, how many late, how long. */
  counts(): { ticks: number; overruns: number; ms: number } {
    return { ticks: this.ticks, overruns: this.overruns, ms: Math.round(this.age()) };
  }

  /**
   * The report since the previous one (CONTRACT §5a, What a loop reports). Once the loop has ended, the first report
   * after its end is the final one, and every later call returns it as it is.
   */
  report(): LoopReport {
    if (this.final) return structuredClone(this.final);
    const { signals, outputs, trace } = takeStats(this.stats);
    const sorted = this.periods.slice().sort((a, b) => a - b);
    this.periods = [];
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
      runs_on: "host",
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
      params: { ...this.state.params },
      trace,
      ...(notes.length ? { notes } : {}),
    };
    if (end) this.final = structuredClone(report);
    return report;
  }

  private async run(): Promise<void> {
    const { plan, clock } = this.o;
    const period = plan.period_ms;
    let outputs = plan.outputs.map(() => 0);
    let prevAt = 0;
    const t0 = clock.now();
    try {
      for (let n = 0; this.running; n++) {
        const due = t0 + n * period;
        const wait = due - clock.now();
        if (wait > 0) await clock.sleep(wait, this.wake.signal);
        if (!this.running) return;
        const at = clock.now();
        if (this.firstAt === null) this.firstAt = at;
        else if (at - this.firstAt >= plan.duration_ms) return void this.stop({ reason: "completed" });
        // the rate: 3 ticks in a row later than a period, or more than 5 % of the ticks of a second
        const late = at - due > period;
        if (late) this.overruns++;
        this.recent.push({ at, late });
        while (this.recent.length && this.recent[0]!.at <= at - 1000) this.recent.shift();
        const lateInARow = this.lateRun(late);
        const share = this.recent.filter((t) => t.late).length / this.recent.length;
        if (lateInARow >= LOOP_LATE_IN_A_ROW || (at - this.firstAt >= 1000 && share > LOOP_LATE_SHARE))
          return void this.stop({ reason: "overrun" });
        if (plan.signals.some((s) => !this.o.attached(s.device))) return void this.stop({ reason: "input_lost" });

        const inputs: (number | null)[] = plan.signals.map(() => null);
        try {
          await Promise.all(
            this.o.parts.map(async (p) => {
              const writes: LoopWrite[] = p.outputs.map((i) => {
                const o = plan.outputs[i]!;
                return { device: o.device, command: o.command, args: { ...o.args, [o.arg]: outputs[i]! as Value } };
              });
              const reads: LoopRead[] = p.signals.map((i) => {
                const s = plan.signals[i]!;
                return { device: s.device, channel: s.channel, ...(s.index === undefined ? {} : { index: s.index }) };
              });
              const hold = Math.max(0, ...p.outputs.map((i) => plan.outputs[i]!.hold_ms));
              const got = await p.provider.loop.tick(writes, reads, hold);
              p.signals.forEach((i, k) => (inputs[i] = got[k] ?? null));
            }),
          );
        } catch {
          // a tick whose exchange was not answered ends the loop: nothing was read
          return void this.stop({ reason: "input_lost" });
        }
        if (!this.running) return;
        const dt = n === 0 ? 0 : at - prevAt;
        if (n > 0) this.periods.push(dt);
        prevAt = at;
        const step = stepLoop(this.state, inputs, dt);
        this.state = step.state;
        this.ticks++;
        recordTick(this.stats, step.state);
        if (step.end) return void this.stop(step.end);
        outputs = step.outputs;
        if (this.ticks === LOOP_START_TICKS) this.resolveStarted();
      }
    } catch (e) {
      // the law refused a value it should never see (a bug): the loop ends braked, and the report says why
      this.failure = String((e as Error)?.message ?? e);
      void this.stop({ reason: "input_lost" });
    }
  }

  private lateCount = 0;
  private lateRun(late: boolean): number {
    this.lateCount = late ? this.lateCount + 1 : 0;
    return this.lateCount;
  }
}
