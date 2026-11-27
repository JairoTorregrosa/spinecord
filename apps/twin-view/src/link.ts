// The one socket to the spinecord process. Its states: connecting → open → (closed → connecting …). It joins
// again by itself with a growing wait; a socket that stays open but goes silent (the laptop slept, the process
// hangs) is closed by the watchdog and joined again, so the page never shows a frozen robot as live. Every
// request gets its reply, or a refusal of its own when the socket closes first: nothing waits for ever.
import type { PageMessage, RefusalCode, ServerMessage } from "./messages";

export type LinkState = "connecting" | "open" | "closed";
export type Reply = { ok: true } | { ok: false; code: RefusalCode | "offline"; error: string };
/** Distributes PageMessage over its union, so a literal of one action type-checks without `req`. */
type Action<M = PageMessage> = M extends PageMessage ? Omit<M, "req"> : never;

/** The process sends state about 30 times a second: this long without a message means it is gone. */
const SILENCE_MS = 3000;

export class Link {
  state: LinkState = "connecting";
  /** When the socket last closed, for the page's "since" (ms, performance.now()). */
  closedAt = 0;
  private ws: WebSocket | null = null;
  private retryMs = 500;
  private req = 0;
  private lastMessage = 0;
  private readonly pending = new Map<number, (r: Reply) => void>();

  constructor(
    private readonly url: string,
    private readonly onMessage: (m: ServerMessage) => void,
    private readonly onState: (s: LinkState) => void,
  ) {
    let checked = performance.now();
    setInterval(() => {
      const now = performance.now();
      // this check itself came late: the page was frozen (a heavy frame, a resize, sleep), not the process
      // silent; the messages queued meanwhile have not been read yet, so the silence counts from now
      if (now - checked > 1500) this.lastMessage = Math.max(this.lastMessage, now);
      checked = now;
      if (this.state === "open" && now - this.lastMessage > SILENCE_MS) this.ws?.close();
    }, 500);
    // back from sleep or from another tab: try at once rather than after the wait that was growing meanwhile
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.state === "closed") this.connect();
    });
    this.connect();
  }

  /** Sends one action; resolves with its reply, or with `offline` when there is no socket or it closes first. */
  request(m: Action): Promise<Reply> {
    if (this.state !== "open" || !this.ws)
      return Promise.resolve({ ok: false, code: "offline", error: "no connection to spinecord" });
    const req = ++this.req;
    this.ws.send(JSON.stringify({ ...m, req }));
    return new Promise((resolve) => this.pending.set(req, resolve));
  }

  private timer: ReturnType<typeof setTimeout> | null = null;
  private connect(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) return;
    this.set("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 500;
      this.lastMessage = performance.now();
      this.set("open");
    };
    ws.onmessage = (ev) => {
      this.lastMessage = performance.now();
      const m = JSON.parse(String(ev.data)) as ServerMessage;
      if (m.t === "reply") {
        const done = this.pending.get(m.req);
        this.pending.delete(m.req);
        done?.(m.ok ? { ok: true } : { ok: false, code: m.code, error: m.error });
        return;
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      this.ws = null;
      for (const done of this.pending.values())
        done({ ok: false, code: "offline", error: "the connection closed before the reply" });
      this.pending.clear();
      this.closedAt = performance.now();
      this.set("closed");
      this.timer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(4000, this.retryMs * 1.6);
    };
  }

  private set(s: LinkState): void {
    if (s === this.state) return;
    this.state = s;
    this.onState(s);
  }
}
