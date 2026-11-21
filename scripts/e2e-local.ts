// Local end to end, cross-platform: `bun run e2e`.
//   1. the relay (packages/server/src/index.ts, the real Worker) in Miniflare: workerd, Durable Objects and D1,
//      nothing persisted, contract timings from wrangler.jsonc, principals from deployments/example
//   2. apps/twin-runner as its own process, running the twin r1-sim of deployments/example
//   3. this process as an MCP client over Streamable HTTP with the user token, walking the tool surface
// Every call's envelope is checked; a table of the calls is printed; exit 1 if anything is not as expected.
// The runner's output is printed when something fails, or always with E2E_VERBOSE=1.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Envelope } from "../packages/protocol/types";

const root = join(import.meta.dir, "..");
const server = join(root, "packages", "server");
const deployment = join(root, "deployments", "example");
const ROBOT = "r1-sim";
// the tokens of deployments/example/principals.json (packages/server/scripts/dev.md); local only
const USER_TOKEN = "local-user-token-0000";
// the twins connect with the runtime credential: a user token is refused on /ws/robot (CONTRACT §10)
const RUNTIME_TOKEN = "local-runtime-token-0000";
const BUDGET_MS = 240_000;
const verbose = process.env.E2E_VERBOSE === "1";

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(what);
}

// ---------------------------------------------------------------- inputs (deployments/example)
const principals = readJson(join(deployment, "principals.json"));
{
  // the example deployment and the relay's own example must not drift apart
  const line = readFileSync(join(server, ".dev.vars.example"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("PRINCIPALS="));
  check(line, "packages/server/.dev.vars.example has no PRINCIPALS= line");
  check(
    JSON.stringify(JSON.parse(line.slice("PRINCIPALS=".length))) === JSON.stringify(principals),
    "deployments/example/principals.json and packages/server/.dev.vars.example define different principals",
  );
}
const pointerFile = join(deployment, "world.pointer.json");
const pointer = readJson(pointerFile);
check(isObj(pointer) && typeof pointer.world === "string", `${pointerFile} needs "world": a path to a world file`);
const worldFile = resolve(dirname(pointerFile), pointer.world);
const profileFile = join(deployment, "robots", "r1.json");

// ---------------------------------------------------------------- cleanup, whatever happens
const cleanups: (() => Promise<void> | void)[] = [];
let cleaning: Promise<void> | undefined;
const cleanup = (): Promise<void> =>
  (cleaning ??= (async () => {
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch (e) {
        console.error(`cleanup: ${(e as Error).message}`);
      }
    }
  })());
const bail = (code: number, why: string) => {
  console.error(`e2e: ${why}`);
  void cleanup().finally(() => process.exit(code));
};
process.on("SIGINT", () => bail(130, "interrupted"));
process.on("SIGTERM", () => bail(143, "terminated"));
const watchdog = setTimeout(() => bail(1, `still running after ${BUDGET_MS} ms: giving up`), BUDGET_MS);

// ---------------------------------------------------------------- the calls
interface Row {
  tool: string;
  ok: string;
  detail: string;
  ms: number;
  pass: boolean;
}
const rows: Row[] = [];
const failures: string[] = [];
const knownBugs: string[] = [];
let client: Client;
let seq = 0;
const rid = (): string => `e2e-${process.pid}-${++seq}`;

/**
 * One MCP tools/call. Checks the envelope (CONTRACT §7) and that it is ok or fails with `expect.code`;
 * `verify` checks the data. Returns the data on success, undefined otherwise (the failure is recorded).
 */
