// scripts/check-boundaries.ts on a planted tree: an import against ARCHITECTURE.md's graph fails the check,
// under packages/ and under apps/.
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
const DRIVER_PATH = ["..", "driver-ev3", "provider"].join("/");
const DRIVER_NAME = ["@spinecord", "driver-ev3"].join("/");
const APP_PATH = ["..", "..", "apps", "local", "src", "robot"].join("/");
const RUNTIME_FROM_APP = ["..", "..", "..", "packages", "runtime", "runtime"].join("/");
const RUNTIME_NAME = ["@spinecord", "runtime"].join("/");
const LOCAL_FROM_PAGE = ["..", "..", "local", "src", "robot"].join("/");
const PAGE_FROM_LOCAL = ["..", "..", "robot-page", "src", "bridge"].join("/");
const USE_TERM = ["work", "shop"].join("");
const TREE = {
  "packages/driver-ev3/provider.ts": "export const provider = 1;\n",
  "packages/runtime/runtime.ts": "export const runtime = 1;\n",
  "apps/local/src/robot.ts": "export const robot = 1;\n",
  "apps/robot-page/src/bridge.ts": "export const bridge = 1;\n",
};

test("an app may import packages and its own dependencies", () => {
  const r = check({
    ...TREE,
    "apps/local/main.ts": [
      `import { Server } ${FROM} "@modelcontextprotocol/server";`,
      `import { runtime } ${FROM} "../../packages/runtime/runtime";`,
      `import { provider } ${FROM} "../../packages/driver-ev3/provider";`,
    ].join("\n"),
  });
  expect(r.text).toContain("boundaries OK");
  expect(r.code).toBe(0);
});

test("the runtime importing a driver fails, by path and by workspace name", () => {
  const byPath = check({ ...TREE, "packages/runtime/a.ts": `import { provider } ${FROM} "${DRIVER_PATH}";\n` });
  expect(byPath.code).toBe(1);
  expect(byPath.text).toContain(
    `packages/runtime/a.ts:1: packages/runtime must not import driver-ev3 (${DRIVER_PATH})`,
  );
  const byName = check({ ...TREE, "packages/runtime/b.ts": `export * ${FROM} "${DRIVER_NAME}";\n` });
  expect(byName.code).toBe(1);
  expect(byName.text).toContain(`packages/runtime must not import driver-ev3 (${DRIVER_NAME})`);
});

test("the bridge page may import the EV3 driver; apps/local may import the bridge page", () => {
  const r = check({
    ...TREE,
    "apps/robot-page/src/a.ts": `import { provider } ${FROM} "../../../packages/driver-ev3/provider";\n`,
    "apps/local/src/b.ts": `import { bridge } ${FROM} "${PAGE_FROM_LOCAL}";\n`,
  });
  expect(r.text).toContain("boundaries OK");
  expect(r.code).toBe(0);
});

test("the bridge page importing the runtime or apps/local fails", () => {
  const byPath = check({ ...TREE, "apps/robot-page/src/c.ts": `import { runtime } ${FROM} "${RUNTIME_FROM_APP}";\n` });
  expect(byPath.code).toBe(1);
  expect(byPath.text).toContain(
    `apps/robot-page/src/c.ts:1: apps/robot-page must not import runtime (${RUNTIME_FROM_APP})`,
  );
  const byName = check({ ...TREE, "apps/robot-page/src/d.ts": `import { runtime } ${FROM} "${RUNTIME_NAME}";\n` });
  expect(byName.code).toBe(1);
  expect(byName.text).toContain(`apps/robot-page must not import runtime (${RUNTIME_NAME})`);
  const app = check({ ...TREE, "apps/robot-page/src/e.ts": `import { robot } ${FROM} "${LOCAL_FROM_PAGE}";\n` });
  expect(app.code).toBe(1);
  expect(app.text).toContain(
    `apps/robot-page/src/e.ts:1: apps/robot-page must not import the app local (${LOCAL_FROM_PAGE})`,
  );
});

test("a use-specific term fails under apps/ as it does under packages/", () => {
  for (const path of ["apps/local/src/f.ts", "packages/runtime/g.ts"]) {
    const r = check({ ...TREE, [path]: `export const note = "for the ${USE_TERM}";\n` });
    expect(r.code).toBe(1);
    expect(r.text).toContain(`${path}:1: use-specific term`);
  }
});

test("a package importing an app fails", () => {
  const r = check({ ...TREE, "packages/runtime/c.ts": `import { robot } ${FROM} "${APP_PATH}";\n` });
  expect(r.code).toBe(1);
  expect(r.text).toContain(`packages/runtime/c.ts:1: packages/runtime must not import an app (${APP_PATH})`);
});
