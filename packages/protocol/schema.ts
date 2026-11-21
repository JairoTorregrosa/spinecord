// The one JSON Schema validator (hand-written subset, no dependency), shared by the relay and the runtime.
// Keywords: type, enum, const, minimum, maximum, exclusiveMinimum, exclusiveMaximum, minLength, maxLength, pattern,
// items, minItems, maxItems, properties, required, additionalProperties.
// Two modes:
//   "full"   every keyword. The tool catalog (relay) and the arguments the runtime is about to execute, after clamping.
//   "shape"  structure only: type, enum, const, pattern, required, additionalProperties, nested properties and items.
//            Size limits (minimum, maximum, exclusive*, minLength, maxLength, minItems, maxItems) are skipped: the
//            relay uses it on device command arguments, whose sizes the runtime clamps or chunks before checking them.
// A key whose value is undefined counts as absent (callers validate in-process objects, not only parsed JSON).

export type SchemaMode = "shape" | "full";
export interface SchemaIssue {
  /** dotted path of the offending value, "" for the root */
  path: string;
  /** the rule it broke and what is allowed, e.g. "must be <= 250 (maximum), got 600" */
  message: string;
}

const IMPLEMENTED = new Set([
  "type",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "items",
  "minItems",
  "maxItems",
  "properties",
  "required",
  "additionalProperties",
]);
const ANNOTATIONS = new Set([
  "description",
  "title",
  "default",
  "examples",
  "$schema",
  "$id",
  "$comment",
  "unit",
  "format",
]);

type S = Record<string, unknown>;
const isObj = (v: unknown): v is S => typeof v === "object" && v !== null && !Array.isArray(v);

/** Throws if `schema` uses a keyword this validator does not implement (a silently unenforced rule is a bug). */
export function assertSupported(schema: unknown, where: string): void {
  if (!isObj(schema)) throw new Error(`${where}: schema must be an object`);
  for (const [k, v] of Object.entries(schema)) {
    if (!IMPLEMENTED.has(k) && !ANNOTATIONS.has(k))
      throw new Error(`${where}: JSON Schema keyword "${k}" is not implemented by the validator`);
    if (k === "properties" && isObj(v)) for (const [p, s] of Object.entries(v)) assertSupported(s, `${where}.${p}`);
    if (k === "items") assertSupported(v, `${where}[]`);
    if (k === "additionalProperties" && isObj(v)) assertSupported(v, `${where}.*`);
  }
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

/** Every violation of `schema` by `value`, in document order. `path` names the root ("" = no prefix). */
export function schemaIssues(schema: unknown, value: unknown, path = "", mode: SchemaMode = "full"): SchemaIssue[] {
  const out: SchemaIssue[] = [];
  walk(schema, value, path, mode === "full", out);
  return out;
}

function walk(schema: unknown, v: unknown, path: string, sizes: boolean, out: SchemaIssue[]): void {
  if (!isObj(schema)) return;
  const s = schema;
  const fail = (message: string, at = path) => void out.push({ path: at, message });
  const child = (k: string) => (path ? `${path}.${k}` : k);
  if (s.type !== undefined) {
    const want = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    const got = typeOf(v);
    if (!want.includes(got) && !(got === "integer" && want.includes("number")))
      return fail(`must be of type ${want.join(" | ")}, got ${got}`);
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => e === v)) fail(`must be one of ${JSON.stringify(s.enum)}`);
  if ("const" in s && s.const !== v) fail(`must equal ${JSON.stringify(s.const)}`);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return fail("must be a finite number");
    if (sizes) {
      if (typeof s.minimum === "number" && v < s.minimum) fail(`must be >= ${s.minimum} (minimum), got ${v}`);
      if (typeof s.maximum === "number" && v > s.maximum) fail(`must be <= ${s.maximum} (maximum), got ${v}`);
      if (typeof s.exclusiveMinimum === "number" && v <= s.exclusiveMinimum)
        fail(`must be > ${s.exclusiveMinimum} (exclusiveMinimum), got ${v}`);
      if (typeof s.exclusiveMaximum === "number" && v >= s.exclusiveMaximum)
        fail(`must be < ${s.exclusiveMaximum} (exclusiveMaximum), got ${v}`);
    }
  }
  if (typeof v === "string") {
    if (sizes && typeof s.minLength === "number" && v.length < s.minLength)
      fail(`must have at least ${s.minLength} characters (minLength)`);
    if (sizes && typeof s.maxLength === "number" && v.length > s.maxLength)
      fail(`must have at most ${s.maxLength} characters (maxLength), got ${v.length}`);
    if (typeof s.pattern === "string" && !new RegExp(s.pattern).test(v)) fail(`must match pattern ${s.pattern}`);
  }
  if (Array.isArray(v)) {
    if (sizes && typeof s.minItems === "number" && v.length < s.minItems)
      fail(`must have at least ${s.minItems} items (minItems)`);
    if (sizes && typeof s.maxItems === "number" && v.length > s.maxItems)
      fail(`must have at most ${s.maxItems} items (maxItems)`);
    if (s.items !== undefined) v.forEach((item, i) => walk(s.items, item, `${path}[${i}]`, sizes, out));
  }
  if (isObj(v)) {
    const props = isObj(s.properties) ? s.properties : {};
    if (Array.isArray(s.required))
      for (const r of s.required as string[]) if (v[r] === undefined) fail("is required", child(r));
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      if (k in props) walk(props[k], val, child(k), sizes, out);
      else if (s.additionalProperties === false)
        fail(
          `unknown field (additionalProperties is false); allowed: ${Object.keys(props).join(", ") || "none"}`,
          child(k),
        );
      else if (isObj(s.additionalProperties)) walk(s.additionalProperties, val, child(k), sizes, out);
    }
  }
}

/** Every violation as one sentence each: "<path> <rule>". */
export function validateSchema(schema: unknown, value: unknown, path = "args", mode: SchemaMode = "full"): string[] {
  return schemaIssues(schema, value, path, mode).map((i) => `${i.path} ${i.message}`);
}

/** The first violation as "<field>: <rule>" (what `invalid_argument` must name), or null when valid. */
export function firstViolation(schema: unknown, value: unknown, path = "", mode: SchemaMode = "full"): string | null {
  const first = schemaIssues(schema, value, path, mode)[0];
  return first ? `${first.path || "(arguments)"}: ${first.message}` : null;
}
