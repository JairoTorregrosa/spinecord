// The page listeners (CONTRACT §2.4, §6): HTTP + WebSocket servers that peripheral pages join, the pairing token,
// the Host and Origin checks, the limit on wrong tokens, and the page state machine of every page with its ping
// timer.
//   announced → active ↔ asleep → gone        (PAGE_TRANSITIONS, asserted on every transition)
// The hub of each robot (packages/page-hub) holds the pages' devices and answers the runtime; this file decides
// which state each page is in and tells the hub. Three listeners share the pages, the token and the machine:
//   loopback  127.0.0.1:<port>, always: the page with the token in it, and the pairing console
//   lan       <interface address>:<port + 1>, TLS, with --lan only: the page without the token, and the socket
//   tunnel    127.0.0.1:<port + 2>, with --page-origin only: the same as lan, for the person's tunnel program
// Without --lan nothing of it listens beyond loopback. With --page-ext every listener also serves the `.js` files of
// that folder at /ext/<name>, and the page it serves loads each after its kit.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync } from "node:fs";
import { join as joinPath } from "node:path";
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
import type { LanSetup } from "./lan";
import { qrEncode, qrSvg, qrText } from "./qr";

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
  /** Wrong tokens are counted per listener and remote address over this window... */
  attempt_window_ms: 60_000,
  /** ...and an address that sent MAX_WRONG_TOKENS of them is refused this long. */
  lockout_ms: 60_000,
} as const;
export type PageTimes = { [K in keyof typeof PAGE_TIMES]: number };
export const MAX_PAGES = 8;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_MESSAGES_PER_S = 100;
export const MAX_WRONG_TOKENS = 5;

/** One page as describe_robot lists it. */
export interface PageView {
  name: string;
  state: PageState;
  why?: string;
  devices: string[];
  unavailable: { kind: string; why: string }[];
  last_seen_ms: number;
}
/** A link a page joins by: it carries the token in its fragment, so it goes to the person, never to a log. */
export interface JoinLink {
  via: "lan" | "tunnel";
  robot: string;
  url: string;
}
export interface PagesServer {
  url: string;
  port: number;
  /** The pairing console, on loopback. */
  consoleUrl: string;
  /** `https://<name>:<port>/` of the network listener, without the token; null without --lan. */
  lanUrl: string | null;
  /** The tunnel listener's address on this computer, for the tunnel program; null without --page-origin. */
  tunnelUrl: string | null;
  /** The links with the token, per robot and listener: for stderr and the console, never for a log or a tool. */
  links(): JoinLink[];
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
  /** `--lan`: the network listener's address, name and certificate. */
  lan?: LanSetup;
  /** `--page-origin`: the origin of the person's tunnel. */
  origin?: string;
  /** `--page-ext`: an absolute folder whose `.js` files are the page's extensions. */
  ext?: string;
}

/** A name an extension file may have: no separator, no encoding, nothing a path could climb out with. */
const EXT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*\.js$/;
/**
 * The extension files: the `.js` files directly in the folder, listed at each request so an edit shows on a reload.
 * A request is answered only with a name of this list, never with a path joined from the request.
 */
