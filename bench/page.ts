// What a person waits for around the 3D view (`--view`): `bun bench/page.ts`.
//   bun bench/page.ts                       every metric, 5 runs each, headless Chrome on the GPU
//   bun bench/page.ts --runs 7              more runs
//   bun bench/page.ts --software            the page drawn by SwiftShader (a CPU renderer: a weak GPU's stand-in)
//   bun bench/page.ts --throttle 4          the page's CPU slowed 4x (Chrome's own CPU throttling)
//   bun bench/page.ts --chrome <path>       another Chrome or Edge
// One line per metric: `<name> median=<v> min=<v> max=<v> n=<runs> <unit>`.
// - server_ready / server_first_byte: `bun apps/local/main.ts --twin <orugas> --view` spawned, to its `ready` log
//   line, and to the first byte of `GET /` on the view's port.
// - first_frame_cold / first_frame_reload: navigation start to the page's mark `twin:first-frame` (the first frame
//   drawn with a robot in it), in a fresh browser profile with an empty cache, then on a reload of that tab.
// - meshes_cold: navigation start to the mark `twin:meshes` (every real mesh in place).
// - wire_cold / wire_reload: bytes the page's loads took on the wire (Chrome's encodedDataLength, headers included).
// - view_js_wire: bytes of view.js on the wire for a browser's Accept-Encoding.
// - frame_idle / frame_drive: median and p95 time between frames (rAF) over 4 s, robot still and while `drive` runs.
// Not part of CI: wall-clock numbers. Compare runs taken on the same machine, one after the other.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type TestServer } from "../apps/local/test/client";

const argv = process.argv.slice(2);
const value = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const RUNS = Number(value("--runs") ?? 5);
const THROTTLE = Number(value("--throttle") ?? 1);
const SOFTWARE = argv.includes("--software");
/** `--profile <file.cpuprofile>`: the page's CPU profile of the first cold load (open it in Chrome's DevTools). */
const PROFILE = value("--profile");
const ROOT = join(import.meta.dir, "..");
const ROBOT = join(ROOT, "deployments", "orugas", "robots", "orugas.json");
const WORLD = join(ROOT, "deployments", "orugas", "worlds", "sala.json");
const MAIN = join(ROOT, "apps", "local", "main.ts");
const CHROME =
  value("--chrome") ??
  {
    darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  }[process.platform as string] ??
  "google-chrome";
if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error("--runs must be a positive integer");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
const line = (name: string, xs: number[], unit: string) => {
  const r = (v: number) => Math.round(v * 10) / 10;
  console.log(
    `${name} median=${r(median(xs))} min=${r(Math.min(...xs))} max=${r(Math.max(...xs))} n=${xs.length} ${unit}`,
  );
};
const freePort = () => {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port!;
  s.stop(true);
  return p;
};

/** Spawn → `ready` and spawn → first byte of GET /, for one start of the server. */
async function serverStart(): Promise<{ ready: number; firstByte: number }> {
  const port = freePort();
  const t0 = performance.now();
  const child = Bun.spawn(
    [process.execPath, MAIN, "--twin", ROBOT, "--world", WORLD, "--view", "--view-port", `${port}`],
    {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  let ready = NaN;
  const reader = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of child.stderr) {
      buf += dec.decode(chunk);
      if (Number.isNaN(ready) && buf.includes('"ev":"ready"')) ready = performance.now() - t0;
    }
  })();
  let firstByte = NaN;
  while (Number.isNaN(firstByte) && performance.now() - t0 < 60_000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      await res.text();
      if (res.ok) firstByte = performance.now() - t0;
    } catch {
      await sleep(5);
    }
  }
  while (Number.isNaN(ready) && performance.now() - t0 < 60_000) await sleep(5);
  child.stdin.end();
  await child.exited;
  await reader;
  if (Number.isNaN(ready) || Number.isNaN(firstByte)) throw new Error("the server did not start in 60 s");
  return { ready, firstByte };
}

