// Which packages can a diff reach? Cross-platform: `bun scripts/affected.ts [--base origin/main]` prints JSON.
// A package is affected when one of its files changed or when it depends, directly or not, on a package that
// changed. The dependency graph is read from the code (relative imports that cross into another package, and
// workspace names in package.json), so it follows ARCHITECTURE.md without a second copy of it.
// Apps (apps/<name>) are units like packages: they have tests and import packages, and nothing imports them.
// A change in packages/protocol, or in anything at the repo root that is not documentation, affects everything.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const root = join(import.meta.dir, "..");
/** Folders whose children are units with their own tests. A unit's name is unique across both. */
const UNIT_ROOTS = ["packages", "apps"] as const;
const UNIT_PATH = /^(?:packages|apps)\/([^/]+)\//;
const CODE = /\.(ts|tsx|js|mjs|cjs)$/;
/** Root paths that no test can reach (deployments/ is not one: the local server's tests read its robot file). Everything else at the root (config, scripts, lockfile, CI) reaches all. */
const DOCS = [/^[^/]+\.md$/, /^docs\//, /^LICENSE$/, /^\.gitleaksignore$/, /^\.gitattributes$/, /^\.gitignore$/];

export type Affected = { all: boolean; packages: string[]; reason: string; changed: string[] };

/** unit name -> its folder relative to the repo root, posix: "packages/runtime", "apps/robot-page" */
export function unitDirs(): Record<string, string> {
  const dirs: Record<string, string> = {};
  for (const base of UNIT_ROOTS) {
    if (!existsSync(join(root, base))) continue;
    for (const name of readdirSync(join(root, base))) {
      if (!statSync(join(root, base, name)).isDirectory()) continue;
      if (dirs[name]) throw new Error(`two units are named "${name}": ${dirs[name]} and ${base}/${name}`);
      dirs[name] = `${base}/${name}`;
    }
  }
  return dirs;
}
export const unitDir = (name: string): string => {
  const dir = unitDirs()[name];
  if (!dir) throw new Error(`no package or app is named "${name}"`);
  return dir;
};
export const listPackages = (): string[] => Object.keys(unitDirs()).sort();

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (CODE.test(name)) yield p;
  }
}

/** package -> packages it imports */
export function dependencyGraph(packages: string[] = listPackages()): Record<string, string[]> {
  const dirs = unitDirs();
  const abs = (pkg: string) => join(root, ...dirs[pkg]!.split("/"));
  const byName = new Map<string, string>();
  for (const pkg of packages) {
    const manifest = join(abs(pkg), "package.json");
    if (existsSync(manifest)) byName.set((JSON.parse(readFileSync(manifest, "utf8")) as { name: string }).name, pkg);
  }
  const graph: Record<string, string[]> = {};
  for (const pkg of packages) {
    const deps = new Set<string>();
    const manifest = join(abs(pkg), "package.json");
    if (existsSync(manifest)) {
      const m = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, Record<string, string> | undefined>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
        for (const name of Object.keys(m[field] ?? {})) if (byName.has(name)) deps.add(byName.get(name)!);
    }
    for (const file of walk(abs(pkg))) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/(?:from\s+|import\s*\(?\s*|require\(\s*)["'`]([^"'`]+)["'`]/g)) {
        const spec = m[1]!;
        const scoped = byName.get(spec.split("/").slice(0, 2).join("/"));
        if (scoped) deps.add(scoped);
        if (!spec.startsWith(".")) continue;
        const target = `${relative(root, resolve(dirname(file), spec))
          .split(sep)
          .join("/")}/`.match(UNIT_PATH)?.[1];
        if (target && packages.includes(target)) deps.add(target);
      }
    }
    deps.delete(pkg);
    graph[pkg] = [...deps].sort();
  }
  return graph;
}

/** Pure: the packages a list of changed paths (posix, relative to the repo root) can reach. */
export function affectedBy(changed: string[], graph: Record<string, string[]>): Affected {
  const packages = Object.keys(graph).sort();
  const everything = (reason: string): Affected => ({ all: true, packages, reason, changed });
  const direct = new Set<string>();
  for (const path of changed) {
    const m = path.match(UNIT_PATH);
    if (m) {
      // a path in a package the tree does not have (deleted or renamed): its dependents are unknown, so run all
      if (!packages.includes(m[1]!)) return everything(`${path} is in a package that is not in the tree`);
      direct.add(m[1]!);
    } else if (!DOCS.some((re) => re.test(path))) return everything(`${path} is root configuration`);
  }
  if (direct.has("protocol")) return everything("packages/protocol changed");
  const reached = new Set(direct);
  for (let grew = true; grew;) {
    grew = false;
    for (const pkg of packages)
      if (!reached.has(pkg) && graph[pkg]!.some((dep) => reached.has(dep))) {
        reached.add(pkg);
        grew = true;
      }
  }
  const list = [...reached].sort();
  return {
    all: list.length === packages.length,
    packages: list,
    reason: list.length ? `changed: ${[...direct].sort().join(", ")}` : "no package is reachable from the diff",
    changed,
  };
}

export function changedFiles(base: string): string[] {
  // three dots: what this branch changed since it left the base, not what the base did meanwhile
  const r = Bun.spawnSync(["git", "diff", "--name-only", `${base}...HEAD`], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0)
    throw new Error(
      `git diff against ${base} failed (is it fetched? CI needs fetch-depth: 0): ${r.stderr.toString().trim()}`,
    );
  return r.stdout
    .toString()
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

export const affected = (base: string): Affected => affectedBy(changedFiles(base), dependencyGraph());

export function baseFromArgs(argv: string[]): string {
  const i = argv.indexOf("--base");
  const base = i >= 0 ? argv[i + 1] : process.env.AFFECTED_BASE;
  if (!base)
    throw new Error("no base to diff against: pass --base <ref> (for example origin/main) or set AFFECTED_BASE");
  return base;
}

if (import.meta.main) {
  if (process.argv.includes("--graph")) console.log(JSON.stringify(dependencyGraph(), null, 2));
  else console.log(JSON.stringify(affected(baseFromArgs(process.argv.slice(2))), null, 2));
}
