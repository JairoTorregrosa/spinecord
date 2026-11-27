// Builds the 3D view page (view.html, view.css, src/main.ts with three.js) in memory, for the process that serves
// it (apps/local --view). Nothing is written to disk.
import { readdirSync } from "node:fs";
import { join } from "node:path";

export interface ViewPageFiles {
  html: string;
  /** Files served next to it, by name: view.js, view.css, the real meshes (meshes/<part>.bin.gz) and their
   *  attribution (meshes/ATTRIBUTION.md). */
  files: Record<string, { type: string; body: string | Uint8Array<ArrayBuffer> }>;
}

let built: Promise<ViewPageFiles> | null = null;
/** The page's files; built once per process. */
export function buildViewPage(): Promise<ViewPageFiles> {
  built ??= (async () => {
    const dir = import.meta.dir;
    const entry = join(dir, "src", "main.ts");
    const build = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", minify: true });
    if (!build.success || build.outputs.length !== 1)
      throw new Error(`the 3D view page did not build (${entry}):\n${build.logs.join("\n")}`);
    const [html, css, js] = await Promise.all([
      Bun.file(join(dir, "view.html")).text(),
      Bun.file(join(dir, "view.css")).text(),
      build.outputs[0]!.text(),
    ]);
    // the meshes scripts/ldraw-meshes.ts converted: served as they are, gzipped (the page inflates them)
    const meshDir = join(dir, "meshes");
    const meshes: ViewPageFiles["files"] = {};
    for (const name of readdirSync(meshDir)) {
      if (name.endsWith(".bin.gz"))
        meshes[`meshes/${name}`] = {
          type: "application/gzip",
          body: new Uint8Array(await Bun.file(join(meshDir, name)).arrayBuffer()),
        };
      else if (name === "ATTRIBUTION.md")
        meshes[`meshes/${name}`] = {
          type: "text/plain; charset=utf-8",
          body: await Bun.file(join(meshDir, name)).text(),
        };
    }
    return {
      html,
      files: {
        "view.js": { type: "text/javascript; charset=utf-8", body: js },
        "view.css": { type: "text/css; charset=utf-8", body: css },
        ...meshes,
      },
    };
  })();
  built.catch(() => (built = null));
  return built;
}
