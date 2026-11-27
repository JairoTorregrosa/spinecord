// The 3D view of the twins (`--view`): an HTTP + WebSocket server on 127.0.0.1 that serves apps/twin-view's page
// and streams what each twin's simulated brick and world do (pose, motors, sensors, LED, screen, tones, speech)
// together with the MCP calls as they begin and end. The person at the page acts on a twin as on a robot on the
// floor: picks it up and sets it down, sets boxes down or takes them away, presses the brick's buttons.
// Nothing here changes what a tool does: the runtime and the real Ev3Provider still talk to the brick byte by
// byte, and the page reads values that spend none of the world's noise.
// Bound to 127.0.0.1 by name. It answers only requests whose Host is its own (a site whose name was made to
// resolve to this computer gets 403), and only the page served here may open the socket (any site a browser has
// open can reach 127.0.0.1).
import type { SimBrick } from "../../../packages/sim-ev3/brick";
import { CONE_HALF_DEG, type World } from "../../../packages/sim-world/world";
import type { SimWorldProvider } from "../../../packages/sim-world/world-provider";
import type {
  Box,
  CallEnd,
  CallStart,
  PageMessage,
  RobotMeta,
  RobotState,
  ServerMessage,
  WorldShape,
} from "../../twin-view/src/messages";
import type { ViewPageFiles } from "../../twin-view/view-build";
import type { CallWatcher } from "./mcp";
import type { LocalRobot } from "./robot";

export const VIEW_RATE_HZ = 30;
/** Calls a page that opens late still sees. */
const CALL_HISTORY = 40;

export interface ViewTwin {
  id: string;
  brick: SimBrick;
  sim: SimWorldProvider;
  robot: LocalRobot;
}
export interface ViewServer extends CallWatcher {
  url: string;
  port: number;
  /** Pages connected now. */
  clients(): number;
  stop(): void;
}
type Log = (ev: string, fields?: Record<string, unknown>) => void;
interface Socket {
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

const r2 = (v: number) => Math.round(v * 100) / 100 + 0;
const r1 = (v: number) => Math.round(v * 10) / 10 + 0;
const DEG = 180 / Math.PI;

function shape(w: World): WorldShape {
  const c = w.cfg;
  const look = c.extensions.view;
  return {
    name: c.name,
    width: c.width,
    height: c.height,
    boxes: c.boxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h })),
    zones: c.zones.map((z) => ({
      x: z.x,
      y: z.y,
      w: z.w,
      h: z.h,
      color: z.color,
      ...(z.label === undefined ? {} : { label: z.label }),
    })),
    lines: c.lines.map((l) => ({ points: l.points.map((p) => [p[0], p[1]]), width: l.width, closed: l.closed })),
    points: c.points.map((p) => ({ ...p })),
    body: { ...c.body },
    start: { x: c.start.x, y: c.start.y, heading_deg: c.start.th * DEG },
    look: look !== null && typeof look === "object" && !Array.isArray(look) ? (look as Record<string, unknown>) : null,
  };
}

function meta(t: ViewTwin): RobotMeta {
  const d = t.brick.drivetrain;
  return {
    id: t.id,
    drivetrain: d ? { ...d } : null,
    ports: { motors: { ...t.brick.ports.motors }, sensors: { ...t.brick.ports.sensors } },
    world: shape(t.brick.world),
  };
}

function state(t: ViewTwin): RobotState {
  const p = t.brick.peek(); // runs the physics up to now
  const w = t.brick.world;
  const a = CONE_HALF_DEG / DEG;
  const ray = (off: number) => r1(Math.min(9999, w.rayDistance(w.pose, off)));
  const v = t.robot.view();
  return {
    id: t.id,
    pose: { x: r2(w.pose.x), y: r2(w.pose.y), heading_deg: r2(w.pose.th * DEG) },
    stalled: w.last_stalled,
    link: v.link,
    activity: v.activity,
    motors: p.motors.map((m) => ({ ...m, tacho_deg: r1(m.tacho_deg), speed_pct: r1(m.speed_pct) })),
    sensors: p.sensors.map((s) => ({ port: s.port, kind: s.kind, mode: s.mode, values: s.values })),
    led: p.led,
    lcd: p.lcd,
    battery_v: p.battery_v,
    battery_pct: p.battery_pct,
    buttons: p.buttons,
    rays_cm: [ray(-a), ray(0), ray(a)],
    t_ms: Math.round(w.t_ms),
  };
}

