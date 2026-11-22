// The process's end of the stock EV3 link: an HTTP + WebSocket server on 127.0.0.1 that serves the bridge page
// (apps/robot-page/bridge.html) and turns its socket into a driver-ev3 `Transport`. The page moves bytes between
// the socket and WebHID; the runtime and the real Ev3Provider run in this process, so nothing on the path of an
// `until` watch depends on a browser timer.
// Bound to 127.0.0.1 by name: nothing listens on the network (and Windows shows no firewall prompt).
import { CLOSE_TAKEN } from "../../robot-page/src/bridge";
import { TransportError, type Transport } from "../../../packages/driver-ev3/transport";

export interface BridgePageFiles {
  html: string;
  js: string;
}
export interface BridgeEvents {
  /** The page has an EV3 open: `transport` reaches it until onGone. */
  onDevice: (transport: Transport, info: { name: string; report_bytes: number }) => void;
  /** The EV3, the page or its socket went away. */
  onGone: (why: string) => void;
  /** Anything else the page says (a measurement harness reports through it). */
  onText?: (msg: Record<string, unknown>) => void;
}
export interface BridgeServer {
  url: string;
  port: number;
  /** True while a page holds the socket. */
  connected(): boolean;
  stop(): void;
}

interface Waiter {
  counter: number;
  resolve: (d: Uint8Array) => void;
  reject: (e: Error) => void;
}
interface Socket {
  send(data: string | Uint8Array): unknown;
  close(code?: number, reason?: string): void;
}

/** One exchange at a time, matched by the packet counter, like WebHIDTransport: only the wire differs. */
class SocketTransport implements Transport {
  private waiter: Waiter | null = null;
  private closed: string | null = null;
  constructor(
    private readonly socket: Socket,
    private readonly reportBytes: number,
  ) {}

  send(bytes: Uint8Array): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new TransportError("closed", this.closed));
    if (bytes.length < 4) return Promise.reject(new TransportError("bad_packet", "packet too short"));
    if (bytes.length > this.reportBytes)
      return Promise.reject(
        new TransportError(
          "too_long",
          `packet of ${bytes.length} bytes does not fit the ${this.reportBytes}-byte report`,
        ),
      );
    const counter = bytes[2]! | (bytes[3]! << 8);
    // a new send supersedes a reply nobody collected (its caller timed out)
    this.waiter?.reject(new TransportError("superseded", "a newer command was sent before this reply arrived"));
    const reply = new Promise<Uint8Array>((resolve, reject) => {
      this.waiter = { counter, resolve, reject };
    });
    reply.catch(() => {});
    this.socket.send(bytes);
    return reply;
  }
  /** One input report from the page. */
  receive(raw: Uint8Array): void {
    if (raw.length < 5) return;
    const len = raw[0]! | (raw[1]! << 8);
    const counter = raw[2]! | (raw[3]! << 8);
    const w = this.waiter;
    // a late reply to a command that already timed out carries another counter
    if (!w || w.counter !== counter) return;
    this.waiter = null;
    if (len + 2 > raw.length)
      return w.reject(
        new TransportError("bad_reply", `reply length field ${len} exceeds the ${raw.length}-byte report`),
      );
    w.resolve(raw.slice(0, len + 2));
  }
  end(why: string): void {
    if (this.closed) return;
    this.closed = why;
    this.waiter?.reject(new TransportError("closed", why));
    this.waiter = null;
  }
}

/** Starts the server. Throws when the port cannot be bound (another process, or another spinecord, holds it). */
export function serveBridge(page: BridgePageFiles, port: number, events: BridgeEvents): BridgeServer {
  let current: { socket: Socket; transport: SocketTransport | null } | null = null;
  const origins = (p: number) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`];
  const gone = (why: string) => {
    if (!current?.transport) return;
    current.transport.end(why);
    current.transport = null;
    events.onGone(why);
  };
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/hid") {
          // only the page this server serves may take the socket: any site a browser has open can reach 127.0.0.1
          const origin = req.headers.get("origin");
          if (!origin || !origins(srv.port ?? port).includes(origin))
            return new Response("forbidden: this socket is for the page served here", { status: 403 });
          return srv.upgrade(req, { data: undefined })
            ? undefined
            : new Response("expected a WebSocket upgrade", { status: 426 });
        }
        const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
        if (url.pathname === "/")
          return new Response(page.html, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
        if (url.pathname === "/bridge.js")
          return new Response(page.js, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8" } });
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          // refused after the upgrade, so the page receives the code and the reason
          if (current) return ws.close(CLOSE_TAKEN, "another tab already holds the robot");
          current = { socket: ws, transport: null };
        },
        message(ws, data) {
          if (current?.socket !== ws) return;
          if (typeof data !== "string") return void current.transport?.receive(new Uint8Array(data));
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(data) as Record<string, unknown>;
          } catch {
            return ws.close(4000, "bad message: not JSON");
          }
          if (msg.t === "device") {
            const report_bytes = msg.report_bytes;
            if (typeof report_bytes !== "number" || !(report_bytes >= 16))
              return ws.close(4000, "bad message: device.report_bytes");
            gone("the page opened another EV3");
            current.transport = new SocketTransport(ws, report_bytes);
            events.onDevice(current.transport, { name: String(msg.name ?? ""), report_bytes });
          } else if (msg.t === "gone") gone(String(msg.why ?? "the page has no EV3 open"));
          else if (msg.t === "error") gone(`the page could not send a packet: ${String(msg.message ?? "")}`);
          else events.onText?.(msg);
        },
        close(ws) {
          if (current?.socket !== ws) return;
          gone("the page was closed or lost its connection to this process");
          current = null;
        },
      },
    });
  } catch (e) {
    throw new Error(
      `cannot listen on 127.0.0.1:${port} (${(e as Error).message}). Another process holds that port, often another spinecord: close it, or pick another port with --port.`,
      { cause: e },
    );
  }
  const bound = server.port ?? port;
  return {
    url: `http://127.0.0.1:${bound}/`,
    port: bound,
    connected: () => current !== null,
    stop: () => {
      gone("the process is ending");
      void server.stop(true);
    },
  };
}
