// Cross-platform (macOS, Windows, Linux): `bun scripts/check-boundaries.ts`.
// Fails if code under packages/ or apps/ references a specific use, or imports across the boundaries in
// ARCHITECTURE.md.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

// --root <dir> checks another tree with the same layout (the script's own test plants a forbidden import in one)
const rootArg = process.argv.indexOf("--root");
const root = rootArg >= 0 ? resolve(process.argv[rootArg + 1] ?? "") : join(import.meta.dir, "..");
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
const KINDS = ["packages", "apps"] as const;
// unit → units it must not import (ARCHITECTURE.md dependency direction). A unit is `packages/<name>` or
// `apps/<name>`. No package imports an app, whatever this table says.
const FORBIDDEN: Record<string, string[]> = {
  "packages/protocol": ["driver-ev3", "driver-ev3dev", "sim-world", "sim-ev3", "runtime", "page-hub"].map(
    (p) => `packages/${p}`,
  ),
  "packages/driver-ev3": ["driver-ev3dev", "sim-world", "sim-ev3", "runtime"].map((p) => `packages/${p}`),
  "packages/driver-ev3dev": ["driver-ev3", "sim-world", "sim-ev3", "runtime"].map((p) => `packages/${p}`),
  "packages/sim-world": ["driver-ev3", "driver-ev3dev", "sim-ev3", "runtime"].map((p) => `packages/${p}`),
  "packages/sim-ev3": ["driver-ev3dev", "runtime"].map((p) => `packages/${p}`),
  "packages/runtime": ["driver-ev3", "driver-ev3dev", "sim-world", "sim-ev3", "page-hub"].map((p) => `packages/${p}`),
  // the page hub talks to pages and to the runtime only through protocol's types and the Provider interface
  "packages/page-hub": ["driver-ev3", "driver-ev3dev", "sim-world", "sim-ev3", "runtime"].map((p) => `packages/${p}`),
  // the LEGO parts map is data and a loader: it stands on nothing else
  "packages/lego-parts": ["protocol", "driver-ev3", "driver-ev3dev", "sim-world", "sim-ev3", "runtime", "page-hub"].map(
    (p) => `packages/${p}`,
  ),
  // the bridge page speaks EV3 bytes and nothing else; apps/local builds and serves it, not the other way round
  "apps/robot-page": [
    ...["protocol", "driver-ev3dev", "sim-world", "sim-ev3", "runtime"].map((p) => `packages/${p}`),
    "apps/local",
  ],
  // the 3D view draws what apps/local sends it: three.js and its own message types, nothing of a runtime or a driver
  "apps/twin-view": [
    ...["protocol", "driver-ev3", "driver-ev3dev", "sim-world", "sim-ev3", "runtime", "page-hub"].map(
      (p) => `packages/${p}`,
    ),
    "apps/local",
    "apps/robot-page",
    "apps/peripheral-page",
  ],
  // the peripheral page speaks the page protocol and nothing else: protocol's types, never a runtime or the hub
  "apps/peripheral-page": [
    ...["driver-ev3", "driver-ev3dev", "sim-world", "sim-ev3", "runtime", "page-hub"].map((p) => `packages/${p}`),
    "apps/local",
    "apps/robot-page",
  ],
};

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (EXT.test(name)) yield p;
  }
}

const units: string[] = [];
for (const kind of KINDS) {
  const dir = join(root, kind);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) if (statSync(join(dir, name)).isDirectory()) units.push(`${kind}/${name}`);
}

/** The unit an import specifier points into, or null (a dependency, a file of the same tree outside every unit). */
function target(file: string, spec: string): string | null {
  if (spec.startsWith(".")) {
    const parts = relative(root, resolve(dirname(file), spec)).split(sep);
    return parts.length >= 2 && units.includes(`${parts[0]}/${parts[1]}`) ? `${parts[0]}/${parts[1]}` : null;
  }
  // a workspace name: @scope/<directory name>
  const name = spec.match(/^@[^/]+\/([^/]+)$/)?.[1];
  return (name && units.find((u) => u.split("/")[1] === name)) || null;
}

const problems: string[] = [];
for (const unit of units) {
  for (const file of walk(join(root, ...unit.split("/")))) {
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
        const to = target(file, spec);
        if (!to || to === unit) return;
        const [kind, name] = to.split("/");
        // the 3D view reads the LEGO parts map in one module only, as a Bun macro that runs at build time, so the page
        // gets the numbers and never the loader (node:fs) or the map's data; its tests, which never reach the page, may
        // check against the map
        if (
          unit === "apps/twin-view" &&
          to === "packages/lego-parts" &&
          rel !== "apps/twin-view/src/lego.ts" &&
          !rel.endsWith(".test.ts")
        )
          problems.push(`${rel}:${i + 1}: apps/twin-view reads packages/lego-parts only in src/lego.ts (${spec})`);
        else if (unit.startsWith("packages/") && kind === "apps")
          problems.push(`${rel}:${i + 1}: ${unit} must not import an app (${spec})`);
        else if (FORBIDDEN[unit]?.includes(to))
          problems.push(
            `${rel}:${i + 1}: ${unit} must not import ${kind === "apps" ? `the app ${name}` : name} (${spec})`,
          );
      });
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`BOUNDARY: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log("boundaries OK");
