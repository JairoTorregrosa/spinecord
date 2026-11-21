// Principals and tunables. PRINCIPALS is a secret holding only SHA-256 hashes of tokens.
// Missing or malformed config throws ConfigError: every request then answers 503 `misconfigured` (fail loud).

/** People (and their models) call tools and the HTTP API. */
export type ToolRole = "user" | "admin";
/** Machines open sockets: "runtime" is a robot's runtime (/ws/robot), "organ" an attached provider (/ws/organ). */
export type SocketRole = "runtime" | "organ";
export type Role = ToolRole | SocketRole;
export interface Principal {
  principal_id: string;
  role: Role;
  token_sha256: string;
  robot_ids: string[];
}
export type ToolPrincipal = Principal & { role: ToolRole };
/** Who is calling, without the secret. */
export interface Caller {
  id: string;
  role: ToolRole;
}
export interface Timing {
  hbIntervalMs: number;
  hbTimeoutMs: number;
  organGoneMs: number;
  stopVerifyMarginMs: number;
  helloTimeoutMs: number;
  callTimeoutMs: number;
  deadlineMarginMs: number;
}
export interface Config {
  principals: Principal[];
  /** every robot id named explicitly by a principal, sorted */
  robots: string[];
  timing: Timing;
  identify(token: string): Promise<Principal | null>;
}

export class ConfigError extends Error {}

const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const SHA = /^[0-9a-f]{64}$/;
const ROLES: readonly Role[] = ["user", "admin", "runtime", "organ"];
const SHAPE =
  'PRINCIPALS must be a JSON array: [{"principal_id","role":"user"|"admin"|"runtime"|"organ","token_sha256":<64 hex>,"robot_ids":[...]}]';

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two equal-length hex strings. */
function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function ms(env: Record<string, unknown>, key: string): number {
  const n = Number(env[key]);
  if (env[key] === undefined || env[key] === "" || !Number.isFinite(n) || n <= 0)
    throw new ConfigError(`${key} must be a positive number of milliseconds`);
  return n;
}

let cached: { key: string; config: Config } | undefined;

/** Parses and validates once per isolate (again only if the raw values change). Throws ConfigError. */
export function loadConfig(env: Env): Config {
  const e = env as unknown as Record<string, unknown>;
  const keys = [
    "PRINCIPALS",
    "HB_INTERVAL_MS",
    "HB_TIMEOUT_MS",
    "ORGAN_GONE_MS",
    "STOP_VERIFY_MARGIN_MS",
    "HELLO_TIMEOUT_MS",
    "CALL_TIMEOUT_MS",
    "DEADLINE_MARGIN_MS",
  ];
  const key = keys.map((k) => String(e[k])).join("\u0000");
  if (cached?.key !== key) cached = { key, config: parse(e) };
  return cached.config;
}

