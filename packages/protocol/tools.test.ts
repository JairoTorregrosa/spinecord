import { describe, expect, test } from "bun:test";
import { assertSupported } from "./schema";
import { LOCAL_SERVER_INSTRUCTIONS, LOCAL_TOOLS, TOOLS } from "./tools";

describe("local catalog", () => {
  const names = LOCAL_TOOLS.map((t) => t.name);
  test("serves the tools the runtime executes, plus list_robots and stop", () => {
    expect(names).toEqual([
      "list_robots",
      "describe_robot",
      "describe_device",
      "read_device",
      "read_all",
      "sample_device",
      "wait_until",
      "drive",
      "turn",
      "arc",
      "command_device",
      "stop",
      "reset_fault",
      "run_program",
    ]);
  });
  test("every tool is a catalog tool with the same title and annotations, except idempotency", () => {
    for (const t of LOCAL_TOOLS) {
      const base = TOOLS.find((b) => b.name === t.name)!;
      expect(base).toBeDefined();
      expect(t.title).toBe(base.title);
      expect({ ...t.annotations, idempotentHint: base.annotations.idempotentHint }).toEqual(base.annotations);
      assertSupported(t.input, t.name);
    }
  });
  test("a tool that moves the robot is not idempotent: a repeated call moves it again", () => {
    const hints = Object.fromEntries(LOCAL_TOOLS.map((t) => [t.name, t.annotations.idempotentHint]));
    for (const name of ["drive", "turn", "arc", "command_device", "run_program"]) expect(hints[name]).toBe(false);
    for (const name of ["read_all", "wait_until", "stop", "reset_fault"]) expect(hints[name]).toBe(true);
  });
  test("no text names what only a relay has", () => {
    const relayOnly =
      /\btokens?\b|\bin control\b|\bcontrol\b|\bepisodes?\b|\blibrary\b|\badmin\b|\bverif(y|ied)_program\b|\bsave_program\b|-sim\b|\b10 min\b/i;
    for (const t of LOCAL_TOOLS) {
      expect(t.description).not.toMatch(relayOnly);
      expect(JSON.stringify(t.input)).not.toMatch(relayOnly);
    }
    expect(LOCAL_SERVER_INSTRUCTIONS).not.toMatch(relayOnly);
    for (const tool of LOCAL_SERVER_INSTRUCTIONS.matchAll(/\b[a-z]+_[a-z_]+\b/g))
      if (TOOLS.some((t) => t.name === tool[0])) expect(names).toContain(tool[0]);
  });
  test("request_id is optional and robot state has no control or episode", () => {
    for (const t of LOCAL_TOOLS) {
      expect(t.input.required ?? []).not.toContain("request_id");
      const robot = t.output.properties.robot as { properties: object; required: string[] };
      expect(Object.keys(robot.properties)).toEqual(["id", "backend", "link", "activity"]);
      expect(robot.required).toEqual(["id", "backend", "link", "activity"]);
      expect(t.output.$id).toStartWith(`urn:spinecord:local:output:${t.name}:`);
    }
  });
  test("run_program takes the program inline", () => {
    const run = LOCAL_TOOLS.find((t) => t.name === "run_program")!;
    expect(run.input.required).toEqual(["robot_id", "body"]);
    expect(Object.keys(run.input.properties)).toEqual(["robot_id", "body", "success", "request_id"]);
  });
});
