// Builds the robot page and serves apps/robot-page/dist on localhost: `bun apps/robot-page/serve.ts`.
// WebHID needs a secure context, and http://localhost is one. PORT picks the port (default 8766);
// --no-build serves the dist folder as it is; --deployments <dir> is passed to the build.
import { existsSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { buildPage } from "./build";

const dist = join(import.meta.dir, "dist");
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
};

export function servePage(root: string, port: number) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be 0..65535, got ${port}`);
  if (!existsSync(join(root, "index.html"))) throw new Error(`${root} has no index.html: run the build first`);
  return Bun.serve({
    port,
    hostname: "localhost",
    async fetch(req) {
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(req.url).pathname);
      } catch {
        return new Response("bad request", { status: 400 });
      }
      const path = normalize(join(root, pathname === "/" ? "index.html" : pathname));
      if (!path.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
      const file = Bun.file(path);
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file, {
        headers: {
          "content-type": TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    },
  });
}

if (import.meta.main) {
  const i = process.argv.indexOf("--deployments");
  const deployments = i >= 0 ? process.argv[i + 1] : undefined;
  if (i >= 0 && !deployments) throw new Error("--deployments needs a folder");
  if (!process.argv.includes("--no-build")) await buildPage(deployments ? { deployments: resolve(deployments) } : {});
  const server = servePage(dist, Number(process.env.PORT ?? 8766));
  console.log(`robot page: http://localhost:${server.port}/  (Chrome or Edge; Ctrl+C to stop)`);
}
