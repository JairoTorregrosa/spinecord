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
import {
  CONE_HALF_DEG,
  ObstacleError,
  ULTRASONIC_ECHO_DEG,
  ULTRASONIC_MAX_CM,
  ULTRASONIC_RAYS,
  type World,
} from "../../../packages/sim-world/world";
import type { SimWorldProvider } from "../../../packages/sim-world/world-provider";
import type {
  Box,
  CallEnd,
  CallStart,
  RefusalCode,
  RobotMeta,
  RobotState,
  SensorRays,
  ServerMessage,
  WorldEventMsg,
  WorldShape,
} from "../../twin-view/src/messages";
import { RAY_MAX_CM } from "../../twin-view/src/messages";
import { poseOfBody } from "../../twin-view/src/sensor-pose";
import type { ViewPageFiles } from "../../twin-view/view-build";
import type { ViewChat } from "./chat";
import { cacheFile, respond, type CachedFile } from "./http-cache";
import type { CallWatcher } from "./mcp";
import type { LocalRobot } from "./robot";
import type { RobotActivity } from "../../../packages/protocol/types";

export const VIEW_RATE_HZ = 30;
/** What a robot may be doing that a restore of its room waits out with a stop (one already stopping is joined). */
const MOVING = new Set<RobotActivity>(["acting", "running_program", "looping", "stopping"]);
/** Calls a page that opens late still sees. */
const CALL_HISTORY = 40;
/** World events of each twin a page that opens late still sees. */
const EVENT_HISTORY = 40;
/** Longest message a page may send: an action is a few numbers. A longer one closes that page's socket. */
export const VIEW_MESSAGE_MAX = 2048;
/** Actions one page may send in a second: far above a hand (a held button, a drag that ends), far below a flood. */
export const VIEW_ACTIONS_PER_S = 60;
/**
 * Bytes a page may leave unread before it misses state frames: a page that is slow or asleep gets the next
 * frame once it catches up (each one is whole), never a growing queue of old ones.
 */
const STATE_BACKLOG_MAX = 256 * 1024;
/** Bytes unread at which the socket is closed: the page joins again and starts from a fresh hello. */
const BACKPRESSURE_MAX = 4 * 1024 * 1024;

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
  getBufferedAmount(): number;
}
/** An action refused, changing nothing; the page words it from `code`. */
class Refused extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
  }
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
    boxes: c.boxes.map((b) => ({ ...b })),
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
    body: {
      front_cm: c.body.front_cm,
      back_cm: c.body.back_cm,
      half_width_cm: c.body.half_width_cm,
      color_sensor_x_cm: c.body.color_sensor_x_cm,
      color_spot_radius_cm: c.body.color_spot_radius_cm,
      distance_sensor_x_cm: c.body.distance_sensor_x_cm,
      distance_sensor_y_cm: c.body.distance_sensor_y_cm,
      distance_sensor_z_cm: c.body.distance_sensor_z_cm,
      distance_sensor_yaw_deg: c.body.distance_sensor_yaw_deg,
    },
    start: { x: c.start.x, y: c.start.y, heading_deg: c.start.th * DEG },
    look: look !== null && typeof look === "object" && !Array.isArray(look) ? (look as Record<string, unknown>) : null,
  };
}

function meta(t: ViewTwin): RobotMeta {
  const d = t.brick.drivetrain;
  return {
    id: t.id,
    name: t.robot.name,
    drivetrain: d ? { ...d } : null,
    ports: { motors: { ...t.brick.ports.motors }, sensors: { ...t.brick.ports.sensors } },
    world: shape(t.brick.world),
  };
}

