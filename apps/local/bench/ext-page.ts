// Measures the example extensions of the peripheral page (deployments/example/page-ext) in a real browser:
//   bun apps/local/bench/ext-page.ts [--chrome <path to Chrome or Edge>] [--headed] [--out <file.json>]
// It starts the process's fleet with a robot of source `pages` and --page-ext deployments/example/page-ext, opens
// the page served at `/` in Chrome with a throwaway profile and its fake camera and microphone, taps "Lend this
// device" with a trusted input event, and asks through the tools, as a model would: whether the page lends `door`
// and `qr` (the scripts ran under the page's Content Security Policy), a wait_until on door.closed met by a press
// on the pad and another by its release, and a qr scan of the fake camera's picture (it holds no code: timeout) or
// why qr is unavailable. Then the browser closes the page's socket (as a phone does in the background): what the
// banner and the status say while the page joins again by itself, and that the process lists one page, active,
// with door met again. Writes one JSON object to --out (default bench/results/ext-page.json next to this file).
// Not part of CI: it needs Chrome.
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
const out = values.out ?? join(import.meta.dir, "results", "ext-page.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fleet = await buildFleet(loadConfig(["--pages", "--page-ext", "deployments/example/page-ext"]), {
  log: () => {},
  pagePort: 0,
});
const call = async (name: string, args: Record<string, unknown> = {}) =>
  (await callTool(fleet.robots, name, { robot_id: "pages", ...args })).envelope as any;
const listed = (await callTool(fleet.robots, "list_robots", {})).envelope as any;
const url = String(listed.data.robots[0].join).match(/http:\/\/127\.0\.0\.1:\d+\//)![0];

const profile = mkdtempSync(join(tmpdir(), "spinecord-ext-"));
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
    "--window-size=1000,900",
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
const console_: string[] = [];
cdp.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id) pending.get(m.id)?.(m.error ? { error: m.error } : (m.result ?? {}));
  if (m.method === "Runtime.exceptionThrown") console_.push(String(m.params.exceptionDetails?.exception?.description));
  if (m.method === "Log.entryAdded")
    console_.push(
      `${m.params.entry.level}: ${m.params.entry.text}${m.params.entry.url ? ` (${new URL(m.params.entry.url).pathname})` : ""}`,
    );
};
const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const evaluate = async (expression: string, session: string) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session)).result?.value;
const center = (selector: string, s: string) =>
  evaluate(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
    s,
  ) as Promise<[number, number]>;
const mouse = (type: "mousePressed" | "mouseReleased", [x, y]: [number, number], s: string) =>
  send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, s);

// Keeps every WebSocket the page opens, so the bench can close one as the browser would.
const SOCKETS = `(() => {
  const Native = window.WebSocket;
  const all = (window.__spinecord_sockets = []);
  window.WebSocket = class extends Native { constructor(...a) { super(...a); all.push(this); } };
})()`;

const steps: Record<string, unknown> = {};
let offered: unknown = null;
try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, s);
  await send("Log.enable", {}, s);
  await send("Page.enable", {}, s);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: SOCKETS }, s);
  await send("Page.navigate", { url: `${url}#name=desk` }, s);
  for (
    let i = 0;
    i < 50 && !(await evaluate("!!document.getElementById('lend') && document.readyState === 'complete'", s));
    i++
  )
    await sleep(100);
  await sleep(300); // the module scripts after page.js
  steps.scripts = await evaluate("[...document.scripts].map((x) => x.getAttribute('src'))", s);
  steps.barcode_detector = await evaluate("typeof BarcodeDetector", s);
  const lend = await center("#lend", s);
  await mouse("mousePressed", lend, s);
  await mouse("mouseReleased", lend, s);
  let pages: any[] = [];
  for (let i = 0; i < 100; i++) {
    pages = (await call("describe_robot")).data?.pages ?? [];
    if (pages.some((p) => p.name === "desk" && p.state === "active")) break;
    await sleep(100);
  }
  const desk = pages.find((p) => p.name === "desk");
  if (desk?.state !== "active") throw new Error(`the page did not join: ${JSON.stringify(pages)}`);
  offered = { devices: desk.devices, unavailable: desk.unavailable };

  const pad = await center(".sc-pad", s);
  const shut = call("wait_until", {
    condition: { device: "desk.door", channel: "closed", op: "eq", value: true },
    timeout_ms: 3000,
  });
  await sleep(300);
  await mouse("mousePressed", pad, s);
  const met = await shut;
  steps.wait_until_closed_true = met.ok ? met.data : `${met.error.code}: ${met.error.message}`;
  const open = call("wait_until", {
    condition: { device: "desk.door", channel: "closed", op: "eq", value: false },
    timeout_ms: 3000,
  });
  await sleep(300);
  await mouse("mouseReleased", pad, s);
  const metOpen = await open;
  steps.wait_until_closed_false = metOpen.ok ? metOpen.data : `${metOpen.error.code}: ${metOpen.error.message}`;
  const count = await call("read_device", { device: "desk.door", channels: ["opened_count"] });
  steps.opened_count = count.ok ? count.data.readings[0].value : count.error;

  if (desk.devices.includes("desk.qr")) {
    const scan = await call("command_device", { device: "desk.qr", command: "scan", args: { max_ms: 1000 } });
    steps.qr_scan = scan.ok ? { reason: scan.data.reason, measured: scan.data.measured } : scan.error;
  } else steps.qr = desk.unavailable.find((u: any) => u.kind === "code_reader")?.why;

  // the browser closes the socket: the page joins again under its name
  await evaluate("window.__spinecord_sockets.at(-1).close(4999, 'the bench closed it')", s);
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    seen.add(
      String(
        await evaluate(
          "`${document.getElementById('status').textContent} | ${document.getElementById('banner').hidden ? '(no banner)' : document.getElementById('banner-what').textContent}`",
          s,
        ),
      ),
    );
    await sleep(50);
  }
  steps.while_rejoining = [...seen];
  let again: any[] = [];
  for (let i = 0; i < 100; i++) {
    again = (await call("describe_robot")).data?.pages ?? [];
    if (again.length === 1 && again[0].state === "active") break;
    await sleep(100);
  }
  steps.pages_after_rejoin = again.map((p) => ({ name: p.name, state: p.state }));
  steps.sockets_opened = await evaluate("window.__spinecord_sockets.length", s);
  const shutAgain = call("wait_until", {
    condition: { device: "desk.door", channel: "closed", op: "eq", value: true },
    timeout_ms: 3000,
  });
  await sleep(300);
  await mouse("mousePressed", pad, s);
  const metAgain = await shutAgain;
  steps.wait_until_after_rejoin = metAgain.ok
    ? metAgain.data.reason
    : `${metAgain.error.code}: ${metAgain.error.message}`;
  await mouse("mouseReleased", pad, s);
  steps.console = console_;
} finally {
  browser.kill();
  await browser.exited;
  await fleet.shutdown();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}

const result = {
  schema: "spinecord/ext-page@1",
  at: new Date().toISOString(),
  browser: chrome.split(/[\\/]/).at(-1),
  headless: values.headed !== true,
  os: `${process.platform} ${process.arch}`,
  note: "Chrome with its fake camera and microphone; the page served with --page-ext deployments/example/page-ext; the fleet runs in this process",
  offered,
  steps,
};
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(0);
