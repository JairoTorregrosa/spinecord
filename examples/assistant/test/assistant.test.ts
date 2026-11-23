// Nothing here calls Claude: these tests read the assistant files, the command line and the options object
// that agent.ts hands to the SDK.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  autonomous,
  buildOptions,
  endSession,
  BUILT_IN_TOOLS,
  DEFAULT_MISSION_FILE,
  instructions,
  MAX_STEPS_PER_TURN,
  MODEL,
  SPINECORD_MAIN,
  tickMessage,
} from "../agent.ts";
import {
  activeProfile,
  antConfigDir,
  checkEnv,
  costLine,
  localTime,
  paidBy,
  parseArgs,
  parseMission,
  readChatLine,
  readMission,
  SECTIONS,
  Spend,
  UsageError,
} from "../setup.ts";

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

  test("a message goes to Claude as written: no @file mention is replaced by the file", () => {
    expect(options.verbatimPrompts).toBe(true);
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

  test("a turn's cost and the session's total are printed with the turn's own tokens", () => {
    const usage = {
      input_tokens: 10,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 9000,
      output_tokens: 55,
    };
    expect(costLine(3, 0.0125, 0.0625, { usage }, 1)).toBe(
      "[turn 3: $0.0125, 9210 tokens read (9000 from cache), 55 written | total $0.0625 of $1.00]",
    );
  });
});

