// Pure, dependency-free validators shared by every package (single owner of these rules).
// They check shape, caps and the names a spec refers to within itself; what needs real devices is checked against them
// by whoever holds them (the runtime for programs and conditions, planLoop in loop.ts for loops).
import { assertSupported } from "./schema";
import type { CompareOp, Condition, LoopSpec, PageDevice, ProgramNode } from "./types";

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

// ---------- Loops (CONTRACT §5a) ----------
export const LOOP_CAPS = {
  max_signals: 8,
  max_outputs: 4,
  max_terms: 16,
  max_guards: 8,
  max_params: 16,
  max_trace_hz: 20,
  min_rate_hz: 0.1,
  /** The largest magnitude of a gain, a setpoint, a feed, a param, a clamp, a guard value and a filter constant. */
  max_magnitude: 1e6,
  max_ramp_ms: 3_600_000,
  max_name: 32, // characters of a signal, param or guard name
  max_text: 64, // characters of a device, channel or command string
} as const;

const PARTS = ["value", "integral", "derivative"] as const;
const GUARD_OPS = ["gt", "lt", "abs_gt"] as const;
// A name is a key of the report's trace and of plain objects: an identifier, and never the one key an object
// does not hold as its own.
const NAME = new RegExp(`^(?!__proto__$)[A-Za-z_][A-Za-z0-9_]{0,${LOOP_CAPS.max_name - 1}}$`);
const NAME_RULE = `a name is 1 to ${LOOP_CAPS.max_name} letters, digits and _, not starting with a digit, and not __proto__`;
const TEXT_RULE = `required string of at most ${LOOP_CAPS.max_text} characters`;
const TRACE_KEY = /^(t_ms|out\d+)$/;
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isText = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= LOOP_CAPS.max_text;
const isCapped = (x: unknown): x is number => isNum(x) && x >= -LOOP_CAPS.max_magnitude && x <= LOOP_CAPS.max_magnitude;
const CAPPED = `a number within ±${LOOP_CAPS.max_magnitude}`;
const unknownKeys = (o: Record<string, unknown>, known: readonly string[], path: string): ValidationIssue[] => {
  const extra = Object.keys(o).filter((k) => !known.includes(k));
  return extra.length ? [{ path, message: `unknown keys: ${extra.join(", ")}` }] : [];
};

