// Peripheral pages end to end (CONTRACT §2.4): the fake page client (./pages.ts) over a real WebSocket to the page
// listener of a fleet with the example twin and the robot without a body. Every envelope is checked against its
// tool's outputSchema. The image block is assembled by the MCP layer, so that check runs through a spawned server.
import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { firstViolation } from "../../../packages/protocol/schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoopSpec } from "../../../packages/protocol/types";
import { REPO, loadConfig } from "../src/config";
import { PAGE_TIMES, type PageTimes } from "../src/pages";
import { buildFleet, twinRuntime, type Fleet } from "../src/sources";
import { TOOL, callTool } from "../src/tools";
import { sleep, startServer, until, type TestServer } from "./client";
import { FAKE_DEVICES, FAKE_IMU, FAKE_SCREEN, fakePage, servedToken, testJpeg, type FakePage } from "./pages";

/** C5 of docs/loops.md, as printed there. */
const C5 = [...readFileSync(join(REPO, "docs", "loops.md"), "utf8").matchAll(/```json\r?\n([\s\S]*?)```/g)].map(
  (m) => JSON.parse(m[1]!) as LoopSpec,
)[4]!;

const open: { fleet?: Fleet; pages: FakePage[]; server?: TestServer }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    for (const p of o.pages) p.close();
    await o.fleet?.shutdown();
    if (o.server) await o.server.closeStdin();
  }
});

async function rig(times: Partial<PageTimes> = {}) {
  const events: Record<string, unknown>[] = [];
  const fleet = await buildFleet(loadConfig(["--twin", "--pages"]), {
    log: (ev, fields) => void events.push({ ev, ...fields }),
    pagePort: 0,
    pageTimes: times,
  });
  const entry: { fleet: Fleet; pages: FakePage[] } = { fleet, pages: [] };
  open.push(entry);
  /** One call; the envelope must match the tool's outputSchema. */
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const { envelope } = await callTool(fleet.robots, name, args);
    const bad = firstViolation(TOOL.get(name)!.output, envelope);
    if (bad) throw new Error(`${name}: the envelope does not match its outputSchema: ${bad}`);
    return envelope;
  };
  const twin = (name: string, args: Record<string, unknown> = {}) => call(name, { robot_id: "r1-sim", ...args });
  // the page's address, as a person gets it: from the join sentence of list_robots
  const listed = await call("list_robots");
  const join = (listed as any).data.robots[0].join as string;
  const url = join.match(/http:\/\/127\.0\.0\.1:\d+\//)![0];
  const page = async (o: Partial<Parameters<typeof fakePage>[0]> = {}) => {
    const p = await fakePage({ url, robot: "r1-sim", transcript: "ya me la tomé", ...o });
    entry.pages.push(p);
    return p;
  };
  const joined = async (o: Partial<Parameters<typeof fakePage>[0]> = {}) => {
    const p = await page(o);
    await p.joined;
    await until("the page to be active", async () => {
      const d = await twin("describe_robot");
      return (
        d.ok &&
        d.data.pages.some((x: { name: string; state: string }) => x.name === (o.name ?? "desk") && x.state === "active")
      );
    });
    return p;
  };
  const pageEvents = () => events.filter((e) => e.ev === "page");
  return { fleet, call, twin, url, join, page, joined, pageEvents, listed };
}

