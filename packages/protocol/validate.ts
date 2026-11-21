// Pure, dependency-free validators shared by every package (single owner of these rules).
// They check shape and caps only; device existence is checked by the runtime against real devices.
import type { CompareOp, Condition, ProgramNode, RobotProfile } from "./types";

export const PROGRAM_CAPS = {
  max_nodes: 500,
  max_repeat_times: 50,
  max_while_iterations: 200,
  max_wait_ms: 10_000,
  max_condition_depth: 8,
} as const;

const OPS: readonly CompareOp[] = ["lt", "lte", "gt", "gte", "eq", "neq", "changed", "contains"];
const NUMERIC_OPS: readonly CompareOp[] = ["lt", "lte", "gt", "gte"];
const CALL_TOOLS = ["drive", "turn", "arc", "command_device", "wait_until"] as const;

export interface ValidationIssue {
  path: string;
  message: string;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);

export function validateCondition(c: unknown, path = "condition", depth = 1): ValidationIssue[] {
  if (depth > PROGRAM_CAPS.max_condition_depth)
    return [{ path, message: `nesting deeper than ${PROGRAM_CAPS.max_condition_depth}` }];
  if (!isObj(c)) return [{ path, message: "must be an object" }];
  const keys = Object.keys(c);
  if ("any" in c || "all" in c) {
    const k = "any" in c ? "any" : "all";
    if (keys.length !== 1) return [{ path, message: `{${k}:[...]} must have no other keys` }];
    const list = c[k];
    if (!Array.isArray(list) || list.length === 0)
      return [{ path: `${path}.${k}`, message: "must be a non-empty array" }];
    return list.flatMap((x, i) => validateCondition(x, `${path}.${k}[${i}]`, depth + 1));
  }
  if ("not" in c) {
    if (keys.length !== 1) return [{ path, message: "{not:{...}} must have no other keys" }];
    return validateCondition(c.not, `${path}.not`, depth + 1);
  }
  const out: ValidationIssue[] = [];
  if (typeof c.device !== "string" || !c.device)
    out.push({ path: `${path}.device`, message: "required string (device id or role)" });
  if (typeof c.channel !== "string" || !c.channel) out.push({ path: `${path}.channel`, message: "required string" });
  if (!OPS.includes(c.op as CompareOp)) out.push({ path: `${path}.op`, message: `must be one of ${OPS.join(", ")}` });
  if (c.op === "changed") {
    if ("value" in c) out.push({ path: `${path}.value`, message: "must be omitted for op changed" });
  } else if (!("value" in c)) out.push({ path: `${path}.value`, message: "required for this op" });
  else if (NUMERIC_OPS.includes(c.op as CompareOp) && typeof c.value !== "number")
    out.push({ path: `${path}.value`, message: `must be a number for op ${String(c.op)}` });
  else if (!["number", "string", "boolean"].includes(typeof c.value))
    out.push({ path: `${path}.value`, message: "must be a number, string or boolean" });
  const extra = keys.filter((k) => !["device", "channel", "op", "value"].includes(k));
  if (extra.length) out.push({ path, message: `unknown keys: ${extra.join(", ")}` });
  return out;
}