/** Shape, caps and names of a loop. What needs the robot (channels, commands, rates) is planLoop's (loop.ts). */
export function validateLoop(spec: unknown, path = "loop"): ValidationIssue[] {
  if (!isObj(spec)) return [{ path, message: "must be an object" }];
  const out: ValidationIssue[] = unknownKeys(
    spec,
    ["rate_hz", "duration_ms", "attention_ms", "signals", "params", "outputs", "guards", "trace_hz"],
    path,
  );
  if (!isNum(spec.rate_hz) || spec.rate_hz < LOOP_CAPS.min_rate_hz)
    out.push({ path: `${path}.rate_hz`, message: `number of at least ${LOOP_CAPS.min_rate_hz}` });
  if (!isInt(spec.duration_ms) || spec.duration_ms < 1)
    out.push({ path: `${path}.duration_ms`, message: "integer of at least 1" });
  if ("attention_ms" in spec && (!isInt(spec.attention_ms) || spec.attention_ms < 1))
    out.push({ path: `${path}.attention_ms`, message: "integer of at least 1" });
  if ("trace_hz" in spec && (!isNum(spec.trace_hz) || spec.trace_hz <= 0 || spec.trace_hz > LOOP_CAPS.max_trace_hz))
    out.push({ path: `${path}.trace_hz`, message: `number above 0, at most ${LOOP_CAPS.max_trace_hz}` });

  // params first: setpoints, gains and feeds refer to them
  const params = new Set<string>();
  if ("params" in spec) {
    const p = `${path}.params`;
    if (!isObj(spec.params)) out.push({ path: p, message: "must be an object of numbers" });
    else {
      const names = Object.keys(spec.params);
      if (names.length > LOOP_CAPS.max_params) out.push({ path: p, message: `at most ${LOOP_CAPS.max_params} params` });
      for (const name of names) {
        if (!NAME.test(name)) out.push({ path: `${p}.${name}`, message: NAME_RULE });
        else {
          params.add(name);
          if (!isCapped(spec.params[name])) out.push({ path: `${p}.${name}`, message: `must be ${CAPPED}` });
        }
      }
    }
  }
  /** A number, or the name of a param. */
  const numberOrParam = (x: unknown, p: string): ValidationIssue[] => {
    if (isCapped(x)) return [];
    if (typeof x !== "string") return [{ path: p, message: `must be ${CAPPED} or the name of a param` }];
    return params.has(x) ? [] : [{ path: p, message: `no param "${x}"; params: ${[...params].join(", ") || "none"}` }];
  };

  const signals = new Set<string>();
  const sp = `${path}.signals`;
  if (!isObj(spec.signals)) out.push({ path: sp, message: "must be an object of signals by name" });
  else {
    const names = Object.keys(spec.signals);
    if (names.length === 0) out.push({ path: sp, message: "needs at least one signal" });
    if (names.length > LOOP_CAPS.max_signals)
      out.push({ path: sp, message: `at most ${LOOP_CAPS.max_signals} signals` });
    for (const name of names) {
      const p = `${sp}.${name}`;
      const s = spec.signals[name];
      if (!NAME.test(name)) out.push({ path: p, message: NAME_RULE });
      else if (TRACE_KEY.test(name))
        out.push({ path: p, message: "t_ms and out<i> are keys of the trace; use another name" });
      else signals.add(name);
      if (!isObj(s)) {
        out.push({ path: p, message: "must be {device, channel, index?, zero?, detrend_s?, smooth_ms?}" });
        continue;
      }
      out.push(...unknownKeys(s, ["device", "channel", "index", "zero", "detrend_s", "smooth_ms"], p));
      if (!isText(s.device)) out.push({ path: `${p}.device`, message: `${TEXT_RULE} (device id or role)` });
      if (!isText(s.channel)) out.push({ path: `${p}.channel`, message: TEXT_RULE });
      if ("index" in s && (!isInt(s.index) || s.index < 0))
        out.push({ path: `${p}.index`, message: "integer of at least 0" });
      if ("zero" in s && s.zero !== "start") {
        const z = s.zero;
        if (!isObj(z) || Object.keys(z).length !== 1 || !("mean_ms" in z))
          out.push({ path: `${p}.zero`, message: 'must be "start" or {mean_ms}' });
        else if (!isInt(z.mean_ms) || z.mean_ms < 1)
          out.push({ path: `${p}.zero.mean_ms`, message: "integer of at least 1" });
        else if (isInt(spec.duration_ms) && spec.duration_ms >= 1 && z.mean_ms >= spec.duration_ms)
          out.push({ path: `${p}.zero.mean_ms`, message: "must be under duration_ms" });
      }
      for (const k of ["detrend_s", "smooth_ms"] as const)
        if (k in s && (!isCapped(s[k]) || s[k] <= 0))
          out.push({ path: `${p}.${k}`, message: `number above 0, at most ${LOOP_CAPS.max_magnitude}` });
    }
  }
  const signalRef = (x: unknown, p: string): ValidationIssue[] =>
    typeof x === "string" && signals.has(x)
      ? []
      : [{ path: p, message: `no signal "${String(x)}"; signals: ${[...signals].join(", ") || "none"}` }];
  const partOf = (o: Record<string, unknown>, p: string): ValidationIssue[] =>
    "of" in o && !PARTS.includes(o.of as (typeof PARTS)[number])
      ? [{ path: `${p}.of`, message: `must be one of ${PARTS.join(", ")}` }]
      : [];

  const op = `${path}.outputs`;
  if (!Array.isArray(spec.outputs) || spec.outputs.length === 0)
    out.push({ path: op, message: "must be a non-empty array" });
  else {
    if (spec.outputs.length > LOOP_CAPS.max_outputs)
      out.push({ path: op, message: `at most ${LOOP_CAPS.max_outputs} outputs` });
    const devices = new Set<unknown>();
    spec.outputs.forEach((o: unknown, i) => {
      const p = `${op}[${i}]`;
      if (!isObj(o)) return void out.push({ path: p, message: "must be {device, command, args?, terms, limit?}" });
      out.push(...unknownKeys(o, ["device", "command", "args", "terms", "limit"], p));
      if (!isText(o.device)) out.push({ path: `${p}.device`, message: `${TEXT_RULE} (device id or role)` });
      else if (devices.has(o.device))
        out.push({ path: `${p}.device`, message: `"${o.device}" is driven by another output` });
      devices.add(o.device);
      if (!isText(o.command)) out.push({ path: `${p}.command`, message: TEXT_RULE });
      if ("args" in o && !isObj(o.args)) out.push({ path: `${p}.args`, message: "must be an object" });
      if ("limit" in o) {
        const l = o.limit;
        if (!Array.isArray(l) || l.length !== 2 || !isNum(l[0]) || !isNum(l[1]) || l[0] > l[1])
          out.push({ path: `${p}.limit`, message: "must be [lo, hi], two finite numbers with lo <= hi" });
      }
      if (!Array.isArray(o.terms) || o.terms.length === 0)
        return void out.push({ path: `${p}.terms`, message: "must be a non-empty array" });
      if (o.terms.length > LOOP_CAPS.max_terms)
        out.push({ path: `${p}.terms`, message: `at most ${LOOP_CAPS.max_terms} terms per output` });
      o.terms.forEach((t: unknown, j) => {
        const tp = `${p}.terms[${j}]`;
        if (!isObj(t) || "signal" in t === "feed" in t)
          return void out.push({
            path: tp,
            message: "must be {signal, of?, setpoint?, gain, clamp?} or {feed, gain?}",
          });
        if ("feed" in t) {
          out.push(...unknownKeys(t, ["feed", "gain"], tp), ...numberOrParam(t.feed, `${tp}.feed`));
          if ("gain" in t) out.push(...numberOrParam(t.gain, `${tp}.gain`));
          return;
        }
        out.push(
          ...unknownKeys(t, ["signal", "of", "setpoint", "gain", "clamp"], tp),
          ...signalRef(t.signal, `${tp}.signal`),
          ...partOf(t, tp),
          ...numberOrParam(t.gain, `${tp}.gain`),
        );
        if ("setpoint" in t) out.push(...numberOrParam(t.setpoint, `${tp}.setpoint`));
        if ("clamp" in t) {
          if (t.of !== "integral") out.push({ path: `${tp}.clamp`, message: "only a term of integral has a clamp" });
          else if (!isCapped(t.clamp) || t.clamp <= 0)
            out.push({ path: `${tp}.clamp`, message: `number above 0, at most ${LOOP_CAPS.max_magnitude}` });
        }
      });
    });
  }

  if ("guards" in spec) {
    const gp = `${path}.guards`;
    if (!Array.isArray(spec.guards)) out.push({ path: gp, message: "must be an array" });
    else {
      if (spec.guards.length > LOOP_CAPS.max_guards)
        out.push({ path: gp, message: `at most ${LOOP_CAPS.max_guards} guards` });
      const names = new Set<unknown>();
      spec.guards.forEach((g: unknown, i) => {
        const p = `${gp}[${i}]`;
        if (!isObj(g)) return void out.push({ path: p, message: "must be {name, signal, of?, op, value, for_ms?}" });
        out.push(...unknownKeys(g, ["name", "signal", "of", "op", "value", "for_ms"], p));
        if (typeof g.name !== "string" || !NAME.test(g.name)) out.push({ path: `${p}.name`, message: NAME_RULE });
        else if (names.has(g.name)) out.push({ path: `${p}.name`, message: `"${g.name}" names another guard` });
        names.add(g.name);
        out.push(...signalRef(g.signal, `${p}.signal`), ...partOf(g, p));
        if (!GUARD_OPS.includes(g.op as (typeof GUARD_OPS)[number]))
          out.push({ path: `${p}.op`, message: `must be one of ${GUARD_OPS.join(", ")}` });
        if (!isCapped(g.value)) out.push({ path: `${p}.value`, message: `must be ${CAPPED}` });
        if ("for_ms" in g && (!isInt(g.for_ms) || g.for_ms < 1))
          out.push({ path: `${p}.for_ms`, message: "integer of at least 1" });
      });
    }
  }
  return out;
}

