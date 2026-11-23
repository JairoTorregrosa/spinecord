// The real peripheral page (apps/peripheral-page: its kit and shipped kinds over a fake browser) against the page
// listener and the hub, over a real WebSocket, through the tools a model calls (CONTRACT §2.4). The browser part
// that needs pixels and a sound card is measured by bench/peripheral-page.ts in a real Chrome.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function rig(pageTimes: Partial<PageTimes> = {}, args: string[] = []) {
  const fleet = await buildFleet(loadConfig(["--twin", "--pages", ...args]), { log: () => {}, pagePort: 0, pageTimes });
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
  const lend = async (
    o: FakeBrowserOptions = {},
    name = "desk",
    /** Runs before the tap, as the page's extension scripts do once its own has run. */
    extend?: (page: Page) => Promise<void>,
  ) => {
    const browser = fakeBrowser(o);
    const host = new URL(url).host;
    // a locked phone: its page runs no script, so the process's messages wait unanswered
    const life = { frozen: false, visible: true };
    const sockets: WebSocket[] = [];
    const vanishers = new Map<WebSocket, () => void>();
    const vanished = new Set<WebSocket>();
    const page = createPage({
      win: browser.win,
      url: `ws://${host}/page`,
      token: await servedToken(url),
      openSocket: (u) => {
        const ws = new WebSocket(u, { headers: { Origin: `http://${host}` } } as unknown as string[]);
        sockets.push(ws);
        const add = ws.addEventListener.bind(ws) as (t: string, cb: (ev: unknown) => void) => void;
        (ws as unknown as { addEventListener: typeof add }).addEventListener = (t, cb) => {
          if (t === "close") vanishers.set(ws, () => cb({ code: 1006, reason: "" }));
          add(t, (ev) => (t === "message" && (life.frozen || vanished.has(ws)) ? undefined : cb(ev)));
        };
        return ws as never;
      },
      visible: () => life.visible,
      lang: "es-ES",
      workletUrl: "level.js",
      render: () => {},
      onLabels: () => {},
      rejoin: { delays_ms: [50, 100, 200, 500] },
    });
    entry.pages.push(page);
    await extend?.(page);
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
    /** The browser closes the page's socket (a phone puts the page in the background). */
    const drop = () => sockets.at(-1)!.close(4999, "the browser closed the socket");
    /** The page sees its socket close and the process does not: no close frame reaches it (iOS drops sockets so). */
    const vanish = () => {
      const ws = sockets.at(-1)!;
      vanished.add(ws);
      vanishers.get(ws)!();
    };
    return { page, browser, lock, drop, vanish, sockets };
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

  test("a page whose socket closed joins again by itself within 30 s and keeps its place; wait_until on it is met", async () => {
    const r = await rig();
    const { page, drop, sockets } = await r.lend();
    const before = r.call("wait_until", {
      condition: { device: "desk.touch", channel: "b1", op: "eq", value: true },
      timeout_ms: 5000,
    });
    await Bun.sleep(50);
    drop();
    // the call in flight ends as the model is told to retry it: the page closed, try again in 2 s
    expect(await before).toMatchObject({
      ok: false,
      error: { code: "device_offline", retryable: true, retry_after_ms: 2000 },
      next: ["describe_robot", "wait_until"],
    });
    await until("the page to be away", async () => page.kit.status().state !== "lending");
    await until("the page to be active again", async () => {
      const d = await r.call("describe_robot");
      return page.kit.status().state === "lending" && d.data.pages[0]?.state === "active";
    });
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    const d = await r.call("describe_robot");
    expect(d.data.pages.length).toBe(1);
    expect(d.data.pages[0]).toMatchObject({ name: "desk", state: "active" });
    const waiting = r.call("wait_until", {
      condition: { device: "desk.touch", channel: "b1", op: "eq", value: true },
      timeout_ms: 3000,
    });
    setTimeout(() => page.touch.press(0), 100);
    expect((await waiting).data).toMatchObject({ met: true });
  });

  test("a socket the process never saw close: the page joins again and takes its place in under 1 s", async () => {
    const r = await rig();
    const { page, vanish, sockets } = await r.lend();
    const t0 = Date.now();
    vanish();
    // lending on the page, and active on the process once it answered the first ping of the new socket
    await until(
      "the page to be active again",
      async () =>
        page.kit.status().state === "lending" &&
        sockets.length >= 2 &&
        (await r.call("describe_robot")).data.pages[0]?.state === "active",
    );
    expect(Date.now() - t0).toBeLessThan(1000);
    const d = await r.call("describe_robot");
    expect(d.data.pages).toEqual([expect.objectContaining({ name: "desk", state: "active" })]);
    expect(d.data.devices.map((x: { id: string }) => x.id)).toContain("desk.camera");
    expect(page.kit.status().state).toBe("lending");
  });

  test("a page whose token the process refuses stops at once: one socket, closed with the reason", async () => {
    const r = await rig();
    const host = new URL(r.url).host;
    let sockets = 0;
    const page = createPage({
      win: fakeBrowser().win,
      url: `ws://${host}/page`,
      token: "not-the-token",
      openSocket: (u) => {
        sockets++;
        return new WebSocket(u, { headers: { Origin: `http://${host}` } } as unknown as string[]) as never;
      },
      visible: () => true,
      lang: "es-ES",
      workletUrl: "level.js",
      render: () => {},
      onLabels: () => {},
      rejoin: { delays_ms: [10] },
    });
    await page.lend({ name: "desk", robot: "r1-sim" });
    await until("the page to close", async () => page.kit.status().state === "closed");
    await Bun.sleep(200);
    expect(sockets).toBe(1);
    expect(page.kit.status().closed).toMatchObject({ code: 4001 });
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

    // the longest ms is not cut by the robot's motion limit: set returns at once
    const lit = await r.call("command_device", {
      device: "phone.torch",
      command: "set",
      args: { on: true, ms: 30000 },
    });
    expect(lit.data).toMatchObject({ reason: "completed", measured: { on: true }, applied: { on: true, ms: 30000 } });
    expect(lit.data.clamped ?? false).toBe(false);
    expect(browser.video.torchOn).toBe(true);
    const stop = await r.call("stop");
    expect(stop.ok).toBe(true);
    expect(browser.video.torchOn).toBe(false);
  });
});

