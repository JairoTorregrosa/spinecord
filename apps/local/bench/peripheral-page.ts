// Measures the peripheral page (apps/peripheral-page) in a real browser with the tab in front, covered by another
// window and hidden behind another tab:
//   bun apps/local/bench/peripheral-page.ts [--chrome <path to Chrome or Edge>] [--headless] [--out <file.json>]
//     [--screenshots <dir>]
// It starts the process's fleet with a robot of source `pages`, opens the page served at `/` in a browser with a
// throwaway profile and Chrome's fake camera and microphone (--use-fake-device-for-media-stream) and permission
// prompts answered yes (--use-fake-ui-for-media-stream), taps "Lend this device" with a trusted input event, and
// per window state asks through the tools, as a model would: one frame (read_device), one speak and one listen
// (command_device). On macOS the fake microphone plays a phrase spoken by `say`, so a listen can hear something.
// Writes one JSON object to --out (default bench/results/peripheral-page.json next to this file). Not part of CI:
// it needs a desktop session (a window is opened and closed), and it plays one short phrase on the speakers.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config";
import { buildFleet } from "../src/sources";
import { callTool } from "../src/tools";

const { values } = parseArgs({
  options: {
    chrome: { type: "string" },
    headless: { type: "boolean" },
    out: { type: "string" },
    screenshots: { type: "string" },
  },
});
const CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
];
const chrome = values.chrome ?? CANDIDATES.find((p) => existsSync(p));
if (!chrome) throw new Error("no Chrome or Edge found: pass --chrome <path>");
const out = values.out ?? join(import.meta.dir, "results", "peripheral-page.json");
const PHRASE = "hola robot";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the phrase the fake microphone plays (macOS only: `say`) ----
const profile = mkdtempSync(join(tmpdir(), "spinecord-peripheral-"));
let audioFile: string | null = null;
if (process.platform === "darwin") {
  const wav = join(profile, "phrase.wav");
  const said = Bun.spawnSync(["say", "-v", "Mónica", "-o", wav, "--data-format=LEI16@48000", `${PHRASE}. ${PHRASE}.`]);
  if (said.exitCode === 0 && existsSync(wav)) audioFile = wav;
}

// ---- this process: the fleet with a robot whose devices pages lend ----
const fleet = await buildFleet(loadConfig(["--pages"]), { log: () => {}, pagePort: 0 });
const callOut = (name: string, args: Record<string, unknown>) =>
  callTool(fleet.robots, name, { robot_id: "pages", ...args });
const call = async (name: string, args: Record<string, unknown>) => (await callOut(name, args)).envelope as any;
const join_ = (await callTool(fleet.robots, "list_robots", {})).envelope as any;
const url = String(join_.data.robots[0].join).match(/http:\/\/127\.0\.0\.1:\d+\//)![0];

// ---- the browser, driven over the DevTools protocol ----
const browser = Bun.spawn(
  [
    chrome,
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    ...(audioFile ? [`--use-file-for-fake-audio-capture=${audioFile}`] : []),
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1100,850",
    ...(values.headless ? ["--headless=new"] : []),
    url,
  ],
  { stdout: "ignore", stderr: "pipe" },
);
let devtools = "";
const decoder = new TextDecoder();
for await (const chunk of browser.stderr) {
  const m = decoder.decode(chunk).match(/DevTools listening on (ws:\/\/\S+)/);
  if (m) {
    devtools = m[1]!;
    break;
  }
}
const cdp = new WebSocket(devtools);
await new Promise((resolve, reject) => {
  cdp.onopen = resolve;
  cdp.onerror = reject;
});
let seq = 0;
const pending = new Map<number, (r: any) => void>();
cdp.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id) pending.get(m.id)?.(m.result ?? { error: m.error });
};
const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

type Outcome = { ok: boolean; detail: string; ms: number };
async function attempt(fn: () => Promise<Outcome>): Promise<Outcome> {
  const t = performance.now();
  try {
    return await fn();
  } catch (e) {
    return { ok: false, detail: `threw: ${(e as Error).message}`, ms: Math.round(performance.now() - t) };
  }
}
const describe = (env: any): string => (env.ok ? "" : `${env.error.code}: ${env.error.message}`.slice(0, 240));

async function measure(window: string, session: string) {
  await sleep(2500); // the browser applies its policy for the window state a moment after it changes
  const visibility = (
    await send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, session)
  ).result?.value;
  const frame = await attempt(async () => {
    const t = performance.now();
    const o = await callOut("read_device", { device: "desk.camera", channels: ["frame", "width_px", "height_px"] });
    const env = o.envelope as any;
    const ms = Math.round(performance.now() - t);
    if (!env.ok) return { ok: false, detail: describe(env), ms };
    const value = (c: string) => env.data.readings.find((x: any) => x.channel === c);
    if (!o.image) return { ok: false, detail: `no image: ${value("frame")?.error ?? "none"}`, ms };
    const kib = Math.round((o.image.b64.length * 3) / 4 / 1024);
    return {
      ok: true,
      detail: `${value("width_px")?.value}x${value("height_px")?.value} jpeg, ${kib} KiB, age ${o.image.age_ms} ms`,
      ms,
    };
  });
  const speak = await attempt(async () => {
    const t = performance.now();
    const env = await call("command_device", { device: "desk.speaker", command: "speak", args: { text: "hola" } });
    const ms = Math.round(performance.now() - t);
    if (!env.ok) return { ok: false, detail: describe(env), ms };
    return {
      ok: env.data.measured?.spoken === true,
      detail: `reason ${env.data.reason}, spoken ${env.data.measured?.spoken}`,
      ms,
    };
  });
  const listen = await attempt(async () => {
    const t = performance.now();
    const env = await call("command_device", {
      device: "desk.mic",
      command: "listen",
      args: { max_ms: 6000, expect: [PHRASE] },
    });
    const ms = Math.round(performance.now() - t);
    if (!env.ok) return { ok: false, detail: describe(env), ms };
    const m = env.data.measured ?? {};
    return {
      ok: m.heard === true,
      detail: `reason ${env.data.reason}, heard ${m.heard}, transcript "${m.transcript}", match "${m.match}"`,
      ms,
    };
  });
  return { window, page_visibility: visibility, frame, speak, listen };
}