/** The finite number `msg[key]`, or a throw naming it. */
function num(msg: Record<string, unknown>, key: string): number {
  const v = msg[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${key} must be a finite number`);
  return v;
}

/** Starts the server. Throws when the port cannot be bound (another process, or another spinecord, holds it). */
export function serveView(
  twins: readonly ViewTwin[],
  port: number,
  o: { page: ViewPageFiles; log: Log; rateHz?: number },
): ViewServer {
  if (twins.length === 0) throw new Error("the 3D view needs at least one twin");
  const rate = o.rateHz ?? VIEW_RATE_HZ;
  const byId = new Map(twins.map((t) => [t.id, t]));
  const sockets = new Set<Socket>();
  /** Buttons each page holds down: released when that page goes away. */
  const held = new Map<Socket, Set<string>>();
  /** What each twin looked like at the last tick: its world, its obstacles, its tone count. */
  const seen = new Map<string, { world: World; boxes: string; tones: number }>();
  /** The obstacles each world came with, for `restore`. */
  const original = new WeakMap<World, Box[]>();
  const calls: (CallStart | CallEnd)[] = [];

  const send = (s: Socket, m: ServerMessage) => {
    try {
      s.send(JSON.stringify(m));
    } catch {
      // a socket that is closing: its close handler cleans up
    }
  };
  const broadcast = (m: ServerMessage) => {
    if (sockets.size === 0) return;
    const text = JSON.stringify(m);
    for (const s of sockets) {
      try {
        s.send(text);
      } catch {
        // see send
      }
    }
  };
  const remember = (w: World) => {
    if (!original.has(w))
      original.set(
        w,
        w.cfg.boxes.map((b) => ({ ...b })),
      );
  };
  for (const t of twins) {
    remember(t.brick.world);
    seen.set(t.id, {
      world: t.brick.world,
      boxes: JSON.stringify(t.brick.world.cfg.boxes),
      tones: t.brick.toneCount,
    });
  }
  const unsubscribe = twins.map((t) => t.sim.onSpoken((text) => broadcast({ t: "speak", id: t.id, text })));

  const tick = () => {
    if (sockets.size === 0) return;
    const robots: RobotState[] = [];
    for (const t of twins) {
      const last = seen.get(t.id)!;
      let st: RobotState;
      try {
        st = state(t);
      } catch (e) {
        o.log("view_error", { robot_id: t.id, error: (e as Error).message });
        continue;
      }
      const w = t.brick.world;
      if (w !== last.world) {
        remember(w);
        last.world = w;
        last.boxes = JSON.stringify(w.cfg.boxes);
        broadcast({ t: "robot", robot: meta(t) });
      } else {
        const boxes = JSON.stringify(w.cfg.boxes);
        if (boxes !== last.boxes) {
          last.boxes = boxes;
          broadcast({ t: "boxes", id: t.id, boxes: w.cfg.boxes.map((b) => ({ ...b })) });
        }
      }
      const count = t.brick.toneCount;
      if (count > last.tones) {
        const fresh = t.brick.tones.slice(-Math.min(count - last.tones, t.brick.tones.length));
        for (const tone of fresh) broadcast({ t: "tone", id: t.id, ...tone });
      }
      last.tones = count;
      robots.push(st);
    }
    broadcast({ t: "state", robots });
  };
  const timer = setInterval(tick, Math.max(10, Math.round(1000 / rate)));
  timer.unref?.();

  /** One action of the person at the page. Throws with a message for that person. */
  const act = (s: Socket, msg: Record<string, unknown>): void => {
    const t = byId.get(String(msg.id));
    if (!t) throw new Error(`no twin "${String(msg.id)}" here: ${[...byId.keys()].join(", ")}`);
    const { brick } = t;
    brick.tick(); // the physics up to now happens where the robot was
    const w = brick.world;
    switch (msg.t) {
      case "carry":
        w.carry({ x: num(msg, "x"), y: num(msg, "y"), th: num(msg, "heading_deg") / DEG });
        break;
      case "box_add": {
        const r = { x: num(msg, "x"), y: num(msg, "y"), w: num(msg, "w"), h: num(msg, "h") };
        if (r.w < 1 || r.h < 1 || r.w > w.cfg.width || r.h > w.cfg.height)
          throw new Error(`a box from 1 cm up to the size of the arena (${w.cfg.width} x ${w.cfg.height} cm)`);
        w.addObstacle(r);
        break;
      }
      case "box_remove":
        w.removeObstacle(num(msg, "index"));
        break;
      case "restore": {
        const before = w.cfg.boxes;
        w.cfg.boxes = (original.get(w) ?? []).map((b) => ({ ...b }));
        try {
          w.setPose({ ...w.cfg.start });
        } catch (e) {
          w.cfg.boxes = before;
          throw e;
        }
        break;
      }
      case "button": {
        const b = num(msg, "button");
        if (!Number.isInteger(b) || b < 1 || b > 6) throw new Error("button must be 1..6");
        const down = msg.down === true;
        brick.pressButton(b, down);
        const mine = held.get(s)!;
        if (down) mine.add(`${t.id}:${b}`);
        else mine.delete(`${t.id}:${b}`);
        return; // too frequent to log
      }
      default:
        throw new Error(`unknown action ${JSON.stringify(msg.t)}`);
    }
    o.log("view_action", { robot_id: t.id, action: msg.t });
  };

  const hosts = (p: number) => [`127.0.0.1:${p}`, `localhost:${p}`];
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        const url = new URL(req.url);
        const own = hosts(srv.port ?? port);
        if (!own.includes(req.headers.get("host") ?? ""))
          return new Response("forbidden: ask for this listener by its own address", { status: 403 });
        const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
        if (url.pathname === "/ws") {
          const origin = req.headers.get("origin");
          if (!origin || !own.map((h) => `http://${h}`).includes(origin))
            return new Response("forbidden: this socket is for the page served here", { status: 403 });
          return srv.upgrade(req, { data: undefined })
            ? undefined
            : new Response("expected a WebSocket upgrade", { status: 426 });
        }
        if (url.pathname === "/")
          return new Response(o.page.html, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
        const file = o.page.files[url.pathname.slice(1)];
        if (file) return new Response(file.body, { headers: { ...headers, "content-type": file.type } });
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
          held.set(ws, new Set());
          send(ws, { t: "hello", robots: twins.map(meta), rate_hz: rate, calls });
        },
        message(ws, data) {
          if (typeof data !== "string") return ws.close(4000, "bad message: expected JSON text");
          let msg: PageMessage | Record<string, unknown>;
          try {
            msg = JSON.parse(data) as Record<string, unknown>;
          } catch {
            return ws.close(4000, "bad message: not JSON");
          }
          if (typeof msg !== "object" || msg === null) return ws.close(4000, "bad message: not an object");
          const req = typeof msg.req === "number" ? msg.req : 0;
          try {
            act(ws, msg as Record<string, unknown>);
            send(ws, { t: "reply", req, ok: true });
          } catch (e) {
            send(ws, { t: "reply", req, ok: false, error: (e as Error).message });
          }
        },
        close(ws) {
          sockets.delete(ws);
          // a page that goes away lets go of the buttons it held
          for (const key of held.get(ws) ?? []) {
            const [id, b] = key.split(":");
            byId.get(id!)?.brick.pressButton(Number(b), false);
          }
          held.delete(ws);
        },
      },
    });
  } catch (e) {
    for (const u of unsubscribe) u();
    clearInterval(timer);
    throw new Error(
      `cannot listen on 127.0.0.1:${port} for the 3D view (${(e as Error).message}). Another process holds that port, often another spinecord: close it, or pick another port with --view-port.`,
      { cause: e },
    );
  }
  const bound = server.port ?? port;
  const keep = (m: CallStart | CallEnd) => {
    calls.push(m);
    if (calls.length > CALL_HISTORY) calls.shift();
    broadcast(m);
  };
  return {
    url: `http://127.0.0.1:${bound}/`,
    port: bound,
    clients: () => sockets.size,
    callStarted: (c) => keep({ t: "call_start", ...c }),
    callEnded: (c) => keep({ t: "call_end", ...c }),
    stop() {
      clearInterval(timer);
      for (const u of unsubscribe) u();
      for (const s of sockets) s.close(1001, "the process is ending");
      void server.stop(true);
    },
  };
}
