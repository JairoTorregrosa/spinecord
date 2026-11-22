// Builds the local bridge page (bridge.html + src/bridge-main.ts) in memory, for the process that serves it
// (apps/local). Nothing is written to disk.
import { join } from "node:path";

export interface BridgePage {
  html: string;
  js: string;
}

/** `entry` is the page script; a measurement harness passes its own (a simulated brick behind the same bridge). */
export async function buildBridgePage(entry = join(import.meta.dir, "src", "bridge-main.ts")): Promise<BridgePage> {
  const build = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", minify: true });
  if (!build.success || build.outputs.length !== 1)
    throw new Error(`the bridge page did not build:\n${build.logs.join("\n")}`);
  return {
    html: await Bun.file(join(import.meta.dir, "bridge.html")).text(),
    js: await build.outputs[0]!.text(),
  };
}
