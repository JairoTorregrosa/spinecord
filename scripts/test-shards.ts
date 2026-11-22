// Runs the tests of every package and app, cross-platform: `bun run test`.
//   bun scripts/test-shards.ts                  every test file
//   SHARD=2/3 bun scripts/test-shards.ts        (or --shard 2/3) only the files of shard 2 of 3
//   bun scripts/test-shards.ts --affected       only packages the diff can reach (scripts/affected.ts; --base <ref> or AFFECTED_BASE)
//   bun scripts/test-shards.ts --record         run everything and write per-file durations to test-timings.json
//   bun scripts/test-shards.ts --list           print the plan as JSON and run nothing
// Shards balance recorded time, not file count: files are sorted longest first and each goes to the shard with
// the least time so far. A file without a recorded time weighs the median of the recorded ones.
// Each package's files run in one `bun test` process with the package as cwd, so its bunfig.toml applies.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { affected, baseFromArgs, listPackages, root, unitDir } from "./affected.ts";

const TIMINGS = join(root, "test-timings.json");
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

type Timings = { note: string; files: Record<string, number> };
export type Shard = { files: string[]; ms: number };

/** Greedy longest-first: deterministic for the same files and weights, whatever order they arrive in. */
export function split(files: string[], weight: (file: string) => number, n: number): Shard[] {
  const shards: Shard[] = Array.from({ length: n }, () => ({ files: [], ms: 0 }));
  const sorted = [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const file of sorted) {
    const least = shards.reduce((min, s) => (s.ms < min.ms ? s : min));
    least.files.push(file);
    least.ms += weight(file);
  }
  return shards;
}

export function parseShard(spec: string): { index: number; total: number } {
  const m = spec.match(/^(\d+)\/(\d+)$/);
  const [index, total] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  if (!m || total < 1 || index < 1 || index > total)
    throw new Error(`bad shard "${spec}": expected i/N with 1 <= i <= N, for example 2/3`);
  return { index, total };
}

/** Test files as posix paths relative to the repo root, e.g. packages/runtime/runtime.test.ts */
function testFiles(packages: string[]): string[] {
  const out: string[] = [];
  for (const pkg of packages) {
    const glob = new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}");
    const dir = unitDir(pkg);
    for (const file of glob.scanSync({ cwd: join(root, ...dir.split("/")) })) {
      const posix = file.split("\\").join("/");
      const parts = posix.split("/");
      if (!parts.includes("node_modules") && !parts.includes("dist")) out.push(`${dir}/${posix}`);
    }
  }
  return out.sort();
}

function readTimings(): Timings {
  const t = JSON.parse(readFileSync(TIMINGS, "utf8")) as Timings;
  if (typeof t.files !== "object" || t.files === null)
    throw new Error(`${TIMINGS} has no "files" map; rewrite it with: bun run test:record`);
  return t;
}

/** file (relative to the package) -> ms, summed over the test cases of a junit report */
export function durationsFromJunit(xml: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of xml.matchAll(/<testcase\b[^>]*>/g)) {
    const file = m[0].match(/\bfile="([^"]*)"/)?.[1];
    const time = m[0].match(/\btime="([^"]*)"/)?.[1];
    if (file === undefined || time === undefined) throw new Error(`junit test case without file or time: ${m[0]}`);
    const key = file.split("\\").join("/");
    out[key] = (out[key] ?? 0) + Number(time) * 1000;
  }
  return out;
}

async function main(): Promise<number> {
  const record = flag("--record");
  const packages = listPackages();
  let selected = packages;
  if (flag("--affected") && !record) {
    const a = affected(baseFromArgs(argv));
    selected = a.packages;
    console.log(`affected: ${a.all ? "all packages" : selected.join(", ") || "none"} (${a.reason})`);
  }

  const timings = readTimings();
  const known = Object.values(timings.files).sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)]! : 1000;
  const weight = (file: string) => timings.files[file] ?? fallback;

  let files = testFiles(selected);
  const spec = value("--shard") ?? process.env.SHARD;
  if (spec && !record) {
    const { index, total } = parseShard(spec);
    const shard = split(files, weight, total)[index - 1]!;
    console.log(
      `shard ${index}/${total}: ${shard.files.length} of ${files.length} file(s), about ${Math.round(shard.ms)} ms recorded`,
    );
    files = shard.files;
  }
  if (flag("--list")) {
    console.log(JSON.stringify({ files, unrecorded: files.filter((f) => !(f in timings.files)) }, null, 2));
    return 0;
  }
  if (files.length === 0) {
    // an empty shard or a diff that reaches no package is a pass, not an error
    console.log("no test files to run");
    return 0;
  }

  const tmp = mkdtempSync(join(tmpdir(), "test-shards-"));
  const measured: Record<string, number> = {};
  let failed = 0;
  try {
    for (const pkg of packages) {
      const prefix = `${unitDir(pkg)}/`;
      const mine = files.filter((f) => f.startsWith(prefix)).map((f) => `./${f.slice(prefix.length)}`);
      if (mine.length === 0) continue;
      const report = join(tmp, `${pkg}.xml`);
      const t = Date.now();
      console.log(`\n> ${pkg}: bun test (${mine.length} file(s))`);
      const child = Bun.spawn([process.execPath, "test", ...mine, "--reporter=junit", `--reporter-outfile=${report}`], {
        cwd: join(root, ...unitDir(pkg).split("/")),
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      const code = await child.exited;
      console.log(`${code === 0 ? "PASS" : "FAIL"} ${pkg} (${Date.now() - t} ms)`);
      if (code !== 0) failed++;
      else if (record)
        for (const [file, ms] of Object.entries(durationsFromJunit(readFileSync(report, "utf8"))))
          measured[`${prefix}${file}`] = Math.round(ms);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (record) {
    if (failed) throw new Error("timings not recorded: a test run failed");
    const missing = files.filter((f) => !(f in measured));
    if (missing.length)
      throw new Error(`timings not recorded: the junit reports have no test case for ${missing.join(", ")}`);
    const sorted = Object.fromEntries(Object.entries(measured).sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(TIMINGS, `${JSON.stringify({ note: timings.note, files: sorted }, null, 2)}\n`);
    console.log(`\nrecorded ${Object.keys(sorted).length} file(s) in test-timings.json`);
  }
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
