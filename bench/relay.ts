// The real Worker (packages/server/src/index.ts) in Miniflare, with the timings of wrangler.jsonc unchanged
// (the tests shorten them; a benchmark must not). Follows packages/server/test/setup.ts, minus the test hooks.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ROOT = join(import.meta.dir, "..");
export const SERVER = join(ROOT, "packages", "server");
/** miniflare and the MCP client are dependencies of packages/server only: resolve them from there. */
export const fromServer = (name: string): Promise<any> =>
  import(pathToFileURL(Bun.resolveSync(name, SERVER)).href) as Promise<any>;

export const TOKEN = "bench-token-user";
export const ADMIN_TOKEN = "bench-token-admin";
export const RUNTIME_TOKEN = "bench-token-runtime";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface Relay {
  url: string;
  /** ms: bundling the Worker; Miniflare (workerd) start until it accepts requests; the first request it serves. */
  cold: { bundle_ms: number; start_ms: number; first_request_ms: number };
  logs: string[];
  dispose(): Promise<void>;
}

export async function startRelay(robots: string[]): Promise<Relay> {
  const { Miniflare, convertV4MiniflareOptions } = await fromServer("miniflare");
  const wrangler = Bun.JSONC.parse(readFileSync(join(SERVER, "wrangler.jsonc"), "utf8")) as {
    compatibility_date: string;
    compatibility_flags: string[];
    vars: Record<string, string>;
  };
  const t0 = performance.now();
  const build = await Bun.build({
    entrypoints: [join(SERVER, "src", "index.ts")],
    target: "browser",
    format: "esm",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "workerd:*", "node:*"],
  });
  if (!build.success || build.outputs.length !== 1) throw new Error(`worker bundle failed:\n${build.logs.join("\n")}`);
  const t1 = performance.now();
  const logs: string[] = [];
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      handleStructuredLogs: ({ level, message }: { level: string; message: string }) => {
        if (level === "error") console.error(`[worker error] ${message}`);
        logs.push(message);
      },
      host: "127.0.0.1",
      port: 0,
      modules: [{ type: "ESModule", path: "index.js", contents: await build.outputs[0]!.text() }],
      compatibilityDate: wrangler.compatibility_date,
      compatibilityFlags: wrangler.compatibility_flags,
      durableObjects: { ROBOT: { className: "RobotDO", useSQLite: true } },
      d1Databases: ["DB"],
      bindings: {
        ...wrangler.vars,
        PRINCIPALS: JSON.stringify([
          { principal_id: "bench-user", role: "user", token_sha256: sha(TOKEN), robot_ids: robots },
          { principal_id: "bench-admin", role: "admin", token_sha256: sha(ADMIN_TOKEN), robot_ids: ["*"] },
          { principal_id: "bench-runtime", role: "runtime", token_sha256: sha(RUNTIME_TOKEN), robot_ids: robots },
        ]),
      },
    }),
  );
  const url = ((await mf.ready) as URL).origin;
  const t2 = performance.now();
  const health = await fetch(`${url}/health`);
  if (!health.ok) throw new Error(`/health answered ${health.status}: ${await health.text()}`);
  await health.text();
  const t3 = performance.now();

  const dir = join(SERVER, "migrations");
  const statements = readdirSync(dir)
    .sort()
    .flatMap((file) =>
      readFileSync(join(dir, file), "utf8")
        .replace(/^\s*--.*$/gm, "")
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
  if (statements.length === 0) throw new Error(`no SQL statements found in ${dir}`);
  const db = await mf.getD1Database("DB");
  await db.batch(statements.map((s: string) => db.prepare(s)));

  return {
    url,
    cold: { bundle_ms: t1 - t0, start_ms: t2 - t1, first_request_ms: t3 - t2 },
    logs,
    dispose: () => mf.dispose(),
  };
}
