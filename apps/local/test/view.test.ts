// The 3D view of the twins (`--view`): its flags, and its listener end to end over a real WebSocket next to a
// fleet with the example twin. What the person at the page does (carry the robot, set a box down, hold a button)
// must reach what the robot reads through the tools, and what the tools do (a tone, a phrase, a call) must reach
// the page.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../../twin-view/src/messages";
import { buildViewPage } from "../../twin-view/view-build";
import { DEFAULT_VIEW_PORT, loadConfig } from "../src/config";
import { buildFleet, type Fleet } from "../src/sources";
import { callTool } from "../src/tools";
import { cutText } from "../src/mcp";
import { VIEW_ACTIONS_PER_S, VIEW_MESSAGE_MAX, serveView, type ViewServer } from "../src/view";
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
    expect(boxes.boxes).toEqual([{ x: 85, y: 50, w: 10, h: 20 }]);
    expect(Math.abs((await reading("distance", "distance_cm")) - 17)).toBeLessThan(3);
    expect(await p.act({ t: "box_add", id: "r1-sim", x: 55, y: 55, w: 10, h: 10 })).toMatchObject({
      ok: false,
      code: "box_on_robot",
    });
    expect(await p.act({ t: "box_add", id: "r1-sim", x: 115, y: 50, w: 10, h: 20 })).toMatchObject({
      ok: false,
      code: "outside",
    });
    expect(await p.act({ t: "box_remove", id: "r1-sim", index: 0 })).toMatchObject({ ok: true });
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
    expect(await p.act({ t: "box_move", id: "r1-sim", index: 0, x: 85, y: 50, w: 10, h: 20 })).toMatchObject({
      ok: true,
    });
    expect(Math.abs((await reading("distance", "distance_cm")) - 17)).toBeLessThan(3);
    const refused = await p.act({ t: "box_move", id: "r1-sim", index: 0, x: 55, y: 55, w: 10, h: 10 });
    expect(refused).toMatchObject({ ok: false, code: "box_on_robot" });
    expect(await p.act({ t: "box_move", id: "r1-sim", index: 3, x: 5, y: 5, w: 5, h: 5 })).toMatchObject({
      ok: false,
      code: "no_such_box",
    });
    await p.next((m) => m.t === "boxes" && m.boxes.length === 1 && m.boxes[0]!.x === 85, 0);
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
    w.cfg.boxes = []; // what a page's "take it away" leaves
    expect(await p.act({ t: "restore", id: "r1-sim" })).toMatchObject({ ok: true });
    expect(w.cfg.boxes).toEqual([{ x: 10, y: 10, w: 12, h: 12 }]);
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
      { t: "box_remove", id: "r1-sim", index: 0.5 },
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
      flood.ws.send(JSON.stringify({ t: "button", id: "r1-sim", button: 1, down: false, req: i + 1 }));
    await flood.next((m) => m.t === "reply" && !m.ok && m.code === "too_fast", 0);
    expect(fleet.bricks.get("r1-sim")!.world.pose).toEqual(pose);
    await good.state();
    expect(view.clients()).toBe(2);
  });

  test("stop closes every page and the listener, twice is harmless", async () => {
    const { connect, view } = await rig();
    const p = await connect();
    view.stop();
    expect(await p.closed).toBe(1001);
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