/** The rays the twin's sensors cast now, for the sensors it has (src/messages.ts SensorRays). Spends no noise. */
export function sensorRays(w: World, kinds: readonly string[]): SensorRays {
  const b = w.cfg.body;
  const cm = (d: number) => r1(Math.min(RAY_MAX_CM, d));
  let ultrasonic: SensorRays["ultrasonic"] = null;
  if (kinds.includes("ultrasonic")) {
    const half = CONE_HALF_DEG / DEG,
      minCos = Math.cos(ULTRASONIC_ECHO_DEG / DEG);
    const rays = Array.from({ length: ULTRASONIC_RAYS }, (_, i) => {
      const off = ((2 * i) / (ULTRASONIC_RAYS - 1) - 1) * half;
      const h = w.rayHit(w.pose, off);
      return { deg: r1(off * DEG), cm: cm(h.d), echo: h.cos >= minCos - 1e-12 && h.d <= ULTRASONIC_MAX_CM };
    });
    // the reading's own rule (ultrasonicCm): an echo beyond the range, or none, reads 255
    const e = w.coneEcho();
    ultrasonic = { rays, echo: e.d <= ULTRASONIC_MAX_CM ? { deg: r1(e.off * DEG), cm: r1(e.d) } : null };
  }
  const ir = kinds.includes("ir")
    ? {
        rays: w.irBeam().rays.map((r) => ({
          deg: r1(r.off * DEG),
          cm: cm(r.d),
          share: Math.round(r.share * 1000) / 1000,
        })),
      }
    : null;
  const color = kinds.includes("color") ? { ahead_cm: b.color_sensor_x_cm, r_cm: b.color_spot_radius_cm } : null;
  return { from: poseOfBody(b), ultrasonic, ir, color };
}

function state(t: ViewTwin): RobotState {
  const p = t.brick.peek(); // runs the physics up to now
  const w = t.brick.world;
  const v = t.robot.view();
  return {
    id: t.id,
    pose: { x: r2(w.pose.x), y: r2(w.pose.y), heading_deg: r2(w.pose.th * DEG) },
    stalled: w.last_stalled,
    link: v.link,
    activity: v.activity,
    motors: p.motors.map((m) => ({ ...m, tacho_deg: r1(m.tacho_deg), speed_pct: r1(m.speed_pct) })),
    // as the tools read them: the EV3 gyro counts clockwise, the contract counter-clockwise (driver-ev3's ccw)
    sensors: p.sensors.map((s) => ({
      port: s.port,
      kind: s.kind,
      mode: s.mode,
      values: s.kind === "gyro" ? s.values.map((v) => (v === 0 ? 0 : -v)) : s.values,
    })),
    led: p.led,
    lcd: p.lcd,
    battery_v: p.battery_v,
    battery_pct: p.battery_pct,
    buttons: p.buttons,
    rays: sensorRays(w, Object.values(t.brick.ports.sensors) as string[]),
    t_ms: Math.round(w.t_ms),
  };
}

