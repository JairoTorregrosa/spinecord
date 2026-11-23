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
      "run_loop",
      "supervise_loop",
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
    // accounts and access, stored results and programs, recorded attempts, devices on other machines (a page a
    // person opens on a phone is a device of this process: its socket ends here)
    const absent =
      /\btokens?\b|\badmins?\b|\bowner\b|\bin control\b|\b(take|release)_control\b|\bepisodes?\b|\blibrary\b|\b(save|list|get|verify|retire)_programs?\b|\b10 min\b|\borgans?\b|\bmicrocontroller\b|\bprovider_errors\b/i;
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
    // an error code is a word of the surface too; beacon_heading is a channel the sign rule names, last_match the
    // microphone channel a condition tests after listen
    const codes = (TOOLS[0]!.output.properties.error as { properties: { code: { enum: string[] } } }).properties.code
      .enum;
    for (const word of SERVER_INSTRUCTIONS.matchAll(/\b[a-z]+(_[a-z]+)+\b/g))
      if (
        !/_(ms|id|cm|deg|hz|heading)$/.test(word[0]) &&
        !fields.has(word[0]) &&
        !codes.includes(word[0]) &&
        word[0] !== "condition_met" &&
        word[0] !== "last_match"
      )
        expect(names).toContain(word[0]);
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
  test("pages: join in list_robots, pages in describe_robot, pushed in describe_device, device_offline a code", () => {
    const data = (name: string) =>
      TOOLS.find((t) => t.name === name)!.output.properties.data as { properties: Record<string, any> };
    const robot = data("list_robots").properties.robots.items;
    expect(Object.keys(robot.properties)).toContain("join");
    expect(robot.required).not.toContain("join");
    const pages = data("describe_robot").properties.pages;
    expect(Object.keys(pages.items.properties)).toEqual([
      "name",
      "state",
      "why",
      "devices",
      "unavailable",
      "last_seen_ms",
    ]);
    expect(pages.items.properties.state.enum).toEqual(["announced", "active", "asleep", "gone"]);
    expect(Object.keys(data("describe_device").properties.channels.items.properties)).toContain("pushed");
    const codes = (TOOLS[0]!.output.properties.error as { properties: { code: { enum: string[] } } }).properties.code
      .enum;
    expect(codes).toContain("device_offline");
    const backend = (TOOLS[1]!.output.properties.robot as { properties: { backend: { enum: unknown[] } } }).properties
      .backend.enum;
    expect(backend).toEqual(["ev3", "sim", "page", null]);
    expect(SERVER_INSTRUCTIONS).toContain("device_offline");
    expect(SERVER_INSTRUCTIONS).toContain("join");
  });
  test("run_program takes the program inline", () => {
    const run = TOOLS.find((t) => t.name === "run_program")!;
    expect(run.input.required).toEqual(["robot_id", "body"]);
    expect(Object.keys(run.input.properties)).toEqual(["robot_id", "body", "success", "request_id"]);
  });
});
