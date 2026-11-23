// The real peripheral page (apps/peripheral-page: its kit and shipped kinds over a fake browser) against the page
// listener and the hub, over a real WebSocket, through the tools a model calls (CONTRACT §2.4). The browser part
// that needs pixels and a sound card is measured by bench/peripheral-page.ts in a real Chrome.
import { afterEach, describe, expect, test } from "bun:test";
import { firstViolation } from "../../../packages/protocol/schema";
import { createPage, type Page } from "../../peripheral-page/src/page";
import { fakeBrowser, type FakeBrowserOptions } from "../../peripheral-page/test/fakes";
import { loadConfig } from "../src/config";
import { buildFleet, type Fleet } from "../src/sources";
import { TOOL, callTool } from "../src/tools";
import type { PageTimes } from "../src/pages";
import { until } from "./client";
import { servedToken } from "./pages";

const open: { fleet: Fleet; pages: Page[] }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    for (const p of o.pages) p.kit.close();
    await o.fleet.shutdown();
  }
});

async function rig(pageTimes: Partial<PageTimes> = {}) {
  const fleet = await buildFleet(loadConfig(["--twin", "--pages"]), { log: () => {}, pagePort: 0, pageTimes });
  const entry = { fleet, pages: [] as Page[] };
  open.push(entry);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const out = await callTool(fleet.robots, name, { robot_id: "r1-sim", ...args });
    const bad = firstViolation(TOOL.get(name)!.output, out.envelope);
    if (bad) throw new Error(`${name}: the envelope does not match its outputSchema: ${bad}`);
    return Object.assign(out.envelope, { image: out.image });
  };
  const listed = (await callTool(fleet.robots, "list_robots", {})).envelope as any;
  const url = String(listed.data.robots[0].join).match(/http:\/\/127\.0\.0\.1:\d+\//)![0];
  /** The page as a person opens it: the served token, a tap, the robot r1-sim. */
  const lend = async (o: FakeBrowserOptions = {}, name = "desk") => {
    const browser = fakeBrowser(o);
    const host = new URL(url).host;
    // a locked phone: its page runs no script, so the process's messages wait unanswered
    const life = { frozen: false, visible: true };
    const page = createPage({
      win: browser.win,
      url: `ws://${host}/page`,
      token: await servedToken(url),
      openSocket: (u) => {
        const ws = new WebSocket(u, { headers: { Origin: `http://${host}` } } as unknown as string[]);
        const add = ws.addEventListener.bind(ws) as (t: string, cb: (ev: unknown) => void) => void;
        (ws as unknown as { addEventListener: typeof add }).addEventListener = (t, cb) =>
          add(t, (ev) => (t === "message" && life.frozen ? undefined : cb(ev)));
        return ws as never;
      },
      visible: () => life.visible,
      lang: "es-ES",
      workletUrl: "level.js",
      render: () => {},
      onLabels: () => {},
    });
    entry.pages.push(page);
    await page.lend({ name, robot: "r1-sim" });
    await until("the page to be active", async () => {
      const d = await call("describe_robot");
      return d.data.pages.some((p: { name: string; state: string }) => p.name === name && p.state === "active");
    });
    /** The phone is locked (hidden, frozen) or unlocked (visible, running). */
    const lock = (locked: boolean) => {
      // a browser releases the wake lock of a page it hides
      if (locked) browser.wake.sentinels.at(-1)?.fireRelease();
      life.visible = !locked;
      life.frozen = locked;
      page.visibilityChanged();
    };
    return { page, browser, lock };
  };
  return { call, url, lend };
}

