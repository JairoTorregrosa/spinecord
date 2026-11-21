// Admin HTTP API (CONTRACT §9). JSON in, JSON out, bearer of an admin principal. Mutations go through the same
// tool pipeline as MCP, so state machines, logs and the call table see them the same way.

import { PROGRAM_TRANSITIONS } from "../../protocol/types.ts";
import { type Config, type Principal, ownersOf } from "./config.ts";
import { callTool, listRobots } from "./dispatch.ts";
import { ToolFail } from "./envelope.ts";
import { log } from "./log.ts";
import * as store from "./store.ts";

export const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
export const httpError = (status: number, code: string, message: string, headers?: HeadersInit) =>
  json({ ok: false, error: { code, message } }, status, headers);

const STATUS: Record<string, number> = {
  unauthorized: 403,
  unknown_robot: 404,
  invalid_argument: 400,
  illegal_state: 409,
  robot_offline: 409,
  stop_unverified: 502,
  rate_limited: 429,
  internal: 500,
};

export async function serveApi(
  request: Request,
  url: URL,
  env: Env,
  cfg: Config,
  who: Principal,
  trace_id: string,
): Promise<Response> {
  const path = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent); // after "api"
  const route = `${request.method} ${path.map((p, i) => ((path[0] === "robots" && i === 1) || (path[0] === "programs" && (i === 1 || i === 2)) ? ":" : p)).join("/")}`;
  const tool = async (name: string, args: Record<string, unknown>) => {
    const { envelope } = await callTool(env, cfg, who, name, args, trace_id);
    return json(envelope, envelope.ok ? 200 : (STATUS[envelope.error.code] ?? 409));
  };
  try {
    switch (route) {
      case "GET robots": {
        const robots = await listRobots(env, cfg, who);
        return json({ ok: true, data: robots.map((r) => ({ ...r, owner_principals: ownersOf(cfg, r.id) })) });
      }
      case "POST robots/:/stop":
        return tool("stop", { robot_id: path[1] });
      case "POST stop-all":
        return tool("stop_all", {});
      case "POST robots/:/control": {
        const body = (await request.json().catch(() => null)) as { to?: unknown } | null;
        if (body?.to !== "owner" && body?.to !== "admin")
          return httpError(400, "invalid_argument", 'to: must be "owner" or "admin" (JSON body {"to": ...})');
        return tool(body.to === "admin" ? "take_control" : "release_control", {
          robot_id: path[1],
          request_id: `http-${trace_id}`,
        });
      }
      case "GET calls": {
        const since = Number(url.searchParams.get("since") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 100);
        if (!Number.isFinite(since) || since < 0)
          return httpError(400, "invalid_argument", "since: must be a timestamp in ms since the epoch");
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
          return httpError(400, "invalid_argument", "limit: must be an integer 1..1000");
        return json({
          ok: true,
          data: await store.listCalls(env.DB, {
            robot_id: url.searchParams.get("robot_id") ?? undefined,
            since,
            limit,
          }),
        });
      }
      case "GET episodes":
        return json({
          ok: true,
          data: await store.listEpisodes(env.DB, url.searchParams.get("robot_id") ?? undefined),
        });
      case "GET programs":
        return json({
          ok: true,
          data: await store.listPrograms(env.DB, {
            query: url.searchParams.get("query") ?? undefined,
            state: url.searchParams.get("state") ?? undefined,
          }),
        });
      case "POST programs/:/:/approve": {
        const version = Number(path[2]);
        if (!Number.isInteger(version)) return httpError(400, "invalid_argument", "version: must be an integer");
        const p = await store.getProgram(env.DB, path[1] as string, version);
        void PROGRAM_TRANSITIONS; // the assertion lives in store.transitionProgram
        const moved = await store.transitionProgram(env.DB, p, "approved");
        log("program_approved", { name: p.name, version: p.version, principal: who.principal_id, trace_id });
        return json({ ok: true, data: moved });
      }
      default:
        return httpError(404, "not_found", `no route ${request.method} ${url.pathname}; see CONTRACT.md §9`);
    }
  } catch (e) {
    if (e instanceof ToolFail) return httpError(STATUS[e.code] ?? 409, e.code, e.message);
    log("internal_error", {
      trace_id,
      route,
      message: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e),
    });
    return httpError(500, "internal", `unexpected error (trace_id ${trace_id})`);
  }
}