/** The finite number `msg[key]`, or a refusal naming it. */
function num(msg: Record<string, unknown>, key: string): number {
  const v = msg[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Refused("invalid", `${key} must be a finite number`);
  return v;
}

/** The box `x, y, w, h` of an action, refused unless it lies inside the arena with sides of 1 cm or more. */
function boxOf(msg: Record<string, unknown>, w: World): Box {
  const r = { x: num(msg, "x"), y: num(msg, "y"), w: num(msg, "w"), h: num(msg, "h") };
  if (r.w < 1 || r.h < 1 || r.x < 0 || r.y < 0 || r.x + r.w > w.cfg.width || r.y + r.h > w.cfg.height)
    throw new Refused(
      "outside",
      `a box lies inside the arena (0..${w.cfg.width} x 0..${w.cfg.height} cm) with sides of 1 cm or more`,
    );
  return r;
}

/** Does `change` to the world's boxes, or refuses with the world's reason. */
function boxChange(change: () => void): void {
  try {
    change();
  } catch (e) {
    if (!(e instanceof ObstacleError)) throw e;
    throw new Refused(e.code === "on_robot" ? "box_on_robot" : e.code === "id_taken" ? "invalid" : e.code, e.message);
  }
}

/** Starts the server. Throws when the port cannot be bound (another process, or another spinecord, holds it). */
export function serveView(
  twins: readonly ViewTwin[],
  port: number,
  o: { page: ViewPageFiles; log: Log; rateHz?: number; chat?: ViewChat },
): ViewServer {
  if (twins.length === 0) throw new Error("the 3D view needs at least one twin");
  const hz = o.rateHz ?? VIEW_RATE_HZ;
  const byId = new Map(twins.map((t) => [t.id, t]));
  const sockets = new Set<Socket>();
  /**
   * Buttons each page holds down, by twin. A button is down while any page holds it: one page letting go (or
   * going away) releases it only when no other page still holds it.
   */
  const held = new Map<Socket, Map<string, Set<number>>>();
  const heldElsewhere = (s: Socket, id: string, b: number) =>
    [...held].some(([o, m]) => o !== s && m.get(id)?.has(b) === true);
  const letGo = (s: Socket, id: string, b: number) => {
    held.get(s)?.get(id)?.delete(b);
    if (!heldElsewhere(s, id, b)) byId.get(id)?.brick.pressButton(b, false);
  };
  /** Actions of each page in the current second, for VIEW_ACTIONS_PER_S. */
  const rate = new Map<Socket, { second: number; n: number }>();
  /** What each twin looked like at the last tick: its world, its obstacles, its tone count. */
  const seen = new Map<string, { world: World; rev: number; tones: number; events: number }>();
  /** The last world events of each twin, for a page that opens late. */
  const happened = new Map<string, WorldEventMsg[]>(twins.map((t) => [t.id, []]));
  const calls: (CallStart | CallEnd)[] = [];

  let stopped = false;
  const send = (s: Socket, m: ServerMessage) => {
    try {
      s.send(JSON.stringify(m));
    } catch {
      // a socket that is closing: its close handler cleans up
    }
  };
  /** To every page. `skippable`: a page with a backlog misses it (a state frame: the next one replaces it). */
  const broadcast = (m: ServerMessage, skippable = false) => {
    if (sockets.size === 0) return;
    const text = JSON.stringify(m);
    for (const s of sockets) {
      if (skippable && s.getBufferedAmount() > STATE_BACKLOG_MAX) continue;
      try {
        s.send(text);
      } catch {
        // see send
      }
    }
  };
  for (const t of twins) {
    seen.set(t.id, {
      world: t.brick.world,
      rev: t.brick.world.obstacles_rev,
      tones: t.brick.toneCount,
      events: t.brick.world.eventsSince(0).next,
    });
  }
  const unsubscribe = [...twins.map((t) => t.sim.onSpoken((text) => broadcast({ t: "speak", id: t.id, text })))];

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
        last.world = w;
        last.rev = w.obstacles_rev;
        last.events = 0; // a new world keeps its own log
        broadcast({ t: "robot", robot: meta(t) });
      } else if (w.obstacles_rev !== last.rev) {
        // every change of the obstacles counts in obstacles_rev: a push, a page's action, sim.world
        last.rev = w.obstacles_rev;
        broadcast({ t: "boxes", id: t.id, rev: w.obstacles_rev, boxes: w.cfg.boxes.map((b) => ({ ...b })) });
      }
      const ev = w.eventsSince(last.events);
      if (ev.events.length > 0) {
        last.events = ev.next;
        const kept = happened.get(t.id)!;
        kept.push(...ev.events);
        kept.splice(0, Math.max(0, kept.length - EVENT_HISTORY));
        broadcast({ t: "events", id: t.id, events: ev.events });
      }
      const count = t.brick.toneCount;
      if (count > last.tones) {
        const fresh = t.brick.tones.slice(-Math.min(count - last.tones, t.brick.tones.length));
        for (const tone of fresh) broadcast({ t: "tone", id: t.id, ...tone });
      }
      last.tones = count;
      robots.push(st);
    }
    broadcast({ t: "state", robots }, true);
  };
  o.chat?.attach((m) => broadcast(m));
  const timer = setInterval(tick, Math.max(10, Math.round(1000 / hz)));
  timer.unref?.();

  /**
   * The room the twin started in, whole (sim.world restore). A robot still moving is stopped first, as by the tools'
   * stop (a stop already running, Claude's or an earlier restore's, is joined), and the restore waits for that stop: the preempted call ends, and measures, in the room it ran in. A
   * robot in fault stays in fault (a hand does not clear it, reset_fault does): the answer carries the activity the
   * robot is left in, so the page can say so.
   */
  const restore = async (t: ViewTwin): Promise<{ activity: RobotActivity }> => {
    if (MOVING.has(t.robot.view().activity)) await t.robot.stop().catch(() => {}); // a failed stop leaves it in fault
    t.sim.restore();
    o.log("view_action", { robot_id: t.id, action: "restore" });
    return { activity: t.robot.view().activity };
  };

  /**
   * One action of the person at the page. Throws Refused, changing nothing, when it cannot be done. A restore
   * answers later, with what it leaves.
   */
  const act = (s: Socket, msg: Record<string, unknown>): void | Promise<{ activity: RobotActivity }> => {
    const t = typeof msg.id === "string" ? byId.get(msg.id) : undefined;
    if (!t) throw new Refused("invalid", `no twin ${JSON.stringify(msg.id)} here: ${[...byId.keys()].join(", ")}`);
    const { brick } = t;
    brick.tick(); // the physics up to now happens where the robot was
    const w = brick.world;
    /** The id of the box the action names; refused when no box of this world has it (another page took it). */
    const boxId = () => {
      const id = msg.box;
      if (typeof id !== "string") throw new Refused("invalid", "box must be the id of a box");
      if (!w.obstacle(id))
        throw new Refused(
          "no_such_box",
          `no box ${JSON.stringify(id)}: this world has ${w.cfg.boxes.map((b) => b.id).join(", ") || "none"}`,
        );
      return id;
    };
    switch (msg.t) {
      case "carry": {
        const p = { x: num(msg, "x"), y: num(msg, "y"), th: num(msg, "heading_deg") / DEG };
        if (w.collides(p))
          throw new Refused(
            "does_not_fit",
            `the robot does not fit at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}): it would overlap a wall or a box`,
          );
        w.carry(p);
        break;
      }
      case "box_add": {
        const r = boxOf(msg, w);
        boxChange(() => w.addObstacle(r));
        break;
      }
      case "box_remove": {
        const id = boxId();
        boxChange(() => w.removeObstacle(id));
        break;
      }
      case "box_move": {
        const id = boxId();
        const r = boxOf(msg, w);
        boxChange(() => w.moveObstacle(id, r)); // refused, the box stays where it was
        break;
      }
      case "restore":
        return restore(t);
      case "button": {
        const b = num(msg, "button");
        if (!Number.isInteger(b) || b < 1 || b > 6) throw new Refused("invalid", "button must be 1..6");
        let mine = held.get(s)!.get(t.id);
        if (!mine) held.get(s)!.set(t.id, (mine = new Set()));
        if (msg.down === true) {
          mine.add(b);
          brick.pressButton(b, true);
        } else letGo(s, t.id, b);
        return; // too frequent to log
      }
      default:
        throw new Refused("invalid", `unknown action ${JSON.stringify(msg.t)}`);
    }
    o.log("view_action", { robot_id: t.id, action: msg.t });
  };
  /** Counts one action of page `s`; false when it is over VIEW_ACTIONS_PER_S this second. */
  const allowed = (s: Socket): boolean => {
    const second = Math.floor(performance.now() / 1000);
    const r = rate.get(s);
    if (!r || r.second !== second) {
      rate.set(s, { second, n: 1 });
      return true;
    }
    return ++r.n <= VIEW_ACTIONS_PER_S;
  };

  // the page's files with their tags; text is gzipped on first ask (http-cache.ts)
  const text = (type: string) => /^text\/|javascript|json/.test(type);
  const pageFiles = new Map<string, CachedFile>([
    ["/", cacheFile("text/html; charset=utf-8", o.page.html, true)],
    ...Object.entries(o.page.files).map(([name, f]) => [`/${name}`, cacheFile(f.type, f.body, text(f.type))] as const),
  ]);
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
        if (url.pathname === "/ws") {
          const origin = req.headers.get("origin");
          if (!origin || !own.map((h) => `http://${h}`).includes(origin))
            return new Response("forbidden: this socket is for the page served here", { status: 403 });
          return srv.upgrade(req, { data: undefined })
            ? undefined
            : new Response("expected a WebSocket upgrade", { status: 426 });
        }
        const file = pageFiles.get(url.pathname);
        if (file) return respond(file, req.headers, { "x-content-type-options": "nosniff" });
        return new Response("not found", { status: 404 });
      },
      websocket: {
        // a longer message is no action of this page: Bun closes that socket (1009), the listener goes on
        maxPayloadLength: VIEW_MESSAGE_MAX,
        backpressureLimit: BACKPRESSURE_MAX,
        closeOnBackpressureLimit: true,
        open(ws) {
          if (stopped) return ws.close(1001, "the process is ending");
          sockets.add(ws);
          held.set(ws, new Map());
          send(ws, {
            t: "hello",
            robots: twins.map(meta),
            rate_hz: hz,
            calls,
            events: [...happened].map(([id, events]) => ({ id, events })),
            ...(o.chat ? { chat: o.chat.hello() } : {}),
          });
        },
        message(ws, data) {
          if (typeof data !== "string") return ws.close(4000, "bad message: expected JSON text");
          let msg: unknown;
          try {
            msg = JSON.parse(data);
          } catch {
            return ws.close(4000, "bad message: not JSON");
          }
          if (typeof msg !== "object" || msg === null || Array.isArray(msg))
            return ws.close(4000, "bad message: not an object");
          const m = msg as Record<string, unknown>;
          const req = typeof m.req === "number" && Number.isFinite(m.req) ? m.req : 0;
          // letting a button go is never refused: a release lost to the limit would hold it down for good;
          // neither is the chat's stop (--chat): a stop lost to the limit would leave the robot moving
          const release = (m.t === "button" && m.down !== true) || (o.chat !== undefined && m.t === "chat_stop");
          if (!release && !allowed(ws))
            return send(ws, { t: "reply", req, ok: false, code: "too_fast", error: "too many actions this second" });
          // --chat: the chat's own messages (src/chat.ts); without it they are unknown actions, as before
          if (o.chat && typeof m.t === "string" && m.t.startsWith("chat_"))
            return o.chat.message(m, (r) => send(ws, r));
          const fail = (e: unknown) => {
            if (e instanceof Refused) return send(ws, { t: "reply", req, ok: false, code: e.code, error: e.message });
            // a fault of the view, not of the person: logged loud, shown as one on the page, the listener goes on
            const error = (e as Error).message;
            o.log("view_error", { robot_id: m.id, action: m.t, error });
            send(ws, { t: "reply", req, ok: false, code: "internal", error });
          };
          try {
            const later = act(ws, m);
            if (later) later.then((r) => send(ws, { t: "reply", req, ok: true, ...r }), fail);
            else send(ws, { t: "reply", req, ok: true });
          } catch (e) {
            fail(e);
          }
        },
        close(ws) {
          sockets.delete(ws);
          rate.delete(ws);
          // a page that goes away lets go of the buttons it held (those no other page holds)
          for (const [id, bs] of held.get(ws) ?? []) for (const b of [...bs]) letGo(ws, id, b);
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
    if (stopped) return;
    calls.push(m);
    if (calls.length > CALL_HISTORY) calls.shift();
    broadcast(m);
  };
  return {
    url: `http://127.0.0.1:${bound}/`,
    port: bound,
    clients: () => sockets.size,
    callStarted: (c) => keep({ t: "call_start", at: Date.now(), ...c }),
    callEnded: (c) => keep({ t: "call_end", at: Date.now(), ...c }),
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const u of unsubscribe) u();
      for (const s of sockets) s.close(1001, "the process is ending");
      void server.stop(true);
    },
  };
}
