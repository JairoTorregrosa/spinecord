// Builds the viewer bundles (page + training worker) into ev3/dist. Run: bun run build:demo
import { join } from "node:path";

const root = join(import.meta.dir, "..");
export async function buildDemo(): Promise<string> {
  const outdir = join(root, "dist");
  const result = await Bun.build({
    entrypoints: [join(root, "demo.ts"), join(root, "..", "sim-world", "train-worker.ts")],
    outdir,
    target: "browser",
    format: "esm",
    minify: true,
    naming: "[name].[ext]",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("demo build failed");
  }
  return outdir;
}
if (import.meta.main) console.log(`built ${await buildDemo()}`);