const EXAMPLE_EXT = join(import.meta.dir, "..", "..", "..", "deployments", "example", "page-ext");
const scratch = mkdtempSync(join(tmpdir(), "spinecord-ext-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The scripts the served page loads, in order. */
const scripts = (html: string) =>
  [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)].map((m) => m[1]!);
/** One raw HTTP request, so that nothing on the way normalizes its path. Resolves with the status code. */
const rawStatus = (url: string, path: string) =>
  new Promise<number>((resolve, reject) => {
    const u = new URL(url);
    const sock = connect(Number(u.port), u.hostname, () =>
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n\r\n`),
    );
    let text = "";
    sock.on("data", (d) => (text += d.toString()));
    sock.on("end", () => resolve(Number(text.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0)));
    sock.on("error", reject);
  });

describe("extensions (--page-ext)", () => {
  test("the folder's .js files are served next to the page, which loads them after its own script", async () => {
    const dir = join(scratch, "served");
    mkdirSync(join(dir, "sub"), { recursive: true });
    copyFileSync(join(EXAMPLE_EXT, "door.js"), join(dir, "door.js"));
    copyFileSync(join(EXAMPLE_EXT, "qr.js"), join(dir, "qr.js"));
    writeFileSync(join(dir, "notes.txt"), "not served");
    writeFileSync(join(dir, "door.js.map"), "{}");
    writeFileSync(join(dir, "sub", "inner.js"), "// not served: not directly in the folder");
    writeFileSync(join(scratch, "outside.js"), "// not served: outside the folder");
    const r = await rig({}, ["--page-ext", dir]);
    const page = await fetch(r.url);
    expect(page.headers.get("content-security-policy")).toBe("default-src 'self'; connect-src 'self'");
    expect(scripts(await page.text())).toEqual(["page.js", "ext/door.js", "ext/qr.js"]);
    const door = await fetch(new URL("ext/door.js", r.url));
    expect(door.status).toBe(200);
    expect(door.headers.get("content-type")).toStartWith("text/javascript");
    expect(door.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await door.text()).toBe(readFileSync(join(EXAMPLE_EXT, "door.js"), "utf8"));
    // an edit shows on a reload: the folder is listed at each request
    writeFileSync(join(dir, "late.js"), "// added after the start");
    expect(scripts(await (await fetch(r.url)).text())).toContain("ext/late.js");
    expect((await fetch(new URL("ext/late.js", r.url))).status).toBe(200);
    for (const path of [
      "/ext/notes.txt",
      "/ext/door.js.map",
      "/ext/sub/inner.js",
      "/ext/missing.js",
      "/ext/",
      "/ext/..%2foutside.js",
      "/ext/%2e%2e%2foutside.js",
      "/ext/..%5coutside.js",
      "/ext/%2e%2e/outside.js",
      "/ext/../outside.js",
      "/ext/./door.js/",
      "/outside.js",
    ])
      expect([path, await rawStatus(r.url, path)]).toEqual([path, 404]);
    // the Host check comes first, as for every file of the page
    const foreign = await fetch(new URL("ext/door.js", r.url), { headers: { Host: "evil.example" } });
    expect(foreign.status).toBe(403);
  });

  test("without --page-ext there is no extension: no script, and /ext/ answers 404", async () => {
    const r = await rig();
    expect(scripts(await (await fetch(r.url)).text())).toEqual(["page.js"]);
    expect(await rawStatus(r.url, "/ext/door.js")).toBe(404);
  });

  test("the fake browser loads door.js from the served page: the manifest carries door, and wait_until on it is met", async () => {
    const r = await rig({}, ["--page-ext", EXAMPLE_EXT]);
    const listeners: Record<string, () => void> = {};
    const pad = { className: "", addEventListener: (t: string, cb: () => void) => void (listeners[t] = cb) };
    const document = { body: { appendChild: (el: unknown) => el }, createElement: () => pad };
    const { page } = await r.lend({}, "desk", async (p) => {
      // what the browser does with the page it is served: each extension script, in order, after page.js
      const html = await (await fetch(r.url)).text();
      for (const src of scripts(html).filter((x) => x !== "page.js")) {
        const res = await fetch(new URL(src, r.url));
        expect(res.status).toBe(200);
        new Function("spinecord", "document", "globalThis", await res.text())(p.spinecord, document, {});
      }
    });
    expect(page.kit.manifest().devices.map((d) => d.id)).toContain("door");
    const d = await r.call("describe_robot");
    expect(d.data.devices.map((x: { id: string }) => x.id)).toContain("desk.door");
    expect(d.data.pages[0].unavailable).toContainEqual({
      kind: "code_reader",
      why: "code_reader: this browser has no barcode detector (BarcodeDetector)",
    });
    const described = await r.call("describe_device", { device: "desk.door" });
    expect(described.data).toMatchObject({ kind: "contact" });
    const shut = r.call("wait_until", {
      condition: { device: "desk.door", channel: "closed", op: "eq", value: true },
      timeout_ms: 3000,
    });
    setTimeout(() => listeners.pointerdown!(), 100);
    expect((await shut).data).toMatchObject({ met: true });
    const opened = r.call("wait_until", {
      condition: { device: "desk.door", channel: "closed", op: "eq", value: false },
      timeout_ms: 3000,
    });
    setTimeout(() => listeners.pointerup!(), 100);
    expect((await opened).data).toMatchObject({ met: true });
    const count = await r.call("read_device", { device: "desk.door", channels: ["opened_count"] });
    expect(count.data.readings[0].value).toBe(1);
  });
});
