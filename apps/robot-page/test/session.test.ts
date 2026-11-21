import { afterEach, describe, expect, test } from "bun:test";
import type { RuntimeToRelay } from "../../../packages/protocol/types";
import {
  createSession,
  DEVICE_TRANSITIONS,
  MAX_CALLS,
  type Session,
  type SessionEnv,
  type Snapshot,
} from "../src/session";
import { fakeHid, fakeHidDevice, fakeRelay, pageConfig, until } from "./fakes";

const open: { session?: Session; relay?: ReturnType<typeof fakeRelay> }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    o.session?.dispose();
    await o.relay?.die();
  }
});

/** A page with a granted fake EV3 and a fake relay. Short timers, so nothing waits for real seconds. */
function setup(o: { env?: Partial<SessionEnv>; refuse?: { code: number; reason: string }; granted?: boolean } = {}) {
  const ev3 = fakeHidDevice();
  const usb = fakeHid(o.granted === false ? { chooser: [ev3.device] } : { granted: [ev3.device] });
  const relay = fakeRelay(o.refuse ? { refuse: o.refuse } : {});
  const seen: Snapshot[] = [];
  const session = createSession({
    hid: usb.hid,
    pollMs: 5,
    reconnectMs: 30,
    onChange: (s) => seen.push(s),
    ...o.env,
  });
  open.push({ session, relay });
  const online = async () => {
    await session.connect(pageConfig(relay.url), { prompt: true });
    await until("link online", () => session.snapshot().link === "online");
  };
  return { ev3, usb, relay, session, seen, online };
}
const hello = (frames: RuntimeToRelay[]) =>
  frames.find((m) => m.t === "hello") as Extract<RuntimeToRelay, { t: "hello" }>;

describe("device state machine", () => {
  test("every state has a row and no state reaches unsupported", () => {
    for (const [from, next] of Object.entries(DEVICE_TRANSITIONS)) {
      expect(next).not.toContain("unsupported");
      expect(next).not.toContain(from);
    }
    expect(DEVICE_TRANSITIONS.unsupported).toEqual([]);
  });
  test("without WebHID the page says so and connect does nothing", async () => {
    const session = createSession({});
    open.push({ session });
    expect(session.snapshot().device).toBe("unsupported");
    expect(session.snapshot().problem?.code).toBe("webhid_unsupported");
    await session.connect(pageConfig("ws://127.0.0.1:1/ws/robot"), { prompt: true });
    expect(session.snapshot().device).toBe("unsupported");
    expect(await session.stop()).toBe(false);
  });
});