describe("the clock", () => {
  /** A program with one way out, as in agent.ts: stop() resolves untilStopped, the first reason wins. */
  function program() {
    const reasons: string[] = [];
    let announce: (why: string) => void = () => {};
    const untilStopped = new Promise<string>((done) => (announce = done));
    const stop = (why: string) => {
      reasons.push(why);
      announce(why);
    };
    return { reasons, untilStopped, stop, isStopped: () => reasons.length > 0 };
  }

  test("--for ends a turn that is still running: the deadline calls the one way out", async () => {
    const p = program();
    const turns: string[] = [];
    let inFlight = false;
    const started = Date.now();
    await autonomous({
      name: "Test",
      everySeconds: 10,
      forMinutes: 0.002, // 120 ms
      // a turn that never finishes by itself, the way a long drive keeps Claude busy
      takeTurn: async (text) => {
        turns.push(text);
        inFlight = true;
        await p.untilStopped;
      },
      ...p,
    });
    expect(turns).toHaveLength(1);
    expect(inFlight).toBe(true);
    expect(p.reasons[0]).toBe("the 0.002 min of --for are over");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("--for lasts its full time when the last wake-up comes early", async () => {
    const p = program();
    let turns = 0;
    const started = Date.now();
    await autonomous({
      name: "Test",
      everySeconds: 10, // the second wake-up would be after the deadline
      forMinutes: 0.005, // 300 ms
      takeTurn: async () => {
        turns += 1;
      },
      ...p,
    });
    expect(turns).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    expect(p.reasons).toEqual(["the 0.005 min of --for are over"]);
  });

  test("a stop while the clock waits starts no more turns", async () => {
    const p = program();
    let turns = 0;
    setTimeout(() => p.stop("Ctrl+C"), 50);
    await autonomous({
      name: "Test",
      everySeconds: 10,
      forMinutes: null,
      takeTurn: async () => {
        turns += 1;
      },
      ...p,
    });
    expect(turns).toBe(1);
    expect(p.reasons).toEqual(["Ctrl+C"]);
  });
});

describe("the budget", () => {
  test("a turn costs the difference of the SDK's running total", () => {
    const spend = new Spend();
    expect(spend.add(0.05)).toBeCloseTo(0.05);
    expect(spend.add(0.0625)).toBeCloseTo(0.0125);
    expect(spend.total).toBeCloseTo(0.0625);
  });

  test("a reset of the SDK's running total never lowers what was spent", () => {
    const spend = new Spend();
    spend.add(0.3);
    spend.reset(); // a conversation_reset message
    expect(spend.add(0.02)).toBeCloseTo(0.02);
    expect(spend.total).toBeCloseTo(0.32);
  });

  test("a lower running total without a reset message counts as a reset too", () => {
    const spend = new Spend();
    spend.add(0.3);
    expect(spend.add(0.01)).toBeCloseTo(0.01);
    expect(spend.add(0.04)).toBeCloseTo(0.03);
    expect(spend.total).toBeCloseTo(0.34);
  });

  test("no slash command reaches Claude: /clear would reset the SDK's budget", () => {
    for (const line of ["/clear", " /reset", "/new", "/model claude-haiku-5-5", "/compact", "/"])
      expect(readChatLine(line)).toEqual({ kind: "command" });
    expect(readChatLine("  do your mission now ")).toEqual({ kind: "message", text: "do your mission now" });
    expect(readChatLine("what is 1/2 of 40 cm?")).toEqual({ kind: "message", text: "what is 1/2 of 40 cm?" });
    expect(readChatLine("BYE")).toEqual({ kind: "bye" });
    expect(readChatLine("   ")).toEqual({ kind: "empty" });
  });
});

describe("files of this computer", () => {
  test("a word that starts with @ never reaches Claude: Claude Code would paste that file in", () => {
    for (const line of ["@x", "see @README.md", "\t@x", "what is in @/home/me/notes.txt?", "a\n@x"])
      expect(readChatLine(line)).toEqual({ kind: "file-mention" });
  });

  test("an @ inside a word is not a mention", () => {
    expect(readChatLine("mail me at a@b.com")).toEqual({ kind: "message", text: "mail me at a@b.com" });
    expect(readChatLine("5 cm@speed 20")).toEqual({ kind: "message", text: "5 cm@speed 20" });
  });
});

describe("who pays", () => {
  // the accountInfo() answers below are the shapes Claude Code 2.1.319 gave on 2026-11-22, one for each login
  const LOGIN = { subscriptionType: "Claude Max", apiProvider: "firstParty" };
  const TOKEN = { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" };
  const KEY = { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" };
  const BEARER = { tokenSource: "ANTHROPIC_AUTH_TOKEN", apiProvider: "firstParty" };
  const CONSOLE = { apiProvider: "firstParty" }; // an ant profile, named or active
  const NOTHING = { tokenSource: "none", apiProvider: "firstParty" };

  test("the ant folder: ANTHROPIC_CONFIG_DIR, else $XDG_CONFIG_HOME/anthropic, else ~/.config/anthropic", () => {
    expect(antConfigDir({ ANTHROPIC_CONFIG_DIR: join("x", "ant") }, "home")).toBe(join("x", "ant"));
    expect(antConfigDir({ XDG_CONFIG_HOME: join("x", "cfg") }, "home")).toBe(join("x", "cfg", "anthropic"));
    expect(antConfigDir({ ANTHROPIC_CONFIG_DIR: "" }, "home")).toBe(join("home", ".config", "anthropic"));
  });

  test("the active profile is the first line of active_config, or none", () => {
    expect(activeProfile("dir", () => "work\n")).toBe("work");
    expect(activeProfile("dir", () => "  ")).toBeNull();
    expect(
      activeProfile("dir", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });

  test("a profile under a cloud switch, a key or a token stops the start before Claude Code runs", () => {
    expect(() => checkEnv({ ANTHROPIC_PROFILE: "work", ANTHROPIC_API_KEY: "k" })).toThrow(
      "ANTHROPIC_PROFILE=work is set, but ANTHROPIC_API_KEY is set too and would pay first",
    );
    expect(() => checkEnv({ ANTHROPIC_PROFILE: " work ", CLAUDE_CODE_OAUTH_TOKEN: "t" })).toThrow(
      "ANTHROPIC_PROFILE=work is set, but CLAUDE_CODE_OAUTH_TOKEN",
    );
    expect(() => checkEnv({ ANTHROPIC_PROFILE: "work", CLAUDE_CODE_USE_MANTLE: "1" })).toThrow(
      "CLAUDE_CODE_USE_MANTLE",
    );
    expect(() => checkEnv({ ANTHROPIC_PROFILE: "work", CLAUDE_CODE_USE_BEDROCK: "off" })).not.toThrow();
    expect(() => checkEnv({ ANTHROPIC_PROFILE: "work" })).not.toThrow();
    expect(() => checkEnv({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" })).not.toThrow();
  });

  test("a cloud provider is named from apiProvider, and an Anthropic credential next to it stops the start", () => {
    expect(paidBy({ apiProvider: "bedrock" }, {}, null)).toBe("paid by: Amazon Bedrock, through your cloud account");
    expect(paidBy({ apiProvider: "anthropicGoogleCloud" }, {}, null)).toBe(
      "paid by: Claude Platform on Google Cloud, through your cloud account",
    );
    expect(paidBy({ apiProvider: "newCloud" }, {}, null)).toBe("paid by: newCloud, through your cloud account");
    expect(() => paidBy({ apiProvider: "vertex" }, { ANTHROPIC_PROFILE: "work" }, null)).toThrow(
      "ANTHROPIC_PROFILE would not pay",
    );
    expect(() => paidBy({ apiProvider: "vertex" }, { ANTHROPIC_API_KEY: "k" }, null)).toThrow(
      "ANTHROPIC_API_KEY would not pay",
    );
    // a cloud switch that Claude Code did not follow
    expect(() => paidBy(KEY, { CLAUDE_CODE_USE_GATEWAY: "1", ANTHROPIC_API_KEY: "k" }, null)).toThrow(
      "CLAUDE_CODE_USE_GATEWAY is on, but Claude Code uses Anthropic's API",
    );
    for (const off of ["0", "false", "No", "off"])
      expect(paidBy(KEY, { CLAUDE_CODE_USE_BEDROCK: off, ANTHROPIC_API_KEY: "k" }, null)).toBe("paid by: API key");
  });

  test("a Claude plan: the subscription token, or this computer's login", () => {
    expect(paidBy(TOKEN, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-secret" }, "work")).toBe(
      "paid by: Claude subscription token",
    );
    expect(paidBy(LOGIN, {}, "work")).toBe("paid by: this computer's Claude Code login (Claude Max plan)");
    expect(() => paidBy(LOGIN, { CLAUDE_CODE_OAUTH_TOKEN: "t" }, null)).toThrow(
      "CLAUDE_CODE_OAUTH_TOKEN is set, but Claude Code does not use it",
    );
  });

  test("a named profile that Claude Code skipped stops the start: missing, logged out or misnamed", () => {
    expect(() => paidBy(LOGIN, { ANTHROPIC_PROFILE: "nonexistent" }, "work")).toThrow(
      "ANTHROPIC_PROFILE=nonexistent is set, but Claude Code skipped that profile and uses this computer's Claude Code login (Claude Max plan)",
    );
    expect(() => paidBy(NOTHING, { ANTHROPIC_PROFILE: "nonexistent" }, null)).toThrow(
      "ANTHROPIC_PROFILE=nonexistent: Claude Code found no login in that profile",
    );
    expect(() => paidBy(NOTHING, {}, null)).toThrow("Claude Code has no login on this computer");
  });

  test("Console billing is named from the environment, and a credential Claude Code did not use stops the start", () => {
    expect(paidBy(KEY, { ANTHROPIC_API_KEY: "sk-ant-secret" }, "work")).toBe("paid by: API key");
    expect(() => paidBy(CONSOLE, { ANTHROPIC_API_KEY: "k" }, null)).toThrow("ANTHROPIC_API_KEY is set, but");
    expect(paidBy(BEARER, { ANTHROPIC_AUTH_TOKEN: "b" }, null)).toBe(
      "paid by: the bearer token in ANTHROPIC_AUTH_TOKEN",
    );
    expect(() => paidBy(CONSOLE, { ANTHROPIC_AUTH_TOKEN: "b" }, null)).toThrow("ANTHROPIC_AUTH_TOKEN is set, but");
    expect(paidBy({ apiKeySource: "/login managed key" }, {}, null)).toBe(
      "paid by: a Console API key saved by this computer's Claude Code (/login)",
    );
    expect(() => paidBy({ apiKeySource: "/login managed key" }, { ANTHROPIC_PROFILE: "work" }, null)).toThrow(
      "skipped that profile",
    );
    expect(paidBy(CONSOLE, { ANTHROPIC_PROFILE: " work " }, "other")).toBe("paid by: Console login, ant profile work");
    expect(paidBy(CONSOLE, {}, "work")).toBe("paid by: Console login, ant profile work (active profile)");
    expect(paidBy(CONSOLE, {}, null)).toBe("paid by: a Console credential this program cannot name");
  });

  test("no line carries a secret", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-secret" };
    expect(paidBy(TOKEN, env, null)).not.toContain("secret");
  });
});

describe("the end", () => {
  function fakeSession(interrupt: () => Promise<void> = async () => {}) {
    const calls: string[] = [];
    return {
      calls,
      session: {
        interrupt: async () => {
          calls.push("interrupt");
          await interrupt();
        },
        close: () => {
          calls.push("close");
        },
      },
    };
  }

  test("a running turn is interrupted, then the input is closed, then the session", async () => {
    const fake = fakeSession();
    await endSession({
      session: fake.session,
      turnRunning: true,
      closeInput: () => fake.calls.push("close input"),
      reading: Promise.resolve(),
      patienceMs: 1000,
    });
    expect(fake.calls).toEqual(["interrupt", "close input", "close"]);
  });

  test("without a running turn nothing is interrupted", async () => {
    const fake = fakeSession();
    await endSession({
      session: fake.session,
      turnRunning: false,
      closeInput: () => fake.calls.push("close input"),
      reading: Promise.resolve(),
      patienceMs: 1000,
    });
    expect(fake.calls).toEqual(["close input", "close"]);
  });

  test("a session that never lets go is closed after the patience, and a failed read does not stop the end", async () => {
    const fake = fakeSession(() => new Promise<void>(() => {}));
    const started = Date.now();
    await endSession({
      session: fake.session,
      turnRunning: true,
      closeInput: () => fake.calls.push("close input"),
      reading: Promise.reject(new Error("Claude Code died")),
      patienceMs: 50,
    });
    expect(fake.calls).toEqual(["interrupt", "close input", "close"]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
