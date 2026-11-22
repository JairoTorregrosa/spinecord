// One entry for every tool call, shared by the MCP endpoint and the admin HTTP API.
// Order: scope → input schema → robot visibility → the robot's Durable Object (or the library).

import { firstViolation } from "../../protocol/schema.ts";
import type { ErrorCode } from "../../protocol/types.ts";
import { type Config, type ToolPrincipal, canSee, isOwner, visibleRobots } from "./config.ts";
import { type Out, TOOL, ToolFail, errOut, okOut, toolError } from "./envelope.ts";
import { log } from "./log.ts";
import { type InvokeReq, LIBRARY, type RobotDO } from "./robot-do.ts";
import * as store from "./store.ts";

export const robotStub = (env: Env, robot_id: string) =>
  env.ROBOT.get(env.ROBOT.idFromName(robot_id)) as unknown as RobotDO;

/**
 * Resolves when the call log (D1) holds every call answered so far: all of them, or those of one robot.
 * A robot's rows are written by its Durable Object; rows without a robot by the LIBRARY instance (store.CallLog).
 */
export async function callLogFlushed(env: Env, cfg: Config, robot_id?: string): Promise<void> {
  const ids = robot_id === undefined ? [...cfg.robots, LIBRARY] : cfg.robots.includes(robot_id) ? [robot_id] : [];
  await Promise.all(ids.map((id) => robotStub(env, id).callsFlushed()));
}

export async function listRobots(env: Env, cfg: Config, who: ToolPrincipal) {
  return Promise.all(
    visibleRobots(cfg, who).map(async (id) => {
      const s = await robotStub(env, id).status(id);
      return {
        id: s.id,
        backend: s.backend,
        link: s.link,
        activity: s.activity,
        control: s.control,
        episode: s.episode,
        battery_low: s.battery_low,
        profile_hash: s.profile_hash,
        fault_reason: s.fault_reason,
        devices: s.devices,
        organs: s.organs,
      };
    }),
  );
}

export async function callTool(
  env: Env,
  cfg: Config,
  who: ToolPrincipal,
  name: string,
  rawArgs: unknown,
  trace_id: string,
  ctx: ExecutionContext,
): Promise<Out> {
  const t0 = Date.now();
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const caller = { id: who.principal_id, role: who.role };
  const robot_id = typeof args?.robot_id === "string" ? args.robot_id : null;

  /** terminal state of a call that never reaches a Durable Object: logged and stored here, once */
  const local = (state: "rejected" | "completed", out: Out): Out => {
    const code = out.envelope.ok ? null : out.envelope.error.code;
    const ms = Date.now() - t0;
    log("call", {
      robot_id,
      tool: name,
      call_state: state,
      code,
      ms,
      trace_id,
      principal: who.principal_id,
      ok: out.envelope.ok,
    });
    // off the response path: the row is handed to the LIBRARY instance, which writes it with its own (store.CallLog)
    ctx.waitUntil(
      Promise.resolve(
        robotStub(env, LIBRARY).logCall({
          id: crypto.randomUUID(),
          robot_id: null,
          tool: name,
          request_id: null,
          state,
          code,
          ms,
          episode_id: null,
          created_at: t0,
          principal: who.principal_id,
          moving: false,
          trace_id,
        }),
      ).catch((e: unknown) =>
        log("calls_write_error", { trace_id, message: e instanceof Error ? e.message : String(e) }),
      ),
    );
    return out;
  };
  const reject = (code: ErrorCode, message: string) => local("rejected", errOut(name, toolError(code, message)));

  const def = TOOL.get(name);
  if (!def) return reject("invalid_argument", `name: unknown tool "${name}"; tools: ${[...TOOL.keys()].join(", ")}`);
  if (def.scope === "admin" && who.role !== "admin")
    return reject("unauthorized", `${name} is for admins; this token is a user token`);

  const invalid = firstViolation(def.input, args);
  const usesRobot = "robot_id" in def.input.properties;
  try {
    if (usesRobot) {
      if (robot_id === null) return reject("invalid_argument", invalid ?? "robot_id: is required");
      if (!cfg.robots.includes(robot_id))
        return reject(
          "unknown_robot",
          `no robot "${robot_id}"; robots this token can see: ${visibleRobots(cfg, who).join(", ") || "none"}`,
        );
      if (!canSee(who, robot_id))
        return reject(
          "unauthorized",
          `this token cannot use robot "${robot_id}"; robots it can see: ${visibleRobots(cfg, who).join(", ") || "none"}`,
        );
      const req: InvokeReq = {
        robot_id,
        caller,
        owner: isOwner(who, robot_id),
        tool: name,
        args,
        trace_id,
        ...(invalid ? { pre: { code: "invalid_argument", message: invalid } } : {}),
      };
      return await robotStub(env, robot_id).invoke(req);
    }
    if (invalid) return reject("invalid_argument", invalid);
    switch (name) {
      case "list_robots":
        return local("completed", okOut(name, await listRobots(env, cfg, who)));
      case "stop_all": {
        // every robot this admin can see; an offline one has nothing to stop and says so
        const ids = visibleRobots(cfg, who);
        const outs = await Promise.all(
          ids.map((id) =>
            robotStub(env, id).invoke({
              robot_id: id,
              caller,
              owner: isOwner(who, id),
              tool: "stop",
              args: { robot_id: id },
              trace_id,
            }),
          ),
        );
        const data = outs.map((o, i) => {
          const e = o.envelope;
          return {
            robot_id: ids[i],
            motors_stopped: e.ok ? (e.data as { motors_stopped: boolean }).motors_stopped : false,
            link: e.robot?.link,
            ...(e.ok ? {} : { error: e.error.code }),
          };
        });
        return local("completed", okOut(name, data));
      }
      case "list_programs":
        return local(
          "completed",
          okOut(name, await store.listPrograms(env.DB, args as { query?: string; state?: string })),
        );
      case "get_program": {
        const p = await store.getProgram(env.DB, String(args.name), args.version as number | undefined);
        return local("completed", okOut(name, { ...p, runs: await store.listRuns(env.DB, p.name, p.version) }));
      }
      case "save_program":
      case "retire_program":
        return await robotStub(env, LIBRARY).invoke({
          robot_id: LIBRARY,
          caller,
          owner: false,
          tool: name,
          args,
          trace_id,
        });
      default:
        throw new Error(`tool ${name} has no handler`);
    }
  } catch (e) {
    if (e instanceof ToolFail) return local("rejected", errOut(name, e.toError()));
    log("internal_error", {
      tool: name,
      trace_id,
      message: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e),
    });
    return local("rejected", errOut(name, toolError("internal", `unexpected error (trace_id ${trace_id})`)));
  }
}
