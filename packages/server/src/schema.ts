// Small JSON Schema validator: the keywords the tool catalog uses, plus the common ones device manifests use.
// It returns the first violation as "field: rule", which is what `invalid_argument` must name.
// Strict mode (the catalog) throws at init on a keyword it does not implement, so a contract change that
// adds one fails loud instead of being silently unenforced. Lenient mode (manifests) ignores unknown keywords.

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

type Schema = Record<string, unknown>;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Throws if `schema` uses a keyword this validator does not implement. */
export function assertSupported(schema: unknown, where: string): void {
  if (!isObj(schema)) throw new Error(`${where}: schema must be an object`);
  for (const [k, v] of Object.entries(schema)) {
    if (!IMPLEMENTED.has(k) && !ANNOTATIONS.has(k))
      throw new Error(`${where}: JSON Schema keyword "${k}" is not implemented by the relay validator`);
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

/** Returns null when valid, else "<field>: <rule>" for the first violation. */
export function validate(schema: unknown, value: unknown, path = ""): string | null {
  if (!isObj(schema)) return null;
  const s = schema as Schema;
  const at = path || "(arguments)";
  if (s.type !== undefined) {
    const want = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    const got = typeOf(value);
    if (!want.includes(got) && !(got === "integer" && want.includes("number")))
      return `${at}: must be of type ${want.join(" | ")}, got ${got}`;
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => e === value))
    return `${at}: must be one of ${JSON.stringify(s.enum)}`;
  if ("const" in s && s.const !== value) return `${at}: must equal ${JSON.stringify(s.const)}`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `${at}: must be a finite number`;
    if (typeof s.minimum === "number" && value < s.minimum)
      return `${at}: must be >= ${s.minimum} (minimum), got ${value}`;
    if (typeof s.maximum === "number" && value > s.maximum)
      return `${at}: must be <= ${s.maximum} (maximum), got ${value}`;
    if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum)
      return `${at}: must be > ${s.exclusiveMinimum} (exclusiveMinimum), got ${value}`;
    if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum)
      return `${at}: must be < ${s.exclusiveMaximum} (exclusiveMaximum), got ${value}`;
  }
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength)
      return `${at}: must have at least ${s.minLength} characters (minLength)`;
    if (typeof s.maxLength === "number" && value.length > s.maxLength)
      return `${at}: must have at most ${s.maxLength} characters (maxLength), got ${value.length}`;
    if (typeof s.pattern === "string" && !new RegExp(s.pattern).test(value))
      return `${at}: must match pattern ${s.pattern}`;
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems)
      return `${at}: must have at least ${s.minItems} items (minItems)`;
    if (typeof s.maxItems === "number" && value.length > s.maxItems)
      return `${at}: must have at most ${s.maxItems} items (maxItems)`;
    if (s.items !== undefined)
      for (let i = 0; i < value.length; i++) {
        const e = validate(s.items, value[i], `${path}[${i}]`);
        if (e) return e;
      }
  }
  if (isObj(value)) {
    const props = isObj(s.properties) ? s.properties : {};
    if (Array.isArray(s.required))
      for (const r of s.required as string[]) if (!(r in value)) return `${path ? `${path}.` : ""}${r}: is required`;
    for (const [k, v] of Object.entries(value)) {
      const child = path ? `${path}.${k}` : k;
      if (k in props) {
        const e = validate(props[k], v, child);
        if (e) return e;
      } else if (s.additionalProperties === false) {
        return `${child}: unknown field (additionalProperties is false); allowed: ${Object.keys(props).join(", ") || "none"}`;
      } else if (isObj(s.additionalProperties)) {
        const e = validate(s.additionalProperties, v, child);
        if (e) return e;
      }
    }
  }
  return null;
}
