// Time source injected into the runtime and the relay client, so limits (1500 ms, 3 s, max_program_ms)
// are testable without waiting. `sleep` resolves early (never rejects) when its signal aborts.
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      signal?.addEventListener("abort", done, { once: true });
    }),
};

// The macrotask the virtual clock advances on. Not a timer: setTimeout(0) waits for the OS timer tick (about
// 15 ms on Windows), so a test with hundreds of virtual sleeps would take seconds of real time there.
const macrotask: (fn: () => void) => void =
  typeof setImmediate === "function"
    ? (fn) => void setImmediate(fn)
    : (fn) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => {
          ch.port1.close();
          fn();
        };
        ch.port2.postMessage(null);
      };

// Virtual clock for tests: time only moves when someone sleeps. One macrotask fires the earliest timer,
// so every promise chain settles before time advances again (deterministic, no real waiting).
export class FakeClock implements Clock {
  private t: number;
  private seq = 0;
  private timers: { at: number; seq: number; fire: () => void }[] = [];
  private pumping = false;
  constructor(start = 1_000_000) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = {
        at: this.t + Math.max(0, ms),
        seq: this.seq++,
        fire: () => {
          signal?.removeEventListener("abort", cancel);
          resolve();
        },
      };
      const cancel = () => {
        this.timers = this.timers.filter((x) => x !== timer);
        resolve();
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.timers.push(timer);
      this.pump();
    });
  }
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    macrotask(() => {
      this.pumping = false;
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers.shift();
      if (next) {
        this.t = Math.max(this.t, next.at);
        next.fire();
      }
      if (this.timers.length) this.pump();
    });
  }
}

export function linkAbort(parent: AbortSignal, child: AbortController): void {
  if (parent.aborted) child.abort();
  else parent.addEventListener("abort", () => child.abort(), { once: true });
}
