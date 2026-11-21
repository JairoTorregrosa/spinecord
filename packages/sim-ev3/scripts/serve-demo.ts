// Builds the viewer and serves packages/sim-ev3 over http on localhost. Run: bun run demo
import { join, normalize, sep } from "node:path";
import { buildDemo } from "./build-demo";

const root = join(import.meta.dir, "..", ".."); // packages/: the page reads ../sim-world/examples
await buildDemo();
const port = Number(process.env.PORT ?? 8765);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error(`PORT must be 1..65535, got ${process.env.PORT}`);
const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = normalize(join(root, decodeURIComponent(new URL(req.url).pathname)));
    if (path !== root && !path.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
    const file = Bun.file(path);
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
console.log(`viewer: http://127.0.0.1:${server.port}/sim-ev3/demo.html  (Ctrl+C to stop)`);