async function call<T = any>(
  tool: string,
  args: Record<string, unknown>,
  expect: {
    code?: string;
    verify?: (data: T) => void;
    label?: string;
    /** Expected-failing: this error code is accepted until the named fix lands (ok:true passes too). */
    knownBug?: { code: string; fix: string };
  } = {},
): Promise<T | undefined> {
  const t0 = performance.now();
  const row: Row = { tool: expect.label ?? tool, ok: "-", detail: "", ms: 0, pass: false };
  rows.push(row);
  try {
    const res = await client.callTool({ name: tool, arguments: args }, { timeout: BUDGET_MS });
    row.ms = Math.round(performance.now() - t0);
    const content = res.content as { type: string; text?: string }[];
    check(Array.isArray(content) && content[0]?.type === "text", "content[0] is not a text block");
    const env = JSON.parse(content[0].text!) as Envelope<T>;
    check(typeof env.ok === "boolean", "envelope.ok is not a boolean");
    check(Array.isArray(env.next), "envelope.next is not an array");
    check((res.isError === true) === !env.ok, `isError is ${String(res.isError)} but envelope.ok is ${env.ok}`);
    row.ok = String(env.ok);
    if (!env.ok) {
      const e = env.error;
      check(
        isObj(e) && typeof e.code === "string" && typeof e.message === "string" && typeof e.retryable === "boolean",
        "error envelope without {code, message, retryable}",
      );
      row.detail = e.code;
      if (expect.knownBug && e.code === expect.knownBug.code) {
        // accepted for now, and said out loud so it is not forgotten
        row.detail = `${e.code} (KNOWN BUG, fix: ${expect.knownBug.fix})`;
        knownBugs.push(`${row.tool}: ${e.code}: ${e.message}`);
        row.pass = true;
        return undefined;
      }
      check(e.code === expect.code, `${e.code}: ${e.message}`);
      row.detail = `${e.code} (expected)`;
      row.pass = true;
      return undefined;
    }
    check("data" in env, "ok envelope without data");
    const d = env.data as unknown;
    row.detail = isObj(d) ? String(d.reason ?? d.outcome ?? d.state ?? "") : "";
    check(expect.code === undefined, `expected error ${expect.code}, got ok`);
    expect.verify?.(env.data);
    row.pass = true;
    return env.data;
  } catch (e) {
    row.ms ||= Math.round(performance.now() - t0);
    row.detail = row.detail ? `${row.detail}: FAILED` : "FAILED";
    failures.push(`${row.tool}: ${(e as Error).message}`);
    return undefined;
  }
}
const near = (value: unknown, target: number, tolerance: number, what: string): void =>
  check(
    typeof value === "number" && Math.abs(value - target) <= tolerance,
    `${what} is ${JSON.stringify(value)}, expected ${target} ± ${tolerance}`,
  );