describe("connect", () => {
  test("the button asks for the EV3, opens it and goes online with the profile and the token in hello", async () => {
    const { session, relay, usb, ev3, seen, online } = setup({ granted: false });
    await online();
    expect(usb.hid.requests).toBe(1);
    expect(ev3.device.opened).toBe(true);
    const s = session.snapshot();
    expect(s.device).toBe("ready");
    expect(s.deviceName).toBe("EV3 fake");
    expect(s.problem).toBeNull();
    expect(seen.map((x) => x.link)).toContain("handshaking");
    const h = hello(relay.received);
    expect(h.robot_id).toBe("test-ev3");
    expect(h.token).toBe("secret-token");
    expect(h.backend).toBe("ev3");
    expect(h.profile.id).toBe("test-ev3");
    expect(h.devices.map((d) => d.id)).toEqual(expect.arrayContaining(["ev3.B", "ev3.C", "ev3.pair", "ev3.battery"]));
    // the token travels in the hello frame, never in the address
    expect(relay.urls.every((u) => u.includes("robot_id=test-ev3") && !u.includes("secret-token"))).toBe(true);
  });
  test("a later visit reconnects to the granted EV3 without the chooser", async () => {
    const { session, relay, usb } = setup();
    await session.connect(pageConfig(relay.url), { prompt: false });
    await until("link online", () => session.snapshot().link === "online");
    expect(usb.hid.requests).toBe(0);
  });
  test("no granted EV3 and no gesture, or a closed chooser, is not an error", async () => {
    const usb = fakeHid({ chooser: [] });
    const session = createSession({ hid: usb.hid });
    open.push({ session });
    await session.connect(pageConfig("ws://127.0.0.1:1/ws/robot"), { prompt: false });
    expect(usb.hid.requests).toBe(0);
    expect(session.snapshot()).toMatchObject({ device: "none", problem: null });
    await session.connect(pageConfig("ws://127.0.0.1:1/ws/robot"), { prompt: true });
    expect(usb.hid.requests).toBe(1);
    expect(session.snapshot()).toMatchObject({ device: "none", problem: null });
  });
  test("an EV3 held by another program is reported as busy", async () => {
    const { session, relay, ev3 } = setup();
    ev3.device.openError = new Error("Failed to open the device.");
    await session.connect(pageConfig(relay.url), { prompt: true });
    const s = session.snapshot();
    expect(s.device).toBe("none");
    expect(s.problem).toEqual({ code: "device_busy", detail: "Failed to open the device." });
    expect(relay.received).toEqual([]);
    // the other program lets go: the same button works
    ev3.device.openError = null;
    await session.connect(pageConfig(relay.url), { prompt: true });
    expect(session.snapshot()).toMatchObject({ device: "ready", problem: null });
  });
  test("a brick that does not answer is reported and the device is released", async () => {
    const { session, relay, ev3 } = setup();
    ev3.brick.dropNext(1000);
    await session.connect(pageConfig(relay.url), { prompt: true });
    expect(session.snapshot()).toMatchObject({ device: "none", problem: { code: "brick_silent" } });
    expect(ev3.device.opened).toBe(false);
  });
  test("a profile the runtime rejects is a config problem", async () => {
    const { session, relay, ev3 } = setup();
    const cfg = pageConfig(relay.url);
    cfg.robot = { ...cfg.robot, hardware: { ...cfg.robot.hardware, tone_volume_pct: 500 } };
    await session.connect(cfg, { prompt: true });
    expect(session.snapshot()).toMatchObject({ device: "none", problem: { code: "config" } });
    expect(ev3.device.opened).toBe(false);
  });
  test("a refusal by the relay is shown and not retried", async () => {
    const { session, relay } = setup({
      refuse: { code: 4001, reason: "unauthorized: token is not valid for this robot" },
    });
    await session.connect(pageConfig(relay.url), { prompt: true });
    await until("refused", () => session.snapshot().problem?.code === "relay_refused");
    const s = session.snapshot();
    expect(s.problem?.detail).toContain("unauthorized");
    expect(s.link).toBe("offline");
    expect(s.device).toBe("ready"); // the cable still works, and so does STOP
    await new Promise((r) => setTimeout(r, 150)); // five reconnect periods
    expect(relay.urls.length).toBe(1);
  });
  test("an unreachable relay keeps retrying and STOP still works", async () => {
    const { session, relay, ev3 } = setup();
    await relay.die();
    await session.connect(pageConfig(relay.url), { prompt: true });
    await until("a failed attempt", () => session.snapshot().linkDetail.startsWith("code"));
    expect(session.snapshot()).toMatchObject({ device: "ready", link: "offline", problem: null });
    expect(await session.stop()).toBe(true);
    expect(ev3.brick.busy()).toBe(false);
  });
});

