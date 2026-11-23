// Nothing here calls Claude: these tests read the assistant files, the command line and the options object
// that agent.ts hands to the SDK.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  buildOptions,
  BUILT_IN_TOOLS,
  DEFAULT_MISSION_FILE,
  instructions,
  MAX_STEPS_PER_TURN,
  MODEL,
  SPINECORD_MAIN,
  tickMessage,
} from "../agent.ts";
import { costLine, localTime, parseArgs, parseMission, readMission, SECTIONS, UsageError } from "../setup.ts";

const HERE = resolve(import.meta.dir, "..");
const MISSIONS = join(HERE, "missions");
const missionFiles = [DEFAULT_MISSION_FILE, ...readdirSync(MISSIONS).map((name) => join(MISSIONS, name))];

describe("assistant files", () => {
  test("missions/ holds at least two more examples, all markdown", () => {
    expect(missionFiles.length).toBeGreaterThanOrEqual(3);
    for (const file of missionFiles) expect(file.endsWith(".md")).toBe(true);
  });

  for (const file of missionFiles)
    test(`${file.slice(HERE.length + 1)} has every section and a name`, () => {
      const mission = readMission(file);
      expect(mission.name.length).toBeGreaterThan(0);
      for (const title of SECTIONS) expect(mission.text).toContain(`## ${title}`);
    });

  test("the example names are different, so two files are never mixed up", () => {
    const names = missionFiles.map((file) => readMission(file).name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("a missing or empty section fails with its title and the file", () => {
    const text = SECTIONS.map((title) => `## ${title}\nwords`)
      .join("\n")
      .replace("## Rules\nwords", "## Rules\n");
    expect(() => parseMission(text, "mine.md")).toThrow(/mine\.md: "## Rules" is missing or empty/);
    expect(() => parseMission("## Name\nAda", "mine.md")).toThrow(/"## Who I help", .* are missing or empty/);
  });

  test("Windows line ends and a byte order mark parse the same", () => {
    const text = `﻿${SECTIONS.map((title) => `## ${title}\r\n\r\nAda ${title}\r\n`).join("\r\n")}`;
    expect(parseMission(text, "mine.md").name).toBe("Ada Name");
  });

  test("a file that is not there fails with its path", () => {
    expect(() => readMission(join(HERE, "nobody.md"))).toThrow(/nobody\.md: this assistant file cannot be read/);
  });
});

describe("command line", () => {
  test("no arguments: chat, the twin, the default budget", () => {
    expect(parseArgs([])).toEqual({
      mode: { kind: "chat" },
      maxUsd: 1,
      missionFile: null,
      robotFlags: [],
      help: false,
    });
  });

  test("--every with and without a number", () => {
    expect(parseArgs(["--every"]).mode).toEqual({ kind: "autonomous", everySeconds: 60, forMinutes: null });
    expect(parseArgs(["--every", "15", "--for", "1"]).mode).toEqual({
      kind: "autonomous",
      everySeconds: 15,
      forMinutes: 1,
    });
    expect(parseArgs(["--every", "--max-usd", "0.25"])).toMatchObject({
      mode: { kind: "autonomous", everySeconds: 60 },
      maxUsd: 0.25,
    });
  });

  test("everything after -- goes to the robot server, untouched", () => {
    const settings = parseArgs(["--every", "30", "--", "--ev3", "--twin", "--log-file", "robot.log"]);
    expect(settings.robotFlags).toEqual(["--ev3", "--twin", "--log-file", "robot.log"]);
    expect(settings.mode).toMatchObject({ kind: "autonomous", everySeconds: 30 });
    // a flag of this program after -- belongs to the robot server too
    expect(parseArgs(["--", "--every", "5"])).toMatchObject({ mode: { kind: "chat" }, robotFlags: ["--every", "5"] });
  });

  test("bun removes a -- right after the file name: the first foreign option starts the robot flags", () => {
    expect(parseArgs(["--ev3", "--twin"]).robotFlags).toEqual(["--ev3", "--twin"]);
    expect(parseArgs(["--log-file", "robot.log"])).toMatchObject({
      mode: { kind: "chat" },
      robotFlags: ["--log-file", "robot.log"],
    });
    expect(parseArgs(["--every", "30", "--ev3dev", "--ssh", "robot@brick"])).toMatchObject({
      mode: { kind: "autonomous", everySeconds: 30 },
      robotFlags: ["--ev3dev", "--ssh", "robot@brick"],
    });
  });

  test("--mission becomes a full path", () => {
    const file = parseArgs(["--mission", join("missions", "waiter.md")]).missionFile!;
    expect(isAbsolute(file)).toBe(true);
    expect(file.endsWith(join("missions", "waiter.md"))).toBe(true);
  });

  test("mistakes are usage errors that say what to write", () => {
    const bad: [string[], RegExp][] = [
      [["--every", "5"], /minimum is 10 seconds/],
      [["--for", "2"], /--for only works with --every/],
      [["--every", "--for"], /--for needs a number of minutes/],
      [["--max-usd", "0"], /--max-usd needs an amount/],
      [["--max-usd"], /--max-usd needs an amount/],
      [["--mission"], /--mission needs a file/],
      [["robot.json"], /"robot\.json" is not an option\. Robot flags go after a lone --/],
    ];
    for (const [argv, message] of bad) {
      expect(() => parseArgs(argv)).toThrow(UsageError);
      expect(() => parseArgs(argv)).toThrow(message);
    }
  });
});

describe("what the SDK is given", () => {
  const mission = readMission(DEFAULT_MISSION_FILE);
  const options = buildOptions(mission, parseArgs(["--max-usd", "0.5", "--", "--twin", "--seed", "7"]));

  test("the model is the constant at the top of agent.ts", () => {
    expect(MODEL).toBe("claude-opus-5-5");
    expect(options.model).toBe(MODEL);
  });

  test("the only tools are spinecord's, and they never ask", () => {
    expect(options.allowedTools).toEqual(["mcp__spinecord__*"]);
    expect(options.permissionMode).toBe("dontAsk");
  });

  test("the built-in tools are gone and denied", () => {
    expect(options.tools).toEqual([]);
    for (const tool of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent"]) {
      expect(BUILT_IN_TOOLS).toContain(tool);
      expect(options.disallowedTools).toContain(tool);
    }
  });

  test("nothing of this computer's Claude Code leaks in", () => {
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.persistSession).toBe(false);
    expect(Object.keys(options.mcpServers!)).toEqual(["spinecord"]);
  });

  test("spinecord starts from full paths, with the robot flags after its main file", () => {
    const server = options.mcpServers!.spinecord as { type?: string; command: string; args: string[] };
    expect(server.type).toBe("stdio");
    expect(isAbsolute(server.command)).toBe(true);
    expect(server.command).toBe(process.execPath);
    expect(isAbsolute(server.args[0]!)).toBe(true);
    expect(server.args[0]).toBe(SPINECORD_MAIN);
    expect(existsSync(SPINECORD_MAIN)).toBe(true);
    expect(server.args.slice(1)).toEqual(["--twin", "--seed", "7"]);
  });

  test("without robot flags the server gets none: its default is the twin", () => {
    const server = buildOptions(mission, parseArgs([])).mcpServers!.spinecord as { args: string[] };
    expect(server.args).toEqual([SPINECORD_MAIN]);
  });

  test("the command that is built starts on this system", () => {
    const server = options.mcpServers!.spinecord as { command: string; args: string[] };
    const run = Bun.spawnSync([server.command, server.args[0]!, "--help"], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(0);
    // the usage text of the server, on whichever stream it prints it
    expect(run.stdout.toString() + run.stderr.toString()).toContain("--twin");
  });

  test("every turn and the whole session are bounded", () => {
    expect(options.maxTurns).toBe(MAX_STEPS_PER_TURN);
    expect(options.maxBudgetUsd).toBe(0.5);
  });

  test("the system prompt is the fixed lines and then the file, whole", () => {
    expect(options.systemPrompt).toBe(instructions(mission));
    expect(instructions(mission)).toContain(mission.text);
    expect(instructions(mission)).toContain("nothing to do");
  });
});

describe("what is printed and sent", () => {
  const at = new Date(2026, 0, 5, 8, 7); // a Monday, in whatever time zone the test runs

  test("local time reads the same on every system", () => {
    expect(localTime(at)).toBe("Monday 2026-01-05 08:07");
  });

  test("a tick carries the time and the way out", () => {
    expect(tickMessage(at)).toBe(
      '[tick] Local time: Monday 2026-01-05 08:07. Act on your mission if it is time; else answer "nothing to do".',
    );
  });

  test("a turn's cost is the difference of the running total; its tokens are its own", () => {
    const usage = {
      input_tokens: 10,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 9000,
      output_tokens: 55,
    };
    expect(costLine(3, 0.05, { total_cost_usd: 0.0625, usage }, 1)).toBe(
      "[turn 3: $0.0125, 9210 tokens read (9000 from cache), 55 written | total $0.0625 of $1.00]",
    );
  });
});