function table(): string {
  const head = ["tool", "ok", "reason/code", "ms"];
  const body = rows.map((r) => [r.tool, r.ok, r.detail || "-", String(r.ms)]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(w[i]!)).join(" | ")} |`;
  return [line(head), `|${w.map((n) => "-".repeat(n + 2)).join("|")}|`, ...body.map(line)].join("\n");
}

let runnerOutput = "";
try {
  // ---------------------------------------------------------------- 1. relay
  const wrangler = Bun.JSONC.parse(readFileSync(join(server, "wrangler.jsonc"), "utf8")) as {
    compatibility_date: string;
    compatibility_flags: string[];
    vars: Record<string, string>;
  };
  const build = await Bun.build({
    entrypoints: [join(server, "src", "index.ts")],
    target: "browser",
    format: "esm",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "workerd:*", "node:*"],
  });
  if (!build.success || build.outputs.length !== 1) throw new Error(`worker bundle failed:\n${build.logs.join("\n")}`);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      handleStructuredLogs: ({ level, message }) => {
        if (verbose || level === "error") console.error(`[relay ${level}] ${message}`);
      },
      host: "127.0.0.1",
      port: 0,
      modules: [{ type: "ESModule", path: "index.js", contents: await build.outputs[0]!.text() }],
      compatibilityDate: wrangler.compatibility_date,
      compatibilityFlags: wrangler.compatibility_flags,
      durableObjects: { ROBOT: { className: "RobotDO", useSQLite: true } },
      d1Databases: ["DB"],
      bindings: { ...wrangler.vars, PRINCIPALS: JSON.stringify(principals) },
    }),
  );
  cleanups.push(() => mf.dispose());
  const base = (await mf.ready).origin;
  const migrations = join(server, "migrations");
  const statements = readdirSync(migrations)
    .sort()
    .flatMap((file) =>
      readFileSync(join(migrations, file), "utf8")
        .replace(/^\s*--.*$/gm, "")
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
  check(statements.length > 0, `no SQL statements found in ${migrations}`);
  const db = await mf.getD1Database("DB");
  await db.batch(statements.map((s) => db.prepare(s)));
  const health = await fetch(`${base}/health`);
  check(health.ok, `GET /health answered ${health.status}: ${await health.text()}`);
  console.log(`relay: ${base}`);

  // ---------------------------------------------------------------- 2. twin runner
  const scratch = mkdtempSync(join(tmpdir(), "spinecord-e2e-"));
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
  const tokenFile = join(scratch, "token");
  writeFileSync(tokenFile, `${RUNTIME_TOKEN}\n`);
  const runnerArgs = [join(root, "apps", "twin-runner", "main.ts"), "--profile", profileFile, "--world", worldFile];

  // fail loud: without a token file the runner must refuse to start (exit 2), not run half-configured
  const refused = Bun.spawn(
    [process.execPath, ...runnerArgs, "--server", `${base.replace(/^http/, "ws")}/ws/robot`, "--robot-id", ROBOT],
    { cwd: root, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  cleanups.push(() => void refused.kill());
  const refusedCode = await refused.exited;
  if (refusedCode !== 2) failures.push(`twin-runner without --token-file exited ${refusedCode}, expected 2`);

  // fail loud: a twin id the relay does not know gets HTTP 404 on the WebSocket upgrade; the runner must
  // exit 1 saying so, not reconnect forever
  const unknown = Bun.spawn(
    [
      process.execPath,
      ...runnerArgs,
      "--server",
      `${base.replace(/^http/, "ws")}/ws/robot`,
      "--token-file",
      tokenFile,
      "--robot-id",
      "nobody-sim",
    ],
    { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  cleanups.push(() => void unknown.kill());
  const unknownOut = new Response(unknown.stdout).text();
  const unknownCode = await Promise.race([unknown.exited, sleep(10_000).then(() => "still running after 10 s")]);
  unknown.kill();
  if (unknownCode !== 1 || !(await unknownOut).includes("HTTP 404"))
    failures.push(
      `twin-runner with an unknown robot id: exit ${unknownCode}, expected 1 naming HTTP 404. Output:\n${await unknownOut}`,
    );

  // process.execPath is this bun: no shell in between, so killing the child leaves nothing behind on any OS
  const runner = Bun.spawn(
    [
      process.execPath,
      ...runnerArgs,
      "--server",
      `${base.replace(/^http/, "ws")}/ws/robot`,
      "--token-file",
      tokenFile,
      "--robot-id",
      ROBOT,
    ],
    { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const drained = Promise.all(
    [runner.stdout, runner.stderr].map(async (stream) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        runnerOutput += text;
        if (verbose) process.stderr.write(text);
      }
    }),
  );
  let runnerExit: number | null = null;
  void runner.exited.then((code) => {
    runnerExit = code;
  });
  cleanups.push(async () => {
    runner.kill();
    await runner.exited;
    await drained;
  });

  // ---------------------------------------------------------------- 3. MCP client
  client = new Client({ name: "spinecord-e2e", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${USER_TOKEN}` } },
    }),
  );
  cleanups.push(() => client.close());

  // wait for the twin: the relay says when it is online
  for (const t0 = Date.now(); ; await sleep(100)) {
    check(runnerExit === null, `twin-runner exited ${runnerExit} before ${ROBOT} came online`);
    const res = await client.callTool({ name: "list_robots", arguments: {} });
    const env = JSON.parse((res.content as { text: string }[])[0]!.text) as Envelope<{ id: string; link: string }[]>;
    if (env.ok && env.data.find((r) => r.id === ROBOT)?.link === "online") break;
    check(Date.now() - t0 < 20_000, `${ROBOT} is not online after 20 s`);
  }

  const robot_id = ROBOT;
  await call<{ id: string; link: string; backend: string }[]>(
    "list_robots",
    {},
    {
      verify: (d) => {
        const twin = d.find((r) => r.id === ROBOT);
        check(twin?.link === "online" && twin.backend === "sim", `${ROBOT} is not an online sim robot`);
        check(
          d.some((r) => r.id === "r1" && r.link === "offline"),
          "r1 (no runtime connected) is not listed as offline",
        );
      },
    },
  );
  await call<{ backend: string; devices: { id: string }[] }>(
    "describe_robot",
    { robot_id },
    {
      verify: (d) => {
        check(d.backend === "sim", `backend is ${d.backend}, expected sim`);
        const ids = d.devices.map((x) => x.id);
        for (const id of ["ev3.pair", "ev3.B", "ev3.C", "ev3.S2", "sim.world"])
          check(ids.includes(id), `device ${id} is missing; devices: ${ids.join(", ")}`);
      },
    },
  );
  await call<{ reason: string; measured: { distance_cm: number } }>(
    "drive",
    { robot_id, distance_cm: 20, request_id: rid() },
    {
      label: "drive 20 cm",
      verify: (d) => {
        check(d.reason === "completed", `reason is ${d.reason}`);
        near(d.measured.distance_cm, 20, 2, "measured.distance_cm");
      },
    },
  );
  await call<{ reason: string; measured: { angle_deg: number } }>(
    "turn",
    { robot_id, angle_deg: 90, request_id: rid() },
    {
      label: "turn 90",
      verify: (d) => {
        check(d.reason === "completed", `reason is ${d.reason}`);
        near(d.measured.angle_deg, 90, 8, "measured.angle_deg");
      },
    },
  );
  await call<{ readings: unknown[] } | unknown[]>(
    "read_all",
    { robot_id },
    {
      verify: (d) => {
        const readings = (Array.isArray(d) ? d : d.readings) as { device: string; channel: string; value: unknown }[];
        check(Array.isArray(readings) && readings.length > 0, "no readings");
        const pose = readings.find((r) => r.device === "sim.world" && r.channel === "pose")?.value as number[];
        check(Array.isArray(pose), "sim.world pose is not among the readings");
        // 20 cm along +x from the world's start, then facing +y
        const start = (readJson(worldFile) as { start: { x: number; y: number; heading_deg: number } }).start;
        near(pose[0], start.x + 20, 3, "pose x_cm");
        near(pose[1], start.y, 3, "pose y_cm");
        near(pose[2], start.heading_deg + 90, 8, "pose heading_deg");
      },
    },
  );
  // an error is an envelope too: r1 is the hardware robot and nothing runs it here
  await call("read_all", { robot_id: "r1" }, { code: "robot_offline", label: "read_all (r1, offline)" });

  // Calls that take their whole time on purpose: the relay's deadline must not cut them short.
  // KNOWN BUG today: the relay's deadline races the runtime's answer and wins, so both come back as error
  // `timeout` (with the right partial result). Branch fix/relay-deadlines fixes the relay; that PR removes the
  // two `knownBug` markers below, after which only ok:true passes.
  const RELAY_DEADLINE = { code: "timeout", fix: "branch fix/relay-deadlines" };
  await call<{ met: boolean; after_ms: number }>(
    "wait_until",
    { robot_id, condition: { device: "touch", channel: "pressed", op: "eq", value: true }, timeout_ms: 1500 },
    {
      label: "wait_until (never true, 1500 ms)",
      knownBug: RELAY_DEADLINE,
      verify: (d) => {
        check(d.met === false, `met is ${JSON.stringify(d.met)}, expected false`);
        check(d.after_ms >= 1400, `after_ms is ${d.after_ms}, expected about 1500`);
      },
    },
  );
  await call<{ samples: [number, number][]; last: number }>(
    "sample_device",
    { robot_id, device: "distance", channel: "distance_cm", rate_hz: 10, duration_ms: 1000 },
    {
      label: "sample_device (1000 ms)",
      knownBug: RELAY_DEADLINE,
      verify: (d) => {
        check(Array.isArray(d.samples) && d.samples.length >= 5, `samples: ${JSON.stringify(d.samples)}`);
        check(
          d.samples.every((s) => typeof s[0] === "number" && typeof s[1] === "number"),
          "a sample is not [t_ms, value]",
        );
      },
    },
  );

  // back to the start pose, then a small square as a program (turning right keeps it clear of the obstacle)
  await call(
    "command_device",
    { robot_id, device: "sim.world", command: "reset", args: {}, request_id: rid() },
    { label: "command_device sim.world reset" },
  );
  const side = { call: { tool: "drive", args: { distance_cm: 10 } } };
  const corner = { call: { tool: "turn", args: { angle_deg: -90 } } };
  const saved = await call<{ name: string; version: number; state: string }>(
    "save_program",
    {
      name: "e2e_square",
      description: "A 10 cm square, turning right at each corner.",
      body: { repeat: { times: 4, body: { seq: [side, corner] } } },
      request_id: rid(),
    },
    { verify: (d) => check(d.state === "draft", `state is ${d.state}, expected draft`) },
  );
  if (saved) {
    const program = { name: saved.name, version: saved.version };
    await call<{ success_rate: number; state: string; outcomes: { outcome: string; reason: string }[] }>(
      "verify_program",
      { ...program, robot_id, trials: 2, request_id: rid() },
      {
        verify: (d) => {
          check(
            d.state === "verified" && d.success_rate === 1 && d.outcomes.length === 2,
            `state ${d.state}, success_rate ${d.success_rate}, outcomes ${JSON.stringify(d.outcomes)}`,
          );
        },
      },
    );
    await call<{ outcome: string; reason: string; steps: { ok: boolean }[] }>(
      "run_program",
      { ...program, robot_id, request_id: rid() },
      {
        verify: (d) => {
          check(d.outcome === "succeeded", `outcome is ${d.outcome} (${d.reason})`);
          check(d.steps.length === 8 && d.steps.every((s) => s.ok), `steps: ${JSON.stringify(d.steps)}`);
        },
      },
    );
  }

  await call<{ state: string }>(
    "start_episode",
    { robot_id, label: "e2e-local", tags: ["e2e"], request_id: rid() },
    { verify: (d) => check(d.state === "running", `state is ${d.state}`) },
  );
  await call("mark_episode", { robot_id, kind: "checkpoint", note: "square done", request_id: rid() });
  await call<{ outcome: string; marks: unknown }>(
    "end_episode",
    { robot_id, outcome: "done", metrics: { squares: 1 }, request_id: rid() },
    { verify: (d) => check(d.outcome === "done", `outcome is ${JSON.stringify(d.outcome)}`) },
  );
  check(runnerExit === null, `twin-runner exited ${runnerExit} during the run`);
} catch (e) {
  failures.push((e as Error).message);
}

clearTimeout(watchdog);
await cleanup();
if (rows.length) console.log(`\n${table()}\n`);
if (failures.length) {
  if (!verbose && runnerOutput) console.error(`twin-runner output:\n${runnerOutput}`);
  console.error(`e2e FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
if (knownBugs.length)
  console.log(`known bugs, accepted for now (expected-failing):\n${knownBugs.map((k) => `  - ${k}`).join("\n")}\n`);
console.log(`e2e OK: ${rows.length} calls${knownBugs.length ? `, ${knownBugs.length} known bug(s)` : ""}`);
process.exit(0);