const results: unknown[] = [];
let offered: unknown = null;
let probe: unknown = null;
try {
  const targets = (await send("Target.getTargets")).targetInfos as { targetId: string; type: string; url: string }[];
  const tab = targets.find((t) => t.type === "page" && t.url.startsWith(url));
  if (!tab) throw new Error("the page did not open");
  const { sessionId: session } = await send("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
  await send("Runtime.enable", {}, session);
  for (let i = 0; i < 50; i++) {
    const ready = await send(
      "Runtime.evaluate",
      { expression: "!!document.getElementById('lend') && document.readyState === 'complete'", returnByValue: true },
      session,
    );
    if (ready.result?.value) break;
    await sleep(100);
  }
  if (values.screenshots) await screenshots(values.screenshots, session, "before");
  // the person's tap: a trusted click on "Lend this device"
  const rect = (
    await send(
      "Runtime.evaluate",
      {
        expression:
          "(() => { const r = document.getElementById('lend').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()",
        returnByValue: true,
      },
      session,
    )
  ).result.value as [number, number];
  for (const type of ["mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", { type, x: rect[0], y: rect[1], button: "left", clickCount: 1 }, session);
  let pages: any[] = [];
  for (let i = 0; i < 100; i++) {
    const d = await call("describe_robot", {});
    pages = d.ok ? d.data.pages : [];
    if (pages.some((p) => p.name === "desk" && p.state === "active")) break;
    await sleep(100);
  }
  const desk = pages.find((p) => p.name === "desk");
  if (desk?.state !== "active") throw new Error(`the page did not join: ${JSON.stringify(pages)}`);
  offered = { devices: desk.devices, unavailable: desk.unavailable };
  if (values.screenshots) await screenshots(values.screenshots, session, "lending");
  const { windowId } = await send("Browser.getWindowForTarget", { targetId: tab.targetId });

  probe = (
    await send(
      "Runtime.evaluate",
      {
        expression: `new Promise((resolve) => { const ev = []; const t0 = performance.now(); const R = window.SpeechRecognition || window.webkitSpeechRecognition; if (!R) return resolve(["no recognizer"]); const r = new R(); r.lang = "es-ES"; for (const k of ["start","audiostart","soundstart","speechstart","result","nomatch","error","end"]) r.addEventListener(k, (e) => ev.push(Math.round(performance.now() - t0) + " " + k + (e.error ? ":" + e.error : "") + (e.results ? ":" + e.results[0][0].transcript : ""))); r.start(); setTimeout(() => { try { r.abort(); } catch {} setTimeout(() => resolve(ev), 300); }, 7000); })`,
        awaitPromise: true,
        returnByValue: true,
      },
      session,
    )
  ).result?.value;
  results.push(await measure("front", session));
  // another window over the page's, at the same place and size
  const { bounds } = await send("Browser.getWindowBounds", { windowId });
  const cover = await send("Target.createTarget", { url: "about:blank", newWindow: true });
  const coverWindow = (await send("Browser.getWindowForTarget", { targetId: cover.targetId })).windowId;
  await send("Browser.setWindowBounds", {
    windowId: coverWindow,
    bounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
  });
  await send("Target.activateTarget", { targetId: cover.targetId });
  results.push(await measure("covered by another window", session));
  await send("Target.closeTarget", { targetId: cover.targetId });
  await send("Target.activateTarget", { targetId: tab.targetId });
  await sleep(500);
  const other = await send("Target.createTarget", { url: "about:blank" }); // a tab in front of the page
  results.push(await measure("hidden behind another tab", session));
  await send("Target.closeTarget", { targetId: other.targetId });
} finally {
  browser.kill();
  await browser.exited;
  await fleet.shutdown();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}

/** Phone and laptop widths of the page, as PNG files in dir. */
async function screenshots(dir: string, session: string, label: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const [name, width, height, mobile] of [
    ["phone", 390, 844, true],
    ["laptop", 1280, 800, false],
  ] as const) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile }, session);
    await sleep(400);
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, session);
    writeFileSync(join(dir, `${label}-${name}.png`), Buffer.from(shot.data, "base64"));
  }
  await send("Emulation.clearDeviceMetricsOverride", {}, session);
}

const result = {
  schema: "spinecord/peripheral-page@1",
  at: new Date().toISOString(),
  browser: chrome,
  headless: values.headless === true,
  os: `${process.platform} ${process.arch}`,
  note: `Chrome's fake camera and microphone; ${audioFile ? `the microphone plays "${PHRASE}" spoken by macOS say` : "the microphone plays Chrome's fake beep"}; the fleet runs in this process`,
  offered,
  recognizer_events: probe,
  results,
};
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(0);
