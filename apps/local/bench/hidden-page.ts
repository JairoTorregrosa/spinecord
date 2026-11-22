// Measures the stock EV3 link with the browser window visible, hidden behind another tab and minimized:
//   bun apps/local/bench/hidden-page.ts [--chrome <path to Chrome or Edge>] [--trials <n>]
// It serves the bridge page with a simulated EV3 behind a fake WebHID (bench/sim-page.ts), opens it in a real
// browser with a throwaway profile, and runs the runtime and the real Ev3Provider in this process over the page's
// socket, as apps/local does. Per window state it reports:
//   timer        how often the page's own 10 ms timer fires (what a runtime inside the page would get)
//   packet       round trip of one EV3 packet through the page
//   until        a turn at 30 % speed with `until gyro angle > start + 30`: how far past the threshold the robot
//                stops, and that distance as time at the turn's rate
// Prints one JSON object. Needs a desktop session (a window is opened and closed).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Transport } from "../../../packages/driver-ev3/transport";
import type { LocalRuntime } from "../../../packages/runtime/runtime";
import { buildBridgePage } from "../../robot-page/bridge-build";
import { loadConfig } from "../src/config";
import { serveBridge } from "../src/hid-bridge";
import { ev3Runtime } from "../src/sources";

const { values } = parseArgs({ options: { chrome: { type: "string" }, trials: { type: "string" } } });
const trials = Number(values.trials ?? 15);
const CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
];
const chrome = values.chrome ?? CANDIDATES.find((p) => existsSync(p));
if (!chrome) throw new Error("no Chrome or Edge found: pass --chrome <path>");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 100) / 100 : null;
};

// ---- this process's end: the bridge server, a transport that times every packet, the runtime ----
const source = loadConfig([
  "--ev3",
  join(import.meta.dir, "..", "..", "..", "deployments", "example", "robots", "r1.json"),
]).robots[0]!;
if (source.source !== "ev3") throw new Error("unreachable");
const page = await buildBridgePage(join(import.meta.dir, "sim-page.ts"));
let packets: number[] = [];
let timers: { visibility: string; fired: number; gap_ms_p50: number; gap_ms_max: number }[] = [];
let runtime: LocalRuntime | null = null;
const bridge = serveBridge(page, 0, {
  onDevice(transport) {
    const timed: Transport = {
      async send(bytes) {
        const t = performance.now();
        const reply = await transport.send(bytes);
        packets.push(performance.now() - t);
        return reply;
      },
    };
    runtime = ev3Runtime(source, timed);
  },
  onGone: (why) => console.error(`page gone: ${why}`),
  onText: (m) => {
    if (m.t === "timers") timers.push(m as never);
  },
});

// ---- the browser, driven over the DevTools protocol ----
const profile = mkdtempSync(join(tmpdir(), "spinecord-hidden-"));
const browser = Bun.spawn(
  [
    chrome,
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=900,700",
    bridge.url,
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
  if (m.id) pending.get(m.id)?.(m.result ?? m.error);
};
const send = (method: string, params: object = {}): Promise<any> =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    cdp.send(JSON.stringify({ id, method, params }));
  });

async function measure(state: string) {
  await sleep(2500); // the browser applies its timer policy a moment after the window changes
  timers = [];
  packets = [];
  await sleep(3200);
  const seen = timers.slice(-3);
  const rt = runtime!;
  const signal = new AbortController().signal;
  const angle = async () =>
    (
      (await rt.call("read_device", { device: "gyro" }, signal)).data as {
        readings: { channel: string; value: number }[];
      }
    ).readings.find((r) => r.channel === "angle_deg")!.value;
  const over: number[] = [];
  const ms: number[] = [];
  let rate = 0;
  for (let i = 0; i < trials; i++) {
    const start = await angle();
    const threshold = start + 30;
    const t = performance.now();
    const r = await rt.call(
      "turn",
      { angle_deg: 120, speed_pct: 30, until: { device: "gyro", channel: "angle_deg", op: "gt", value: threshold } },
      signal,
    );
    const took = performance.now() - t;
    const d = r.data as { reason: string };
    if (d.reason !== "condition_met") throw new Error(`${state}: trial ${i} ended ${d.reason}`);
    const end = await angle();
    over.push(end - threshold);
    ms.push(took);
    rate = Math.max(rate, (end - start) / (took / 1000));
  }
  // the turn's rate from geometry: wheel speed × wheel diameter / axle track
  const deg_per_s = (0.3 * 1050 * 5.6) / 12;
  return {
    window: state,
    page_visibility: seen.at(-1)?.visibility ?? "no report",
    page_timer_10ms: { fired_per_s: seen.at(-1)?.fired ?? 0, gap_ms_p50: seen.at(-1)?.gap_ms_p50 ?? null },
    packet_round_trip_ms: { n: packets.length, p50: pct(packets, 0.5), p95: pct(packets, 0.95), max: pct(packets, 1) },
    until_turn: {
      trials,
      overshoot_deg_p50: pct(over, 0.5),
      overshoot_deg_max: pct(over, 1),
      overshoot_as_ms_p50: Math.round(((pct(over, 0.5) ?? 0) / deg_per_s) * 1000),
      overshoot_as_ms_max: Math.round(((pct(over, 1) ?? 0) / deg_per_s) * 1000),
      call_ms_p50: pct(ms, 0.5),
    },
  };
}

const results: unknown[] = [];
try {
  for (let i = 0; i < 100 && !runtime; i++) await sleep(100);
  if (!runtime) throw new Error("the page did not connect");
  await (runtime as LocalRuntime).ready();
  const targets = (await send("Target.getTargets")).targetInfos as { targetId: string; type: string; url: string }[];
  const tab = targets.find((t) => t.type === "page" && t.url.startsWith(bridge.url))!;
  const { windowId } = await send("Browser.getWindowForTarget", { targetId: tab.targetId });

  results.push(await measure("visible"));
  const other = await send("Target.createTarget", { url: "about:blank" }); // a tab in front of the page
  results.push(await measure("hidden behind another tab"));
  await send("Target.closeTarget", { targetId: other.targetId });
  await send("Target.activateTarget", { targetId: tab.targetId });
  await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
  results.push(await measure("minimized"));
} finally {
  bridge.stop();
  browser.kill();
  await browser.exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(
  JSON.stringify(
    {
      schema: "spinecord/hidden-page@1",
      at: new Date().toISOString(),
      browser: chrome,
      os: `${process.platform} ${process.arch}`,
      note: "simulated EV3 behind a fake WebHID in the page; the runtime and Ev3Provider run in this process",
      results,
    },
    null,
    2,
  ),
);
process.exit(0);