export function isLoopSpec(x: unknown): x is LoopSpec {
  return validateLoop(x).length === 0;
}

// ---------- Peripheral pages (CONTRACT §2.4) ----------
export const PAGE_CAPS = {
  max_devices: 16,
  max_channels: 24, // per device
  max_commands: 12, // per device
  max_roles: 4, // per device
  max_description: 300, // characters
  max_bound_ms: 30_000,
  max_hello_bytes: 64 * 1024,
  max_unavailable: 32,
  max_why: 300, // characters of one `unavailable` reason
} as const;
/** A page's name: the provider of its devices. */
export const PAGE_NAME = /^[a-z][a-z0-9_-]{0,15}$/;
/** Names a page never takes: the providers of a robot's body. */
export const RESERVED_PAGE_NAMES: readonly string[] = ["ev3", "sim"];
// device, channel, command and kind names, and proposed roles
const PAGE_ID = /^[a-z][a-z0-9_]{0,31}$/;
const PAGE_ID_RULE = "must match ^[a-z][a-z0-9_]{0,31}$";
// printable text: no control characters (a line break or a tab included)
const PRINTABLE = /^[^\p{Cc}\p{Cf}]*$/u;
const CHANNEL_TYPES = ["number", "boolean", "string", "vector", "image"];
const PUSHED_TYPES = ["number", "boolean", "string"];
// The keywords a page may use in a command's params: the validator's, without `pattern` (a regular expression
// written by a page would run in this process on every call).
const PAGE_SCHEMA_REFUSED = ["pattern"];

