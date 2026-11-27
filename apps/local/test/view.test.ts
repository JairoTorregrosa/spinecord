// The 3D view of the twins (`--view`): its flags, and its listener end to end over a real WebSocket next to a
// fleet with the example twin. What the person at the page does (carry the robot, set a box down, hold a button)
// must reach what the robot reads through the tools, and what the tools do (a tone, a phrase, a call) must reach
// the page.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IR_RAYS, NO_NOISE, ULTRASONIC_RAYS, World } from "../../../packages/sim-world/world";
import { loadWorldFile } from "../../../packages/sim-world/world-file";
import { fit } from "../../twin-view/src/fit";
import type { ServerMessage } from "../../twin-view/src/messages";
import { buildViewPage } from "../../twin-view/view-build";
import { DEFAULT_VIEW_PORT, loadConfig } from "../src/config";
import { buildFleet, type Fleet } from "../src/sources";
import { callTool } from "../src/tools";
import { cutText } from "../src/mcp";
import { VIEW_ACTIONS_PER_S, VIEW_MESSAGE_MAX, sensorRays, serveView, type ViewServer } from "../src/view";
import { startServer, until, type TestServer } from "./client";

describe("--view flags", () => {
  test("--view alone shows the example twin on the default port; --view-port picks another", () => {
    const c = loadConfig(["--view"]);
    expect(c.view).toEqual({ port: DEFAULT_VIEW_PORT });
    expect(c.robots.map((r) => r.id)).toEqual(["r1-sim"]);
    expect(loadConfig(["--twin", "--view", "--view-port", "0"]).view).toEqual({ port: 0 });
    expect(loadConfig(["--twin"]).view).toBeNull();
  });
  test("refused: --view-port without --view, --view without a twin, a bad port", () => {
    expect(() => loadConfig(["--twin", "--view-port", "9000"])).toThrow(/--view-port needs --view/);
    expect(() => loadConfig(["--ev3", "--view"])).toThrow(/--view shows the simulated twins/);
    expect(() => loadConfig(["--view", "--view-port", "70000"])).toThrow(/--view-port must be an integer/);
  });
  test("a config file takes view: true or {port}", () => {
    const dir = mkdtempSync(join(tmpdir(), "spinecord-view-"));
    try {
      const file = (view: unknown) => {
        const path = join(dir, "c.json");
        writeFileSync(
          path,
          JSON.stringify({
            view,
            robots: [
              {
                source: "twin",
                robot: join(import.meta.dir, "..", "..", "..", "deployments", "example", "robots", "r1.json"),
                world: join(import.meta.dir, "..", "examples", "room.json"),
              },
            ],
          }),
        );
        return path;
      };
      expect(loadConfig(["--config", file(true)]).view).toEqual({ port: DEFAULT_VIEW_PORT });
      expect(loadConfig(["--config", file({ port: 9123 })]).view).toEqual({ port: 9123 });
      expect(() => loadConfig(["--config", file({ where: 1 })])).toThrow(/view must be true or/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const open: { fleet?: Fleet; view?: ViewServer; sockets: WebSocket[]; server?: TestServer }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    for (const s of o.sockets) s.close();
    o.view?.stop();
    await o.fleet?.shutdown();
    if (o.server) await o.server.closeStdin();
  }
});

/** A page's socket: every message it got, and a wait for the next one that matches. */
function page(url: string, origin = new URL(url).origin) {
  const ws = new WebSocket(`${url.replace("http", "ws")}ws`, { headers: { origin } } as never);
  const got: ServerMessage[] = [];
  ws.onmessage = (e) => void got.push(JSON.parse(String(e.data)) as ServerMessage);
  let req = 0;
  const next = async <T extends ServerMessage>(pred: (m: ServerMessage) => boolean, from = got.length) => {
    let hit: ServerMessage | undefined;
    await until("a message from the view", () => (hit = got.slice(from).find(pred)) !== undefined, 4000);
    return hit as T;
  };
  return {
    ws,
    got,
    next,
    closed: new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code))),
    opened: new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("the socket did not open"));
    }),
    /** Sends one action and waits for its reply. */
    async act(msg: Record<string, unknown>) {
      const r = ++req;
      const from = got.length;
      ws.send(JSON.stringify({ ...msg, req: r }));
      return next<Extract<ServerMessage, { t: "reply" }>>((m) => m.t === "reply" && m.req === r, from);
    },
    /** The next state of a twin. */
    state: (id = "r1-sim") =>
      next<Extract<ServerMessage, { t: "state" }>>((m) => m.t === "state").then((m) =>
        m.robots.find((r) => r.id === id)!,
      ),
  };
}

