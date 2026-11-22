// One robot of this process and the only state it has (CONTRACT §11): a link (is there a runtime to talk to?)
// and an activity. Both follow the transition tables of protocol/types.ts, asserted on every transition.
//   link      offline → handshaking → online → offline
//   activity  idle → acting | running_program → idle        one moving call at a time; a second one gets `busy`
//             any → stopping → idle | fault                  stop preempts everything and is verified
//             fault → idle                                   reset_fault, after a verified stop
// Every check-and-claim happens before the first await, so calls sent in parallel cannot both win.
import {
  ACTIVITY_TRANSITIONS,
  LINK_TRANSITIONS,
  RuntimeError,
  type ErrorCode,
  type LocalRobotStateView,
  type RobotActivity,
  type RobotLink,
  type RobotTool,
  type RuntimeResult,
} from "../../../packages/protocol/types";
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
  ) {
    super(code, message, retryable);
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
  onTransition?: (fsm: "link" | "activity", from: string, to: string, why: string) => void;
  /** Default DEADLINE_MARGIN_MS. */
  deadlineMarginMs?: number;
  /** The client cancelled a call in flight. */
  onCancel?: (tool: string, moving: boolean) => void;
}

/** A moving call's hold on the robot. `ended` resolves when its runtime call has fully ended. */
interface Claim {
  ended: Promise<void>;
  end: () => void;
}
const MAY_HAVE_MOVED =
  "The move had started and may have partly happened: read the robot (read_all) before moving again.";

export class LocalRobot {
  readonly id: string;
  private readonly connectHint: string | null;
  private link: RobotLink = "offline";
  private activity: RobotActivity = "idle";
  private faultReason: string | null = null;
  private rt: LocalRuntime | null = null;
  /** The one moving call in flight: its identity and when it has fully ended. */
  private move: Claim | null = null;
  private stopRun: Promise<{ motors_stopped: boolean; activity: RobotActivity }> | null = null;
  private resetRun: Promise<RuntimeResult> | null = null;
  /** The verified stop a reset_fault is running in the runtime; a stop waits for it instead of running beside it. */
  private resetVerify: Promise<unknown> | null = null;

  constructor(private readonly o: RobotOptions) {
    this.id = o.id;
    this.connectHint = o.connect ?? null;
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
  private fault(reason: string): void {
    this.toActivity("fault", reason);
    this.faultReason = reason;
  }
  view(): LocalRobotStateView {
    return { id: this.id, backend: this.rt?.backend ?? null, link: this.link, activity: this.activity };
  }
  listing() {
    return {
      ...this.view(),
      fault_reason: this.activity === "fault" ? this.faultReason : null,
      connect: this.link === "online" ? null : this.connectHint,
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
      const { motors_stopped } = await rt.stop();
      if (this.link !== "handshaking") throw new Error("the link went away during the handshake");
      this.rt = rt;
      if (motors_stopped) {
        if (this.activity === "fault") this.toActivity("idle", "verified stop at attach");
      } else if (this.activity !== "fault") this.fault("the stop at connection could not be verified");
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
    const rt = this.online();
    if (tool === "stop") return { data: await this.stop() };
    if (tool === "reset_fault") return this.resetFault(rt);
    const moving = this.moves(rt, tool, args);
    const reads = !moving && tool !== "command_device";
    if (!reads && this.activity === "fault")
      throw new LocalError(
        "fault",
        `Robot ${this.id} is in fault (${this.faultReason ?? "unknown reason"}). Read it (read_all), then call reset_fault.`,
      );
    if (!moving) return this.bounded(rt, tool, args, null, cancel);
    if (this.activity !== "idle")
      throw new LocalError(
        "busy",
        `Robot ${this.id} is ${this.activity}: one moving call at a time. Wait for it to end, or call stop.`,
        true,
        BUSY_RETRY_MS,
      );
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
        throw new LocalError(e.code, `${e.message} ${MAY_HAVE_MOVED}`, false, undefined, true);
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
      if (moving) {
        // this call gives its own claim up: the stop verifies the motors and does not wait for a call that hangs
        if (this.move === claim) this.move = null;
        try {
          await this.stop();
        } catch {
          // no link to stop through (the robot went offline meanwhile): the move is over all the same
          const state = this.activity as RobotActivity;
          if (state === "acting" || state === "running_program")
            this.toActivity("idle", `${tool} timed out, robot offline`);
        }
      }
      throw new LocalError(
        "timeout",
        `${tool} did not end within ${deadline} ms; it was aborted${moving ? ` and the robot was stopped. ${MAY_HAVE_MOVED}` : "."}`,
        !moving,
        undefined,
        moving,
      );
    } finally {
      clearTimeout(timer);
      if (onCancel) cancel?.removeEventListener("abort", onCancel);
    }
  }

  /** Brakes everything and aborts every call in flight. Never waits behind another call; a second stop joins the first. */
  stop(): Promise<{ motors_stopped: boolean; activity: RobotActivity }> {
    if (this.stopRun) return this.stopRun;
    const rt = this.online();
    const cameFromFault = this.activity === "fault";
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
      // a verified stop does not clear a fault: reset_fault does
      if (!stopped) this.fault(why);
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

  /** Process exit: the same verified stop, joined with one already running, then the runtime is let go. null = there was no link to stop through. */
  async shutdown(): Promise<boolean | null> {
    const rt = this.rt;
    if (!rt || this.link !== "online") return null;
    let stopped = false;
    try {
      stopped = (await this.stop()).motors_stopped;
    } catch {
      /* reported as not stopped */
    }
    rt.dispose();
    return stopped;
  }
}
