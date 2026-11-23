// One robot of this process and the only state it has (CONTRACT §1): a link (is there a runtime to talk to?)
// and an activity. Both follow the transition tables of protocol/types.ts, asserted on every transition.
//   link      offline → handshaking → online → offline
//   activity  idle → acting | running_program → idle        one moving call at a time; a second one gets `busy`
//             idle → looping → stopping → idle | fault       run_loop; every end of the loop takes the path of stop
//             any → stopping → idle | fault                  stop preempts everything and is verified
//             fault → idle                                   reset_fault, after a verified stop
// Every check-and-claim happens before the first await, so calls sent in parallel cannot both win.
import {
  ACTIVITY_TRANSITIONS,
  LINK_TRANSITIONS,
  RuntimeError,
  type ErrorCode,
  type RobotStateView,
  type RobotActivity,
  type RobotLink,
  type RobotTool,
  type RuntimeResult,
} from "../../../packages/protocol/types";
import type { LoopEnd, LoopReport } from "../../../packages/protocol/types";
import { type Clock, realClock } from "../../../packages/runtime/clock";
import type { RuntimeLoop } from "../../../packages/runtime/device-loop";
import { LOOP_START_TICKS } from "../../../packages/runtime/host-loop";
import type { LocalRuntime } from "../../../packages/runtime/runtime";

/** A typed failure with what the envelope's error needs beyond the code. */
export class LocalError extends RuntimeError {
  constructor(
    code: ErrorCode,
    message: string,
    retryable = false,
    readonly retry_after_ms?: number,
    /** The call had started to move the robot: it may have partly happened, so the next step is a read. */
    readonly afterMove = false,
    measured?: RuntimeError["measured"],
  ) {
    super(code, message, retryable, measured);
  }
}

/** Added to a call's own time limit before the backstop ends it: the runtime's limit answers first, with data. */
export const DEADLINE_MARGIN_MS = 2000;
const BUSY_RETRY_MS = 250;
const MOVING_TOOLS: readonly string[] = ["drive", "turn", "arc"];

export interface RobotOptions {
  id: string;
  /** What a person must do to bring this robot online while it is offline (the page to open); null when nothing. */
  connect?: string | null;
  onTransition?: (fsm: "link" | "activity" | "life", from: string, to: string, why: string) => void;
  /** Default DEADLINE_MARGIN_MS. */
  deadlineMarginMs?: number;
  /** The client cancelled a call in flight. */
  onCancel?: (tool: string, moving: boolean) => void;
  /** A loop ended, whoever ended it (CONTRACT §6: the `loop_end` line). */
  onLoopEnd?: (line: LoopEndLine) => void;
  /** The clock of the attention window and of the backstop behind a loop. Default: real time. */
  clock?: Clock;
  /** With pages enabled: how a person lends this robot a page's devices, and its pages for describe_robot. */
  pages?: { join(): string; view(): unknown[] };
}
/** What the log keeps of a loop that ended: no signal value and no trace. */
export interface LoopEndLine {
  ts: string;
  robot_id: string;
  reason: LoopEnd["reason"];
  guard: string | null;
  runs_on: LoopReport["runs_on"];
  ticks: number;
  overruns: number;
  ms: number;
}
/**
 * The robot's loop on this link. Its states are the executor's (running → ended); around it, this process keeps the
 * attention window (a timer armed while no supervise_loop is pending) and the backstop (one timer from the start).
 */
interface LoopRecord {
  loop: RuntimeLoop;
  /** supervise_loop calls in flight: while one is, the attention window is not counting. */
  pending: number;
  attention: AbortController | null;
  backstop: AbortController;
  /** Resolves once the loop has ended and the robot has taken the path of stop after it. */
  settled: Promise<void>;
  settle: () => void;
}

/** The life of a robot in its process. In `closing` and `closed` every call is refused; only the shutdown's own stop runs. */
export type Life = "serving" | "closing" | "closed";
export const LIFE_TRANSITIONS: Record<Life, readonly Life[]> = {
  serving: ["closing"],
  closing: ["closed"],
  closed: [],
};

/** A moving call's hold on the robot. `ended` resolves when its runtime call has fully ended. */
interface Claim {
  ended: Promise<void>;
  end: () => void;
}
const MAY_HAVE_MOVED =
  "The move had started and may have partly happened: read the robot (read_all) before moving again.";

