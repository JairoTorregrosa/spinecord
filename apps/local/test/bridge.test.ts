// The stock EV3 link end to end, without a browser and without a brick: the page's own bridge code
// (apps/robot-page/src/bridge.ts) over a real WebSocket to this process's server, a fake EV3 behind a fake WebHID.
import { afterEach, describe, expect, test } from "bun:test";
import { OP } from "../../../packages/driver-ev3/encode";
import { startBridge, type Bridge, type BridgeSocket } from "../../robot-page/src/bridge";
import { fakeHid, fakeHidDevice } from "../../robot-page/test/fakes";
import { EXAMPLE, loadConfig } from "../src/config";
import { serveBridge } from "../src/hid-bridge";
import { buildFleet, type Fleet } from "../src/sources";
import { callTool } from "../src/tools";
import { until } from "./client";

const PAGE = { html: "<!doctype html><title>bridge</title>", js: "" };
const open: { fleet?: Fleet; page?: Bridge }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.page?.dispose();
    await o.fleet?.shutdown();
  }
});

async function rig() {
  const events: string[] = [];
  const fleet = await buildFleet(loadConfig(["--ev3", EXAMPLE.robot]), {
    log: (ev) => void events.push(ev),
    page: PAGE,
    port: 0,
  });
  const usb = fakeHidDevice();
  const { hid } = fakeHid({ granted: [usb.device] });
  const bridge = fleet.bridge!;
  const openPage = (origin = bridge.url.slice(0, -1)) =>
    startBridge({
      hid,
      url: `ws://127.0.0.1:${bridge.port}/hid`,
      openSocket: (url) =>
        new WebSocket(url, { headers: { Origin: origin } } as unknown as string[]) as unknown as BridgeSocket,
      onStatus: () => {},
      retryMs: 50,
    });
  const entry: { fleet: Fleet; page?: Bridge } = { fleet };
  open.push(entry);
  const tool = async (name: string, args: Record<string, unknown> = {}) =>
    (await callTool(fleet.robots, name, { robot_id: "r1", ...args })).envelope;
  const online = () => until("the robot to be online", () => fleet.robots[0]!.view().link === "online");
  return { fleet, bridge, usb, events, openPage, entry, tool, online };
}

