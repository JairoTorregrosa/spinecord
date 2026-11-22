// MCP server and relay for robots.
//   /mcp         Streamable HTTP MCP (stateless). Authorization: Bearer <principal token>.
//   /ws/robot    a robot's runtime (CONTRACT §8). ?robot_id=<id> reaches the robot's Durable Object directly;
//                without it the worker reads robot_id from the hello frame and bridges the socket.
//   /ws/organ    an external device provider attached to a robot. Same addressing.
//   /api/*       admin HTTP API (CONTRACT §9)
//   /health      liveness, no auth
// One Durable Object per robot_id (src/robot-do.ts) owns sockets, state machines, queue and idempotency.

import { httpError, json, serveApi } from "./api.ts";
import { type Config, ConfigError, isToolPrincipal, loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { serveMcp } from "./mcp.ts";
import { CLOSE } from "./robot-do.ts";

export { RobotDO } from "./robot-do.ts";

function bearer(request: Request): string {
  const header = request.headers.get("Authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function toRobot(request: Request, url: URL, env: Env, role: "robot" | "organ", robot_id: string): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set("x-relay-role", role);
  headers.set("x-robot-id", robot_id);
  return env.ROBOT.get(env.ROBOT.idFromName(robot_id)).fetch(new Request(url, { headers }));
}

const closeCode = (code: number) => (code === 1000 || (code >= 3000 && code <= 4999) ? code : 1011);

/** No ?robot_id=: accept here, read robot_id from the hello frame, then pipe both ways to the robot's Durable Object. */
function bridge(request: Request, url: URL, env: Env, cfg: Config, role: "robot" | "organ"): Response {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  let upstream: WebSocket | null = null;
  let connecting = false;
  const early: (string | ArrayBuffer)[] = [];
  const end = (ws: WebSocket | null, code: number, reason: string) => {
    try {
      ws?.close(closeCode(code), reason.slice(0, 120));
    } catch {}
  };
  server.addEventListener("message", (ev) => {
    if (upstream) return upstream.send(ev.data);
    if (connecting) return void early.push(ev.data);
    let robot_id: unknown;
    try {
      const m = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data)) as {
        t?: unknown;
        robot_id?: unknown;
      };
      if (m.t === "hello") robot_id = m.robot_id;
    } catch {}
    if (typeof robot_id !== "string" || !cfg.robots.includes(robot_id)) {
      log("ws_refused", { role, ok: false, reason: "first frame must be hello with a known robot_id" });
      return end(server, CLOSE.REFUSED, "first frame must be hello with a known robot_id");
    }
    connecting = true;
    void toRobot(request, url, env, role, robot_id).then(
      (res) => {
        const up = res.webSocket;
        if (!up) return end(server, 1011, "relay could not reach the robot");
        up.accept();
        up.addEventListener("message", (e) => {
          try {
            server.send(e.data);
          } catch {}
        });
        up.addEventListener("close", (e) => end(server, e.code, e.reason));
        up.addEventListener("error", () => end(server, 1011, "upstream error"));
        up.send(ev.data);
        for (const d of early) up.send(d);
        upstream = up;
      },
      () => end(server, 1011, "relay could not reach the robot"),
    );
  });
  server.addEventListener("close", (e) => end(upstream, e.code, e.reason));
  server.addEventListener("error", () => end(upstream, 1011, "client error"));
  return new Response(null, { status: 101, webSocket: client });
}

function socket(
  request: Request,
  url: URL,
  env: Env,
  cfg: Config,
  role: "robot" | "organ",
): Promise<Response> | Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return httpError(
      426,
      "websocket_required",
      "this route only accepts WebSocket; connect with wss:// and send hello",
    );
  const robot_id = url.searchParams.get("robot_id");
  if (robot_id === null) return bridge(request, url, env, cfg, role);
  if (!cfg.robots.includes(robot_id)) {
    log("ws_refused", { role, ok: false, reason: "unknown_robot" });
    return httpError(404, "unknown_robot", "no such robot_id");
  }
  return toRobot(request, url, env, role, robot_id);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const trace_id = crypto.randomUUID().slice(0, 13);

    let cfg: Config;
    try {
      cfg = loadConfig(env);
    } catch (e) {
      // fail loud: without a valid config nothing is served, not even /health
      const message = e instanceof ConfigError ? e.message : "configuration could not be read";
      log("config_error", { ok: false, code: "misconfigured", message, trace_id });
      return httpError(503, "misconfigured", `${message}. Every request fails until it is fixed (DEPLOY.md).`);
    }

    if (url.pathname === "/health")
      return json({ ok: true, name: "spinecord-server", version: env.GIT_SHA, robots: cfg.robots.length });
    if (url.pathname === "/ws/robot") return socket(request, url, env, cfg, "robot");
    if (url.pathname === "/ws/organ") return socket(request, url, env, cfg, "organ");

    const api = url.pathname.startsWith("/api/");
    if (url.pathname !== "/mcp" && !api)
      return httpError(404, "not_found", "routes: /mcp, /ws/robot, /ws/organ, /api/*, /health");

    const who = await cfg.identify(bearer(request));
    if (!who) {
      log("http", { ok: false, code: "unauthorized", path: url.pathname, http_status: 401, trace_id });
      return httpError(401, "unauthorized", "missing or invalid token; send Authorization: Bearer <token>", {
        "WWW-Authenticate": 'Bearer realm="spinecord"',
      });
    }
    if (!isToolPrincipal(who)) {
      log("http", { ok: false, code: "unauthorized", path: url.pathname, http_status: 403, trace_id });
      return httpError(
        403,
        "unauthorized",
        `this is a ${who.role} credential: it only opens ${who.role === "runtime" ? "/ws/robot" : "/ws/organ"} for its robots; tools and the HTTP API need a user or admin token`,
      );
    }
    if (api) {
      if (who.role !== "admin") return httpError(403, "unauthorized", "the HTTP API is for admins");
      return serveApi(request, url, env, cfg, who, trace_id, ctx);
    }
    // the token goes no further than this function
    const headers = new Headers(request.headers);
    headers.delete("Authorization");
    return serveMcp(new Request(request, { headers }), env, cfg, who, trace_id, ctx);
  },
} satisfies ExportedHandler<Env>;