/** What every call answers once the process has started to end. */
export const shuttingDown = (): LocalError =>
  new LocalError("robot_offline", "The server is shutting down: its robots are being stopped and it takes no calls.");

/** Verified stops tried at connection before a robot comes online in fault. */
export const ATTACH_STOPS = 3;

export class LocalRobot {
  readonly id: string;
  private readonly connectBase: string | null;
  private attachError: string | null = null; // why the last attempt to bring the robot online failed
  private attachNeedsPerson = false; // that failure repeats until a person changes something (a bridge to reinstall)
  private link: RobotLink = "offline";
  private activity: RobotActivity = "idle";
  private life: Life = "serving";
  private faultReason: string | null = null;
  private rt: LocalRuntime | null = null;
  /** The one moving call in flight: its identity and when it has fully ended. */
  private move: Claim | null = null;
  private stopRun: Promise<{ motors_stopped: boolean; activity: RobotActivity }> | null = null;
  private resetRun: Promise<RuntimeResult> | null = null;
  /** The verified stop a reset_fault is running in the runtime; a stop waits for it, so the two never run side by side. */
  private resetVerify: Promise<unknown> | null = null;
  /** The latest loop of this link: running while the robot is looping, its final report after. */
  private loop: LoopRecord | null = null;
  private readonly clock: Clock;

  constructor(private readonly o: RobotOptions) {
    this.id = o.id;
    this.connectBase = o.connect ?? null;
    this.clock = o.clock ?? realClock;
  }

  // ---------- state ----------
  private toLink(next: RobotLink, why: string): void {
    if (!LINK_TRANSITIONS[this.link].includes(next))
      throw new Error(`${this.id}: illegal link transition ${this.link} → ${next} (${why})`);
    this.o.onTransition?.("link", this.link, next, why);
    this.link = next;
  }
  private toActivity(next: RobotActivity, why: string): void {
    if (!ACTIVITY_TRANSITIONS[this.activity].includes(next))
      throw new Error(`${this.id}: illegal activity transition ${this.activity} → ${next} (${why})`);
    this.o.onTransition?.("activity", this.activity, next, why);
    this.activity = next;
    if (next !== "fault" && next !== "stopping") this.faultReason = null;
  }
  private toLife(next: Life): void {
    if (!LIFE_TRANSITIONS[this.life].includes(next))
      throw new Error(`${this.id}: illegal life transition ${this.life} → ${next}`);
    this.o.onTransition?.("life", this.life, next, "the process is ending");
    this.life = next;
  }
  /** True from the moment the process starts to end. */
  get shuttingDown(): boolean {
    return this.life !== "serving";
  }
  private fault(reason: string): void {
    this.toActivity("fault", reason);
    this.faultReason = reason;
  }
  view(): RobotStateView {
    return { id: this.id, backend: this.rt?.backend ?? null, link: this.link, activity: this.activity };
  }
  /** What a person must do to bring the robot online, with the reason the last attempt failed when one did. */
  private get connectHint(): string | null {
    if (this.attachError === null) return this.connectBase;
    if (this.attachNeedsPerson)
      return `This robot does not come online by itself: every attempt fails until this is fixed. ${this.attachError}`;
    return `${this.connectBase ? `${this.connectBase} ` : ""}The last attempt failed: ${this.attachError}`;
  }
  /** A source tried to bring the robot online and could not; `list_robots` shows why until an attach succeeds. */
  attachFailed(why: string, needsPerson = false): void {
    this.attachError = why;
    this.attachNeedsPerson = needsPerson;
  }
  listing() {
    return {
      ...this.view(),
      fault_reason: this.activity === "fault" ? this.faultReason : null,
      connect: this.link === "online" ? null : this.connectHint,
      join: this.o.pages?.join() ?? null,
    };
  }
  runtime(): LocalRuntime | null {
    return this.rt;
  }

