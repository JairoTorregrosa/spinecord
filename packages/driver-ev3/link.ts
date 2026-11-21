// Serial command queue over a Transport. The brick ignores a command that arrives
// while it is still handling the previous one, so: one command at a time, always
// with reply (type 0x00), matched by counter, and a timeout that rejects (fail loud).
import { decodeReply, frame } from "./encode";
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

interface Job {
  bytecodes: number[];
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
  readonly timeoutMs: number;

  constructor(
    private readonly transport: Transport,
    opts: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 1000;
    if (!(this.timeoutMs > 0)) throw new Ev3Error("bad_param", "timeoutMs must be > 0");
  }

  /** Queue a direct command; resolves with exactly `globals` reply bytes. */
  command(bytecodes: number[], globals = 0, opts: CommandOptions = {}): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const job: Job = {
        bytecodes,
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

  private async exchange(job: Job): Promise<Uint8Array> {
    this.counter = (this.counter % 0xffff) + 1; // 1..65535, never 0
    const counter = this.counter;
    const packet = frame(job.bytecodes, { counter, globals: job.globals, reply: true });
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