describe("the peripheral page against the listener and the hub", () => {
  test("the listener serves the page, its script, its style and its worklet under the page's CSP", async () => {
    const r = await rig();
    const html = await fetch(r.url);
    expect(html.headers.get("content-security-policy")).toBe("default-src 'self'; connect-src 'self'");
    const text = await html.text();
    expect(text).toContain('<script type="module" src="page.js"></script>');
    expect(text).toMatch(/<meta name="spinecord-robots" content="r1-sim pages">/);
    expect(text).not.toContain("spinecord:meta");
    for (const [file, type] of [
      ["page.js", "text/javascript"],
      ["page.css", "text/css"],
      ["level.js", "text/javascript"],
    ] as const) {
      const res = await fetch(new URL(file, r.url));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toStartWith(type);
    }
    expect((await fetch(new URL("page.html", r.url))).status).toBe(404);
    expect((await fetch(new URL("constructor", r.url))).status).toBe(404);
  });

  test("a page joins with what its browser has; describe_robot lists it and what it could not lend", async () => {
    const r = await rig();
    await r.lend({ microphone: "NotAllowedError" });
    const d = await r.call("describe_robot");
    expect(d.data.pages).toEqual([
      {
        name: "desk",
        state: "active",
        devices: ["desk.screen", "desk.touch", "desk.camera", "desk.speaker"],
        unavailable: [
          { kind: "microphone", why: "microphone: the person did not allow it" },
          { kind: "imu", why: "imu: this browser has no motion sensors" },
          { kind: "vibrator", why: "vibrator: this browser has no vibration" },
          {
            kind: "torch",
            why: "torch: the lent camera has no torch the browser can switch (on a phone the torch is usually next to the camera facing environment)",
          },
        ],
        last_seen_ms: expect.any(Number),
      },
    ]);
    expect(d.data.roles).toMatchObject({ eyes: "desk.camera", voice: "desk.speaker", face: "desk.screen" });
  });

  test("a frame, a configure, a speak, a listen matched on the page and last_match read back", async () => {
    const r = await rig();
    const { browser } = await r.lend();
    const frame = await r.call("read_device", { device: "desk.camera", channels: ["frame", "width_px"] });
    expect(frame.ok).toBe(true);
    expect(frame.data.readings[0]).toMatchObject({ channel: "frame", image: true, mime: "image/jpeg" });
    expect(frame.data.readings[1]).toMatchObject({ channel: "width_px", value: 640 });
    expect(frame.image.mime).toBe("image/jpeg");
    const conf = await r.call("command_device", {
      device: "desk.camera",
      command: "configure",
      args: { max_side_px: 320 },
    });
    expect(conf.data.measured).toMatchObject({ width_px: 320, height_px: 180 });

    const said = await r.call("command_device", { device: "voice", command: "speak", args: { text: "hola" } });
    expect(said.data).toMatchObject({ reason: "completed", measured: { spoken: true } });
    expect(browser.spoken.at(-1)!.text).toBe("hola");

    browser.hear({ transcript: "Sí, ya me la tomé", confidence: 0.9 });
    const heard = await r.call("command_device", {
      device: "ears",
      command: "listen",
      args: { max_ms: 3000, expect: ["no", "ya me la tome"] },
    });
    expect(heard.data).toMatchObject({
      reason: "completed",
      measured: { heard: true, transcript: "Sí, ya me la tomé", match: "ya me la tome" },
    });
    const last = await r.call("read_device", { device: "desk.mic", channels: ["last_match", "heard_count"] });
    expect(last.data.readings.map((x: { value: unknown }) => x.value)).toEqual(["ya me la tome", 1]);
  });

  test("a button pressed on the page meets wait_until; a face shows; stop lending takes the camera out", async () => {
    const r = await rig();
    const { page } = await r.lend();
    const waiting = r.call("wait_until", {
      condition: { device: "desk.touch", channel: "b3", op: "eq", value: true },
      timeout_ms: 3000,
    });
    setTimeout(() => page.touch.press(2), 100);
    expect((await waiting).data).toMatchObject({ met: true });
    const face = await r.call("command_device", { device: "face", command: "face", args: { expression: "happy" } });
    expect(face.ok).toBe(true);
    const showing = await r.call("read_device", { device: "desk.screen", channels: ["showing"] });
    expect(showing.data.readings[0].value).toBe("face: happy");

    page.stopLending();
    await until("the camera to leave", async () => {
      const d = await r.call("describe_robot");
      return !d.data.devices.some((x: { id: string }) => x.id === "desk.camera");
    });
    const d = await r.call("describe_robot");
    expect(
      d.data.pages[0].unavailable.filter((u: { kind: string }) => ["camera", "microphone"].includes(u.kind)),
    ).toEqual([
      { kind: "camera", why: "camera: the person stopped lending it" },
      { kind: "microphone", why: "microphone: the person stopped lending it" },
    ]);
    expect((await r.call("read_device", { device: "desk.camera" })).error.code).toBe("unknown_device");
  });

  test("pause makes the page's devices answer device_offline until resume", async () => {
    const r = await rig();
    const { page } = await r.lend();
    page.kit.pause("test");
    await until("the page to sleep", async () => (await r.call("describe_robot")).data.pages[0].state === "asleep");
    const off = await r.call("read_device", { device: "desk.camera", channels: ["frame"] });
    expect(off.error).toMatchObject({ code: "device_offline", retryable: true, retry_after_ms: 2000 });
    page.kit.resume();
    await until("the page to wake", async () => (await r.call("describe_robot")).data.pages[0].state === "active");
    expect((await r.call("read_device", { device: "desk.camera", channels: ["width_px"] })).ok).toBe(true);
  });

  test("a muted camera track: the camera answers device_offline, the page's other devices work; unmuted it works", async () => {
    const r = await rig();
    const { browser } = await r.lend();
    browser.video.fire("mute");
    await until("the camera to be down", async () => {
      const d = await r.call("read_device", { device: "desk.camera", channels: ["width_px"] });
      return d.error?.code === "device_offline";
    });
    const off = await r.call("read_device", { device: "desk.camera", channels: ["width_px"] });
    expect(off.error).toMatchObject({ code: "device_offline", retryable: true, retry_after_ms: 2000 });
    expect(off.error.message).toContain("the camera stopped sending pictures");
    expect((await r.call("read_device", { device: "desk.screen", channels: ["showing"] })).ok).toBe(true);
    browser.video.fire("unmute");
    await until(
      "the camera to be up",
      async () => (await r.call("read_device", { device: "desk.camera", channels: ["width_px"] })).ok,
    );
  });

  test("a locked phone: pings unanswered, the page is asleep and device_offline; unlocked, active and the wake lock asked again", async () => {
    const r = await rig({ ping_ms: 50, asleep_ms: 300 });
    const { browser, lock } = await r.lend(
      { motion: "events", vibrate: true, pointer: "coarse", torch: true },
      "phone",
    );
    expect(browser.wake.requests).toBe(1);
    lock(true);
    await until("the page to sleep", async () => (await r.call("describe_robot")).data.pages[0].state === "asleep");
    const d = await r.call("describe_robot");
    expect(d.data.pages[0].why).toContain("did not answer a ping");
    for (const device of ["phone.camera", "phone.imu", "phone.touch"]) {
      const off = await r.call("read_device", { device });
      expect(off.error).toMatchObject({ code: "device_offline", retry_after_ms: 2000 });
    }
    lock(false);
    expect(browser.wake.requests).toBe(2);
    await until("the page to wake", async () => (await r.call("describe_robot")).data.pages[0].state === "active");
    await until(
      "the imu to be up",
      async () => (await r.call("read_device", { device: "phone.imu", channels: ["pitch_deg"] })).ok,
    );
  });

  test("a phone's imu, vibrator and torch through the tools", async () => {
    const r = await rig();
    // motion events without a compass: the first sample comes after the page joined, and announces the imu
    const { browser } = await r.lend({ motion: "silent", vibrate: true, pointer: "coarse", torch: true }, "phone");
    browser.orient({ alpha: 0, beta: 25, gamma: -5, absolute: false });
    await until("the tilt to arrive", async () => {
      const d = await r.call("read_device", { device: "phone.imu", channels: ["pitch_deg"] });
      return d.data?.readings[0].value === 25;
    });
    const tilt = await r.call("read_device", {
      device: "phone.imu",
      channels: ["pitch_deg", "roll_deg", "heading_deg"],
    });
    expect(tilt.data.readings[1]).toMatchObject({ channel: "roll_deg", value: -5 });
    // no compass: the heading is absent, and that null is an answer
    expect(tilt.data.readings[2]).toMatchObject({ channel: "heading_deg", value: null, absent: true });
    const met = await r.call("wait_until", {
      condition: { device: "phone.imu", channel: "pitch_deg", op: "gt", value: 20 },
      timeout_ms: 1000,
    });
    expect(met.data).toMatchObject({ met: true });

    const buzz = await r.call("command_device", { device: "phone.vibrator", command: "vibrate", args: { ms: 50 } });
    expect(buzz.data).toMatchObject({ reason: "completed", measured: { vibrated_ms: 50 } });
    expect(browser.vibrations).toEqual([50]);

    const lit = await r.call("command_device", { device: "phone.torch", command: "set", args: { on: true, ms: 5000 } });
    expect(lit.data).toMatchObject({ reason: "completed", measured: { on: true } });
    expect(browser.video.torchOn).toBe(true);
    const stop = await r.call("stop");
    expect(stop.ok).toBe(true);
    expect(browser.video.torchOn).toBe(false);
  });
});