/** `rateHz`: the state frames; a slow rate keeps the tick away from what a test does between two frames. */
async function rig(rateHz = 50) {
  const events: Record<string, unknown>[] = [];
  const log = (ev: string, fields?: Record<string, unknown>) => void events.push({ ev, ...fields });
  const fleet = await buildFleet(loadConfig(["--twin"]), { log });
  const twins = fleet.robots.map((r) => ({
    id: r.id,
    brick: fleet.bricks.get(r.id)!,
    sim: fleet.sims.get(r.id)!,
    robot: r,
  }));
  const view = serveView(twins, 0, { page: await buildViewPage(), log, rateHz });
  const entry = { fleet, view, sockets: [] as WebSocket[] };
  open.push(entry);
  const tool = async (name: string, args: Record<string, unknown> = {}) =>
    (await callTool(fleet.robots, name, { robot_id: "r1-sim", ...args })).envelope as { ok: boolean; data: any };
  const reading = async (device: string, channel: string) =>
    (await tool("read_device", { device, channels: [channel] })).data.readings[0].value;
  const connect = async () => {
    const p = page(view.url);
    entry.sockets.push(p.ws);
    await p.opened;
    return p;
  };
  return { fleet, view, events, tool, reading, connect };
}

describe("the view listener", () => {
  test("serves the page on 127.0.0.1; only the page served here takes the socket", async () => {
    const { view } = await rig();
    expect(view.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const html = await (await fetch(view.url)).text();
    expect(html).toContain("gemelo 3D");
    const js = await fetch(`${view.url}view.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect((await fetch(`${view.url}nope`)).status).toBe(404);
    expect((await fetch(`${view.url}ws`)).status).toBe(403);
    expect((await fetch(`${view.url}ws`, { headers: { origin: "https://example.com" } })).status).toBe(403);
    expect((await fetch(view.url, { headers: { host: "rebound.example:80" } })).status).toBe(403);
  });

  test("hello names each twin with its world and ports, then the state streams", async () => {
    const { connect } = await rig();
    const p = await connect();
    const hello = await p.next<Extract<ServerMessage, { t: "hello" }>>((m) => m.t === "hello", 0);
    const r = hello.robots[0]!;
    expect(r.id).toBe("r1-sim");
    expect(r.world.name).toBe("room");
    expect(r.ports.sensors).toEqual({ "1": "touch", "2": "gyro", "3": "color", "4": "ultrasonic" });
    expect(r.drivetrain).toMatchObject({ left: "B", right: "C", wheel_diameter_cm: 5.6 });
    const s = await p.state();
    expect(s.pose).toEqual({ x: 60, y: 60, heading_deg: 0 });
    expect(s.link).toBe("online");
    expect(s.sensors[3]!.values[0]).toBeGreaterThan(40);
  });

  test("carrying the robot moves it, and the gyro the tools read felt the turn", async () => {
    const { connect, reading } = await rig();
    const p = await connect();
    expect(await p.act({ t: "carry", id: "r1-sim", x: 40, y: 50, heading_deg: 90 })).toMatchObject({ ok: true });
    const s = await p.state();
    expect(s.pose).toMatchObject({ x: 40, y: 50, heading_deg: 90 });
    expect(Math.abs((await reading("gyro", "angle_deg")) - 90)).toBeLessThanOrEqual(2);
    const refused = await p.act({ t: "carry", id: "r1-sim", x: 1, y: 1, heading_deg: 0 });
    expect(refused).toMatchObject({ ok: false, code: "does_not_fit" });
  });

  test("a box set down is what the distance sensor sees; taking it away and restoring bring the room back", async () => {
    const { connect, reading } = await rig();
    const p = await connect();
    const far = await reading("distance", "distance_cm");
    expect(await p.act({ t: "box_add", id: "r1-sim", x: 85, y: 50, w: 10, h: 20 })).toMatchObject({ ok: true });
    const boxes = await p.next<Extract<ServerMessage, { t: "boxes" }>>((m) => m.t === "boxes", 0);
    expect(boxes.boxes).toEqual([{ id: "box1", x: 85, y: 50, w: 10, h: 20 }] as never);
    expect(Math.abs((await reading("distance", "distance_cm")) - 17)).toBeLessThan(3);
    expect(await p.act({ t: "box_add", id: "r1-sim", x: 55, y: 55, w: 10, h: 10 })).toMatchObject({
      ok: false,
      code: "box_on_robot",
    });
    expect(await p.act({ t: "box_add", id: "r1-sim", x: 115, y: 50, w: 10, h: 20 })).toMatchObject({
      ok: false,
      code: "outside",
    });
    expect(await p.act({ t: "box_remove", id: "r1-sim", box: "box1" })).toMatchObject({ ok: true });
    expect(Math.abs((await reading("distance", "distance_cm")) - far)).toBeLessThan(3);
    await p.act({ t: "box_add", id: "r1-sim", x: 85, y: 50, w: 10, h: 20 });
    await p.act({ t: "carry", id: "r1-sim", x: 30, y: 30, heading_deg: 45 });
    const before = p.got.length;
    expect(await p.act({ t: "restore", id: "r1-sim" })).toMatchObject({ ok: true });
    const s = await p.state();
    expect(s.pose).toEqual({ x: 60, y: 60, heading_deg: 0 });
    await p.next((m) => m.t === "boxes" && m.boxes.length === 0, before);
    expect(await p.act({ t: "fly", id: "r1-sim" })).toMatchObject({
      ok: false,
      code: "invalid",
      error: 'unknown action "fly"',
    });
  });

  test("a box moved is lifted and set down whole; onto the robot it is refused and stays", async () => {
    const { connect, reading } = await rig();
    const p = await connect();
    await p.act({ t: "box_add", id: "r1-sim", x: 10, y: 10, w: 10, h: 10 });
    expect(await p.act({ t: "box_move", id: "r1-sim", box: "box1", x: 85, y: 50, w: 10, h: 20 })).toMatchObject({
      ok: true,
    });
    expect(Math.abs((await reading("distance", "distance_cm")) - 17)).toBeLessThan(3);
    const refused = await p.act({ t: "box_move", id: "r1-sim", box: "box1", x: 55, y: 55, w: 10, h: 10 });
    expect(refused).toMatchObject({ ok: false, code: "box_on_robot" });
    expect(await p.act({ t: "box_move", id: "r1-sim", box: "box9", x: 5, y: 5, w: 5, h: 5 })).toMatchObject({
      ok: false,
      code: "no_such_box",
    });
    await p.next((m) => m.t === "boxes" && m.boxes.length === 1 && m.boxes[0]!.x === 85, 0);
  });

  test("every obstacle reaches the page whole, by id; a push moves it on every page alike", async () => {
    const { connect, tool, fleet } = await rig();
    const w = fleet.bricks.get("r1-sim")!.world;
    w.addObstacle({ id: "cup", x: 80, y: 55, w: 8, h: 10, height_cm: 9, mass_g: 50, ir_reflectivity: 0.21 });
    const a = await connect(),
      b = await connect();
    const hello = await a.next<Extract<ServerMessage, { t: "hello" }>>((m) => m.t === "hello", 0);
    expect(hello.robots[0]!.world.boxes).toEqual([
      { id: "cup", x: 80, y: 55, w: 8, h: 10, height_cm: 9, mass_g: 50, ir_reflectivity: 0.21 },
    ]);
    expect(hello.robots[0]!.world.body.distance_sensor_z_cm).toBe(w.cfg.body.distance_sensor_z_cm);
    // the robot drives into the cup and pushes it: both pages get the box where the world has it
    const from = a.got.length;
    expect((await tool("drive", { distance_cm: 25, speed_pct: 30 })).ok).toBe(true);
    const moved = (m: ServerMessage) => m.t === "boxes" && m.boxes[0]!.x > 80.5;
    const ma = await a.next<Extract<ServerMessage, { t: "boxes" }>>(moved, from);
    await b.next(moved, 0);
    const last = (p: typeof a) => p.got.filter((m) => m.t === "boxes").at(-1) as Extract<ServerMessage, { t: "boxes" }>;
    await until(
      "both pages at the world's last revision",
      () => last(a).rev === w.obstacles_rev && last(b).rev === w.obstacles_rev,
    );
    expect(last(a).boxes).toEqual(w.cfg.boxes as never);
    expect(last(b).boxes).toEqual(last(a).boxes);
    expect(ma.boxes[0]).toMatchObject({ id: "cup", height_cm: 9, mass_g: 50 });
    // the push reaches the page as world events, and a page that opens late sees them in its hello
    await a.next((m) => m.t === "events" && m.events.some((e) => e.kind === "push_began" && e.box === "cup"), from);
    const late = await connect();
    const lateHello = await late.next<Extract<ServerMessage, { t: "hello" }>>((m) => m.t === "hello", 0);
    expect(lateHello.events[0]!.events.some((e) => e.kind === "push_began" && e.box === "cup")).toBe(true);
    // a page moves it by id: its height and mass stay; an id no box has is refused
    expect(await b.act({ t: "box_move", id: "r1-sim", box: "cup", x: 20, y: 20, w: 8, h: 10 })).toMatchObject({
      ok: true,
    });
    expect(w.obstacle("cup")).toMatchObject({ x: 20, y: 20, height_cm: 9, mass_g: 50, ir_reflectivity: 0.21 });
    expect(await a.act({ t: "box_remove", id: "r1-sim", box: "nope" })).toMatchObject({
      ok: false,
      code: "no_such_box",
    });
    expect(await a.act({ t: "box_remove", id: "r1-sim", box: "cup" })).toMatchObject({ ok: true });
    await a.next((m) => m.t === "boxes" && m.boxes.length === 0, 0);
    await b.next((m) => m.t === "boxes" && m.boxes.length === 0, 0);
  });

  test("the rays are the physics' own; on a world without noise every sensor the page shows reads what the tools read", async () => {
    const { connect, tool, fleet } = await rig();
    const world = JSON.parse(await Bun.file(join(import.meta.dir, "..", "examples", "room.json")).text());
    world.name = "room-quiet";
    world.noise = { ...NO_NOISE };
    world.obstacles = [
      { id: "post", x: 95, y: 58, w: 4, h: 4 },
      { id: "low", x: 20, y: 90, w: 30, h: 8, height_cm: 4 },
    ];
    const loaded = await tool("command_device", {
      device: "sim.world",
      command: "load_world",
      args: { world: JSON.stringify(world) },
    });
    expect(loaded.ok).toBe(true);
    const p = await connect();
    const w = fleet.bricks.get("r1-sim")!.world;
    const ports: Record<string, [string, string]> = {
      "1": ["ev3.S1", "pressed"],
      "2": ["ev3.S2", "angle_deg"],
      "3": ["ev3.S3", "reflected_pct"],
      "4": ["ev3.S4", "distance_cm"],
    };
    for (const pose of [
      { x: 60, y: 60, heading_deg: 0 },
      { x: 40, y: 40, heading_deg: 90 },
      { x: 30, y: 30, heading_deg: 30 },
      { x: 100, y: 100, heading_deg: 45 },
    ]) {
      expect(await p.act({ t: "carry", id: "r1-sim", ...pose })).toMatchObject({ ok: true });
      const from = p.got.length;
      const st = await p
        .next<Extract<ServerMessage, { t: "state" }>>((m) => m.t === "state", from)
        .then((m) => m.robots[0]!);
      for (const s of st.sensors) {
        const [device, channel] = ports[s.port]!;
        const r = await tool("read_device", { device, channels: [channel] });
        const v = r.data.readings[0].value;
        expect([s.port, s.values[0]]).toEqual([s.port, typeof v === "boolean" ? Number(v) : v]);
      }
      // the ultrasonic's mark is where its reading comes from: the echo's length is the reading (or none at 255)
      const us = st.rays.ultrasonic!;
      const reading = st.sensors.find((s) => s.kind === "ultrasonic")!.values[0]!;
      if (reading === 255) expect(us.echo).toBeNull();
      else expect(Math.abs(Math.max(3, us.echo!.cm) - reading)).toBeLessThanOrEqual(0.1);
      expect(us.rays).toHaveLength(ULTRASONIC_RAYS);
      expect(st.rays.ir).toBeNull(); // no infrared on this robot: no rays invented for it
      expect(st.rays.color).toEqual({ ahead_cm: w.cfg.body.color_sensor_x_cm, r_cm: w.cfg.body.color_spot_radius_cm });
      expect(st.rays.from).toEqual({
        ahead_cm: w.cfg.body.distance_sensor_x_cm,
        z_cm: w.cfg.body.distance_sensor_z_cm,
      });
    }
  });

  test("sensorRays: the infrared's rays share out its light, and an echo beyond range is none", async () => {
    const w = new World({
      ...(await loadWorldFile(join(import.meta.dir, "..", "examples", "room.json"))),
      noise: NO_NOISE,
    });
    w.addObstacle({ id: "near", x: 80, y: 50, w: 10, h: 20 });
    const r = sensorRays(w, ["ir", "ultrasonic"]);
    expect(r.ir!.rays).toHaveLength(IR_RAYS);
    expect(r.ir!.rays.reduce((a, b) => a + b.share, 0)).toBeCloseTo(1, 2);
    expect(r.ir!.rays[(IR_RAYS - 1) / 2]!.deg).toBe(0);
    expect(r.ultrasonic!.echo!.cm).toBeCloseTo(w.ultrasonicCm(), 0);
    expect(r.color).toBeNull();
    w.removeObstacle("near");
    w.setPose({ x: 60, y: 60, th: Math.PI / 4 }); // square on to nothing near: a corner far away
    const far = sensorRays(w, ["ultrasonic"]);
    expect(far.ultrasonic!.echo === null).toBe(w.ultrasonicCm() === 255);
  });

  test("restore right after load_world, before any frame, brings that world's own boxes back", async () => {
    const { connect, tool, fleet } = await rig(0.05); // one frame in 20 s: none falls inside this test
    const p = await connect();
    const world = JSON.parse(await Bun.file(join(import.meta.dir, "..", "examples", "room.json")).text());
    world.name = "room-with-box";
    world.obstacles = [{ x: 10, y: 10, w: 12, h: 12 }];
    const loaded = await tool("command_device", {
      device: "sim.world",
      command: "load_world",
      args: { world: JSON.stringify(world) },
    });
    expect(loaded.ok).toBe(true);
    const w = fleet.bricks.get("r1-sim")!.world;
    expect(w.cfg.name).toBe("room-with-box");
    w.setObstacles([]); // what a page's "take it away" leaves
    expect(await p.act({ t: "restore", id: "r1-sim" })).toMatchObject({ ok: true });
    expect(w.cfg.boxes).toEqual([{ id: "box1", x: 10, y: 10, w: 12, h: 12 }]);
  });

  test("a button held on the page is pressed for the tools until the page lets go or goes away", async () => {
    const { connect, reading } = await rig();
    const p = await connect();
    await p.act({ t: "button", id: "r1-sim", button: 2, down: true });
    expect(await reading("ev3.buttons", "pressed")).toEqual(["enter"]);
    await p.act({ t: "button", id: "r1-sim", button: 2, down: false });
    expect(await reading("ev3.buttons", "pressed")).toEqual([]);
    expect(await p.act({ t: "button", id: "r1-sim", button: 9, down: true })).toMatchObject({ ok: false });
    await p.act({ t: "button", id: "r1-sim", button: 4, down: true });
    expect(await reading("ev3.buttons", "pressed")).toEqual(["right"]);
    p.ws.close();
    await until("the page gone", async () => (await reading("ev3.buttons", "pressed")).length === 0);
  });

  test("a button two pages hold stays down until the last of them lets go", async () => {
    const { connect, reading } = await rig();
    const a = await connect();
    const b = await connect();
    await a.act({ t: "button", id: "r1-sim", button: 2, down: true });
    await b.act({ t: "button", id: "r1-sim", button: 2, down: true });
    a.ws.close();
    await a.closed;
    await b.state(); // the close has been handled by then
    expect(await reading("ev3.buttons", "pressed")).toEqual(["enter"]);
    await b.act({ t: "button", id: "r1-sim", button: 2, down: false });
    expect(await reading("ev3.buttons", "pressed")).toEqual([]);
  });

  test("a bad, oversized or flooding page changes nothing and the listener goes on", async () => {
    const { connect, view, fleet } = await rig();
    const good = await connect();
    const pose = { ...fleet.bricks.get("r1-sim")!.world.pose };
    for (const bad of [
      { t: "carry", id: "r1-sim", x: "1", y: 2, heading_deg: 0 },
      { t: "carry", id: { toString: 1 }, x: 1, y: 2, heading_deg: 0 },
      { t: "box_remove", id: "r1-sim", box: 0 },
      { t: "button", id: "r1-sim", button: 2.5, down: true },
    ])
      expect(await good.act(bad)).toMatchObject({ ok: false });
    for (const text of ["[1,2]", "null", "not json", "x".repeat(VIEW_MESSAGE_MAX + 1)]) {
      const bad = await connect();
      bad.ws.send(text);
      expect(await bad.closed).not.toBe(1000);
    }
    const flood = await connect();
    for (let i = 0; i < VIEW_ACTIONS_PER_S + 20; i++)
      flood.ws.send(JSON.stringify({ t: "button", id: "r1-sim", button: 1, down: true, req: i + 1 }));
    await flood.next((m) => m.t === "reply" && !m.ok && m.code === "too_fast", 0);
    expect(fleet.bricks.get("r1-sim")!.peek().buttons).toEqual([1]);
    // over the limit all the same, a release goes through: nothing is left held
    expect(await flood.act({ t: "button", id: "r1-sim", button: 1, down: false })).toMatchObject({ ok: true });
    expect(fleet.bricks.get("r1-sim")!.peek().buttons).toEqual([]);
    expect(fleet.bricks.get("r1-sim")!.world.pose).toEqual(pose);
    await good.state();
    expect(view.clients()).toBe(2);
  });

  test("stop closes every page and the listener, twice is harmless", async () => {
    const { connect, view } = await rig();
    const p = await connect();
    view.stop();
    // a normal close: CONTRACT §6 names no code for the view, and the page joins again after any close. The
    // listener closes with 1001; bun 1.3.x, which stops the server at once, delivers it as 1000
    expect([1000, 1001]).toContain(await p.closed);
    view.stop();
    expect(view.clients()).toBe(0);
    expect(
      await fetch(view.url).then(
        () => "answered",
        () => "refused",
      ),
    ).toBe("refused");
  });

  test("a tone of the brick, a phrase of the simulated speaker and a moving call reach the page", async () => {
    const { connect, tool } = await rig();
    const p = await connect();
    await tool("command_device", {
      device: "ev3.speaker",
      command: "tone",
      args: { frequency_hz: 880, duration_ms: 120 },
    });
    expect(await p.next((m) => m.t === "tone")).toMatchObject({ t: "tone", id: "r1-sim", hz: 880, ms: 120 });
    await tool("command_device", { device: "sim.speaker", command: "speak", args: { text: "hola" } });
    expect(await p.next((m) => m.t === "speak")).toEqual({ t: "speak", id: "r1-sim", text: "hola" });
    const from = p.got.length;
    expect((await tool("drive", { distance_cm: 10, speed_pct: 50 })).ok).toBe(true);
    const moved = await p.state();
    expect(moved.pose.x).toBeGreaterThan(68);
    expect(p.got.slice(from).some((m) => m.t === "state" && m.robots[0]!.motors[1]!.speed_pct > 0)).toBe(true);
  });
});

test("through the MCP server: --view prints its address and the page sees each call begin and end", async () => {
  const server = await startServer(["--view", "--view-port", "0"]);
  const entry = { server, sockets: [] as WebSocket[] };
  open.push(entry);
  const line = server.stderr.find((l) => l.includes("the 3D view of the twins is on"));
  const url = line?.match(/(http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
  expect(url).toBeDefined();
  const p = page(url!);
  entry.sockets.push(p.ws);
  await p.opened;
  await p.next((m) => m.t === "hello", 0);
  await server.tool("read_all", { robot_id: "r1-sim" });
  const start = await p.next<Extract<ServerMessage, { t: "call_start" }>>(
    (m) => m.t === "call_start" && m.tool === "read_all",
    0,
  );
  expect(start.args).toBe('{"robot_id":"r1-sim"}');
  const end = await p.next<Extract<ServerMessage, { t: "call_end" }>>((m) => m.t === "call_end" && m.n === start.n, 0);
  expect(end).toMatchObject({ ok: true, code: null, robot_id: "r1-sim" });
  expect(end.summary).toMatch(/^read_all ok/);
  expect(end.at).toBeGreaterThanOrEqual(start.at);
});

test("call arguments are cut for the page without splitting a character in two", () => {
  expect(cutText("abc", 3)).toBe("abc");
  expect(cutText("abcd", 3)).toBe("abc…");
  // "😀" is two UTF-16 units: a cut through it drops it whole
  expect(cutText("ab😀", 3)).toBe("ab…");
  expect(cutText("a😀b", 3)).toBe("a😀…");
});

test("the page's preview of where the robot fits agrees with the world's own rule", async () => {
  const cfg = {
    ...(await loadWorldFile(join(import.meta.dir, "..", "examples", "room.json"))),
    boxes: [
      { id: "a", x: 20, y: 20, w: 15, h: 30 },
      { id: "b", x: 80, y: 70, w: 25, h: 10 },
      { id: "c", x: 50, y: 95, w: 10, h: 10 },
    ],
  };
  const w = new World(cfg);
  const shape = { width: cfg.width, height: cfg.height, body: cfg.body } as unknown as Parameters<typeof fit>[0];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let hits = 0;
  for (let i = 0; i < 2000; i++) {
    const x = rnd() * 130 - 5,
      y = rnd() * 130 - 5,
      th = rnd() * 7 - 3.5;
    const mine = fit(shape, cfg.boxes, x, y, th);
    expect({ x, y, th, collides: mine !== "free" }).toEqual({ x, y, th, collides: w.collides({ x, y, th }) });
    if (mine === "box") hits++;
  }
  expect(hits).toBeGreaterThan(50);
});