/** A minimal Chrome DevTools Protocol client over the browser's WebSocket. */
class Cdp {
  private id = 0;
  private waiting = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  private listeners: ((m: any) => void)[] = [];
  constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id !== undefined) {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) w?.no(new Error(`${JSON.stringify(m.error)}`));
        else w?.ok(m.result);
      } else for (const l of this.listeners) l(m);
    };
  }
  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((ok, no) => ((ws.onopen = ok), (ws.onerror = no)));
    return new Cdp(ws);
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((ok, no) => this.waiting.set(id, { ok, no }));
  }
  on(l: (m: any) => void): void {
    this.listeners.push(l);
  }
  close(): void {
    this.ws.close();
  }
}

async function launchChrome(): Promise<{ cdp: Cdp; stop: () => Promise<void> }> {
  const profile = mkdtempSync(join(tmpdir(), "spinecord-bench-chrome-"));
  const flags = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,720",
    "--autoplay-policy=no-user-gesture-required",
    ...(SOFTWARE ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : []),
  ];
  const child = Bun.spawn([CHROME, ...flags, "about:blank"], { stdout: "ignore", stderr: "pipe" });
  const dec = new TextDecoder();
  let buf = "";
  let url = "";
  const reader = child.stderr.getReader();
  const t0 = performance.now();
  while (!url) {
    if (performance.now() - t0 > 20_000) throw new Error(`Chrome did not start (${CHROME}):\n${buf}`);
    const { value: chunk, done } = await reader.read();
    if (done) throw new Error(`Chrome exited:\n${buf}`);
    buf += dec.decode(chunk);
    url = /DevTools listening on (ws:\S+)/.exec(buf)?.[1] ?? "";
  }
  void (async () => {
    while (!(await reader.read()).done);
  })();
  const cdp = await Cdp.open(url);
  return {
    cdp,
    stop: async () => {
      cdp.close();
      child.kill();
      await child.exited;
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

interface Load {
  firstFrame: number;
  meshes: number;
  wire: number;
}

let profiled = false;
/** A fresh tab in its own browser context (an empty cache), the page loaded cold, then reloaded. */
async function loadTwice(cdp: Cdp, url: string): Promise<{ cold: Load; reload: Load; sessionId: string }> {
  const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m: string, p: object = {}) => cdp.send(m, p, sessionId);
  let wire = 0;
  cdp.on((m) => {
    if (m.sessionId === sessionId && m.method === "Network.loadingFinished") wire += m.params.encodedDataLength;
  });
  await s("Network.enable");
  await s("Page.enable");
  await s("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  if (THROTTLE > 1) await s("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  const marks = async (gen: number): Promise<Load> => {
    const t0 = performance.now();
    for (;;) {
      if (performance.now() - t0 > 90_000) throw new Error("the page drew no robot in 90 s");
      const r = await s("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => { if (window.__gen !== undefined) return null;
          const f = performance.getEntriesByName("twin:first-frame")[0], m = performance.getEntriesByName("twin:meshes")[0];
          return f && m ? [f.startTime, m.startTime] : null; })()`,
      }).catch(() => null);
      const v = r?.result?.value as [number, number] | null | undefined;
      if (v) {
        await sleep(300); // the last loads finish
        const out = { firstFrame: v[0], meshes: v[1], wire };
        await s("Runtime.evaluate", { expression: `window.__gen = ${gen}` });
        return out;
      }
      await sleep(20);
    }
  };
  wire = 0;
  const profiling = PROFILE !== undefined && !profiled;
  if (profiling) {
    profiled = true;
    await s("Profiler.enable");
    await s("Profiler.setSamplingInterval", { interval: 200 });
    await s("Profiler.start");
  }
  await s("Page.navigate", { url });
  const cold = await marks(1);
  if (profiling) await Bun.write(PROFILE, JSON.stringify((await s("Profiler.stop")).profile));
  wire = 0;
  await s("Page.reload", {});
  const reload = await marks(2);
  return { cold, reload, sessionId };
}

/** rAF intervals over `ms` in the tab of `sessionId`. */
async function frameTimes(cdp: Cdp, sessionId: string, ms: number): Promise<number[]> {
  const r = await cdp.send(
    "Runtime.evaluate",
    {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise((done) => { const d = []; let last = 0; const t0 = performance.now();
        const f = (t) => { if (last) d.push(t - last); last = t; if (t - t0 < ${ms}) requestAnimationFrame(f); else done(d); };
        requestAnimationFrame(f); })`,
    },
    sessionId,
  );
  return r.result.value as number[];
}

// ---------------------------------------------------------------- run
console.log(
  `# bench/page.ts ${new Date().toISOString()} ${process.platform} ${process.arch} bun ${Bun.version} runs=${RUNS} throttle=${THROTTLE}x renderer=${SOFTWARE ? "swiftshader" : "gpu"}`,
);
const starts: { ready: number; firstByte: number }[] = [];
for (let i = 0; i < RUNS; i++) starts.push(await serverStart());
line(
  "server_ready",
  starts.map((s) => s.ready),
  "ms",
);
line(
  "server_first_byte",
  starts.map((s) => s.firstByte),
  "ms",
);

const port = freePort();
const server: TestServer = await startServer(["--twin", ROBOT, "--world", WORLD, "--view", "--view-port", `${port}`]);
const url = `http://127.0.0.1:${port}/`;
const robot_id = (await server.tool("list_robots")).envelope.data.robots[0].id as string;
try {
  for (const enc of ["gzip, deflate, br, zstd"]) {
    const res = await fetch(`${url}view.js`, { headers: { "accept-encoding": enc }, decompress: false } as RequestInit);
    const bytes = (await res.arrayBuffer()).byteLength;
    console.log(`view_js_wire bytes=${bytes} encoding=${res.headers.get("content-encoding") ?? "identity"} B`);
  }
  const chrome = await launchChrome();
  try {
    const loads: { cold: Load; reload: Load }[] = [];
    const idle: number[] = [];
    const drive: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const l = await loadTwice(chrome.cdp, url);
      loads.push(l);
      await sleep(500);
      idle.push(...(await frameTimes(chrome.cdp, l.sessionId, 4000)));
      const moving = server.tool("drive", { robot_id, distance_cm: i % 2 ? -40 : 40, speed_pct: 40 });
      await sleep(300);
      drive.push(...(await frameTimes(chrome.cdp, l.sessionId, 3000)));
      await moving;
      await chrome.cdp
        .send("Target.closeTarget", {
          targetId: (await chrome.cdp.send("Target.getTargets")).targetInfos.find(
            (t: any) => t.attached && t.type === "page",
          )?.targetId,
        })
        .catch(() => {});
    }
    line(
      "first_frame_cold",
      loads.map((l) => l.cold.firstFrame),
      "ms",
    );
    line(
      "first_frame_reload",
      loads.map((l) => l.reload.firstFrame),
      "ms",
    );
    line(
      "meshes_cold",
      loads.map((l) => l.cold.meshes),
      "ms",
    );
    line(
      "meshes_reload",
      loads.map((l) => l.reload.meshes),
      "ms",
    );
    line(
      "wire_cold",
      loads.map((l) => l.cold.wire),
      "B",
    );
    line(
      "wire_reload",
      loads.map((l) => l.reload.wire),
      "B",
    );
    console.log(`frame_idle median=${median(idle).toFixed(1)} p95=${pct(idle, 0.95).toFixed(1)} n=${idle.length} ms`);
    console.log(
      `frame_drive median=${median(drive).toFixed(1)} p95=${pct(drive, 0.95).toFixed(1)} n=${drive.length} ms`,
    );
  } finally {
    await chrome.stop();
  }
} finally {
  await server.closeStdin();
}
