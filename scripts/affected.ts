// Which packages can a diff reach? Cross-platform: `bun scripts/affected.ts [--base origin/main]` prints JSON.
// A package is affected when one of its files changed or when it depends, directly or not, on a package that
// changed. The dependency graph is read from the code (relative imports that cross into another package, and
// workspace names in package.json), so it follows ARCHITECTURE.md without a second copy of it.
// A change in packages/protocol, or in anything at the repo root that is not documentation, affects everything.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const root = join(import.meta.dir, "..");
const pkgsDir = join(root, "packages");
const CODE = /\.(ts|tsx|js|mjs|cjs)$/;
/** Root paths that no test can reach. Everything else at the root (config, scripts, lockfile, CI) reaches all. */
const DOCS = [
  /^[^/]+\.md$/,
  /^docs\//,
  /^LICENSE$/,
  /^deployments\//,
  /^\.gitleaksignore$/,
  /^\.gitattributes$/,
  /^\.gitignore$/,
];

export type Affected = { all: boolean; packages: string[]; reason: string; changed: string[] };

export const listPackages = (): string[] =>
  readdirSync(pkgsDir)
    .filter((name) => statSync(join(pkgsDir, name)).isDirectory())
    .sort();

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".wrangler" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (CODE.test(name)) yield p;
  }
}

/** package -> packages it imports */
export function dependencyGraph(packages: string[] = listPackages()): Record<string, string[]> {
  const byName = new Map<string, string>();
  for (const pkg of packages) {
    const manifest = join(pkgsDir, pkg, "package.json");
    if (existsSync(manifest)) byName.set((JSON.parse(readFileSync(manifest, "utf8")) as { name: string }).name, pkg);
  }
  const graph: Record<string, string[]> = {};
  for (const pkg of packages) {
    const deps = new Set<string>();
    const manifest = join(pkgsDir, pkg, "package.json");
    if (existsSync(manifest)) {
      const m = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, Record<string, string> | undefined>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
        for (const name of Object.keys(m[field] ?? {})) if (byName.has(name)) deps.add(byName.get(name)!);
    }
    for (const file of walk(join(pkgsDir, pkg))) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/(?:from\s+|import\s*\(?\s*|require\(\s*)["'`]([^"'`]+)["'`]/g)) {
        const spec = m[1]!;
        const scoped = byName.get(spec.split("/").slice(0, 2).join("/"));
        if (scoped) deps.add(scoped);
        if (!spec.startsWith(".")) continue;
        const target = relative(pkgsDir, resolve(dirname(file), spec)).split(sep);
        if (target[0] !== ".." && packages.includes(target[0]!)) deps.add(target[0]!);
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
    const m = path.match(/^packages\/([^/]+)\//);
    if (m) {
      // a package that no longer exists (deleted or renamed): its dependents are unknown, so run all
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
