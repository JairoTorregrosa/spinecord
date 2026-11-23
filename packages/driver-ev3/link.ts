// Serial command queue over a Transport. The brick ignores a command that arrives
// while it is still handling the previous one, so: one command at a time, always
// with reply (type 0x00), matched by counter, and a timeout that rejects (fail loud).
//
// Round trips are what a slow link (USB HID: about 2 ms per packet) charges for, so reads that are
// queued together travel together: read() takes a builder instead of bytes, and the queue places
// every waiting read in one direct command, each with its own slice of the reply.
import { MAX_GLOBALS, MAX_MESSAGE, decodeReply, frame } from "./encode";
import type { Transport } from "./transport";

export type Ev3ErrorCode =
  | "no_reply" // the brick did not answer in time
  | "brick_error" // the brick answered 0x04
  | "bad_reply" // wrong counter, wrong size or not a direct reply
  | "transport" // the transport failed to send
  | "stopped" // dropped from the queue by stop()
  | "bad_param";

export class Ev3Error extends Error {
  constructor(
    public code: Ev3ErrorCode,
    message: string,
    public next?: string,
  ) {
    super(message);
    this.name = "Ev3Error";
  }
}

/** Bytecodes of one read whose reply bytes start at global offset `base`. Must change nothing on the brick. */
export type ReadBuilder = (base: number) => number[];

interface Job {
  bytecodes: number[];
  /**
   * Decides the bytecodes at the moment the packet is built, not when it was queued: a start whose
   * operation was aborted while it waited leaves its motion opcodes out (a preempted motion never begins).
   */
  late?: () => number[];
  /** Set on a read: it may share a packet with other reads (see read()). */
  build?: ReadBuilder;
  /** A read that already failed inside a shared packet: it goes alone, so only the one at fault fails. */
  alone?: boolean;
  globals: number;
  droppable: boolean;
  timeoutMs: number;
  resolve: (g: Uint8Array) => void;
  reject: (e: Error) => void;
}

export interface CommandOptions {
  /** Goes before everything already queued (used by stop). */
  urgent?: boolean;
  /** Rejected with code "stopped" if stop() runs while it is still queued (motion commands). */
  droppable?: boolean;
  /** Reply timeout for this command only (e.g. a sensor mode switch), ms. */
  timeoutMs?: number;
}

export class Ev3Link {
  private counter = 0;
  private readonly normal: Job[] = [];
  private readonly urgent: Job[] = [];
  private running = false;
  private held = 0;
  private rtt: number | null = null;
  readonly timeoutMs: number;
  /** Direct commands sent so far (a shared packet counts once). */
  packets = 0;
  private readonly now: () => number;

  /** `now`: the clock round trips are measured on, ms. Default performance.now. */
  constructor(
    private readonly transport: Transport,
    opts: { timeoutMs?: number; now?: () => number } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 1000;
    this.now = opts.now ?? (() => performance.now());
    if (!(this.timeoutMs > 0)) throw new Ev3Error("bad_param", "timeoutMs must be > 0");
  }