export function extFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && EXT_NAME.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** What a listener answers to, and what it serves. */
interface Listener {
  name: "loopback" | "lan" | "tunnel";
  /** `Host` values it answers. */
  hosts: () => string[];
  /** `Origin` values whose socket it accepts. */
  origins: () => string[];
  /** Only the loopback listener writes the token into its page and serves the console. */
  loopback: boolean;
  /** Wrong tokens per remote address. */
  attempts: Map<string, { wrong: number[]; refusedUntil: number }>;
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
  listener: Listener;
  /** The remote address of the socket. */
  peer: string;
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
  let lanPort = 0;
  let tunnelPort = 0;
  const own = () => [`127.0.0.1:${bound}`, `localhost:${bound}`];
  const loopback: Listener = {
    name: "loopback",
    hosts: own,
    origins: () => own().map((h) => `http://${h}`),
    loopback: true,
    attempts: new Map(),
  };
  // the authority a browser sends: the name in lowercase, and no port when it is the default one of https
  const lanHost = () => (lanPort === 443 ? o.lan!.host.toLowerCase() : `${o.lan!.host.toLowerCase()}:${lanPort}`);
  const lan: Listener | null = o.lan
    ? {
        name: "lan",
        hosts: () => [lanHost()],
        origins: () => [`https://${lanHost()}`],
        loopback: false,
        attempts: new Map(),
      }
    : null;
  const tunnelOrigin = o.origin ? new URL(o.origin) : null;
  const tunnel: Listener | null = tunnelOrigin
    ? {
        name: "tunnel",
        hosts: () => [tunnelOrigin.host],
        origins: () => [tunnelOrigin.origin],
        loopback: false,
        attempts: new Map(),
      }
    : null;

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
    const t = now();
    const tries = conn.listener.attempts.get(conn.peer) ?? { wrong: [], refusedUntil: 0 };
    if (tries.refusedUntil > t)
      return refuse(
        ws,
        PAGE_CLOSE.too_many,
        `too many wrong tokens from this address: try again in ${Math.ceil((tries.refusedUntil - t) / 1000)} s`,
      );
    const given = typeof msg.token === "string" ? Buffer.from(msg.token) : Buffer.alloc(0);
    if (given.length !== tokenBytes.length || !timingSafeEqual(given, tokenBytes)) {
      tries.wrong = tries.wrong.filter((at) => t - at < times.attempt_window_ms);
      tries.wrong.push(t);
      if (tries.wrong.length >= MAX_WRONG_TOKENS) {
        tries.refusedUntil = t + times.lockout_ms;
        tries.wrong = [];
      }
      conn.listener.attempts.set(conn.peer, tries);
      return refuse(
        ws,
        PAGE_CLOSE.bad_token,
        conn.listener.loopback
          ? "bad or missing token: open the page this server serves"
          : "bad or missing token: open the join link the server shows (its QR code), not the bare address",
      );
    }
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
    // the token is checked above: a hello under a page's name is that page joining again, and it takes its place,
    // whether or not its old socket was seen to close (a phone drops one without a close frame)
    const nameIssue = pageNameIssue(name);
    if (nameIssue) return refuse(ws, PAGE_CLOSE.bad_message, nameIssue);
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
    if (old?.socket) {
      const prev = old.socket;
      old.socket = null;
      old.link.closed();
      to(old, "asleep", "a page joined under its name with the token, in place of its socket");
      refuse(prev, PAGE_CLOSE.replaced, `a page joined under the name ${old.link.name}; this one does not join again`);
    }
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
    for (const l of [loopback, lan, tunnel])
      for (const [peer, a] of l?.attempts ?? [])
        if (a.refusedUntil <= t && a.wrong.every((at) => t - at >= times.attempt_window_ms)) l!.attempts.delete(peer);
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

