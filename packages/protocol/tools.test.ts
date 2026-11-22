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
    // every snake_case word is a tool, a field of some result (fault_reason, motors_stopped), or a field with a
    // unit or an id (retry_after_ms, request_id, distance_cm, heading_change_deg, rate_hz)
    const fields = new Set<string>();
    const collect = (schema: unknown): void => {
      if (typeof schema !== "object" || schema === null) return;
      const s = schema as { properties?: Record<string, unknown>; items?: unknown };
      for (const [name, sub] of Object.entries(s.properties ?? {})) {
        fields.add(name);
        collect(sub);
      }
      collect(s.items);
    };
    for (const t of TOOLS) collect(t.output);
    for (const word of SERVER_INSTRUCTIONS.matchAll(/\b[a-z]+(_[a-z]+)+\b/g))
      if (!/_(ms|id|cm|deg|hz)$/.test(word[0]) && !fields.has(word[0])) expect(names).toContain(word[0]);
  });
  test("data is an object in every tool, and the tools that read channels share one readings field", () => {
    const data = (name: string) =>
      TOOLS.find((t) => t.name === name)!.output.properties.data as {
        type: unknown;
        properties: Record<string, unknown>;
      };
    for (const t of TOOLS) expect(data(t.name).type).toBe("object");
    const readings = data("read_all").properties.readings;
    expect(readings).toBeDefined();
    expect(data("read_device").properties.readings).toEqual(readings);
    expect(data("wait_until").properties.readings).toEqual(readings);
    // one name for how long a call took
    for (const name of ["read_all", "wait_until", "drive", "turn", "arc", "command_device", "run_program"])
      expect(Object.keys(data(name).properties)).toContain("ms");
  });
  test("defaults are stated where the argument is described", () => {
    const input = (name: string) =>
      TOOLS.find((t) => t.name === name)!.input.properties as Record<string, { description?: string }>;
    expect(input("sample_device").rate_hz!.description).toContain("Default 10");
    expect(input("wait_until").poll_hz!.description).toContain("Default 20");
    expect(input("drive").speed_pct!.description).toContain("Default 30");
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
