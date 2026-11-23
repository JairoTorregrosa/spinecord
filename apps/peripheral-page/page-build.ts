// Builds the peripheral page (page.html, page.css, src/main.ts, src/level-worklet.ts) in memory, for the process
// that serves it (apps/local). Nothing is written to disk. The HTML keeps a `<!-- spinecord:meta -->` line where
// the listener writes the token and the robots.
import { join } from "node:path";

export interface PeripheralPageFiles {
  /** page.html, with the meta placeholder. */
  html: string;
  /** Files served next to it, by name: page.js, page.css, level.js. */
  files: Record<string, { type: string; body: string }>;
}
export const META_PLACEHOLDER = "<!-- spinecord:meta -->";

async function bundle(entry: string): Promise<string> {
  const build = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", minify: true });
  if (!build.success || build.outputs.length !== 1)
    throw new Error(`the peripheral page did not build (${entry}):\n${build.logs.join("\n")}`);
  return build.outputs[0]!.text();
}

let built: Promise<PeripheralPageFiles> | null = null;
/** The page's files; built once per process. */
export function buildPeripheralPage(): Promise<PeripheralPageFiles> {
  built ??= (async () => {
    const dir = import.meta.dir;
    const [html, css, js, level] = await Promise.all([
      Bun.file(join(dir, "page.html")).text(),
      Bun.file(join(dir, "page.css")).text(),
      bundle(join(dir, "src", "main.ts")),
      bundle(join(dir, "src", "level-worklet.ts")),
    ]);
    if (!html.includes(META_PLACEHOLDER)) throw new Error(`page.html has no ${META_PLACEHOLDER} line`);
    const js_ = "text/javascript; charset=utf-8";
    return {
      html,
      files: {
        "page.js": { type: js_, body: js },
        "level.js": { type: js_, body: level },
        "page.css": { type: "text/css; charset=utf-8", body: css },
      },
    };
  })();
  built.catch(() => (built = null));
  return built;
}
