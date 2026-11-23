// Measures the phone-only kinds of the peripheral page (apps/peripheral-page) in a real browser that emulates a
// phone's sensors:
//   bun apps/local/bench/phone-page.ts [--chrome <path to Chrome or Edge>] [--headed] [--out <file.json>]
// It starts the process's fleet with a robot of source `pages`, opens the page served at `/` as `phone` in Chrome
// with a throwaway profile, the fake camera and microphone, a phone's viewport and touch, and the motion sensors
// overridden through the DevTools protocol (Emulation.setSensorOverrideEnabled / setSensorOverrideReadings; the
// DeviceOrientation override where those give no event). It taps "Lend this device" with a trusted input event and
// asks through the tools, as a model would: the tilt of two sensor readings, a wait_until on it, a vibrate, what
// the page says of the torch, the imu while the tab is hidden behind another tab, and the wake lock requests
// before and after (counted by a script the page gets before its own). Writes one JSON object to --out (default
// bench/results/phone-page.json next to this file). Not part of CI: it needs Chrome.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config";
import { buildFleet } from "../src/sources";
import { callTool } from "../src/tools";

const { values } = parseArgs({
  options: { chrome: { type: "string" }, headed: { type: "boolean" }, out: { type: "string" } },
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
const out = values.out ?? join(import.meta.dir, "results", "phone-page.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fleet = await buildFleet(loadConfig(["--pages"]), { log: () => {}, pagePort: 0 });
const call = async (name: string, args: Record<string, unknown> = {}) =>
  (await callTool(fleet.robots, name, { robot_id: "pages", ...args })).envelope as any;
const listed = (await callTool(fleet.robots, "list_robots", {})).envelope as any;
const url = String(listed.data.robots[0].join).match(/http:\/\/127\.0\.0\.1:\d+\//)![0];
const origin = url.replace(/\/$/, "");

const profile = mkdtempSync(join(tmpdir(), "spinecord-phone-"));
const browser = Bun.spawn(
  [
    chrome,
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=500,900",
    ...(values.headed ? [] : ["--headless=new"]),
    "about:blank",
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
  if (m.id) pending.get(m.id)?.(m.error ? { error: m.error } : (m.result ?? {}));
};
const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const evaluate = async (expression: string, session: string) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session)).result?.value;

// Counts the page's wake lock requests and vibrations, keeping each call a method call on the real object.
const COUNTERS = `(() => {
  const c = (window.__spinecord_bench = { wake: [], vibrate: [] });
  const wl = navigator.wakeLock;
  if (wl) { const req = wl.request.bind(wl); wl.request = (t) => req(t).then((s) => (c.wake.push("granted"), s), (e) => { c.wake.push("refused: " + e.name); throw e; }); }
  if (navigator.vibrate) { const v = navigator.vibrate.bind(navigator); navigator.vibrate = (p) => { const r = v(p); c.vibrate.push([p, r]); return r; }; }
})()`;

/** A quaternion for a device turned `pitch` degrees about x, then `roll` degrees about y. */
function quaternion(pitchDeg: number, rollDeg: number) {
  const a = (pitchDeg * Math.PI) / 360;
  const b = (rollDeg * Math.PI) / 360;
  // q = qx(pitch) * qy(roll)
  return {
    x: Math.sin(a) * Math.cos(b),
    y: Math.cos(a) * Math.sin(b),
    z: Math.sin(a) * Math.sin(b),
    w: Math.cos(a) * Math.cos(b),
  };
}

const steps: Record<string, unknown> = {};
let offered: unknown = null;
let sensorPath = "Emulation.setSensorOverrideEnabled";
try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, s);
  await send("Page.enable", {}, s);
  await send("Browser.grantPermissions", { origin, permissions: ["sensors", "videoCapture", "audioCapture"] });
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, s);
  await send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" }, s);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: COUNTERS }, s);
  const overrides: Record<string, unknown> = {};
  for (const type of [
    "accelerometer",
    "linear-acceleration",
    "gravity",
    "gyroscope",
    "relative-orientation",
    "absolute-orientation",
  ])
    overrides[type] =
      (await send("Emulation.setSensorOverrideEnabled", { enabled: true, type }, s)).error?.message ?? "ok";
  steps.sensor_overrides = overrides;
  const setReadings = async (pitch: number, roll: number) => {
    const q = quaternion(pitch, roll);
    const r: Record<string, unknown> = {};
    for (const type of ["relative-orientation", "absolute-orientation"])
      r[type] =
        (await send("Emulation.setSensorOverrideReadings", { type, reading: { quaternion: q } }, s)).error?.message ??
        "ok";
    r.accelerometer =
      (
        await send(
          "Emulation.setSensorOverrideReadings",
          { type: "accelerometer", reading: { xyz: { x: 0, y: 0, z: 9.81 } } },
          s,
        )
      ).error?.message ?? "ok";
    r.gravity =
      (
        await send(
          "Emulation.setSensorOverrideReadings",
          { type: "gravity", reading: { xyz: { x: 0, y: 0, z: 9.81 } } },
          s,
        )
      ).error?.message ?? "ok";
    r["linear-acceleration"] =
      (
        await send(
          "Emulation.setSensorOverrideReadings",
          { type: "linear-acceleration", reading: { xyz: { x: 0, y: 0, z: 0 } } },
          s,
        )
      ).error?.message ?? "ok";
    r.gyroscope =
      (
        await send(
          "Emulation.setSensorOverrideReadings",
          { type: "gyroscope", reading: { xyz: { x: 0, y: 0, z: 0 } } },
          s,
        )
      ).error?.message ?? "ok";
    if (sensorPath !== "Emulation.setSensorOverrideEnabled")
      r.device_orientation =
        (await send("DeviceOrientation.setDeviceOrientationOverride", { alpha: 0, beta: pitch, gamma: roll }, s)).error
          ?.message ?? "ok";
    return r;
  };
  steps.readings_before_tap = await setReadings(0, 0);
  await send("Page.navigate", { url: `${url}#name=phone` }, s);
  for (
    let i = 0;
    i < 50 && !(await evaluate("!!document.getElementById('lend') && document.readyState === 'complete'", s));
    i++
  )
    await sleep(100);
  steps.page_sees = await evaluate(
    "({ coarse: matchMedia('(pointer: coarse)').matches, motion: typeof DeviceMotionEvent, requestPermission: typeof DeviceMotionEvent?.requestPermission, vibrate: typeof navigator.vibrate, wakeLock: !!navigator.wakeLock })",
    s,
  );
  const rect = (await evaluate(
    "(() => { const r = document.getElementById('lend').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()",
    s,
  )) as [number, number];
  for (const type of ["touchStart", "touchEnd"])
    await send(
      "Input.dispatchTouchEvent",
      { type, touchPoints: type === "touchEnd" ? [] : [{ x: rect[0], y: rect[1] }] },
      s,
    );
  let pages: any[] = [];
  for (let i = 0; i < 100; i++) {
    pages = (await call("describe_robot")).data?.pages ?? [];
    if (pages.some((p) => p.name === "phone" && p.state === "active")) break;
    await sleep(100);
  }
  const phone = pages.find((p) => p.name === "phone");
  if (phone?.state !== "active") throw new Error(`the page did not join: ${JSON.stringify(pages)}`);
  if (!phone.devices.includes("phone.imu")) {
    // the sensor overrides gave the page no motion event: the DeviceOrientation override, then announce
    sensorPath = "DeviceOrientation.setDeviceOrientationOverride";
    steps.readings_fallback = await setReadings(0, 0);
    await sleep(1500);
  }
  const after = (await call("describe_robot")).data.pages.find((p: any) => p.name === "phone");
  offered = { devices: after.devices, unavailable: after.unavailable };
  steps.sensor_path = sensorPath;

  const tilt = async () => {
    const env = await call("read_device", {
      device: "phone.imu",
      channels: ["pitch_deg", "roll_deg", "heading_deg", "accel_z_m_s2"],
    });
    if (!env.ok) return `${env.error.code}: ${env.error.message}`;
    return Object.fromEntries(
      env.data.readings.map((r: any) => [r.channel, r.absent ? "absent" : (r.value ?? r.error)]),
    );
  };
  await sleep(300);
  steps.tilt_flat = await tilt();
  steps.readings_tilted = await setReadings(30, -15);
  await sleep(300);
  steps.tilt_pitch30_roll_minus15 = await tilt();
  await setReadings(0, 0);
  await sleep(500); // the page has pushed the flat reading before the wait starts
  steps.tilt_flat_again = await tilt();
  const waiting = call("wait_until", {
    condition: { device: "phone.imu", channel: "pitch_deg", op: "gt", value: 20 },
    timeout_ms: 3000,
  });
  await sleep(300);
  await setReadings(40, 0);
  const met = await waiting;
  steps.wait_until_pitch_gt_20 = met.ok ? met.data : `${met.error.code}: ${met.error.message}`;

  const buzz = await call("command_device", { device: "phone.vibrator", command: "vibrate", args: { ms: 200 } });
  steps.vibrate = buzz.ok
    ? { reason: buzz.data.reason, measured: buzz.data.measured }
    : `${buzz.error.code}: ${buzz.error.message}`;
  steps.torch = after.devices.includes("phone.torch")
    ? await call("command_device", { device: "phone.torch", command: "set", args: { on: true, ms: 500 } }).then((e) =>
        e.ok ? e.data.measured : e.error,
      )
    : after.unavailable.find((u: any) => u.kind === "torch")?.why;

  // hidden behind another tab, then in front again
  const other = await send("Target.createTarget", { url: "about:blank" });
  await sleep(1500);
  steps.hidden_visibility = await evaluate("document.visibilityState", s);
  steps.hidden_imu = await tilt();
  steps.hidden_page = (await call("describe_robot")).data.pages.find((p: any) => p.name === "phone")?.state;
  await send("Target.closeTarget", { targetId: other.targetId });
  await send("Target.activateTarget", { targetId });
  await sleep(1500);
  steps.visible_again_visibility = await evaluate("document.visibilityState", s);
  steps.visible_again_imu = await tilt();
  steps.counters = await evaluate("window.__spinecord_bench", s);
} finally {
  browser.kill();
  await browser.exited;
  await fleet.shutdown();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}

const result = {
  schema: "spinecord/phone-page@1",
  at: new Date().toISOString(),
  browser: chrome.split(/[\\/]/).at(-1),
  headless: values.headed !== true,
  os: `${process.platform} ${process.arch}`,
  note: "Chrome with a phone's viewport and touch, its fake camera and microphone, and the motion sensors overridden through the DevTools protocol; the fleet runs in this process",
  offered,
  steps,
};
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(0);