describe("peripheral pages", () => {
  test("list_robots gives join for every robot, without the token; a page joins the twin and describe_robot shows its devices", async () => {
    const r = await rig();
    const robots = (r.listed as any).data.robots as { id: string; join: string; backend: string; link: string }[];
    expect(robots.map((x) => [x.id, x.backend, x.link])).toEqual([
      ["r1-sim", "sim", "online"],
      ["pages", "page", "online"],
    ]);
    const token = await servedToken(r.url);
    for (const x of robots) {
      expect(x.join).toContain(r.url);
      expect(x.join).not.toContain(token);
    }
    await r.joined();
    const d = await r.twin("describe_robot");
    expect(d.ok).toBe(true);
    const ids = d.data.devices.map((x: { id: string }) => x.id);
    expect(ids).toEqual(expect.arrayContaining(["ev3.pair", "desk.camera", "desk.mic", "desk.speaker", "desk.touch"]));
    expect(d.data.backend).toBe("sim"); // the hub is the last provider
    expect(d.data.roles).toMatchObject({ eyes: "desk.camera", ears: "desk.mic", voice: "desk.speaker" });
    // a robot file's role wins over a page's proposal
    expect(d.data.roles.touch).toBe("ev3.S1");
    expect(d.data.pages).toEqual([
      {
        name: "desk",
        state: "active",
        devices: ["desk.camera", "desk.mic", "desk.speaker", "desk.touch"],
        unavailable: [{ kind: "vibrator", why: "this browser has no vibration" }],
        last_seen_ms: expect.any(Number),
      },
    ]);
    const dev = await r.twin("describe_device", { device: "desk.touch" });
    expect(dev.data.channels[0]).toMatchObject({ name: "b1", pushed: true });
    // the page log holds kinds, never a value or the token
    const lines = JSON.stringify(r.pageEvents());
    expect(r.pageEvents().map((e) => e.to)).toEqual(["announced", "active"]);
    expect(r.pageEvents()[0]!.kinds).toEqual(["camera", "microphone", "speaker", "touch_panel"]);
    expect(lines).not.toContain(token);
  });

  test("a robot of source pages is online with no page, and read_all answers with no readings", async () => {
    const r = await rig();
    const all = await r.call("read_all", { robot_id: "pages" });
    expect(all).toMatchObject({
      ok: true,
      robot: { backend: "page", link: "online", activity: "idle" },
      data: { readings: [] },
    });
    const d = await r.call("describe_robot", { robot_id: "pages" });
    expect(d).toMatchObject({ ok: true, data: { devices: [], drivetrain: null, pages: [] } });
    const p = await r.page({ robot: "pages", name: "phone" });
    await p.joined;
    await until(
      "the phone's devices",
      async () => (await r.call("describe_robot", { robot_id: "pages" })).data.devices.length === 4,
    );
    expect((await r.call("drive", { robot_id: "pages", distance_cm: 5 })).error.code).toBe("unsupported");
  });

  test("read_device returns the page's frame, and a pushed button ends drive … until within a poll", async () => {
    const r = await r0();
    const p = await r.joined();
    const frame = await r.twin("read_device", { device: "eyes", channels: ["frame"] });
    expect(frame).toMatchObject({
      ok: true,
      data: {
        readings: [
          { device: "desk.camera", channel: "frame", value: null, image: true, mime: "image/jpeg", age_ms: 20 },
        ],
      },
    });
    const move = r.twin("drive", {
      distance_cm: 60,
      speed_pct: 20,
      until: { device: "desk.touch", channel: "b1", op: "eq", value: true },
    });
    await until("the wheels to turn", async () => {
      const s = await r.twin("read_device", { device: "ev3.B", channels: ["speed_deg_s"] });
      return Math.abs(s.data.readings[0].value) > 0;
    });
    const pressed = Date.now();
    p.press();
    const done = await move;
    const took = Date.now() - pressed;
    expect(done).toMatchObject({ ok: true, data: { reason: "condition_met" } });
    expect(done.data.readings).toEqual([expect.objectContaining({ device: "desk.touch", channel: "b1", value: true })]);
    // one 10 ms poll, the abort and the closing reading; generous for a loaded machine
    expect(took).toBeLessThan(250);
    expect(done.data.measured.distance_cm).toBeLessThan(60);
  });

  test("listen returns the page's transcript, its match lands in last_match; speak reaches the page", async () => {
    const r = await rig();
    const p = await r.joined();
    const heard = await r.twin("command_device", {
      device: "ears",
      command: "listen",
      args: { max_ms: 5000, expect: ["me la tomé"] },
    });
    expect(heard).toMatchObject({
      ok: true,
      data: { reason: "completed", measured: { heard: true, transcript: "ya me la tomé", match: "me la tomé" } },
    });
    const met = await r.twin("wait_until", {
      condition: { device: "ears", channel: "last_match", op: "eq", value: "me la tomé" },
      timeout_ms: 1000,
    });
    expect(met).toMatchObject({ ok: true, data: { met: true } });
    const said = await r.twin("command_device", { device: "voice", command: "speak", args: { text: "Muy bien" } });
    expect(said).toMatchObject({ ok: true, data: { reason: "completed", measured: { spoken: true } } });
    expect(p.spoken).toEqual(["Muy bien"]);
  });

  test("a silent page: a guarded move is braked with condition_unreadable, then the page is asleep and answers device_offline", async () => {
    const r = await rig({ asleep_ms: 1500 });
    const p = await r.joined();
    const move = r.twin("drive", {
      distance_cm: 80,
      speed_pct: 15,
      until: { device: "desk.touch", channel: "b1", op: "eq", value: true },
    });
    await until("the wheels to turn", async () => {
      const s = await r.twin("read_device", { device: "ev3.B", channels: ["speed_deg_s"] });
      return Math.abs(s.data.readings[0].value) > 0;
    });
    const quiet = Date.now();
    p.silence();
    const braked = await move;
    const took = Date.now() - quiet;
    expect(braked).toMatchObject({ ok: false, error: { code: "condition_unreadable", retryable: false } });
    expect(braked.error.message).toContain("device_offline");
    expect(braked.error.measured).toBeDefined();
    // silent for 300 ms from its last answer (at most one ping, 100 ms, before the silence), then three 10 ms polls
    expect(took).toBeGreaterThanOrEqual(100);
    expect(took).toBeLessThan(1000);
    expect((await r.twin("stop")).data.motors_stopped).toBe(true);

    await until(
      "the page to be asleep",
      async () => (await r.twin("describe_robot")).data.pages[0].state === "asleep",
      5000,
    );
    const off = await r.twin("read_device", { device: "desk.touch" });
    expect(off).toMatchObject({
      ok: false,
      error: { code: "device_offline", retryable: true, retry_after_ms: 2000 },
      next: ["describe_robot", "read_device"],
    });
    expect(off.error.message).toContain("page named desk");
    const d = await r.twin("describe_robot");
    expect(d.data.pages[0]).toMatchObject({ state: "asleep", why: "did not answer a ping for 1500 ms" });
    // the robot's own devices work
    expect((await r.twin("read_device", { device: "ev3.S1" })).ok).toBe(true);
    // stop with a silent page is verified, and does not wait on it
    const t0 = Date.now();
    expect(await r.twin("stop")).toMatchObject({ ok: true, data: { motors_stopped: true } });
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 15_000);

  test("a paused page ends a guarded move at the next poll with device_offline; resumed, it works again", async () => {
    const r = await rig();
    const p = await r.joined();
    p.pause();
    await until("the page to sleep", async () => (await r.twin("describe_robot")).data.pages[0].state === "asleep");
    const move = await r.twin("drive", {
      distance_cm: 20,
      until: { device: "desk.touch", channel: "b1", op: "eq", value: true },
    });
    expect(move).toMatchObject({ ok: false, error: { code: "device_offline" } });
    expect(move.error.message).toContain("resume");
    // nothing moved, yet a move had been asked for: it is not to be sent again unread, and carries no wait
    expect(move.error.retry_after_ms).toBeUndefined();
    p.resume();
    await until("the page to wake", async () => (await r.twin("describe_robot")).data.pages[0].state === "active");
    expect((await r.twin("read_device", { device: "desk.touch" })).ok).toBe(true);
  });

  test("C5 on real time: the fake page's roll steers the twin's wheels proportionally, roll 0 holds, a silent page ends it with input_lost", async () => {
    const r = await rig();
    const p = await r.joined({ name: "phone", devices: [...FAKE_DEVICES, FAKE_IMU] });
    // the page joins the robot's loop as inputs: it does not change where a loop runs, or how fast
    expect((await r.twin("describe_robot")).data.loop).toEqual({ runs_on: "host", max_rate_hz: 100 });
    // 5 Hz, not C5's 20: on real time a loaded runner must not end the loop with overrun (one tick of a second
    // that is a period late is 5 % of them at 20 Hz; at 5 Hz a period is 200 ms)
    const started = await r.twin("run_loop", { ...C5, rate_hz: 5, duration_ms: 25000 });
    expect(started).toMatchObject({ ok: true, robot: { activity: "looping" }, data: { state: "running" } });
    expect(started.data.outputs.map((o: { last: number }) => o.last)).toEqual([0, 0]);
    const outputs = async () =>
      ((await r.twin("supervise_loop")).data.outputs as { last: number }[]).map((o) => o.last);
    const speeds = async () =>
      (await r.twin("read_all")).data.readings
        .filter((x: { device: string; channel: string }) => x.channel === "speed_deg_s")
        .reduce(
          (m: Record<string, number>, x: { device: string; value: number }) => ({ ...m, [x.device]: x.value }),
          {},
        );

    // roll 10 → ±5 % (k_left 0.5, k_right -0.5); roll 20 → ±10 %: the output follows the roll, and the wheels turn
    p.push("imu", { roll_deg: 10 });
    await until("the outputs to follow a roll of 10", async () => (await outputs()).join() === "5,-5");
    p.push("imu", { roll_deg: 20 });
    await until("the outputs to follow a roll of 20", async () => (await outputs()).join() === "10,-10");
    await until("the wheels to turn apart", async () => {
      const v = await speeds();
      return v["ev3.B"] > 0 && v["ev3.C"] < 0;
    });
    // while the loop reads the page, the server pings it every 100 ms
    const pings = () => p.received.filter((m) => m.t === "ping").length;
    const before = pings();
    await sleep(1000);
    expect(pings() - before).toBeGreaterThanOrEqual(5);
    // roll 0: both outputs at 0 and the wheels hold
    p.push("imu", { roll_deg: 0 });
    await until("the outputs to rest", async () => (await outputs()).join() === "0,0");
    await until("the wheels to stop", async () => {
      const v = await speeds();
      return v["ev3.B"] === 0 && v["ev3.C"] === 0;
    });

    // the page falls silent while it steers: 300 ms after its last answer, three ticks without a value
    p.push("imu", { roll_deg: 20 });
    await until("the outputs to follow a roll of 20", async () => (await outputs()).join() === "10,-10");
    const quiet = Date.now();
    p.silence();
    const end = await r.twin("supervise_loop", { wait_ms: 5000 });
    const took = Date.now() - quiet;
    expect(end).toMatchObject({ robot: { activity: "idle" }, data: { state: "ended", reason: "input_lost" } });
    expect(end.data.outputs.map((o: { last: number }) => o.last)).toEqual([0, 0]);
    expect(took).toBeGreaterThanOrEqual(200);
    expect(took).toBeLessThan(4000);
    const v = await speeds();
    expect([v["ev3.B"], v["ev3.C"]]).toEqual([0, 0]);
  }, 30_000);

  test("a page is a loop input only: a page device as an output, or a channel it does not push, is refused and nothing is sent", async () => {
    const r = await rig();
    const p = await r.joined({ devices: [...FAKE_DEVICES, FAKE_SCREEN, FAKE_IMU] });
    const sent = () => p.received.filter((m) => m.t === "req").length;
    const before = sent();
    const output = await r.twin("run_loop", {
      rate_hz: 20,
      duration_ms: 1000,
      signals: { roll: { device: "desk.imu", channel: "roll_deg" } },
      outputs: [{ device: "desk.screen", command: "clear", terms: [{ signal: "roll", gain: 1 }] }],
    });
    expect(output).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(output.error.message).toContain("loop inputs only");
    const asked = await r.twin("run_loop", {
      rate_hz: 20,
      duration_ms: 1000,
      signals: { width: { device: "desk.camera", channel: "width_px" } },
      outputs: [{ device: "left_wheel", command: "run_time", terms: [{ signal: "width", gain: 0.1 }] }],
    });
    expect(asked).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(asked.error.message).toContain("width_px of desk.camera is not pushed");
    expect(sent()).toBe(before);
    expect((await r.twin("read_all")).robot.activity).toBe("idle");
    // a touch button is an input like a tilt: a boolean reads 0 or 1
    const pressed = await r.twin("run_loop", {
      rate_hz: 5,
      duration_ms: 8000,
      signals: { b1: { device: "desk.touch", channel: "b1" } },
      outputs: [{ device: "left_wheel", command: "run_time", terms: [{ signal: "b1", gain: 10 }] }],
      guards: [{ name: "pressed", signal: "b1", op: "gt", value: 0.5 }],
    });
    expect(pressed).toMatchObject({ ok: true, data: { state: "running" } });
    p.press();
    const end = await r.twin("supervise_loop", { wait_ms: 5000 });
    expect(end.data).toMatchObject({ state: "ended", reason: "guard", guard: "pressed" });
    // the robot without a body runs no loop: it has nothing to drive
    expect((await r.call("describe_robot", { robot_id: "pages" })).data.loop).toBeNull();
  }, 30_000);

  test("a device reported down answers device_offline for it alone", async () => {
    const r = await rig();
    const p = await r.joined();
    p.down("camera", "its camera track ended");
    await until(
      "the camera to be down",
      async () => !(await r.twin("read_device", { device: "eyes", channels: ["width_px"] })).ok,
    );
    const e = await r.twin("read_device", { device: "eyes", channels: ["frame"] });
    expect(e).toMatchObject({ ok: false, error: { code: "device_offline" } });
    expect(e.error.message).toContain("its camera track ended");
    expect((await r.twin("read_device", { device: "desk.touch" })).ok).toBe(true);
    p.up("camera");
    await until(
      "the camera back",
      async () => (await r.twin("read_device", { device: "eyes", channels: ["width_px"] })).ok,
    );
  });

  test("socket closed: asleep at once, gone after the bound, its devices leave the registry", async () => {
    const r = await rig({ gone_ms: 300 });
    const p = await r.joined();
    p.close();
    await until("asleep", async () => (await r.twin("describe_robot")).data.pages[0].state === "asleep");
    expect((await r.twin("read_device", { device: "desk.touch" })).error.code).toBe("device_offline");
    await until("gone", async () => (await r.twin("describe_robot")).data.pages[0].state === "gone", 3000);
    const d = await r.twin("describe_robot");
    expect(d.data.pages[0]).toMatchObject({ name: "desk", state: "gone", devices: [] });
    expect(d.data.devices.some((x: { id: string }) => x.id.startsWith("desk."))).toBe(false);
    expect((await r.twin("read_device", { device: "desk.touch" })).error.code).toBe("unknown_device");
    expect(r.pageEvents().map((e) => e.to)).toEqual(["announced", "active", "asleep", "gone"]);
  });

  test("a page that joins again under its name within the bound takes its place", async () => {
    const r = await rig();
    const p = await r.joined();
    p.close();
    await until("asleep", async () => (await r.twin("describe_robot")).data.pages[0].state === "asleep");
    await r.joined();
    const d = await r.twin("describe_robot");
    expect(d.data.pages.length).toBe(1);
    expect((await r.twin("read_device", { device: "desk.touch" })).ok).toBe(true);
  });

  test("a socket dropped without a close frame: the page joins again under its name and takes its place at once", async () => {
    const r = await rig();
    const p = await r.joined();
    // the phone's socket is gone, and the process never saw it close: no close frame, no answer to a ping
    p.silence();
    const t0 = Date.now();
    const again = await r.joined();
    expect(Date.now() - t0).toBeLessThan(1000);
    // the old socket is closed with a code a page does not retry
    expect(await p.closed).toMatchObject({ code: 4008 });
    const d = await r.twin("describe_robot");
    expect(d.data.pages).toEqual([expect.objectContaining({ name: "desk", state: "active" })]);
    expect(d.data.devices.map((x: { id: string }) => x.id)).toContain("desk.touch");
    const waiting = r.twin("wait_until", {
      condition: { device: "desk.touch", channel: "b1", op: "eq", value: true },
      timeout_ms: 3000,
    });
    setTimeout(() => again.press(), 100);
    expect((await waiting).data).toMatchObject({ met: true });
    expect(r.pageEvents().map((e) => e.to)).toEqual(["announced", "active", "asleep", "announced", "active"]);
  });

  test("a hello under a page's name with a wrong token displaces nothing", async () => {
    const r = await rig();
    const p = await r.joined();
    const stranger = await r.page({ token: "not-the-token" });
    expect(await stranger.closed).toMatchObject({ code: 4001 });
    const d = await r.twin("describe_robot");
    expect(d.data.pages).toEqual([expect.objectContaining({ name: "desk", state: "active" })]);
    const waiting = r.twin("wait_until", {
      condition: { device: "desk.touch", channel: "b1", op: "eq", value: true },
      timeout_ms: 3000,
    });
    setTimeout(() => p.press(), 100);
    expect((await waiting).data).toMatchObject({ met: true });
  });

  test("a runtime built again finds the page's devices where they were", async () => {
    const r = await rig();
    await r.joined();
    const robot = r.fleet.robots[0]!;
    robot.detach("test: the link closed");
    const s = loadConfig(["--twin"]).robots[0] as Parameters<typeof twinRuntime>[0];
    await robot.attach(twinRuntime(s, undefined, r.fleet.hubs.get("r1-sim")).runtime);
    const d = await r.twin("describe_robot");
    expect(d.data.devices.map((x: { id: string }) => x.id)).toContain("desk.camera");
    expect((await r.twin("read_device", { device: "desk.touch" })).ok).toBe(true);
  });

  test("refused: a wrong token (4001), an unknown robot (4004), a refused manifest (4010), no hello (4000)", async () => {
    const r = await rig({ hello_ms: 300 });
    expect(await (await r.page({ token: "x".repeat(22) })).closed).toMatchObject({ code: 4001 });
    expect(await (await r.page({ robot: "nope" })).closed).toMatchObject({ code: 4004 });
    const moving = structuredClone((await import("./pages")).FAKE_DEVICES);
    moving[2]!.commands[0]!.moves = true;
    const refused = await (await r.page({ devices: moving })).closed;
    expect(refused.code).toBe(4010);
    expect(refused.reason).toContain("devices.speaker.commands[0].moves");
    // a socket that never says hello
    const base = new URL(r.url);
    const mute = new WebSocket(`ws://${base.host}/page`, {
      headers: { Origin: `http://${base.host}` },
    } as unknown as string[]);
    const code = await new Promise<number>((resolve) => mute.addEventListener("close", (e) => resolve(e.code)));
    expect(code).toBe(4000);
    expect(r.pageEvents()).toEqual([]);
  });

  test("refused: a foreign Origin and a foreign Host get 403", async () => {
    const r = await rig();
    const base = new URL(r.url);
    const foreign = await r.page({ origin: "http://evil.example" });
    expect((await foreign.closed).code).not.toBe(1000);
    await expect(foreign.joined).rejects.toThrow();
    // the Host header written by hand, on a raw socket: the request reaches the listener with that Host
    const status = await new Promise<string>((resolve, reject) => {
      const sock = connect(Number(base.port), "127.0.0.1", () =>
        sock.write(`GET / HTTP/1.1\r\nHost: evil.example:${base.port}\r\nConnection: close\r\n\r\n`),
      );
      let text = "";
      sock.on("data", (b) => (text += b.toString()));
      sock.on("end", () => resolve(text.split("\r\n")[0]!));
      sock.on("error", reject);
    });
    expect(status).toContain("403");
    const good = await fetch(r.url);
    expect(good.status).toBe(200);
    expect(good.headers.get("content-security-policy")).toBe("default-src 'self'; connect-src 'self'");
  });

  test("at most 8 pages per process (4029); more than 100 messages in a second closes the page (4000)", async () => {
    const r = await rig();
    const eight = await Promise.all(Array.from({ length: 8 }, (_, i) => r.page({ robot: "pages", name: `p${i}` })));
    await Promise.all(eight.map((p) => p.joined));
    expect(await (await r.page({ robot: "pages", name: "p8" })).closed).toMatchObject({ code: 4029 });
    const loud = eight[0]!;
    for (let i = 0; i < 101; i++)
      loud.raw(JSON.stringify({ t: "state", device: "touch", values: { b1: i % 2 === 0 } }));
    expect(await loud.closed).toMatchObject({ code: 4000, reason: "more than 100 messages in one second" });
  }, 15_000);

  test("nothing listens beyond 127.0.0.1: the page port on a non-loopback address refuses the connection", async () => {
    const r = await rig();
    const port = Number(new URL(r.url).port);
    const address = Object.values(networkInterfaces())
      .flat()
      .find((a) => a && a.family === "IPv4" && !a.internal)?.address;
    if (!address) throw new Error("this machine has no non-loopback IPv4 address to test the listener against");
    const outcome = await new Promise<string>((resolve) => {
      const sock = connect({ host: address, port, timeout: 1500 }, () => {
        sock.destroy();
        resolve("connected");
      });
      sock.on("error", (e) => resolve(`refused: ${(e as NodeJS.ErrnoException).code}`));
      sock.on("timeout", () => {
        sock.destroy();
        resolve("no answer");
      });
    });
    expect(outcome).not.toBe("connected");
  }, 15_000);
});

/** The rig with the default times. */
const r0 = () => rig({});

describe("peripheral pages over MCP", () => {
  test("a frame reaches the client as an image block; the result matches its outputSchema", async () => {
    const s = await startServer(["--twin", "--pages", "--page-port", "0"]);
    const entry: { pages: FakePage[]; server: TestServer } = { pages: [], server: s };
    open.push(entry);
    const listed = await s.tool("list_robots");
    const url = (listed.envelope as any).data.robots[0].join.match(/http:\/\/127\.0\.0\.1:\d+\//)[0] as string;
    const p = await fakePage({ url, robot: "r1-sim", frame: testJpeg(320, 240) });
    entry.pages.push(p);
    await p.joined;
    await until("the page to be active", async () => {
      const d = await s.tool("describe_robot", { robot_id: "r1-sim" });
      return d.envelope.ok && d.envelope.data.pages[0]?.state === "active";
    });
    const out = await s.tool("read_device", { robot_id: "r1-sim", device: "desk.camera", channels: ["frame"] });
    expect(out.envelope.ok).toBe(true);
    expect(out.content[1]).toEqual({
      type: "image",
      data: Buffer.from(testJpeg(320, 240)).toString("base64"),
      mimeType: "image/jpeg",
    });
    expect(s.stderr.some((l) => l.includes("pages join the robots on"))).toBe(true);
  }, 15_000);
});

// the defaults the contract states
test("the page machine's times are the contract's", () => {
  expect(PAGE_TIMES).toMatchObject({
    ping_ms: 1000,
    watched_ping_ms: 100,
    asleep_ms: 3000,
    gone_ms: 30_000,
    hello_ms: 3000,
  });
});
