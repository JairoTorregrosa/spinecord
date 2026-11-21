// Every check at once, cross-platform: `bun run ci` (lint, fmt:check, typecheck, boundaries, tests in parallel).
// Each step is a root package.json script run as its own process; output is streamed line by line with the
// step's name in front. Exits non-zero if any step fails. Extra arguments go to the test step
// (`bun run ci --affected`).
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const extra = process.argv.slice(2);
const steps: [name: string, args: string[]][] = [
  ["lint", ["run", "lint"]],
  ["fmt", ["run", "fmt:check"]],
  ["typecheck", ["run", "check"]],
  ["boundaries", ["run", "boundaries"]],
  ["test", ["run", "test", ...extra]],
  ["apps", ["test", "./apps"]],
];
const width = Math.max(...steps.map(([name]) => name.length));

async function pipe(stream: ReadableStream<Uint8Array>, prefix: string, out: NodeJS.WriteStream): Promise<void> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
    rest = lines.pop() ?? "";
    for (const line of lines) out.write(`${prefix}${line}\n`);
  }
  if (rest) out.write(`${prefix}${rest}\n`);
}

const started = Date.now();
const results = await Promise.all(
  steps.map(async ([name, args]) => {
    const t = Date.now();
    const prefix = `${name.padEnd(width)} | `;
    // process.execPath is this bun: no shell and no PATH lookup, so it is the same on Windows
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    await Promise.all([pipe(child.stdout, prefix, process.stdout), pipe(child.stderr, prefix, process.stderr)]);
    return { name, code: await child.exited, ms: Date.now() - t };
  }),
);

console.log("");
for (const r of results)
  console.log(
    `${r.code === 0 ? "PASS" : "FAIL"} ${r.name.padEnd(width)} ${r.ms} ms${r.code === 0 ? "" : ` (exit ${r.code})`}`,
  );
const failed = results.filter((r) => r.code !== 0);
console.log(
  `${failed.length === 0 ? "ci OK" : `ci FAILED: ${failed.map((r) => r.name).join(", ")}`} (${Date.now() - started} ms)`,
);
process.exit(failed.length === 0 ? 0 : 1);
