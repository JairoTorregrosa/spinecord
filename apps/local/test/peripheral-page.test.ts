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
import { until } from "./client";
import { servedToken } from "./pages";

const open: { fleet: Fleet; pages: Page[] }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    for (const p of o.pages) p.kit.close();
    await o.fleet.shutdown();
  }
});

async function rig() {
  const fleet = await buildFleet(loadConfig(["--twin", "--pages"]), { log: () => {}, pagePort: 0 });
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
    const page = createPage({
      win: browser.win,
      url: `ws://${host}/page`,
      token: await servedToken(url),
      openSocket: (u) => new WebSocket(u, { headers: { Origin: `http://${host}` } } as unknown as string[]) as never,
      visible: () => true,
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
    return { page, browser };
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
        unavailable: [{ kind: "microphone", why: "microphone: the person did not allow it" }],
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
    expect(d.data.pages[0].unavailable).toEqual([
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
});