describe("live panel", () => {
  test("devices and their channels update; the battery is read from the brick", async () => {
    const { session, ev3, online } = setup();
    ev3.brick.setSensor(1, 16, 0); // touch on S1
    await online();
    await until("battery read", () => session.snapshot().battery?.voltage_v !== null);
    expect(session.snapshot().battery).toEqual({ voltage_v: expect.closeTo(7.9, 1), low: false });
    const touch = () => session.snapshot().devices.find((d) => d.id === "ev3.S1");
    await until("touch read", () => touch()?.channels.find((c) => c.name === "pressed")?.value === false);
    expect(touch()?.kind).toBe("touch");
    ev3.brick.setSensor(1, 16, 1);
    await until("touch pressed", () => touch()?.channels.find((c) => c.name === "pressed")?.value === true);
    // the page's own reads are not tool calls
    expect(session.snapshot().calls).toEqual([]);
  });
  test("a sensor plugged in later appears and is announced to the relay", async () => {
    const { session, relay, ev3, online } = setup({ env: { rescanMs: 30 } });
    await online();
    expect(session.snapshot().devices.some((d) => d.id === "ev3.S4")).toBe(false);
    ev3.brick.setSensor(4, 30, 42); // ultrasonic on S4
    await until("S4 listed", () => session.snapshot().devices.some((d) => d.id === "ev3.S4"));
    await until("devices frame", () =>
      relay.received.some((m) => m.t === "devices" && m.devices.some((d) => d.id === "ev3.S4")),
    );
  });
  test("relay calls show up with tool, reason and ms; errors show their code; only the last 20 stay", async () => {
    const { session, relay, ev3, online } = setup();
    await online();
    const moved = await relay.call("drive", { distance_cm: 3, speed_pct: 30 });
    expect(moved.ok).toBe(true);
    expect(ev3.brick.tacho("B")).toBeGreaterThan(0);
    const failed = await relay.call("read_device", { device: "ev3.nope" });
    expect(failed.ok).toBe(false);
    const [last, first] = session.snapshot().calls;
    expect(first).toMatchObject({ tool: "drive", ok: true });
    expect(typeof first!.reason).toBe("string");
    expect(first!.ms).toBeGreaterThan(0);
    expect(last).toMatchObject({ tool: "read_device", reason: "unknown_device", ok: false });
    expect(session.snapshot().activity).toBe("idle");
    for (let i = 0; i < MAX_CALLS + 3; i++) await relay.call("describe_robot", {});
    const calls = session.snapshot().calls;
    expect(calls.length).toBe(MAX_CALLS);
    expect(calls.every((c) => c.tool === "describe_robot" && c.reason === "ok")).toBe(true);
  });
  test("while a call runs the page shows it", async () => {
    const { session, relay, seen, online } = setup();
    await online();
    await relay.call("drive", { distance_cm: 5, speed_pct: 30 });
    expect(seen.some((s) => s.activity === "busy" && s.tool === "drive")).toBe(true);
    expect(session.snapshot()).toMatchObject({ activity: "idle", tool: null });
  });
});

describe("stop", () => {
  test("STOP brakes from the page alone: the relay is up and takes no part", async () => {
    const { session, relay, ev3, online } = setup();
    await online();
    const drive = relay.call("drive", { distance_cm: 80, speed_pct: 50 });
    await until("motors running", () => ev3.brick.busy());
    const t0 = Date.now();
    expect(await session.stop("local")).toBe(true);
    expect(ev3.brick.busy()).toBe(false);
    await drive; // the call in flight ends at once instead of running its 80 cm
    expect(Date.now() - t0).toBeLessThan(1500);
    const before = ev3.brick.tacho("B");
    await new Promise((r) => setTimeout(r, 300));
    expect(ev3.brick.tacho("B")).toBe(before);
    expect(relay.received.some((m) => m.t === "stopped")).toBe(false);
    const s = session.snapshot();
    expect(s.lastStop).toEqual({ why: "local", motors_stopped: true });
    expect(s.calls.find((c) => c.tool === "stop")).toMatchObject({ reason: "local", ok: true });
    expect(s.link).toBe("online");
  });
  test("STOP brakes locally while the server is unreachable", async () => {
    const { session, relay, ev3, online } = setup();
    await online();
    void relay.call("drive", { distance_cm: 80, speed_pct: 50 });
    await until("motors running", () => ev3.brick.busy());
    await relay.die();
    expect(await session.stop("local")).toBe(true);
    expect(ev3.brick.busy()).toBe(false);
    const before = ev3.brick.tacho("B");
    await new Promise((r) => setTimeout(r, 300));
    expect(ev3.brick.tacho("B")).toBe(before);
    // the socket closing stops once more, later: the local stop is in the list either way
    expect(session.snapshot().calls.find((c) => c.reason === "local")).toMatchObject({ tool: "stop", ok: true });
    expect(session.snapshot().problem).toBeNull();
    await until("link offline", () => session.snapshot().link === "offline");
  });
  test("a stop from the relay is answered and shown", async () => {
    const { session, relay, online } = setup();
    await online();
    expect((await relay.stop()).motors_stopped).toBe(true);
    await until("shown", () => session.snapshot().lastStop?.why === "relay");
    expect(session.snapshot().calls[0]).toMatchObject({ tool: "stop", reason: "relay", ok: true });
  });
  test("a tab hidden longer than the limit stops the motors; a shorter glance does not", async () => {
    const { session, relay, ev3, online } = setup({ env: { hiddenStopMs: 80 } });
    await online();
    session.setHidden(true);
    await new Promise((r) => setTimeout(r, 30));
    session.setHidden(false);
    await new Promise((r) => setTimeout(r, 120));
    expect(session.snapshot().lastStop).toBeNull();
    void relay.call("drive", { distance_cm: 80, speed_pct: 50 });
    await until("motors running", () => ev3.brick.busy());
    session.setHidden(true);
    await until("stopped", () => session.snapshot().lastStop?.why === "hidden");
    expect(session.snapshot().lastStop?.motors_stopped).toBe(true);
    expect(ev3.brick.busy()).toBe(false);
  });
  test("closing the page stops the motors", async () => {
    const { session, relay, ev3, online } = setup();
    await online();
    void relay.call("drive", { distance_cm: 80, speed_pct: 50 });
    await until("motors running", () => ev3.brick.busy());
    session.pageHide();
    await until("stopped", () => session.snapshot().lastStop?.why === "pagehide");
    expect(ev3.brick.busy()).toBe(false);
  });
  test("a stop that cannot be verified is a visible problem", async () => {
    const { session, ev3, online } = setup();
    await online();
    ev3.unplug(); // the cable is out but the browser has not said so yet
    expect(await session.stop()).toBe(false);
    const s = session.snapshot();
    expect(s.problem?.code).toBe("stop_unverified");
    expect(s.calls[0]).toMatchObject({ tool: "stop", ok: false });
  });
  test("the relay going silent stops the motors (the runtime client's heartbeat watchdog)", async () => {
    const { session, relay, ev3, online } = setup({ env: { client: { heartbeat_ms: 50, heartbeat_timeout_ms: 400 } } });
    await online();
    void relay.call("drive", { distance_cm: 80, speed_pct: 50 });
    await until("motors running", () => ev3.brick.busy());
    relay.goSilent(); // the socket stays open: only the missing heartbeats can tell
    await until("stopped", () => session.snapshot().lastStop !== null);
    expect(session.snapshot().lastStop).toEqual({ why: "heartbeat_lost", motors_stopped: true });
    expect(ev3.brick.busy()).toBe(false);
  });
});

