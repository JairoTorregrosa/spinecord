// The page listener (CONTRACT §2.4, §6): an HTTP + WebSocket server on 127.0.0.1 that peripheral pages join, the
// pairing token, the Host and Origin checks, and the page state machine of every page with its ping timer.
//   announced → active ↔ asleep → gone        (PAGE_TRANSITIONS, asserted on every transition)
// The hub of each robot (packages/page-hub) holds the pages' devices and answers the runtime; this file decides
// which state each page is in and tells the hub. Nothing of it listens beyond loopback.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { PageHub, PageLink } from "../../../packages/page-hub/hub";
import { META_PLACEHOLDER, type PeripheralPageFiles } from "../../peripheral-page/page-build";
import {
  PAGE_CLOSE,
  PAGE_TRANSITIONS,
  type PageState,
  type PageToServer,
  type ServerToPage,
} from "../../../packages/protocol/types";
import {
  PAGE_CAPS,
  pageNameIssue,
  validatePageManifest,
  validatePageUnavailable,
} from "../../../packages/protocol/validate";

export const DEFAULT_PAGE_PORT = 8768;
/** The times of the page state machine (CONTRACT §1, §4). Tests shorten them. */
export const PAGE_TIMES = {
  /** A page that is not watched is pinged this often. */
  ping_ms: 1000,
  /** A page whose pushed channels are being read is pinged this often. */
  watched_ping_ms: 100,
  /** A page silent this long is asleep (silence: PageLink.silentMs). */
  asleep_ms: 3000,
  /** A page whose socket closed is gone this long after, unless it joined again. */
  gone_ms: 30_000,
  /** A socket that sent no valid hello in this time is closed. */
  hello_ms: 3000,
  /** How often the state machine looks at its pages. */
  tick_ms: 25,
} as const;
export type PageTimes = { [K in keyof typeof PAGE_TIMES]: number };
export const MAX_PAGES = 8;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_MESSAGES_PER_S = 100;

/** One page as describe_robot lists it. */
export interface PageView {
  name: string;
  state: PageState;
  why?: string;
  devices: string[];
  unavailable: { kind: string; why: string }[];
  last_seen_ms: number;
}
export interface PagesServer {
  url: string;
  port: number;
  /** One sentence for a person: how to lend this robot a page's devices. Never holds the token. */
  join(robotId: string): string;
  /** The pages of a robot, gone ones included. */
  view(robotId: string): PageView[];
  stop(): void;
}
export interface PagesOptions {
  /** The page served at `/` and the files next to it (apps/peripheral-page). */
  page: PeripheralPageFiles;
  log: (ev: string, fields?: Record<string, unknown>) => void;
  times?: Partial<PageTimes>;
  /** Resolves when the robot's registry holds what its hub announced (the runtime scanned again). */
  scanned?: (robotId: string) => Promise<void>;
}

/** A page that joined, from its hello until the process ends. */
interface Page {
  robot: string;
  hub: PageHub;
  link: PageLink;
  socket: Ws | null;
  lastPingAt: number;
  goneAt: number | null; // when the socket closed: gone at goneAt + gone_ms
  devices: string[]; // ids, kept for the view of a page that is gone
}
interface Conn {
  page: Page | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
  window: { start: number; count: number };
}
interface Ws {
  data: Conn;
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

/** A WebSocket close reason is at most 123 bytes of UTF-8. */
const reason = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  return bytes.length <= 123 ? text : new TextDecoder().decode(bytes.slice(0, 120)).replace(/�+$/, "") + "...";
};

const TYPES = new Set(["hello", "devices", "res", "state", "pong", "down", "up", "paused", "resumed"]);