  const pageHeaders = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; connect-src 'self'",
    "permissions-policy":
      "camera=(self), microphone=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)",
  };
  const links = (): JoinLink[] =>
    [...hubs.keys()].flatMap((robot) => {
      const out: JoinLink[] = [];
      const fragment = `#t=${token}&robot=${encodeURIComponent(robot)}`;
      if (lan) out.push({ via: "lan", robot, url: `https://${lanHost()}/${fragment}` });
      if (tunnelOrigin) out.push({ via: "tunnel", robot, url: `${tunnelOrigin.origin}/${fragment}` });
      return out;
    });

  /** One listener's answers: its Host and Origin rules, what it serves, and the socket. */
  const handler =
    (l: Listener) =>
    (
      req: Request,
      srv: { upgrade(req: Request, o: { data: Conn }): boolean; requestIP(req: Request): { address: string } | null },
    ) => {
      // a Host of another name is a page of another site whose name was made to resolve here
      if (!l.hosts().includes(req.headers.get("host") ?? ""))
        return new Response(`forbidden: this listener answers only to ${l.hosts().join(" and ")}`, { status: 403 });
      const url = new URL(req.url);
      if (url.pathname === "/page") {
        const origin = req.headers.get("origin");
        if (!origin || !l.origins().includes(origin))
          return new Response("forbidden: this socket is for the page served here", { status: 403 });
        const conn: Conn = {
          listener: l,
          peer: srv.requestIP(req)?.address ?? "unknown",
          page: null,
          helloTimer: null,
          window: { start: now(), count: 0 },
        };
        return srv.upgrade(req, { data: conn })
          ? undefined
          : new Response("expected a WebSocket upgrade", { status: 426 });
      }
      if (url.pathname === "/")
        return new Response(
          pageHtml(o.page.html, l.loopback ? token : null, [...hubs.keys()], o.ext ? extFiles(o.ext) : []),
          { headers: pageHeaders },
        );
      if (url.pathname.startsWith("/ext/")) {
        const name = url.pathname.slice("/ext/".length);
        if (!o.ext || !extFiles(o.ext).includes(name)) return new Response("not found", { status: 404 });
        return new Response(Bun.file(joinPath(o.ext, name)), {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }
      if (url.pathname === "/console" && l.loopback)
        return new Response(
          consoleHtml(links(), (id) => view(id), o.lan ?? null),
          {
            headers: { ...pageHeaders, "content-security-policy": "default-src 'self'" },
          },
        );
      const file = Object.hasOwn(o.page.files, url.pathname.slice(1)) ? o.page.files[url.pathname.slice(1)] : undefined;
      if (file)
        return new Response(file.body, {
          headers: { "content-type": file.type, "cache-control": "no-store", "x-content-type-options": "nosniff" },
        });
      return new Response("not found", { status: 404 });
    };
  const websocket = {
    maxPayloadLength: MAX_MESSAGE_BYTES,
    open(ws: Ws) {
      ws.data.helloTimer = setTimeout(() => {
        if (!ws.data.page) refuse(ws, PAGE_CLOSE.bad_message, `no valid hello within ${times.hello_ms} ms`);
      }, times.hello_ms);
    },
    message: (ws: Ws, data: string | Buffer) => message(ws, data),
    close: (ws: Ws) => closed(ws),
  };
  const servers: { stop(close?: boolean): unknown }[] = [];
  const bind = (l: Listener, hostname: string, at: number, tls?: { cert: string; key: string }) => {
    const server = Bun.serve<Conn, never>({
      port: at,
      hostname,
      ...(tls ? { tls } : {}),
      fetch: handler(l),
      websocket,
    });
    servers.push(server);
    return server.port ?? at;
  };
  const view = (robotId: string): PageView[] =>
    pages
      .filter((p) => p.robot === robotId)
      .map((p) => ({
        name: p.link.name,
        state: p.link.state,
        ...(p.link.why ? { why: p.link.why } : {}),
        devices: p.link.state === "gone" ? [] : p.devices,
        unavailable: p.link.unavailable,
        last_seen_ms: Math.max(0, now() - p.link.seenAt),
      }));
  const end = () => {
    clearInterval(tick);
    for (const s of servers) void s.stop(true);
  };

  try {
    bound = bind(loopback, "127.0.0.1", port);
  } catch (e) {
    end();
    throw new Error(
      `cannot listen on 127.0.0.1:${port} for pages (${(e as Error).message}). Another process holds that port, often another spinecord: close it, or pick another port with --page-port.`,
      { cause: e },
    );
  }
  const next = (k: number) => (port === 0 ? 0 : port + k);
  if (o.lan) {
    try {
      lanPort = bind(lan!, o.lan.address, next(1), { cert: o.lan.cert, key: o.lan.key });
    } catch (e) {
      end();
      throw new Error(
        `--lan: cannot listen on ${o.lan.address}:${next(1)} (${(e as Error).message}). Another process holds that port, or the address left this computer: pick another port with --page-port, or another interface with --lan-interface.`,
        { cause: e },
      );
    }
  }
  if (tunnel) {
    try {
      tunnelPort = bind(tunnel, "127.0.0.1", next(2));
    } catch (e) {
      end();
      throw new Error(
        `--page-origin: cannot listen on 127.0.0.1:${next(2)} for the tunnel (${(e as Error).message}); pick another port with --page-port.`,
        { cause: e },
      );
    }
  }
  const url = `http://127.0.0.1:${bound}/`;
  const consoleUrl = `${url}console`;
  const lanUrl = o.lan ? `https://${lanHost()}/` : null;
  return {
    url,
    port: bound,
    consoleUrl,
    lanUrl,
    tunnelUrl: tunnel ? `http://127.0.0.1:${tunnelPort}/` : null,
    links,
    join: (robotId) => {
      const here = `On this computer open ${url} in Chrome or Edge and lend robot ${robotId} the devices of that page.`;
      const other = [
        ...(lanUrl ? [`a phone on the same network joins at ${lanUrl}`] : []),
        ...(tunnelOrigin ? [`a phone anywhere joins through the tunnel at ${tunnelOrigin.origin}/`] : []),
      ];
      return other.length
        ? `${here} To add a phone: ${other.join("; ")}, with the link of the QR code at ${consoleUrl} (also on the server's stderr), which carries the pairing token.`
        : here;
    },
    view,
    stop() {
      for (const p of pages) if (p.socket) p.socket.close(1001, "the process is ending");
      end();
    },
  };
}

/**
 * The page served at `/`. On loopback it carries the token: whoever reaches this loopback listener is on this
 * computer. On the network and tunnel listeners it carries none: the page takes it from its link's fragment. The
 * extensions are module scripts after the page's own, so they run in that order, once `spinecord` exists.
 */
function pageHtml(template: string, token: string | null, robots: string[], ext: string[]): string {
  if (!template.includes("</body>")) throw new Error("page.html has no </body>");
  const scripts = ext.map((f) => `<script type="module" src="ext/${encodeURIComponent(f)}"></script>\n  `).join("");
  return template.replace("</body>", `${scripts}</body>`).replace(
    META_PLACEHOLDER,
    `${
      token === null
        ? ""
        : `<meta name="spinecord-token" content="${token}">
    `
    }<meta name="spinecord-robots" content="${robots.join(" ")}">`,
  );
}

const esc = (t: string): string =>
  t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The pairing console, on loopback only: the join links as QR codes, and the pages that joined. */
function consoleHtml(links: JoinLink[], view: (robot: string) => PageView[], lan: LanSetup | null): string {
  const robots = [...new Set(links.map((l) => l.robot))];
  const codes = links
    .map(
      (l) => `<section>
<h2>Robot ${esc(l.robot)}${l.via === "tunnel" ? " (through the tunnel)" : ""}</h2>
${qrSvg(qrEncode(l.url), 288)}
<p><a href="${esc(l.url)}">${esc(l.url)}</a></p>
</section>`,
    )
    .join("\n");
  const joined = robots
    .flatMap((r) =>
      view(r).map((p) => `<li>${esc(r)}: ${esc(p.name)}, ${p.state}${p.why ? ` (${esc(p.why)})` : ""}</li>`),
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>spinecord pairing</title>
</head>
<body>
<h1>Add a phone</h1>
${
  links.length === 0
    ? "<p>This server listens on this computer only. Start it with <code>--lan</code> so that a phone on the same network can join.</p>"
    : `<p>Point the phone's camera at a code and open the link. The link carries the pairing token of this start: share it only with phones you trust.</p>
${lan ? `<p>Name check: ${esc(lan.nameCheck.text)}.</p>` : ""}
${codes}`
}
<h2>Pages that joined</h2>
${joined ? `<ul>\n${joined}\n</ul>` : "<p>None yet. Reload this page to see new ones.</p>"}
</body>
</html>
`;
}

/** The join link and its QR code for a terminal, one block per link, for stderr. */
export function linksText(links: JoinLink[]): string {
  return links
    .map((l) => `robot ${l.robot}${l.via === "tunnel" ? " (tunnel)" : ""}: ${l.url}\n${qrText(qrEncode(l.url))}\n`)
    .join("\n");
}
