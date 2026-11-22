// Test-only Worker entry, bundled once per test process by test/setup.ts and run by Miniflare (workerd).
// It is the real worker (../src/index.ts) plus what a test in another process cannot do from outside:
//   x-test-env header   JSON of env overrides for this one request (null removes a binding)
//   POST /__test/sql    {sql, params, raw?} -> rows from D1, once the call log is flushed (raw: without waiting)
//   POST /__test/reset  {migrations} -> deletes every Durable Object and the D1 database (Miniflare keeps D1 in a
//                       Durable Object too), then applies the migration statements: a test file starts from nothing
//   POST /__test/evict  {robot_id}    -> evicts that robot's Durable Object, hibernating its WebSockets
import unsafe from "workerd:unsafe";
import { loadConfig } from "../src/config.ts";
import { callLogFlushed } from "../src/dispatch.ts";
import worker from "../src/index.ts";
import type { RobotDO } from "../src/robot-do.ts";

export { RobotDO } from "../src/index.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__test/sql") {
      const { sql, params, raw } = (await request.json()) as { sql: string; params: unknown[]; raw?: boolean };
      // the call log is written after each answer: read it as the admin API does, once the answered calls are in
      // (raw: read D1 as it is right now, to see what the log's own timer has written)
      if (!raw) await callLogFlushed(env, loadConfig(env));
      const out = await env.DB.prepare(sql)
        .bind(...params)
        .all();
      return Response.json(out.results);
    }
    if (url.pathname === "/__test/reset") {
      const { migrations } = (await request.json()) as { migrations: string[] };
      if (migrations.length === 0) throw new Error("reset needs the migration statements");
      await unsafe.deleteAllDurableObjects();
      await env.DB.batch(migrations.map((statement) => env.DB.prepare(statement)));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__test/evict") {
      const { robot_id } = (await request.json()) as { robot_id: string };
      // an object is only evicted once idle: no call-log row is still waiting for its batch
      await (env.ROBOT.get(env.ROBOT.idFromName(robot_id)) as unknown as RobotDO).callsFlushed();
      await unsafe.evict(env.ROBOT.get(env.ROBOT.idFromName(robot_id)), { webSockets: "hibernate" });
      return Response.json({ ok: true });
    }
    const override = request.headers.get("x-test-env");
    if (override === null) return worker.fetch(request, env, ctx);
    const patched: Record<string, unknown> = { ...env };
    for (const [k, v] of Object.entries(JSON.parse(override) as Record<string, unknown>)) {
      if (v === null) delete patched[k];
      else patched[k] = v;
    }
    const headers = new Headers(request.headers);
    headers.delete("x-test-env");
    return worker.fetch(new Request(request, { headers }), patched as unknown as Env, ctx);
  },
} satisfies ExportedHandler<Env>;