  // ---------- link ----------
  /**
   * A runtime for this robot exists (a twin was built, the brick answered, the page opened an EV3).
   * offline → handshaking → online, after the first device scan and a verified stop: whatever the robot was
   * doing before this process could talk to it has ended, or it starts in fault.
   */
  async attach(rt: LocalRuntime): Promise<void> {
    this.toLink("handshaking", "a runtime is attaching");
    try {
      await this.move?.ended; // a call of the previous link is still unwinding
      await rt.ready();
      // A bridge that has just started on a busy EV3 can miss the stop's bound (measured: the first one or two
      // stops after its hello); up to ATTACH_STOPS verified stops decide. Nothing moves on this link until one
      // stop is verified or reset_fault runs.
      let motors_stopped = false;
      for (let i = 0; i < ATTACH_STOPS && !motors_stopped && this.link === "handshaking"; i++)
        ({ motors_stopped } = await rt.stop());
      if (this.link !== "handshaking") throw new Error("the link went away during the handshake");
      this.rt = rt;
      if (motors_stopped) {
        if (this.activity === "fault") this.toActivity("idle", "verified stop at attach");
      } else if (this.activity !== "fault") this.fault("the stop at connection could not be verified");
      this.attachError = null;
      this.toLink("online", "devices scanned, stop checked");
    } catch (e) {
      rt.dispose();
      if (this.link === "handshaking") this.toLink("offline", `attach failed: ${(e as Error).message}`);
      throw e;
    }
  }
  /** The runtime's hardware went away (page closed, cable pulled). Calls in flight end with the driver's error. */
  detach(why: string): void {
    if (this.link === "offline") return;
    const rt = this.rt;
    this.rt = null;
    this.toLink("offline", why);
    // the report is gone with the link; the brick ends the motion at hold_ms, and the next link's verified stop
    // clears the fault
    const loop = this.loop;
    this.dropLoop();
    if (this.activity === "looping") this.fault(`the link closed while a loop ran: ${why}`);
    if (loop?.loop.running) void loop.loop.stop({ reason: "preempted" }).catch(() => {});
    if (rt) {
      // aborts every call in flight; the stop itself cannot reach the hardware any more
      void rt.stop().catch(() => {});
      rt.dispose();
    }
  }
  private online(): LocalRuntime {
    if (this.link !== "online" || !this.rt)
      throw new LocalError(
        "robot_offline",
        `Robot ${this.id} is ${this.link}.${this.connectHint ? ` ${this.connectHint}` : ""}`,
        true,
        1000,
      );
    return this.rt;
  }

  // ---------- calls ----------
  /** Does this call move the robot? Decided from the device's own manifest, like every other fact about it. */
  private moves(rt: LocalRuntime, tool: string, args: Record<string, unknown>): boolean {
    if (MOVING_TOOLS.includes(tool) || tool === "run_program") return true;
    if (tool !== "command_device") return false;
    const name = args.device;
    const id = typeof name === "string" ? (rt.profile().roles[name] ?? name) : "";
    const device = rt.devices().find((d) => d.id === id || d.roles.includes(String(name)));
    // an unknown device or command moves nothing: the runtime answers with the typed error
    return device?.commands.find((c) => c.name === args.command)?.moves === true;
  }
  /** The call's own time limit (the runtime enforces it and answers with data); the backstop waits a margin longer. */
  private budgetMs(rt: LocalRuntime, tool: string, args: Record<string, unknown>, moving: boolean): number {
    const limits = rt.profile().limits;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
    if (tool === "run_program") return limits.max_program_ms;
    if (tool === "wait_until") return num(args.timeout_ms);
    if (tool === "sample_device") return num(args.duration_ms);
    if (tool === "command_device") {
      const id = typeof args.device === "string" ? (rt.profile().roles[args.device] ?? args.device) : "";
      const bound = rt
        .devices()
        .find((d) => d.id === id || d.roles.includes(String(args.device)))
        ?.commands.find((c) => c.name === args.command)?.bound;
      // a command that does not move may block for its declared ms bound (a speaker's speak)
      return Math.max(limits.max_command_ms, !moving && bound?.kind === "ms" ? bound.max : 0);
    }
    return moving ? limits.max_command_ms : 0;
  }

