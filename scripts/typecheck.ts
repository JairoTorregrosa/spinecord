// Typecheck of every package, app and script, cross-platform: `bun check`.
// One TypeScript project (tsconfig.json): bun and DOM types together.
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const t = Date.now();
const child = Bun.spawn([process.execPath, "x", "tsc", "-p", join(root, "tsconfig.json")], {
  cwd: root,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});
const [out, err, code] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
if (code !== 0) process.stderr.write(out + err);
console.log(`${code === 0 ? "ok  " : "FAIL"} tsc -p tsconfig.json (${Date.now() - t} ms)`);
process.exit(code === 0 ? 0 : 1);