/** The rule a page name breaks, or null. `taken` are the names of the robot's other pages that are not gone. */
export function pageNameIssue(name: unknown, taken: readonly string[] = []): string | null {
  if (typeof name !== "string" || !PAGE_NAME.test(name)) return `name must match ${PAGE_NAME.source}`;
  if (RESERVED_PAGE_NAMES.includes(name)) return `name "${name}" is reserved for the robot's own devices`;
  if (taken.includes(name)) return `name "${name}" is held by another page of this robot`;
  return null;
}

const text = (x: unknown, max: number): boolean => typeof x === "string" && x.length <= max && PRINTABLE.test(x);
const findKeyword = (schema: unknown, banned: readonly string[]): string | null => {
  if (!isObj(schema)) return null;
  for (const [k, v] of Object.entries(schema)) {
    if (banned.includes(k)) return k;
    const inner =
      k === "properties" && isObj(v)
        ? Object.values(v)
        : k === "items" || (k === "additionalProperties" && isObj(v))
          ? [v]
          : [];
    for (const sub of inner) {
      const hit = findKeyword(sub, banned);
      if (hit) return hit;
    }
  }
  return null;
};

/**
 * Shape and bounds of the devices a page declares (`hello.devices`, `devices.devices`), never their meaning.
 * Every failure names the device and the rule; a manifest with any failure is refused whole.
 */
