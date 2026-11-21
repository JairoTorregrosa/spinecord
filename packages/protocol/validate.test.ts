import { expect, test } from "bun:test";
import { profileHash, validateCondition, validateProgram } from "./validate";

test("accepts a valid program", () => {
  const body = {
    seq: [
      {
        call: {
          tool: "drive",
          args: { distance_cm: 20, until: { device: "front", channel: "distance_cm", op: "lt", value: 10 } },
        },
      },
      { repeat: { times: 3, body: { wait_ms: 100 } } },
    ],
  };
  expect(validateProgram(body)).toEqual([]);
});
test("rejects caps and shapes with paths", () => {
  expect(validateProgram({ wait_ms: 1.5 })[0]!.path).toBe("body.wait_ms");
  expect(validateProgram({ repeat: { times: 0, body: { wait_ms: 1 } } })[0]!.path).toBe("body.repeat.times");
  expect(validateProgram({ call: { tool: "drive", args: { robot_id: "x" } } })[0]!.message).toContain("omitted");
  expect(validateProgram({ jump: 1 })[0]!.message).toContain("unknown node");
});
test("condition rules", () => {
  expect(validateCondition({ device: "b", channel: "pressed", op: "contains", value: "enter" })).toEqual([]);
  expect(validateCondition({ device: "b", channel: "x", op: "changed", value: 1 }).length).toBe(1);
  expect(validateCondition({ device: "b", channel: "x", op: "lt", value: "a" }).length).toBe(1);
  let deep: unknown = { device: "d", channel: "c", op: "eq", value: 1 };
  for (let i = 0; i < 9; i++) deep = { not: deep };
  expect(validateCondition(deep)[0]!.message).toContain("nesting");
});
test("profileHash ignores id and notes, changes with limits", () => {
  const base = {
    id: "a",
    roles: { l: "ev3.B" },
    limits: { max_speed_pct: 60, max_command_ms: 5000, max_drive_cm: 100, max_turn_deg: 360, max_program_ms: 60000 },
    notes: ["x"],
  };
  expect(profileHash(base)).toBe(profileHash({ ...base, id: "b", notes: [] }));
  expect(profileHash(base)).not.toBe(profileHash({ ...base, limits: { ...base.limits, max_speed_pct: 80 } }));
});