describe("a stock EV3 lent by the page", () => {
  test("offline until the page opens an EV3; then the real provider drives it through the socket", async () => {
    const r = await rig();
    const offline = await r.tool("read_all");
    expect(offline).toMatchObject({ ok: false, error: { code: "robot_offline" }, robot: { link: "offline" } });
    expect(!offline.ok && offline.error.message).toContain(r.bridge.url);
    expect((await callTool(r.fleet.robots, "list_robots", {})).envelope).toMatchObject({
      data: [{ id: "r1", link: "offline", backend: null }],
    });

    r.entry.page = r.openPage();
    await r.online();
    expect(await r.tool("describe_robot")).toMatchObject({
      ok: true,
      data: { backend: "ev3" },
      robot: { link: "online" },
    });
    const before = r.usb.brick.motors[1]!.pos;
    const drive = await r.tool("drive", { distance_cm: 5, speed_pct: 40 });
    expect(drive).toMatchObject({ ok: true, data: { reason: "completed" } });
    expect(r.usb.brick.motors[1]!.pos).toBeGreaterThan(before);
    expect(r.usb.brick.overlaps).toBe(0);
    expect(await r.tool("stop")).toMatchObject({ ok: true, data: { motors_stopped: true } });
  });

  test("the page closes mid-move: the call ends, the robot is offline; a new page brings it back", async () => {
    const r = await rig();
    r.entry.page = r.openPage();
    await r.online();
    const move = r.tool("drive", { distance_cm: 60, speed_pct: 20 });
    await until("the wheels to turn", () => r.usb.brick.motors[1]!.speedPct !== 0);
    await r.entry.page.dispose();
    const dropped = await move;
    // the move had started: it is not to be sent again blindly
    expect(dropped).toMatchObject({ ok: false, error: { retryable: false } });
    expect(dropped.next[0]).toBe("read_all");
    expect(dropped.next).not.toContain("drive");
    expect(!dropped.ok && dropped.error.message).toContain("may have partly happened");
    await until("the robot to be offline", () => r.fleet.robots[0]!.view().link === "offline");
    expect(r.fleet.robots[0]!.view().activity).toBe("idle");
    r.entry.page = r.openPage();
    await r.online();
    expect(await r.tool("drive", { distance_cm: 3, speed_pct: 40 })).toMatchObject({ ok: true });
  });

  test("the process goes away: the page brakes every motor by itself", async () => {
    const r = await rig();
    r.entry.page = r.openPage();
    await r.online();
    void r.tool("drive", { distance_cm: 60, speed_pct: 20 });
    await until("the wheels to turn", () => r.usb.brick.motors[1]!.speedPct !== 0);
    r.bridge.stop(); // as when the process is killed: the socket closes, nothing is said
    await until("the page's brake to reach the brick", () =>
      r.usb.brick.sent.some((s) => s.type === 0x80 && s.packet[7] === OP.OUTPUT_STOP),
    );
    expect(r.entry.page.status().socket).not.toBe("open");
  });

  test("the automatic open and the button together open the EV3 once", async () => {
    const r = await rig();
    const { hid } = fakeHid({ granted: [r.usb.device], chooser: [r.usb.device] });
    const errors: unknown[] = [];
    const page = startBridge({
      hid,
      url: `ws://127.0.0.1:${r.bridge.port}/hid`,
      openSocket: (url) =>
        new WebSocket(url, {
          headers: { Origin: r.bridge.url.slice(0, -1) },
        } as unknown as string[]) as unknown as BridgeSocket,
      onStatus: () => {},
    });
    r.entry.page = page;
    await page.choose().catch((e) => errors.push(e));
    await r.online();
    expect(errors).toEqual([]);
    expect(page.status().device).toBe("ready");
    // one listener: each reply reaches the process once, so the link sees no stray packets
    expect(await r.tool("drive", { distance_cm: 3, speed_pct: 40 })).toMatchObject({ ok: true });
  });

  test("the socket is only for the page served here, and for one page", async () => {
    const r = await rig();
    const stranger = r.openPage("http://example.com");
    r.entry.page = stranger;
    await new Promise((res) => setTimeout(res, 200));
    expect(stranger.status().socket).not.toBe("open");
    expect(r.fleet.robots[0]!.view().link).toBe("offline");
    await stranger.dispose();

    r.entry.page = r.openPage();
    await r.online();
    const second = r.openPage();
    await until("the second tab to be refused", () => second.status().taken);
    // refused after the upgrade, with a code and a reason the page shows
    expect(second.status()).toMatchObject({ taken: true, detail: "another tab already holds the robot" });
    expect(second.status().socket).not.toBe("open");
    expect(r.fleet.robots[0]!.view().link).toBe("online");
    // the refused tab has the same EV3 open and asks again every 50 ms: while the first tab drives for about
    // a second, no brake of the second tab reaches the brick
    const move = await r.tool("drive", { distance_cm: 15, speed_pct: 30 });
    expect(move).toMatchObject({ ok: true, data: { reason: "completed" } });
    expect(r.usb.brick.sent.filter((p) => p.type === 0x80)).toEqual([]);
    await second.dispose();
  });

  test("the server answers on 127.0.0.1 with the page; a taken port fails loud", async () => {
    const r = await rig();
    expect(r.bridge.url).toBe(`http://127.0.0.1:${r.bridge.port}/`);
    const page = await fetch(r.bridge.url);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${r.bridge.url}bridge.js`)).status).toBe(200);
    expect((await fetch(`${r.bridge.url}other`)).status).toBe(404);
    expect(() => serveBridge(PAGE, r.bridge.port, { onDevice: () => {}, onGone: () => {} })).toThrow(
      `cannot listen on 127.0.0.1:${r.bridge.port}`,
    );
  });

  test("the real page builds", async () => {
    const { buildBridgePage } = await import("../../robot-page/bridge-build");
    const page = await buildBridgePage();
    expect(page.js.length).toBeGreaterThan(500);
    const ids = new Set([...page.html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const main = await Bun.file(new URL("../../robot-page/src/bridge-main.ts", import.meta.url)).text();
    for (const m of main.matchAll(/\bel(?:<[^>]+>)?\("([^"]+)"\)/g)) expect(ids.has(m[1])).toBe(true);
    expect(page.html).toContain('src="bridge.js"');
  });
});