  /** `cancel` is the client's cancellation of this call: a moving call is then stopped (verified), any other is aborted. */
  async call(tool: string, args: Record<string, unknown>, cancel?: AbortSignal): Promise<RuntimeResult> {
    if (this.life !== "serving") throw shuttingDown();
    const rt = this.online();
    if (tool === "stop") return { data: await this.stop() };
    if (tool === "reset_fault") return this.resetFault(rt);
    if (tool === "run_loop") return this.runLoop(rt, args, cancel);
    if (tool === "supervise_loop") return this.superviseLoop(args, cancel);
    if (tool === "describe_robot" && this.o.pages) {
      // the pages of the robot are this process's (their state machine is apps/local's): added to the runtime's answer
      const out = await this.bounded(rt, tool, args, null, cancel);
      return { ...out, data: { ...(out.data as Record<string, unknown>), pages: this.o.pages.view() } };
    }
    const moving = this.moves(rt, tool, args);
    const reads = !moving && tool !== "command_device";
    if (!reads && this.activity === "fault")
      throw new LocalError(
        "fault",
        `Robot ${this.id} is in fault (${this.faultReason ?? "unknown reason"}). Read it (read_all), then call reset_fault.`,
      );
    if (!moving) {
      if (this.activity === "looping" && tool === "command_device" && this.loopDrives(rt, args.device))
        throw this.busy(`${String(args.device)} is driven by the loop`);
      return this.bounded(rt, tool, args, null, cancel);
    }
    if (this.activity !== "idle") throw this.busy();
    // claimed synchronously: a call sent in parallel sees acting and gets busy
    let end!: () => void;
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    const claim: Claim = { ended, end };
    this.move = claim;
    this.toActivity(tool === "run_program" ? "running_program" : "acting", tool);
    try {
      return await this.bounded(rt, tool, args, claim, cancel);
    } catch (e) {
      // a move that failed on the way (the link dropped) is never "send it again": the robot may be somewhere else
      if (e instanceof RuntimeError && e.retryable && !(e instanceof LocalError && e.afterMove))
        throw new LocalError(e.code, `${e.message} ${MAY_HAVE_MOVED}`, false, undefined, true, e.measured).from(e);
      throw e;
    } finally {
      // a stop or a fault that came meanwhile owns the state; only an undisturbed move goes back to idle
      if (this.move === claim) {
        this.move = null;
        const state = this.activity as RobotActivity; // other calls ran during the await
        if (state === "acting" || state === "running_program") this.toActivity("idle", `${tool} ended`);
      }
    }
  }

