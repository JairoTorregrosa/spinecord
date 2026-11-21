import { describe, expect, test } from "bun:test";
import { assertSupported, firstViolation, schemaIssues, validateSchema } from "./schema";

const RUN_TIME = {
  type: "object",
  properties: {
    ms: { type: "integer", minimum: 1, maximum: 250 },
    speed_pct: { type: "number", minimum: -100, maximum: 100 },
    mode: { type: "string", enum: ["brake", "coast"] },
    label: { type: "string", maxLength: 3, pattern: "^[a-z]*$" },
    marks: { type: "array", maxItems: 1, items: { type: "integer", minimum: 0 } },
  },
  required: ["ms", "speed_pct"],
  additionalProperties: false,
};

describe("schema validator", () => {
  test("full mode enforces every keyword and names field, rule and allowed range", () => {
    expect(validateSchema(RUN_TIME, { ms: 100, speed_pct: 20 })).toEqual([]);
    expect(validateSchema(RUN_TIME, { ms: 1000, speed_pct: 120, label: "abcd", marks: [1, -2] })).toEqual([
      "args.ms must be <= 250 (maximum), got 1000",
      "args.speed_pct must be <= 100 (maximum), got 120",
      "args.label must have at most 3 characters (maxLength), got 4",
      "args.marks must have at most 1 items (maxItems)",
      "args.marks[1] must be >= 0 (minimum), got -2",
    ]);
    expect(firstViolation(RUN_TIME, { ms: 1000, speed_pct: 20 })).toBe("ms: must be <= 250 (maximum), got 1000");
    expect(firstViolation(RUN_TIME, 7)).toBe("(arguments): must be of type object, got integer");
    expect(firstViolation(RUN_TIME, { ms: 100, speed_pct: 20 })).toBeNull();
  });

  test("shape mode leaves sizes to whoever clamps them, and still checks structure", () => {
    const oversized = { ms: 1000, speed_pct: 120, label: "abcd", marks: [1, -2] };
    expect(schemaIssues(RUN_TIME, oversized, "args", "shape")).toEqual([]);
    const shape = (v: unknown) => firstViolation(RUN_TIME, v, "args", "shape");
    expect(shape({ speed_pct: 20 })).toBe("args.ms: is required");
    expect(shape({ ms: "long", speed_pct: 20 })).toBe("args.ms: must be of type integer, got string");
    expect(shape({ ms: 1.5, speed_pct: 20 })).toBe("args.ms: must be of type integer, got number");
    expect(shape({ ms: 100, speed_pct: Number.NaN })).toBe("args.speed_pct: must be a finite number");
    expect(shape({ ms: 100, speed_pct: 20, mode: "drift" })).toBe('args.mode: must be one of ["brake","coast"]');
    expect(shape({ ms: 100, speed_pct: 20, label: "AB" })).toBe("args.label: must match pattern ^[a-z]*$");
    expect(shape({ ms: 100, speed_pct: 20, marks: ["x"] })).toBe("args.marks[0]: must be of type integer, got string");
    expect(shape({ ms: 100, speed_pct: 20, warp: 9 })).toMatch(/^args\.warp: unknown field .*allowed: ms, speed_pct/);
  });

  test("a key whose value is undefined is absent", () => {
    expect(validateSchema(RUN_TIME, { ms: 100, speed_pct: 20, mode: undefined, warp: undefined })).toEqual([]);
    expect(validateSchema(RUN_TIME, { ms: undefined, speed_pct: 20 })).toEqual(["args.ms is required"]);
  });

  test("assertSupported fails loud on a keyword the validator would not enforce", () => {
    expect(() => assertSupported(RUN_TIME, "x")).not.toThrow();
    expect(() => assertSupported({ type: "object", properties: { a: { oneOf: [] } } }, "x")).toThrow(
      /x\.a: JSON Schema keyword "oneOf" is not implemented/,
    );
  });
});
