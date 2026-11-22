// scripts/check-boundaries.ts on a planted tree: apps/local reaching packages/server fails the check.
// The planted import lines are assembled from parts, so that the check does not read them in this file.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "boundaries-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function check(files: Record<string, string>): { code: number; text: string } {
  const root = mkdtempSync(join(tmp, "tree-"));
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const r = Bun.spawnSync([
    process.execPath,
    join(import.meta.dir, "..", "..", "..", "scripts", "check-boundaries.ts"),
    "--root",
    root,
  ]);
  return { code: r.exitCode, text: r.stdout.toString() + r.stderr.toString() };
}
const FROM = ["fr", "om"].join("");
const RELAY_PATH = ["..", "..", "..", "packages", "server", "src", "index"].join("/");
const RELAY_NAME = ["@spinecord", "relay", "src", "index"].join("/");
const TREE = {
  "packages/server/package.json": '{"name":"@spinecord/relay"}',
  "packages/server/src/index.ts": "export const relay = 1;\n",
  "packages/runtime/runtime.ts": "export const runtime = 1;\n",
};

test("apps/local may import the runtime and a dependency whose name ends in /server", () => {
  const r = check({
    ...TREE,
    "apps/local/main.ts": [
      `import { Server } ${FROM} "@modelcontextprotocol/server";`,
      `import { StdioServerTransport } ${FROM} "@modelcontextprotocol/server/stdio";`,
      `import { runtime } ${FROM} "../../packages/runtime/runtime";`,
    ].join("\n"),
  });
  expect(r.text).toContain("boundaries OK");
  expect(r.code).toBe(0);
});

test("apps/local importing packages/server fails, by path and by workspace name", () => {
  const byPath = check({ ...TREE, "apps/local/src/a.ts": `import { relay } ${FROM} "${RELAY_PATH}";\n` });
  expect(byPath.code).toBe(1);
  expect(byPath.text).toContain("apps/local/src/a.ts:1: apps/local must not import packages/server");
  const byName = check({ ...TREE, "apps/local/src/b.ts": `export * ${FROM} "${RELAY_NAME}";\n` });
  expect(byName.code).toBe(1);
  expect(byName.text).toContain(`apps/local must not import packages/server (${RELAY_NAME})`);
});