export function validatePageManifest(devices: unknown, path = "devices"): ValidationIssue[] {
  if (!Array.isArray(devices)) return [{ path, message: "must be an array of devices" }];
  const out: ValidationIssue[] = [];
  if (devices.length > PAGE_CAPS.max_devices) out.push({ path, message: `at most ${PAGE_CAPS.max_devices} devices` });
  const ids = new Set<unknown>();
  devices.forEach((d: unknown, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(d))
      return void out.push({ path: p, message: "must be {id, kind, roles, channels, commands, description}" });
    out.push(...unknownKeys(d, ["id", "kind", "roles", "channels", "commands", "description"], p));
    const dp = typeof d.id === "string" && PAGE_ID.test(d.id) ? `${path}.${d.id}` : p;
    if (typeof d.id !== "string" || !PAGE_ID.test(d.id)) out.push({ path: `${p}.id`, message: PAGE_ID_RULE });
    else if (ids.has(d.id)) out.push({ path: `${p}.id`, message: `"${d.id}" names another device of this page` });
    ids.add(d.id);
    if (typeof d.kind !== "string" || !PAGE_ID.test(d.kind)) out.push({ path: `${dp}.kind`, message: PAGE_ID_RULE });
    else if (d.kind === "motor_pair")
      out.push({ path: `${dp}.kind`, message: "a page device is never a motor_pair: a page moves nothing" });
    if (!text(d.description, PAGE_CAPS.max_description))
      out.push({
        path: `${dp}.description`,
        message: `must be printable text of at most ${PAGE_CAPS.max_description} characters`,
      });
    if (!Array.isArray(d.roles) || d.roles.length > PAGE_CAPS.max_roles)
      out.push({ path: `${dp}.roles`, message: `must be an array of at most ${PAGE_CAPS.max_roles} roles` });
    else
      d.roles.forEach((r: unknown, j) => {
        if (typeof r !== "string" || !PAGE_ID.test(r)) out.push({ path: `${dp}.roles[${j}]`, message: PAGE_ID_RULE });
      });

    if (!Array.isArray(d.channels)) out.push({ path: `${dp}.channels`, message: "must be an array" });
    else {
      if (d.channels.length > PAGE_CAPS.max_channels)
        out.push({ path: `${dp}.channels`, message: `at most ${PAGE_CAPS.max_channels} channels per device` });
      const names = new Set<unknown>();
      let images = 0;
      d.channels.forEach((c: unknown, j) => {
        const cp = `${dp}.channels[${j}]`;
        if (!isObj(c)) return void out.push({ path: cp, message: "must be a channel {name, type, description, ...}" });
        out.push(
          ...unknownKeys(
            c,
            [
              "name",
              "type",
              "unit",
              "range",
              "length",
              "max_rate_hz",
              "null_when_absent",
              "approx",
              "noise",
              "pushed",
              "description",
            ],
            cp,
          ),
        );
        if (typeof c.name !== "string" || !PAGE_ID.test(c.name))
          out.push({ path: `${cp}.name`, message: PAGE_ID_RULE });
        else if (names.has(c.name))
          out.push({ path: `${cp}.name`, message: `"${c.name}" names another channel of this device` });
        names.add(c.name);
        if (!CHANNEL_TYPES.includes(c.type as string))
          out.push({ path: `${cp}.type`, message: `must be one of ${CHANNEL_TYPES.join(", ")}` });
        if (c.type === "image" && ++images > 1)
          out.push({ path: `${cp}.type`, message: "at most one image channel per device" });
        if ("pushed" in c && typeof c.pushed !== "boolean")
          out.push({ path: `${cp}.pushed`, message: "must be true or false" });
        if (c.pushed === true && !PUSHED_TYPES.includes(c.type as string))
          out.push({ path: `${cp}.pushed`, message: `a pushed channel is of type ${PUSHED_TYPES.join(", ")}` });
        if (!text(c.description, PAGE_CAPS.max_description))
          out.push({
            path: `${cp}.description`,
            message: `must be printable text of at most ${PAGE_CAPS.max_description} characters`,
          });
        for (const k of ["unit", "approx"] as const)
          if (k in c && !text(c[k], PAGE_CAPS.max_description))
            out.push({ path: `${cp}.${k}`, message: "must be printable text" });
        if ("range" in c) {
          const r = c.range;
          if (!Array.isArray(r) || r.length !== 2 || !isNum(r[0]) || !isNum(r[1]) || r[0] > r[1])
            out.push({ path: `${cp}.range`, message: "must be [lo, hi], two finite numbers with lo <= hi" });
        }
        if ("length" in c && (!isInt(c.length) || c.length < 1))
          out.push({ path: `${cp}.length`, message: "integer of at least 1" });
        for (const k of ["max_rate_hz", "noise"] as const)
          if (k in c && (!isNum(c[k]) || (c[k] as number) < 0))
            out.push({ path: `${cp}.${k}`, message: "a finite number of at least 0" });
        if ("null_when_absent" in c && typeof c.null_when_absent !== "boolean")
          out.push({ path: `${cp}.null_when_absent`, message: "must be true or false" });
      });
    }

    if (!Array.isArray(d.commands)) out.push({ path: `${dp}.commands`, message: "must be an array" });
    else {
      if (d.commands.length > PAGE_CAPS.max_commands)
        out.push({ path: `${dp}.commands`, message: `at most ${PAGE_CAPS.max_commands} commands per device` });
      const names = new Set<unknown>();
      d.commands.forEach((c: unknown, j) => {
        const cp = `${dp}.commands[${j}]`;
        if (!isObj(c))
          return void out.push({ path: cp, message: "must be a command {name, description, params, bound, moves}" });
        out.push(...unknownKeys(c, ["name", "description", "params", "bound", "moves"], cp));
        if (typeof c.name !== "string" || !PAGE_ID.test(c.name))
          out.push({ path: `${cp}.name`, message: PAGE_ID_RULE });
        else if (names.has(c.name))
          out.push({ path: `${cp}.name`, message: `"${c.name}" names another command of this device` });
        names.add(c.name);
        if (!text(c.description, PAGE_CAPS.max_description))
          out.push({
            path: `${cp}.description`,
            message: `must be printable text of at most ${PAGE_CAPS.max_description} characters`,
          });
        if (c.moves !== false)
          out.push({ path: `${cp}.moves`, message: "must be false: a page device never moves the robot" });
        const b = c.bound;
        if (!isObj(b)) out.push({ path: `${cp}.bound`, message: '{kind: "instant" | "ms", params?, max}' });
        else {
          out.push(...unknownKeys(b, ["kind", "params", "max"], `${cp}.bound`));
          if (b.kind !== "instant" && b.kind !== "ms")
            out.push({ path: `${cp}.bound.kind`, message: 'must be "instant" or "ms": a page moves nothing' });
          if (!isNum(b.max) || b.max < 0 || b.max > PAGE_CAPS.max_bound_ms)
            out.push({ path: `${cp}.bound.max`, message: `a number from 0 to ${PAGE_CAPS.max_bound_ms} (ms)` });
          if ("params" in b && (!Array.isArray(b.params) || b.params.some((x) => typeof x !== "string")))
            out.push({ path: `${cp}.bound.params`, message: "must be an array of param names" });
        }
        const s = c.params;
        if (!isObj(s) || s.type !== "object" || s.additionalProperties !== false || !isObj(s.properties))
          out.push({
            path: `${cp}.params`,
            message: 'must be a JSON Schema {type: "object", properties, additionalProperties: false}',
          });
        else {
          try {
            assertSupported(s, `${cp}.params`);
            const refused = findKeyword(s, PAGE_SCHEMA_REFUSED);
            if (refused)
              out.push({ path: `${cp}.params`, message: `keyword "${refused}" is not accepted from a page` });
          } catch (e) {
            out.push({ path: `${cp}.params`, message: (e as Error).message });
          }
        }
      });
    }
  });
  return out;
}

/** `unavailable` of a hello or a devices message: what the page could not offer, and why. */
export function validatePageUnavailable(list: unknown, path = "unavailable"): ValidationIssue[] {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > PAGE_CAPS.max_unavailable)
    return [{ path, message: `must be an array of at most ${PAGE_CAPS.max_unavailable} {kind, why}` }];
  return list.flatMap((u: unknown, i): ValidationIssue[] =>
    isObj(u) &&
    Object.keys(u).every((k) => k === "kind" || k === "why") &&
    text(u.kind, 64) &&
    text(u.why, PAGE_CAPS.max_why)
      ? []
      : [
          {
            path: `${path}[${i}]`,
            message: `must be {kind, why}, printable text of at most ${PAGE_CAPS.max_why} characters`,
          },
        ],
  );
}

export function isPageManifest(x: unknown): x is PageDevice[] {
  return validatePageManifest(x).length === 0;
}
