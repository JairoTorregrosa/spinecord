// --view: serves the sim-world viewer for the twins of this process, on localhost only.
// The page (view-page.ts) draws with the viewer's own code; this side only hands it the world file and,
// on every poll, where the twin is. Nothing is rendered here.
import { join } from "node:path";
import type { Twin } from "./twin";

export interface ViewServer {
  url: string;
  stop(): void;
}

export async function serveView(
  twins: Twin[],
  world: { name: string; json: unknown },
  port: number,
): Promise<ViewServer> {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "view-page.ts")],
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!build.success || build.outputs.length !== 1)
    throw new Error(`--view: the viewer page did not build:\n${build.logs.join("\n")}`);
  const script = await build.outputs[0]!.text();
  const page = await Bun.file(join(import.meta.dir, "view.html")).text();
  const json = (body: unknown, status = 200): Response =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      switch (url.pathname) {
        case "/":
          return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        case "/view.js":
          return new Response(script, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
        case "/twins":
          return json(twins.map((t) => t.robot_id));
        case "/world":
          return json(world);
        case "/state": {
          const id = url.searchParams.get("robot");
          const twin = twins.find((t) => t.robot_id === id);
          if (!twin)
            return json({ error: `no twin "${id}" here; twins: ${twins.map((t) => t.robot_id).join(", ")}` }, 404);
          twin.brick.tick(); // physics up to now
          return json({
            robot_id: twin.robot_id,
            link: twin.client.state(),
            world: twin.brick.world.cfg.name,
            pose: twin.brick.world.pose,
          });
        }
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => void server.stop(true) };
}