  /**
   * Queue a direct command; resolves with exactly `globals` reply bytes. Bytecodes given as a function are
   * asked for when the packet is built, right before it goes on the wire (same `globals` either way).
   */
  command(bytecodes: number[] | (() => number[]), globals = 0, opts: CommandOptions = {}): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const job: Job = {
        bytecodes: typeof bytecodes === "function" ? [] : bytecodes,
        ...(typeof bytecodes === "function" ? { late: bytecodes } : {}),
        globals,
        droppable: !!opts.droppable,
        timeoutMs: opts.timeoutMs ?? this.timeoutMs,
        resolve,
        reject,
      };
      (opts.urgent ? this.urgent : this.normal).push(job);
      void this.pump();
    });
  }

  /**
   * Queue a read that has no side effect on the brick. Reads waiting in the queue at the same time are sent
   * as ONE direct command (their bytecodes one after the other, their replies side by side in the global
   * buffer), split only where a packet would pass the firmware's limits. Resolves with this read's own
   * `globals` bytes. If the brick rejects a shared packet, each of its reads is sent again alone, so a read
   * the brick cannot answer fails by itself and the others still succeed.
   */
  read(build: ReadBuilder, globals: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.normal.push({ bytecodes: [], build, globals, droppable: false, timeoutMs: this.timeoutMs, resolve, reject });
      // One microtask later: reads issued in the same turn (a read of every device) are all queued by then.
      queueMicrotask(() => void this.pump());
    });
  }

  /** Smoothed round trip of one packet, ms (0 until the first reply). Slow commands (own timeout) are left out. */
  get rttMs(): number {
    return this.rtt ?? 0;
  }

  /**
   * While held, only urgent commands are sent; the others wait. Returns the release function.
   * Used by a verified stop so that nothing can get between the brake and its checks.
   */
  hold(): () => void {
    this.held++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held--;
      void this.pump();
    };
  }

  /** Reject every queued (not yet sent) droppable command, and with `urgentToo` every queued urgent one as well. */
  dropQueued(urgentToo = false): number {
    let n = 0;
    if (urgentToo) {
      for (const job of this.urgent.splice(0)) {
        job.reject(new Ev3Error("stopped", "command dropped by stop()"));
        n++;
      }
    }
    for (let i = this.normal.length - 1; i >= 0; i--) {
      if (!this.normal[i].droppable) continue;
      const [job] = this.normal.splice(i, 1);
      job.reject(new Ev3Error("stopped", "command dropped by stop()"));
      n++;
    }
    return n;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.urgent.shift() ?? (this.held > 0 ? undefined : this.normal.shift());
        if (!job) return;
        if (job.build) {
          await this.readTogether(job);
          continue;
        }
        try {
          job.resolve(await this.exchange(job));
        } catch (e) {
          job.reject(e as Error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Sends `first` and every read queued right behind it that fits in the same packet. */
  private async readTogether(first: Job): Promise<void> {
    const batch: Job[] = [];
    const bases: number[] = [];
    const bytecodes: number[] = [];
    let globals = 0;
    for (let job: Job | undefined = first; job; job = this.normal[0]) {
      let bc: number[];
      try {
        // Past the reply buffer the builder cannot even address its bytes (GV is range checked): same as not fitting.
        if (globals + job.globals > MAX_GLOBALS) throw new RangeError("reply buffer full");
        bc = job.build!(globals);
        if (7 + bytecodes.length + bc.length > MAX_MESSAGE) throw new RangeError("packet full");
      } catch (e) {
        if (batch.length) break; // it opens the next packet
        if (job !== first) this.normal.shift();
        job.reject(e instanceof RangeError ? new Ev3Error("bad_param", e.message) : (e as Error));
        return;
      }
      if (job !== first) this.normal.shift();
      batch.push(job);
      bases.push(globals);
      bytecodes.push(...bc);
      globals += job.globals;
      if (job.alone || !this.normal[0]?.build || this.normal[0].alone) break;
    }
    let reply: Uint8Array;
    try {
      reply = await this.exchange({ ...first, bytecodes, globals });
    } catch (e) {
      if (batch.length > 1 && e instanceof Ev3Error && e.code === "brick_error") {
        // One of them is at fault, and the brick does not say which: each goes again, alone, ahead of the queue.
        for (const job of batch) job.alone = true;
        this.normal.unshift(...batch);
        return;
      }
      for (const job of batch) job.reject(e as Error);
      return;
    }
    batch.forEach((job, i) => job.resolve(reply.subarray(bases[i], bases[i] + job.globals)));
  }

  private async exchange(job: Job): Promise<Uint8Array> {
    this.counter = (this.counter % 0xffff) + 1; // 1..65535, never 0
    const counter = this.counter;
    const packet = frame(job.late ? job.late() : job.bytecodes, { counter, globals: job.globals, reply: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Ev3Error(
              "no_reply",
              `the brick did not reply within ${job.timeoutMs} ms (counter ${counter})`,
              "check the USB cable and that the brick is on, then call stop()",
            ),
          ),
        job.timeoutMs,
      );
    });
    let raw: Uint8Array;
    this.packets++;
    const t0 = this.now();
    try {
      const sent = this.transport.send(packet);
      sent.catch(() => {}); // a late failure after the timeout must not become an unhandled rejection
      raw = await Promise.race([sent, timeout]);
    } catch (e) {
      if (e instanceof Ev3Error) throw e;
      throw new Ev3Error("transport", `transport failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (job.timeoutMs === this.timeoutMs) {
      const ms = this.now() - t0;
      this.rtt = this.rtt === null ? ms : this.rtt + 0.25 * (ms - this.rtt);
    }
    let reply;
    try {
      reply = decodeReply(raw);
    } catch (e) {
      throw new Ev3Error("bad_reply", (e as Error).message);
    }
    if (reply.counter !== counter)
      throw new Ev3Error("bad_reply", `reply counter ${reply.counter} does not match command ${counter}`);
    if (!reply.ok) throw new Ev3Error("brick_error", `the brick rejected the command (counter ${counter})`);
    if (reply.globals.length < job.globals) {
      throw new Ev3Error("bad_reply", `reply has ${reply.globals.length} bytes, expected ${job.globals}`);
    }
    return reply.globals.subarray(0, job.globals);
  }
}