  /**
   * Runs one runtime call under a backstop deadline; `claim` is set for a moving call. Past the deadline the call
   * is aborted, a moving one is stopped, and the answer is `timeout`. On `cancel` a moving call is stopped the way
   * `stop` does it, any other call is aborted; the call then ends with what the runtime answers.
   */
  private async bounded(
    rt: LocalRuntime,
    tool: string,
    args: Record<string, unknown>,
    claim: Claim | null,
    cancel?: AbortSignal,
  ): Promise<RuntimeResult> {
    const moving = claim !== null;
    const abort = new AbortController();
    const deadline =
      this.budgetMs(rt, tool, args, moving) + (this.o.deadlineMarginMs ?? DEADLINE_MARGIN_MS) + rt.stop_worst_ms;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), deadline);
    });
    let onCancel: (() => void) | undefined;
    const cancelled = new Promise<"cancelled">((resolve) => {
      onCancel = () => resolve("cancelled");
      if (cancel?.aborted) onCancel();
      else cancel?.addEventListener("abort", onCancel, { once: true });
    });
    const work = rt.call(tool as RobotTool, args, abort.signal, { activity: this.activity });
    // when the deadline wins, the call's own end is not awaited; the claim ends with the runtime call
    work.then(claim?.end, claim?.end ?? (() => {}));
    try {
      let first = await Promise.race([work, late, cancelled]);
      if (first === "cancelled") {
        this.o.onCancel?.(tool, moving);
        abort.abort();
        // the same verified stop a `stop` call runs; it waits for this call's runtime call to end
        if (moving && this.move === claim) await this.stop().catch(() => {});
        first = await Promise.race([work, late]);
      }
      if (first !== "late") return first;
      abort.abort();
      // how the stop behind a move that timed out ended
      let stop: "verified" | "unverified" | "not sent" = "not sent";
      if (moving) {
        // this call gives its own claim up: the stop verifies the motors and does not wait for a call that hangs
        if (this.move === claim) this.move = null;
        try {
          stop = (await this.stop()).motors_stopped ? "verified" : "unverified";
        } catch {
          // no link to stop through (the robot went offline meanwhile): the move is over all the same
          const state = this.activity as RobotActivity;
          if (state === "acting" || state === "running_program")
            this.toActivity("idle", `${tool} timed out, robot offline`);
        }
        // the stop has run: the claim is over although its runtime call never ended, so a new link can attach
        claim.end();
      }
      throw new LocalError(
        "timeout",
        `${tool} did not end within ${deadline} ms; it was aborted${
          !moving
            ? "."
            : stop === "verified"
              ? ` and the robot was stopped. ${MAY_HAVE_MOVED}`
              : stop === "unverified"
                ? `, and the stop could not be verified: the robot is in fault. ${MAY_HAVE_MOVED}`
                : `, and the stop could not be sent: the robot is ${this.link}. ${MAY_HAVE_MOVED}`
        }`,
        !moving,
        undefined,
        moving,
      );
    } finally {
      clearTimeout(timer);
      if (onCancel) cancel?.removeEventListener("abort", onCancel);
    }
  }

  // ---------- loops ----------
  /** `busy` for a call that cannot run in this activity; while looping it names the way to the loop. */
  private busy(what?: string): LocalError {
    const e =
      this.activity === "looping"
        ? new LocalError(
            "busy",
            `Robot ${this.id} is looping${what ? ` (${what})` : ""}: one loop or one moving call at a time. Read or steer the loop with supervise_loop, or end it with stop.`,
            true,
            BUSY_RETRY_MS,
          )
        : new LocalError(
            "busy",
            `Robot ${this.id} is ${this.activity}: one moving call at a time. Wait for it to end, or call stop.`,
            true,
            BUSY_RETRY_MS,
          );
    if (this.activity === "looping") e.next = ["supervise_loop", "stop"];
    return e;
  }
  /** Is `name` (a device id or a role) a device the running loop drives? */
  private loopDrives(rt: LocalRuntime, name: unknown): boolean {
    const loop = this.loop?.loop;
    if (!loop?.running || typeof name !== "string") return false;
    const id = rt.profile().roles[name] ?? name;
    const device = rt.devices().find((d) => d.id === id || d.roles.includes(name));
    return loop.driven.includes(device?.id ?? id);
  }
  private disarm(): void {
    const l = this.loop;
    if (!l) return;
    l.attention?.abort();
    l.attention = null;
    l.backstop.abort();
  }
  private dropLoop(): void {
    this.disarm();
    this.loop = null;
  }
  /** Restarts the attention window of a running loop that no supervise_loop is waiting on. */
  private attend(l: LoopRecord): void {
    l.attention?.abort();
    l.attention = null;
    if (!l.loop.running || l.pending > 0) return;
    const window = new AbortController();
    l.attention = window;
    void this.clock.sleep(l.loop.plan.attention_ms, window.signal).then(() => {
      if (window.signal.aborted || l.attention !== window || !l.loop.running) return;
      void l.loop.stop({ reason: "unattended" });
    });
  }

  /**
   * run_loop: planned against the devices as they stand (a refusal sends nothing and leaves the robot idle), then
   * idle → looping, then started, all ahead of the first await. Answers after the loop's first ticks.
   */
  private async runLoop(rt: LocalRuntime, args: Record<string, unknown>, cancel?: AbortSignal): Promise<RuntimeResult> {
    if (this.activity === "fault")
      throw new LocalError(
        "fault",
        `Robot ${this.id} is in fault (${this.faultReason ?? "unknown reason"}). Read it (read_all), then call reset_fault.`,
      );
    if (this.activity !== "idle") throw this.busy();
    const planned = rt.planLoop(args);
    this.toActivity("looping", "run_loop");
    let loop: RuntimeLoop;
    try {
      loop = rt.startLoop(planned);
    } catch (e) {
      void this.stop().catch(() => {});
      throw e;
    }
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const l: LoopRecord = { loop, pending: 1, attention: null, backstop: new AbortController(), settled, settle };
    this.loop = l;
    // behind the loop: duration + 2 s + the stop's worst case, from its start
    const margin = this.o.deadlineMarginMs ?? DEADLINE_MARGIN_MS;
    void this.clock.sleep(loop.plan.duration_ms + margin + rt.stop_worst_ms, l.backstop.signal).then(() => {
      if (!l.backstop.signal.aborted && loop.running) void loop.stop({ reason: "timeout" });
    });
    void loop.ended.then((end) => this.loopEnded(l, rt, end));
    try {
      // a device that refuses the loop at its start: the loop has ended, the robot takes the path of stop, and the
      // call answers the device's error, with no loop to supervise
      try {
        await loop.accepted;
      } catch (e) {
        await l.settled;
        if (this.loop === l) this.loop = null;
        throw e;
      }
      // the start window: the first ticks, or the loop's end; behind it the backstop of every call
      const window = LOOP_START_TICKS * loop.plan.period_ms + margin + rt.stop_worst_ms;
      const late = new AbortController();
      const first = await Promise.race([
        loop.started.then(() => "started" as const),
        this.clock.sleep(window, late.signal).then(() => "late" as const),
        this.cancelled(cancel),
      ]);
      late.abort();
      if (first === "cancelled") {
        this.o.onCancel?.("run_loop", true);
        if (this.loop === l && (this.activity as RobotActivity) === "looping") await this.stop().catch(() => {});
      } else if (first === "late" && loop.running) {
        await loop.stop({ reason: "timeout" });
        await this.stop().catch(() => {});
      }
      // a loop that ended this early is reported with the robot in the state its stop left it in
      if (!loop.running) await l.settled;
      return { data: loop.report(), moved: true };
    } finally {
      l.pending--;
      this.attend(l);
    }
  }

  /** Resolves "cancelled" when the client cancels the call; never resolves without a signal. */
  private cancelled(cancel?: AbortSignal): Promise<"cancelled"> {
    return new Promise((resolve) => {
      if (cancel?.aborted) resolve("cancelled");
      else cancel?.addEventListener("abort", () => resolve("cancelled"), { once: true });
    });
  }

  /** The loop ended by itself or was ended: the robot takes the path of stop, and the log has one line. */
  private loopEnded(l: LoopRecord, rt: LocalRuntime, end: LoopEnd): void {
    l.attention?.abort();
    l.attention = null;
    l.backstop.abort();
    this.o.onLoopEnd?.({
      ts: new Date().toISOString(),
      robot_id: this.id,
      reason: end.reason,
      guard: end.guard ?? null,
      runs_on: l.loop.runs_on,
      ...l.loop.counts(),
    });
    // every end takes the verified stop (its own, or the stop that ended the loop); a loop whose own brake failed
    // leaves the robot in fault whatever the motors read
    const stopping =
      this.loop === l && this.activity === "looping" && this.rt === rt
        ? this.stop()
        : (this.stopRun ?? Promise.resolve());
    void stopping
      .catch(() => {})
      .then(() => {
        const failed = l.loop.brakeFailed;
        if (failed && this.loop === l && this.rt === rt && this.activity === "idle")
          this.fault(`the brake at the end of the loop failed: ${failed}`);
      })
      .then(l.settle);
  }

  /** supervise_loop: the report, after the params are set and the wait has passed; it renews the attention window. */
  private async superviseLoop(args: Record<string, unknown>, cancel?: AbortSignal): Promise<RuntimeResult> {
    const l = this.loop;
    if (!l)
      throw Object.assign(
        new LocalError(
          "illegal_state",
          `Robot ${this.id} has run no loop on this link (it is ${this.activity}). Start one with run_loop.`,
        ),
        { next: ["run_loop"] },
      );
    const params = (args.params ?? {}) as Record<string, number>;
    const ramp = typeof args.ramp_ms === "number" ? args.ramp_ms : 0;
    const wait = typeof args.wait_ms === "number" ? args.wait_ms : 0;
    if (Object.keys(params).length && l.loop.running) await l.loop.set(params, ramp);
    l.pending++;
    l.attention?.abort();
    l.attention = null;
    try {
      if (wait > 0 && l.loop.running) {
        const done = new AbortController();
        const first = await Promise.race([
          l.loop.ended.then(() => "ended" as const),
          this.clock.sleep(wait, done.signal).then(() => "waited" as const),
          this.cancelled(cancel),
        ]);
        done.abort();
        if (first === "cancelled") {
          this.o.onCancel?.("supervise_loop", true);
          if (this.loop === l && this.activity === "looping") await this.stop().catch(() => {});
        }
      } else if (cancel?.aborted && this.loop === l && this.activity === "looping") {
        this.o.onCancel?.("supervise_loop", true);
        await this.stop().catch(() => {});
      }
      // an ended loop is reported with the robot in the state its stop left it in
      if (!l.loop.running) await l.settled;
      return { data: l.loop.report() };
    } finally {
      l.pending--;
      this.attend(l);
    }
  }

  /** Brakes everything and aborts every call in flight. Never waits behind another call; a second stop joins the first. */
  stop(): Promise<{ motors_stopped: boolean; activity: RobotActivity }> {
    if (this.stopRun) return this.stopRun;
    let rt: LocalRuntime;
    try {
      rt = this.online();
    } catch (e) {
      // callers hold a promise in every case
      return Promise.reject(e);
    }
    const cameFromFault = this.activity === "fault";
    // the loop of a robot still looping (running, or ending with its brake pending): this stop joins its end, and a
    // failed end brake leaves the robot in fault, as for a loop that ends by itself
    const ending = this.activity === "looping" && this.loop ? this.loop.loop : null;
    const preempted = this.move;
    this.move = null;
    this.toActivity("stopping", "stop");
    this.stopRun = (async () => {
      let stopped = false;
      let why = "the stop could not be verified: not every motor reads speed 0";
      try {
        // one stop at a time on the hardware: reset_fault's own is a stop too, bounded like this one
        await this.resetVerify?.catch(() => {});
        stopped = (await rt.stop()).motors_stopped;
      } catch (e) {
        why = `the stop failed: ${(e as Error).message}`;
      }
      if (stopped && preempted) {
        // the preempted call must be over before another move may start
        let timer: ReturnType<typeof setTimeout> | undefined;
        const over = await Promise.race([
          preempted.ended.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), rt.stop_worst_ms);
          }),
        ]);
        clearTimeout(timer);
        if (!over) {
          stopped = false;
          why = "the motors read stopped, but the preempted call did not end";
        }
      }
      this.disarm();
      // a verified stop does not clear a fault: reset_fault does
      if (!stopped) this.fault(why);
      else if (ending?.brakeFailed) this.fault(`the brake at the end of the loop failed: ${ending.brakeFailed}`);
      else if (cameFromFault) this.fault(this.faultReason ?? "fault before the stop");
      else this.toActivity("idle", "stop verified");
      return { motors_stopped: stopped, activity: this.activity };
    })().finally(() => {
      this.stopRun = null;
    });
    return this.stopRun;
  }

  /** Answers from the state the robot is really in: a stop running at the same time is awaited first and again after. */
  private async resetFault(rt: LocalRuntime): Promise<RuntimeResult> {
    // no await when no stop is running: the check below and the claim of resetRun stay in the caller's turn
    if (this.stopRun) await this.stopRun.catch(() => {});
    if (this.resetRun) return this.resetRun;
    if (this.activity !== "fault")
      throw new LocalError(
        "illegal_state",
        `reset_fault is only valid in fault; robot ${this.id} is ${this.activity}. Allowed in ${this.activity}: every other tool.`,
      );
    this.resetRun = (async () => {
      // the runtime verifies the stop and throws stop_unverified when it cannot
      this.resetVerify = rt.call("reset_fault", {}, new AbortController().signal, { activity: "fault" });
      try {
        await this.resetVerify;
      } catch (e) {
        // answered once a stop sent at the same time has settled, so the envelope shows the state the robot ends in
        this.resetVerify = null;
        if (this.stopRun) await this.stopRun.catch(() => {});
        throw e;
      } finally {
        this.resetVerify = null;
      }
      // a stop that came meanwhile has the last word on whether the motors are stopped
      const stop = await this.stopRun?.catch(() => null);
      if (stop && !stop.motors_stopped)
        throw new LocalError(
          "stop_unverified",
          "A stop sent at the same time could not verify that every motor is stopped, so the fault stays. Check the brick's connection and power, then call stop and reset_fault again.",
        );
      if (this.activity === "fault") this.toActivity("idle", "reset_fault verified the stop");
      return { data: { activity: this.activity } };
    })().finally(() => {
      this.resetRun = null;
    });
    return this.resetRun;
  }

  /**
   * The process starts to end: from this call on, synchronously, the robot takes no calls. Called on every robot
   * of the process before any of them is stopped, so no call can start on one while another is still stopping.
   */
  beginShutdown(): void {
    if (this.life === "serving") this.toLife("closing");
  }
  /** After beginShutdown: the verified stop, joined with one already running, then the runtime is let go. null = there was no link to stop through. */
  async shutdown(): Promise<boolean | null> {
    this.beginShutdown();
    if (this.life === "closed") return null;
    const rt = this.rt;
    let stopped: boolean | null = null;
    if (rt && this.link === "online") {
      try {
        stopped = (await this.stop()).motors_stopped;
      } catch {
        stopped = false;
      }
      rt.dispose();
    }
    this.toLife("closed");
    return stopped;
  }
}