function parse(env: Record<string, unknown>): Config {
  if (typeof env.PRINCIPALS !== "string" || env.PRINCIPALS.trim() === "")
    throw new ConfigError("PRINCIPALS is missing");
  let raw: unknown;
  try {
    raw = JSON.parse(env.PRINCIPALS);
  } catch {
    throw new ConfigError("PRINCIPALS is not valid JSON");
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new ConfigError(SHAPE);
  const principals: Principal[] = [];
  const robots = new Set<string>();
  for (const [i, v] of raw.entries()) {
    const p = v as Partial<Principal> | null;
    const where = `PRINCIPALS[${i}]`;
    if (typeof p !== "object" || p === null) throw new ConfigError(`${where}: not an object. ${SHAPE}`);
    if (typeof p.principal_id !== "string" || !ID.test(p.principal_id))
      throw new ConfigError(`${where}: principal_id is missing or does not match ${ID}`);
    if (principals.some((q) => q.principal_id === p.principal_id))
      throw new ConfigError(`${where}: duplicate principal_id "${p.principal_id}"`);
    if (!ROLES.includes(p.role as Role))
      throw new ConfigError(`${where} (${p.principal_id}): role must be one of ${ROLES.join(", ")}`);
    const machine = p.role === "runtime" || p.role === "organ";
    if (typeof p.token_sha256 !== "string" || !SHA.test(p.token_sha256))
      throw new ConfigError(`${where} (${p.principal_id}): token_sha256 must be 64 lowercase hex characters`);
    if (principals.some((q) => q.token_sha256 === p.token_sha256))
      throw new ConfigError(`${where} (${p.principal_id}): its token hash is already used by another principal`);
    if (!Array.isArray(p.robot_ids)) throw new ConfigError(`${where} (${p.principal_id}): robot_ids must be an array`);
    if (machine && p.robot_ids.length === 0)
      throw new ConfigError(
        `${where} (${p.principal_id}): a ${p.role} credential must name the robots it is bound to in robot_ids`,
      );
    for (const r of p.robot_ids) {
      if (r === "*") {
        if (p.role !== "admin" || p.robot_ids.length !== 1)
          throw new ConfigError(`${where} (${p.principal_id}): "*" is only for admins and must be the only entry`);
      } else if (typeof r !== "string" || !ID.test(r))
        throw new ConfigError(`${where} (${p.principal_id}): robot id ${JSON.stringify(r)} does not match ${ID}`);
      else robots.add(r);
    }
    principals.push({
      principal_id: p.principal_id,
      role: p.role as Role,
      token_sha256: p.token_sha256,
      robot_ids: [...p.robot_ids],
    });
  }
  const timing: Timing = {
    hbIntervalMs: ms(env, "HB_INTERVAL_MS"),
    hbTimeoutMs: ms(env, "HB_TIMEOUT_MS"),
    organGoneMs: ms(env, "ORGAN_GONE_MS"),
    stopVerifyMarginMs: ms(env, "STOP_VERIFY_MARGIN_MS"),
    helloTimeoutMs: ms(env, "HELLO_TIMEOUT_MS"),
    callTimeoutMs: ms(env, "CALL_TIMEOUT_MS"),
    deadlineMarginMs: ms(env, "DEADLINE_MARGIN_MS"),
  };
  return {
    principals,
    robots: [...robots].sort(),
    timing,
    identify: async (token) => {
      if (!token) return null;
      const h = await sha256Hex(token);
      let found: Principal | null = null;
      // no early exit: every hash is compared, each in constant time
      for (const p of principals) if (sameHash(h, p.token_sha256)) found = p;
      return found;
    },
  };
}

export const findPrincipal = (cfg: Config, id: string): Principal | undefined =>
  cfg.principals.find((p) => p.principal_id === id);
/** Tools and the HTTP API are for people; a runtime or organ credential only opens its socket. */
export const isToolPrincipal = (p: Principal): p is ToolPrincipal => p.role === "user" || p.role === "admin";
/**
 * May this token open the socket of `role` for this robot? Null when it may, else why not (a close reason).
 * Only a credential of that role, bound to the robot by name, may: a user or admin token never becomes a robot.
 */
export function socketRefusal(p: Principal | null, role: SocketRole, robot_id: string): string | null {
  if (p === null) return "unauthorized: token is not valid for this robot";
  if (p.role !== role)
    return `unauthorized: a ${p.role} token cannot connect as ${role === "runtime" ? "a robot runtime" : "an organ"}; use a "${role}" credential`;
  if (!p.robot_ids.includes(robot_id)) return "unauthorized: token is not valid for this robot";
  return null;
}
/** May this principal see (read, stop) this robot? */
export const canSee = (p: Principal, robot_id: string): boolean =>
  p.robot_ids.includes(robot_id) || p.robot_ids.includes("*");
/** Owners are the principals a robot is assigned to by name ("*" does not make an owner). */
export const isOwner = (p: Principal, robot_id: string): boolean => p.robot_ids.includes(robot_id);
export const visibleRobots = (cfg: Config, p: Principal): string[] => cfg.robots.filter((r) => canSee(p, r));
export const ownersOf = (cfg: Config, robot_id: string): string[] =>
  cfg.principals.filter((p) => isToolPrincipal(p) && isOwner(p, robot_id)).map((p) => p.principal_id);