/** Starts the listener. Throws when the port cannot be bound. `hubs` are the robots that take pages, by id. */
export function servePages(hubs: Map<string, PageHub>, port: number, o: PagesOptions): PagesServer {
  const times: PageTimes = { ...PAGE_TIMES, ...o.times };
  const token = randomBytes(16).toString("base64url");
  const tokenBytes = Buffer.from(token);
  const pages: Page[] = [];
  const now = () => Date.now();
  let bound = port;
  const own = () => [`127.0.0.1:${bound}`, `localhost:${bound}`];
  const origins = () => own().map((h) => `http://${h}`);

  const to = (p: Page, next: PageState, why: string | null): void => {
    const from = p.link.state;
    if (from === next) {
      if (next !== "active") p.link.setState(next, why);
      return;
    }
    if (!PAGE_TRANSITIONS[from].includes(next))
      throw new Error(`page ${p.link.name} of ${p.robot}: illegal page transition ${from} → ${next} (${why})`);
    p.link.setState(next, why);
    o.log("page", {
      ts: new Date().toISOString(),
      robot_id: p.robot,
      name: p.link.name,
      from,
      to: next,
      why: why ?? (next === "active" ? "the page answered a ping" : null),
      kinds: p.link.devices.map((d) => d.kind),
    });
  };

  const send = (ws: Ws, msg: ServerToPage) => void ws.send(JSON.stringify(msg));
  const refuse = (ws: Ws, code: number, why: string) => ws.close(code, reason(why));

  function hello(ws: Ws, msg: Record<string, unknown>, size: number): void {
    const conn = ws.data;
    if (msg.t !== "hello" || msg.v !== 1)
      return refuse(ws, PAGE_CLOSE.bad_message, 'the first message must be {"t":"hello","v":1,...}');
    const given = typeof msg.token === "string" ? Buffer.from(msg.token) : Buffer.alloc(0);
    if (given.length !== tokenBytes.length || !timingSafeEqual(given, tokenBytes))
      return refuse(ws, PAGE_CLOSE.bad_token, "bad or missing token: open the page this server serves");
    let robot = msg.robot;
    if (robot === undefined && hubs.size === 1) robot = [...hubs.keys()][0];
    const hub = typeof robot === "string" ? hubs.get(robot) : undefined;
    if (!hub || typeof robot !== "string")
      return refuse(
        ws,
        PAGE_CLOSE.unknown_robot,
        `unknown robot; robots that take pages: ${[...hubs.keys()].join(", ")}`,
      );
    const name = msg.name;
    const old =
      typeof name === "string"
        ? pages.find((p) => p.robot === robot && p.link.name === name && p.link.state !== "gone")
        : undefined;
    // a page whose socket closed gives its name to the one that joins under it
    const taken = pages
      .filter((p) => p.robot === robot && p.link.state !== "gone" && p.socket !== null)
      .map((p) => p.link.name);
    const nameIssue = pageNameIssue(name, taken);
    if (nameIssue)
      return refuse(ws, taken.includes(name as string) ? PAGE_CLOSE.name_taken : PAGE_CLOSE.bad_message, nameIssue);
    if (size > PAGE_CAPS.max_hello_bytes)
      return refuse(
        ws,
        PAGE_CLOSE.manifest_refused,
        `the hello is ${size} bytes; at most ${PAGE_CAPS.max_hello_bytes}`,
      );
    const issues = [...validatePageManifest(msg.devices), ...validatePageUnavailable(msg.unavailable)];
    if (issues.length) return refuse(ws, PAGE_CLOSE.manifest_refused, `${issues[0]!.path}: ${issues[0]!.message}`);
    if (!old && pages.filter((p) => p.link.state !== "gone").length >= MAX_PAGES)
      return refuse(ws, PAGE_CLOSE.too_many, `at most ${MAX_PAGES} pages per process`);

    const devices = msg.devices as Parameters<PageHub["join"]>[2];
    const unavailable = (msg.unavailable ?? []) as Parameters<PageHub["join"]>[3];
    const socket = { send: (m: ServerToPage) => send(ws, m) };
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    let page: Page;
    if (old) {
      old.hub.join(old.link.name, socket, devices, unavailable);
      old.socket = ws;
      old.goneAt = null;
      old.link.paused = false;
      to(old, "announced", "the page joined again");
      page = old;
    } else {
      const link = hub.join(name as string, socket, devices, unavailable);
      page = { robot, hub, link, socket: ws, lastPingAt: -Infinity, goneAt: null, devices: [] };
      pages.push(page);
      o.log("page", {
        ts: new Date().toISOString(),
        robot_id: robot,
        name,
        from: null,
        to: "announced",
        why: "hello accepted",
        kinds: devices.map((d) => d.kind),
      });
    }
    page.devices = page.link.specs().map((d) => d.id);
    conn.page = page;
    const welcome = () => {
      if (page.socket !== ws) return;
      send(ws, { t: "welcome", name: page.link.name, robot: robot as string });
      page.link.ping();
      page.lastPingAt = now();
    };
    // welcome once the robot's registry holds the page's devices
    void (o.scanned?.(robot) ?? Promise.resolve()).then(welcome, welcome);
  }

  function message(ws: Ws, raw: string | Buffer): void {
    const conn = ws.data;
    const t = now();
    if (t - conn.window.start >= 1000) conn.window = { start: t, count: 0 };
    if (++conn.window.count > MAX_MESSAGES_PER_S)
      return refuse(ws, PAGE_CLOSE.bad_message, `more than ${MAX_MESSAGES_PER_S} messages in one second`);
    const p = conn.page;
    if (typeof raw !== "string") {
      if (!p) return refuse(ws, PAGE_CLOSE.bad_message, "the first message must be the hello");
      const bad = p.link.binary(new Uint8Array(raw));
      return bad ? refuse(ws, PAGE_CLOSE.bad_message, bad) : undefined;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return refuse(ws, PAGE_CLOSE.bad_message, "bad message: not JSON");
    }
    if (typeof msg !== "object" || msg === null || !TYPES.has(msg.t as string))
      return refuse(ws, PAGE_CLOSE.bad_message, "bad message: unknown type");
    if (!p) return hello(ws, msg, raw.length);
    if (p.socket !== ws) return;
    switch (msg.t) {
      case "hello":
        return refuse(ws, PAGE_CLOSE.bad_message, "a second hello");
      case "devices": {
        const issues = [...validatePageManifest(msg.devices), ...validatePageUnavailable(msg.unavailable)];
        if (issues.length) return refuse(ws, PAGE_CLOSE.manifest_refused, `${issues[0]!.path}: ${issues[0]!.message}`);
        p.link.setDevices(
          msg.devices as Parameters<PageHub["join"]>[2],
          (msg.unavailable ?? []) as Parameters<PageHub["join"]>[3],
        );
        p.devices = p.link.specs().map((d) => d.id);
        return;
      }
      case "paused":
        p.link.paused = true;
        return to(
          p,
          "asleep",
          `was paused by the person at the page${typeof msg.why === "string" ? ` (${msg.why.slice(0, 120)})` : ""}`,
        );
      case "resumed":
        p.link.paused = false;
        if (p.link.silentMs() < times.asleep_ms) to(p, "active", "the person resumed lending");
        return;
      case "pong": {
        const bad = p.link.receive(msg as PageToServer);
        if (bad) return refuse(ws, PAGE_CLOSE.bad_message, bad);
        if (!p.link.paused && (p.link.state === "announced" || p.link.state === "asleep")) to(p, "active", null);
        return;
      }
      default: {
        const bad = p.link.receive(msg as PageToServer);
        if (bad) refuse(ws, PAGE_CLOSE.bad_message, bad);
      }
    }
  }

  function closed(ws: Ws): void {
    const conn = ws.data;
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    const p = conn.page;
    if (!p || p.socket !== ws) return;
    p.socket = null;
    p.goneAt = now();
    p.link.closed();
    to(p, "asleep", "closed its connection");
  }

  // The page machine's clock: pings, sleep, gone. A browser's timers are never on this path.
  const tick = setInterval(() => {
    const t = now();
    for (const p of pages) {
      const state = p.link.state;
      if (state === "gone") continue;
      if (p.socket === null) {
        if (p.goneAt !== null && t - p.goneAt >= times.gone_ms) {
          p.hub.remove(p.link.name);
          to(p, "gone", `its connection closed and it did not join again within ${times.gone_ms} ms`);
        }
        continue;
      }
      if (state === "announced" && p.lastPingAt === -Infinity) continue; // the welcome sends the first ping
      const every = p.link.watched() ? times.watched_ping_ms : times.ping_ms;
      if (t - p.lastPingAt >= every) {
        p.link.ping();
        p.lastPingAt = t;
      }
      if ((state === "active" || state === "announced") && p.link.silentMs() >= times.asleep_ms)
        to(p, "asleep", `did not answer a ping for ${times.asleep_ms} ms`);
    }
  }, times.tick_ms);
  (tick as { unref?: () => void }).unref?.();

  let server: ReturnType<typeof Bun.serve<Conn, never>>;
  try {
    server = Bun.serve<Conn, never>({
      port,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        // whoever reaches this listener with a loopback Host is on this computer; a name made to resolve here is not
        if (!own().includes(req.headers.get("host") ?? ""))
          return new Response("forbidden: this listener answers only to its loopback name", { status: 403 });
        const url = new URL(req.url);
        if (url.pathname === "/page") {
          const origin = req.headers.get("origin");
          if (!origin || !origins().includes(origin))
            return new Response("forbidden: this socket is for the page served here", { status: 403 });
          const conn: Conn = { page: null, helloTimer: null, window: { start: now(), count: 0 } };
          return srv.upgrade(req, { data: conn })
            ? undefined
            : new Response("expected a WebSocket upgrade", { status: 426 });
        }
        if (url.pathname === "/")
          return new Response(pageHtml(o.page.html, token, [...hubs.keys()]), {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              "content-security-policy": "default-src 'self'; connect-src 'self'",
              "permissions-policy":
                "camera=(self), microphone=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)",
            },
          });
        const file = Object.hasOwn(o.page.files, url.pathname.slice(1))
          ? o.page.files[url.pathname.slice(1)]
          : undefined;
        if (file)
          return new Response(file.body, {
            headers: { "content-type": file.type, "cache-control": "no-store", "x-content-type-options": "nosniff" },
          });
        return new Response("not found", { status: 404 });
      },
      websocket: {
        maxPayloadLength: MAX_MESSAGE_BYTES,
        open(ws) {
          ws.data.helloTimer = setTimeout(() => {
            if (!ws.data.page) refuse(ws, PAGE_CLOSE.bad_message, `no valid hello within ${times.hello_ms} ms`);
          }, times.hello_ms);
        },
        message: (ws, data) => message(ws, data),
        close: (ws) => closed(ws),
      },
    });
  } catch (e) {
    clearInterval(tick);
    throw new Error(
      `cannot listen on 127.0.0.1:${port} for pages (${(e as Error).message}). Another process holds that port, often another spinecord: close it, or pick another port with --page-port.`,
      { cause: e },
    );
  }
  bound = server.port ?? port;
  const url = `http://127.0.0.1:${bound}/`;
  return {
    url,
    port: bound,
    join: (robotId) =>
      `On this computer open ${url} in Chrome or Edge and lend robot ${robotId} the devices of that page.`,
    view: (robotId) =>
      pages
        .filter((p) => p.robot === robotId)
        .map((p) => ({
          name: p.link.name,
          state: p.link.state,
          ...(p.link.why ? { why: p.link.why } : {}),
          devices: p.link.state === "gone" ? [] : p.devices,
          unavailable: p.link.unavailable,
          last_seen_ms: Math.max(0, now() - p.link.seenAt),
        })),
    stop() {
      clearInterval(tick);
      for (const p of pages) if (p.socket) p.socket.close(1001, "the process is ending");
      void server.stop(true);
    },
  };
}

/** The page served at `/`. It carries the token: whoever reaches this loopback listener is on this computer. */
function pageHtml(template: string, token: string, robots: string[]): string {
  return template.replace(
    META_PLACEHOLDER,
    `<meta name="spinecord-token" content="${token}">\n    <meta name="spinecord-robots" content="${robots.join(" ")}">`,
  );
}
