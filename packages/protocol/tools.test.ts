import { describe, expect, test } from "bun:test";
import { assertSupported } from "./schema";
import { SERVER_INSTRUCTIONS, TOOLS } from "./tools";

describe("catalog", () => {
  const names = TOOLS.map((t) => t.name);
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
  test("every input uses only the keywords the validator implements", () => {
    for (const t of TOOLS) assertSupported(t.input, t.name);
  });
  test("a tool that moves the robot is not idempotent: a repeated call moves it again", () => {
    const hints = Object.fromEntries(TOOLS.map((t) => [t.name, t.annotations.idempotentHint]));
    for (const name of ["drive", "turn", "arc", "command_device", "run_program"]) expect(hints[name]).toBe(false);
    for (const name of ["read_all", "wait_until", "stop", "reset_fault"]) expect(hints[name]).toBe(true);
    for (const t of TOOLS) expect(t.annotations.idempotentHint).toBe(!t.annotations.destructiveHint);
  });
  test("model-facing text names only what this system has", () => {
    // accounts and access, stored results and programs, recorded attempts, devices on other machines
    const absent =
      /\btokens?\b|\badmins?\b|\bowner\b|\bin control\b|\b(take|release)_control\b|\bepisodes?\b|\blibrary\b|\b(save|list|get|verify|retire)_programs?\b|\b10 min\b|\borgans?\b|\bphone\b|\bmicrocontroller\b|\bprovider_errors\b/i;
    for (const t of TOOLS) {
      expect(`${t.name}: ${t.description}`).not.toMatch(absent);
      expect(`${t.name}: ${JSON.stringify(t.input)}`).not.toMatch(absent);
      expect(`${t.name}: ${JSON.stringify(t.output)}`).not.toMatch(absent);
    }
    expect(SERVER_INSTRUCTIONS).not.toMatch(absent);
  });
  test("every tool the instructions name is in the catalog", () => {
    // snake_case words that are not a field with a unit or an id (retry_after_ms, request_id)
    for (const word of SERVER_INSTRUCTIONS.matchAll(/\b[a-z]+_[a-z]+\b/g))
      if (!/_(ms|id)$/.test(word[0])) expect(names).toContain(word[0]);
  });
  test("request_id is optional and robot state is id, backend, link, activity", () => {
    for (const t of TOOLS) {
      expect(t.input.required ?? []).not.toContain("request_id");
      const robot = t.output.properties.robot as { properties: object; required: string[] };
      expect(Object.keys(robot.properties)).toEqual(["id", "backend", "link", "activity"]);
      expect(robot.required).toEqual(["id", "backend", "link", "activity"]);
      expect(t.output.$id).toStartWith(`urn:spinecord:local:output:${t.name}:`);
    }
  });
  test("run_program takes the program inline", () => {
    const run = TOOLS.find((t) => t.name === "run_program")!;
    expect(run.input.required).toEqual(["robot_id", "body"]);
    expect(Object.keys(run.input.properties)).toEqual(["robot_id", "body", "success", "request_id"]);
  });
});