describe("unplug", () => {
  test("pulling the cable goes offline; plugging it back reconnects without a gesture", async () => {
    const { session, relay, usb, ev3, online } = setup();
    await online();
    ev3.unplug();
    usb.fire("disconnect", ev3.device);
    await until("lost", () => session.snapshot().device === "lost");
    const s = session.snapshot();
    expect(s.link).toBe("offline");
    expect(s.devices).toEqual([]);
    expect(s.battery).toBeNull();
    expect(ev3.device.opened).toBe(false);
    ev3.plug();
    usb.fire("connect", ev3.device);
    await until("back online", () => session.snapshot().link === "online" && session.snapshot().device === "ready");
    expect(usb.hid.requests).toBe(0);
    expect(relay.received.filter((m) => m.t === "hello").length).toBe(2);
  });
  test("another device unplugging changes nothing", async () => {
    const { session, usb, online } = setup();
    await online();
    usb.fire("disconnect", fakeHidDevice().device);
    await new Promise((r) => setTimeout(r, 30));
    expect(session.snapshot()).toMatchObject({ device: "ready", link: "online" });
  });
  test("a second connect while the first is closing or opening is ignored, not an illegal transition", async () => {
    const { session, relay, online } = setup();
    await online();
    const cfg = pageConfig(relay.url);
    await Promise.all([session.connect(cfg, { prompt: true }), session.connect(cfg, { prompt: true })]);
    await until("online again", () => session.snapshot().link === "online");
    expect(session.snapshot()).toMatchObject({ device: "ready", problem: null });
  });
  test("disconnect brakes, closes the device and the socket; dispose removes the listeners", async () => {
    const { session, usb, ev3, online } = setup();
    await online();
    await session.disconnect();
    expect(session.snapshot()).toMatchObject({ device: "none", link: "offline" });
    expect(ev3.device.opened).toBe(false);
    session.dispose();
    expect(usb.listeners.connect.length + usb.listeners.disconnect.length).toBe(0);
  });
});
