// What a person waits for to install spinecord, as .claude/skills/setup-spinecord/install.md does it:
// `bun bench/install.ts [--runs 5] [--repo <url>]`. One line per metric: `<name> median=<v> min=<v> max=<v> n=<runs> <unit>`.
// - clone: `git clone <repo>` into an empty folder (seconds, and the size of its .git and of the checkout).
// - clone_shallow: the same with `--depth 1`, for comparison.
// - install: `bun install --filter @spinecord/local` in that clone with an empty package cache (seconds, packages,
//   MB of node_modules).
// Needs the network; not part of CI. Compare runs taken on the same machine and network.
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const value = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const RUNS = Number(value("--runs") ?? 5);
const REPO = value("--repo") ?? "https://github.com/JairoTorregrosa/spinecord";

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const line = (name: string, xs: number[], unit: string) => {
  const r = (v: number) => Math.round(v * 100) / 100;
  console.log(
    `${name} median=${r(median(xs))} min=${r(Math.min(...xs))} max=${r(Math.max(...xs))} n=${xs.length} ${unit}`,
  );
};
/** Bytes under `dir`, links not followed. */
function size(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += size(p);
    else if (e.isFile()) n += statSync(p).size;
  }
  return n;
}
function run(cmd: string[], cwd: string, env: Record<string, string> = {}): number {
  const t0 = performance.now();
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${r.exitCode}):\n${r.stderr.toString()}`);
  return (performance.now() - t0) / 1000;
}

console.log(
  `# bench/install.ts ${new Date().toISOString()} ${process.platform} ${process.arch} bun ${Bun.version} runs=${RUNS}`,
);
const out = { clone: [] as number[], shallow: [] as number[], install: [] as number[] };
const sizes = { git: 0, tree: 0, shallowGit: 0, modules: 0, packages: 0 };
for (let i = 0; i < RUNS; i++) {
  const root = mkdtempSync(join(tmpdir(), "spinecord-install-"));
  try {
    out.clone.push(run(["git", "clone", "-q", REPO, "full"], root));
    out.shallow.push(run(["git", "clone", "-q", "--depth", "1", REPO, "shallow"], root));
    const full = join(root, "full");
    out.install.push(
      run(["bun", "install", "--filter", "@spinecord/local"], full, { BUN_INSTALL_CACHE_DIR: join(root, "cache") }),
    );
    sizes.git = size(join(full, ".git"));
    sizes.shallowGit = size(join(root, "shallow", ".git"));
    sizes.modules = size(join(full, "node_modules"));
    sizes.tree = size(full) - sizes.git - sizes.modules;
    sizes.packages = readdirSync(join(full, "node_modules", ".bun")).filter((n) => n !== "node_modules").length;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const mb = (b: number) => Math.round(b / 1e5) / 10;
line("clone", out.clone, "s");
console.log(`clone_size git=${mb(sizes.git)} checkout=${mb(sizes.tree)} MB`);
line("clone_shallow", out.shallow, "s");
console.log(`clone_shallow_size git=${mb(sizes.shallowGit)} MB`);
line("install", out.install, "s");
console.log(`install_size packages=${sizes.packages} node_modules=${mb(sizes.modules)} MB`);
