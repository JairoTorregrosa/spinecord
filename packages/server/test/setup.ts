// Preloaded once per `bun test` process (bunfig.toml): bundles the Worker once, starts one Miniflare (workerd
// with Durable Objects + D1, nothing persisted), applies the D1 migrations, and stops it when the run ends.
// Tests never share state: each one uses its own robot id, so its own Durable Object and its own rows.
import { afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = path.join(import.meta.dirname, "..");
const verbose = process.env.RELAY_TEST_LOGS === "1";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

// Test principals (tokens in harness.ts). People and runtimes hold different credentials.
const A_ROBOTS = [...many("a", 30), ...many("s", 10).map((s) => `${s}-sim`)];
const PRINCIPALS = [
  { principal_id: "user-a", role: "user", token_sha256: sha("token-user-a"), robot_ids: A_ROBOTS },
  { principal_id: "user-b", role: "user", token_sha256: sha("token-user-b"), robot_ids: ["b1"] },
  { principal_id: "root", role: "admin", token_sha256: sha("token-admin"), robot_ids: ["*"] },
  { principal_id: "rt-a", role: "runtime", token_sha256: sha("token-runtime"), robot_ids: A_ROBOTS },
  { principal_id: "rt-b", role: "runtime", token_sha256: sha("token-runtime-b"), robot_ids: ["b1"] },
  { principal_id: "organs", role: "organ", token_sha256: sha("token-organ"), robot_ids: [...A_ROBOTS, "b1"] },
];

// wrangler.jsonc is the source of truth for dates, flags and default vars
const wrangler = Bun.JSONC.parse(readFileSync(path.join(root, "wrangler.jsonc"), "utf8")) as {
  compatibility_date: string;
  compatibility_flags: string[];
  vars: Record<string, string>;
};

const build = await Bun.build({
  entrypoints: [path.join(root, "test", "entry.ts")],
  target: "browser",
  format: "esm",
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:*", "workerd:*", "node:*"],
});
if (!build.success || build.outputs.length !== 1) throw new Error(`worker bundle failed:\n${build.logs.join("\n")}`);

// every line the worker printed, in order: harness.ts `logged` waits on them (a barrier with no sleep)
const workerLogs: string[] = [];

// Miniflare 5 takes a new config shape; the documented v4 options are still accepted through this converter.
const mf = new Miniflare(
  convertV4MiniflareOptions({
    // the worker prints one JSON line per call (src/log.ts): errors always, the rest with RELAY_TEST_LOGS=1
    handleStructuredLogs: ({ level, message }) => {
      if (verbose || level === "error") console.error(`[worker ${level}] ${message}`);
      workerLogs.push(message);
    },
    host: "127.0.0.1",
    port: 0,
    modules: [{ type: "ESModule", path: "entry.js", contents: await build.outputs[0]!.text() }],
    compatibilityDate: wrangler.compatibility_date,
    compatibilityFlags: [...wrangler.compatibility_flags, "unsafe_module"],
    durableObjects: { ROBOT: { className: "RobotDO", useSQLite: true } },
    d1Databases: ["DB"],
    bindings: {
      ...wrangler.vars,
      PRINCIPALS: JSON.stringify(PRINCIPALS),
      // the contract's timings, shortened so the tests run in seconds
      HB_INTERVAL_MS: "50",
      HB_TIMEOUT_MS: "400",
      ORGAN_GONE_MS: "1000",
      STOP_VERIFY_MARGIN_MS: "200",
      HELLO_TIMEOUT_MS: "400",
      CALL_TIMEOUT_MS: "800",
      DEADLINE_MARGIN_MS: "200",
    },
  }),
);
const url = (await mf.ready).origin;

// applied by harness.ts `resetRelay` at the start of each test file
const dir = path.join(root, "migrations");
const migrations = readdirSync(dir)
  .sort()
  .flatMap((file) =>
    readFileSync(path.join(dir, file), "utf8")
      .replace(/^\s*--.*$/gm, "")
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0),
  );
if (migrations.length === 0) throw new Error(`no SQL statements found in ${dir}`);

(globalThis as { __RELAY__?: { url: string; migrations: string[]; logs: string[] } }).__RELAY__ = {
  url,
  migrations,
  logs: workerLogs,
};
afterAll(() => mf.dispose());
