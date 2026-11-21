// Cross-platform (macOS, Windows, Linux): `bun scripts/check-boundaries.ts`.
// Fails if package code references a specific use, or imports across the boundaries in ARCHITECTURE.md.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = join(import.meta.dir, "..");
const pkgs = join(root, "packages");
// Generic words that signal code written for one event or use. Add private terms (names, places,
// events) one per line to scripts/boundaries.local.txt, which is gitignored.
const LOCAL = join(import.meta.dir, "boundaries.local.txt");
const extra = existsSync(LOCAL)
  ? readFileSync(LOCAL, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"))
  : [];
const TERMS = new RegExp(["taller", "workshop", "facilitat", "\\bmesa\\b", "\\btable_id\\b", ...extra].join("|"), "i");
const EXT = /\.(ts|tsx|js|mjs|cjs|json|jsonc|html|md|txt|sql|py|toml|yaml|yml)$/;
// package → packages it must not import (ARCHITECTURE.md dependency direction)
const FORBIDDEN: Record<string, string[]> = {
  protocol: ["driver-ev3", "driver-ev3dev", "sim-world", "sim-ev3", "runtime", "server"],
  "driver-ev3": ["driver-ev3dev", "sim-world", "sim-ev3", "runtime", "server"],
  "driver-ev3dev": ["driver-ev3", "sim-world", "sim-ev3", "runtime", "server"],
  "sim-world": ["driver-ev3", "driver-ev3dev", "sim-ev3", "runtime", "server"],
  "sim-ev3": ["driver-ev3dev", "runtime", "server"],
  runtime: ["driver-ev3", "driver-ev3dev", "sim-world", "sim-ev3", "server", "e2e"],
  server: ["runtime", "driver-ev3", "driver-ev3dev", "sim-world", "sim-ev3", "e2e"],
  // e2e joins the real runtime to the real relay; it holds tests only and nothing imports it
  e2e: ["driver-ev3", "driver-ev3dev", "sim-world", "sim-ev3"],
};

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".wrangler" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (EXT.test(name)) yield p;
  }
}

const problems: string[] = [];
for (const pkg of readdirSync(pkgs)) {
  const dir = join(pkgs, pkg);
  if (!statSync(dir).isDirectory()) continue;
  for (const file of walk(dir)) {
    const rel = relative(root, file).split(sep).join("/");
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (TERMS.test(line))
          problems.push(`${rel}:${i + 1}: use-specific term → move it to deployments/: ${line.trim().slice(0, 120)}`);
        const m = line.match(
          /from\s+["'`]([^"'`]+)["'`]|\bimport\s*\(?\s*["'`]([^"'`]+)["'`]|\brequire\(\s*["'`]([^"'`]+)["'`]/,
        );
        const spec = m?.[1] ?? m?.[2] ?? m?.[3];
        if (!spec) return;
        if (spec.startsWith(".") && /(^|\/)apps\//.test(spec))
          problems.push(`${rel}:${i + 1}: packages/${pkg} must not import an app (${spec})`);
        for (const bad of FORBIDDEN[pkg] ?? []) {
          if (
            new RegExp(`(^|/)(packages/)?${bad}(/|$)|^@[^/]+/${bad}$`).test(spec) &&
            (spec.startsWith(".") || spec.startsWith("@"))
          )
            problems.push(`${rel}:${i + 1}: packages/${pkg} must not import ${bad} (${spec})`);
        }
      });
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`BOUNDARY: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log("boundaries OK");
