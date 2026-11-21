// Hand-written JSON Schema subset (no dependency): type, properties, required, additionalProperties,
// minimum, maximum, exclusiveMinimum, exclusiveMaximum, enum, const, items, minItems, maxItems, minLength, maxLength, pattern.
// Returns human-readable violations naming the field, the rule and the allowed range.
type S = Record<string, unknown>;

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isFinite(v) ? "number" : "non-finite number";
  return typeof v;
}

export function validateSchema(schema: unknown, value: unknown, path = "args"): string[] {
  const out: string[] = [];
  walk(schema, value, path, out);
  return out;
}

function walk(schema: unknown, v: unknown, path: string, out: string[]): void {
  if (typeof schema !== "object" || schema === null) return;
  const s = schema as S;
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
  if (types.length) {
    const t = typeOf(v);
    const ok = types.some((want) => want === t || (want === "integer" && t === "number" && Number.isInteger(v)));
    if (!ok) {
      out.push(`${path} must be ${types.join(" or ")}, got ${t}`);
      return;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => e === v))
    out.push(`${path} must be one of ${JSON.stringify(s.enum)}`);
  if ("const" in s && s.const !== v) out.push(`${path} must be ${JSON.stringify(s.const)}`);
  if (typeof v === "number") {
    if (typeof s.minimum === "number" && v < s.minimum) out.push(`${path} must be >= ${s.minimum}, got ${v}`);
    if (typeof s.maximum === "number" && v > s.maximum) out.push(`${path} must be <= ${s.maximum}, got ${v}`);
    if (typeof s.exclusiveMinimum === "number" && v <= s.exclusiveMinimum)
      out.push(`${path} must be > ${s.exclusiveMinimum}, got ${v}`);
    if (typeof s.exclusiveMaximum === "number" && v >= s.exclusiveMaximum)
      out.push(`${path} must be < ${s.exclusiveMaximum}, got ${v}`);
  }
  if (typeof v === "string") {
    if (typeof s.minLength === "number" && v.length < s.minLength)
      out.push(`${path} must have at least ${s.minLength} characters`);
    if (typeof s.maxLength === "number" && v.length > s.maxLength)
      out.push(`${path} must have at most ${s.maxLength} characters`);
    if (typeof s.pattern === "string" && !new RegExp(s.pattern).test(v)) out.push(`${path} must match ${s.pattern}`);
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === "number" && v.length < s.minItems)
      out.push(`${path} must have at least ${s.minItems} items`);
    if (typeof s.maxItems === "number" && v.length > s.maxItems)
      out.push(`${path} must have at most ${s.maxItems} items`);
    if (s.items) v.forEach((item, i) => walk(s.items, item, `${path}[${i}]`, out));
  }
  if (typeOf(v) === "object") {
    const o = v as S;
    const props = (s.properties ?? {}) as S;
    for (const req of (s.required ?? []) as string[]) if (o[req] === undefined) out.push(`${path}.${req} is required`);
    for (const [k, val] of Object.entries(o)) {
      if (val === undefined) continue;
      if (k in props) walk(props[k], val, `${path}.${k}`, out);
      else if (s.additionalProperties === false)
        out.push(`${path}.${k} is not allowed; allowed: ${Object.keys(props).join(", ") || "(none)"}`);
      else if (typeof s.additionalProperties === "object") walk(s.additionalProperties, val, `${path}.${k}`, out);
    }
  }
}
