// Builds the robot page into a static folder: `bun apps/robot-page/build.ts` writes apps/robot-page/dist.
//   --out <dir>           another output folder
//   --deployments <dir>   where the robot files are (default: <repo>/deployments)
// dist/profiles.json lists every deployments/<name>/robots/<robot>.json, checked with the page's own parser,
// so a broken robot file fails the build instead of the page.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseRobotConfig, type ProfileEntry } from "./src/config";

const here = import.meta.dir;
const STATIC = ["index.html", "styles.css"];

export function collectProfiles(deployments: string): ProfileEntry[] {
  if (!existsSync(deployments)) throw new Error(`deployments folder not found: ${deployments}`);
  const out: ProfileEntry[] = [];
  for (const name of readdirSync(deployments).sort()) {
    const robots = join(deployments, name, "robots");
    if (!existsSync(robots) || !statSync(robots).isDirectory()) continue;
    for (const file of readdirSync(robots).sort()) {
      if (!file.endsWith(".json")) continue;
      const id = `${name}/${file.slice(0, -".json".length)}`;
      try {
        out.push({ id, config: parseRobotConfig(readFileSync(join(robots, file), "utf8")) });
      } catch (e) {
        throw new Error(`${join(robots, file)}: ${(e as Error).message}`, { cause: e });
      }
    }
  }
  return out;
}

export async function buildPage(opts: { outdir?: string; deployments?: string } = {}): Promise<string> {
  const outdir = opts.outdir ?? join(here, "dist");
  const profiles = collectProfiles(opts.deployments ?? join(here, "..", "..", "deployments"));
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(here, "src", "main.ts")],
    outdir,
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "linked",
    naming: "[name].[ext]",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("robot page build failed");
  }
  for (const file of STATIC) cpSync(join(here, file), join(outdir, file));
  writeFileSync(join(outdir, "profiles.json"), `${JSON.stringify(profiles, null, 2)}\n`);
  return outdir;
}

if (import.meta.main) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    if (i < 0) return undefined;
    const value = process.argv[i + 1];
    if (!value) throw new Error(`${name} needs a folder`);
    return resolve(value);
  };
  const outdir = arg("--out");
  const deployments = arg("--deployments");
  console.log(`built ${await buildPage({ ...(outdir ? { outdir } : {}), ...(deployments ? { deployments } : {}) })}`);
}