export function validateProgram(body: unknown, path = "body"): ValidationIssue[] {
  let nodes = 0;
  const walk = (n: unknown, p: string): ValidationIssue[] => {
    nodes++;
    if (nodes > PROGRAM_CAPS.max_nodes)
      return [{ path: p, message: `program has more than ${PROGRAM_CAPS.max_nodes} nodes` }];
    if (!isObj(n)) return [{ path: p, message: "node must be an object" }];
    const keys = Object.keys(n);
    if (keys.length !== 1)
      return [{ path: p, message: `node must have exactly one key, got ${keys.join(", ") || "none"}` }];
    const k = keys[0]!;
    const v = n[k];
    switch (k) {
      case "seq":
        if (!Array.isArray(v) || v.length === 0) return [{ path: `${p}.seq`, message: "must be a non-empty array" }];
        return v.flatMap((x, i) => walk(x, `${p}.seq[${i}]`));
      case "repeat": {
        if (!isObj(v)) return [{ path: `${p}.repeat`, message: "must be {times, body}" }];
        const out: ValidationIssue[] = [];
        if (!isInt(v.times) || v.times < 1 || v.times > PROGRAM_CAPS.max_repeat_times)
          out.push({ path: `${p}.repeat.times`, message: `integer 1..${PROGRAM_CAPS.max_repeat_times}` });
        return out.concat(walk(v.body, `${p}.repeat.body`));
      }
      case "while": {
        if (!isObj(v)) return [{ path: `${p}.while`, message: "must be {cond, body, max_iterations}" }];
        const out = validateCondition(v.cond, `${p}.while.cond`);
        if (!isInt(v.max_iterations) || v.max_iterations < 1 || v.max_iterations > PROGRAM_CAPS.max_while_iterations)
          out.push({ path: `${p}.while.max_iterations`, message: `integer 1..${PROGRAM_CAPS.max_while_iterations}` });
        return out.concat(walk(v.body, `${p}.while.body`));
      }
      case "if": {
        if (!isObj(v)) return [{ path: `${p}.if`, message: "must be {cond, then, else?}" }];
        const out = validateCondition(v.cond, `${p}.if.cond`).concat(walk(v.then, `${p}.if.then`));
        return "else" in v ? out.concat(walk(v.else, `${p}.if.else`)) : out;
      }
      case "call": {
        if (!isObj(v)) return [{ path: `${p}.call`, message: "must be {tool, args}" }];
        const out: ValidationIssue[] = [];
        if (!CALL_TOOLS.includes(v.tool as (typeof CALL_TOOLS)[number]))
          out.push({ path: `${p}.call.tool`, message: `must be one of ${CALL_TOOLS.join(", ")}` });
        if (!isObj(v.args)) out.push({ path: `${p}.call.args`, message: "must be an object" });
        else {
          for (const banned of ["robot_id", "request_id"])
            if (banned in v.args)
              out.push({ path: `${p}.call.args.${banned}`, message: "must be omitted inside programs" });
          if (v.args.until !== undefined) out.push(...validateCondition(v.args.until, `${p}.call.args.until`));
          if (v.tool === "wait_until" && v.args.condition !== undefined)
            out.push(...validateCondition(v.args.condition, `${p}.call.args.condition`));
        }
        return out;
      }
      case "wait_ms":
        return isInt(v) && v >= 0 && v <= PROGRAM_CAPS.max_wait_ms
          ? []
          : [{ path: `${p}.wait_ms`, message: `integer 0..${PROGRAM_CAPS.max_wait_ms}` }];
      case "succeed":
      case "fail":
        return typeof v === "string" ? [] : [{ path: `${p}.${k}`, message: "must be a string message" }];
      default:
        return [{ path: p, message: `unknown node "${k}"; use seq, repeat, while, if, call, wait_ms, succeed, fail` }];
    }
  };
  return walk(body, path);
}

export function isProgramNode(x: unknown): x is ProgramNode {
  return validateProgram(x).length === 0;
}
export function isCondition(x: unknown): x is Condition {
  return validateCondition(x).length === 0;
}

// Stable hash of what makes a program's behavior transferable: drivetrain, roles, limits.
// Twin and hardware must match for a verified program to run (CONTRACT §1 Program).
export function profileHash(p: RobotProfile): string {
  const canon = JSON.stringify(sortKeys({ drivetrain: p.drivetrain ?? null, roles: p.roles, limits: p.limits }));
  let h1 = 0x811c9dc5,
    h2 = 0x01000193;
  for (let i = 0; i < canon.length; i++) {
    const c = canon.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (isObj(x))
    return Object.fromEntries(
      Object.keys(x)
        .sort()
        .map((k) => [k, sortKeys(x[k])]),
    );
  return x;
}
