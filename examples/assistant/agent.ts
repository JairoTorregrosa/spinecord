// A personal robot assistant in one file. Read it from top to bottom:
//
//   1. WHO it is            assistant.md, in your own words, becomes Claude's instructions.
//   2. WHAT it may touch    one MCP server, spinecord: the robot. No files, no shell, no web.
//   3. HOW it gets a turn   chat (you write) or autonomous (a clock wakes it up).
//   4. THE LOOP             send a message, print what Claude says and does, print what it cost.
//   5. THE END              every way out stops the robot first.
//
// Run it:  bun agent.ts            chat
//          bun agent.ts --every 60 autonomous, one wake-up a minute
//          bun agent.ts --help     every option
//
// The agent loop itself (Claude thinks, calls a tool, reads the result, thinks again) lives in the Claude
// Agent SDK. This file only configures it and passes messages in and out.
import { type Options, query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  costLine,
  localTime,
  type Mission,
  parseArgs,
  readMission,
  type Settings,
  UsageError,
  USAGE,
} from "./setup.ts";

/** The Claude model that thinks for the robot. Change it here, for example to "claude-haiku-5-5" (cheaper). */
export const MODEL = "claude-opus-5-5";

/** Bound of one turn: how many times Claude may go "think, then use tools" before the turn is cut. */
export const MAX_STEPS_PER_TURN = 15;

/** How long the end may wait for Claude to let go of a turn, in ms. */
const PATIENCE_MS = 5000;

const HERE = import.meta.dir;
export const DEFAULT_MISSION_FILE = resolve(HERE, "assistant.md");
/** The spinecord server of this clone: two folders up, as a full path, so it starts from any folder. */
export const SPINECORD_MAIN = resolve(HERE, "..", "..", "apps", "local", "main.ts");
/** The name the server gets here. Its tools are then called mcp__spinecord__drive, mcp__spinecord__stop, ... */
export const SERVER = "spinecord";
const TOOL_PREFIX = `mcp__${SERVER}__`;

/** Claude Code's own tools. This assistant drives a robot: it reads no files and runs no commands. */
export const BUILT_IN_TOOLS = [
  ...["Bash", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep"],
  ...["WebFetch", "WebSearch", "Agent", "Task", "Skill", "TodoWrite", "ToolSearch", "AskUserQuestion"],
];

// ---------------------------------------------------------------- 1. WHO it is

/** The system prompt: a few fixed lines about how this program works, then assistant.md as it is. */
export function instructions(mission: Mission): string {
  return `You are a personal robot assistant. Your owner wrote the notes below in their own words. They say who you are, who you help, what your mission is and the rules you never break. Follow them, and answer in the language they are written in.

You act in the world only through the robot tools of the "${SERVER}" server; its instructions say how to use them. Start with list_robots and describe_robot to learn what your robot has. The moment something looks wrong, or you are not sure, call stop and say why.

Two kinds of message reach you:
- A person writes to you. Answer, and act when they ask.
- A message that starts with [tick]. The program woke you up by itself and tells you the local time. If your notes say it is time to act, act, then report in one or two sentences. Otherwise answer exactly: nothing to do

You remember this whole conversation. Before you act on a tick, check what you already did, so that you never do the same thing twice.

Write plain text for a terminal, without markdown. Be brief: three sentences at most, unless the person asks for more.

----- the owner's notes -----
${mission.text}`;
}

/** What the clock says to the assistant in autonomous mode. */
export function tickMessage(now: Date): string {
  return `[tick] Local time: ${localTime(now)}. Act on your mission if it is time; else answer "nothing to do".`;
}

// ---------------------------------------------------------------- 2. WHAT it may touch

/** Every setting the SDK gets. Each line is one decision about what this agent is allowed to do. */
export function buildOptions(mission: Mission, settings: Settings): Options {
  if (!process.versions.bun) throw new Error("Run this with bun (bun agent.ts): the spinecord server needs it.");
  return {
    model: MODEL,
    // A string is the whole system prompt. To keep Claude Code's own prompt and add to it, the SDK takes
    // { type: "preset", preset: "claude_code", append: "..." }; a robot assistant has no use for a coder's prompt.
    systemPrompt: instructions(mission),

    // The robot: spinecord as a child process that speaks MCP over stdin and stdout. process.execPath is the
    // full path of the bun that runs this file, so nothing is looked up in PATH, on macOS and on Windows.
    mcpServers: {
      [SERVER]: {
        type: "stdio",
        command: process.execPath,
        args: [SPINECORD_MAIN, ...settings.robotFlags],
        alwaysLoad: true,
      },
    },
    strictMcpConfig: true, // only the server above, whatever else this computer has registered

    tools: [], // none of Claude Code's built-in tools exist for this agent...
    disallowedTools: BUILT_IN_TOOLS, // ...and a call to one would be denied anyway
    allowedTools: [`${TOOL_PREFIX}*`], // the robot's tools run without asking
    permissionMode: "dontAsk", // anything else is denied, never asked: nobody is there to click "yes"

    settingSources: [], // ignore the Claude Code settings, memory and skills of this computer
    persistSession: false, // the conversation lives in memory while the program runs, not on disk

    maxTurns: MAX_STEPS_PER_TURN, // bound of one turn
    maxBudgetUsd: settings.maxUsd, // bound of the whole session, checked by the SDK (the loop below checks it too)
  };
}

/** Asks the spinecord server whether it accepts these flags, without starting a robot (--print-add starts nothing). */
function checkRobotFlags(robotFlags: string[]): void {
  const asked = Bun.spawnSync([process.execPath, SPINECORD_MAIN, "--print-add", ...robotFlags], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (asked.exitCode !== 0)
    throw new UsageError(
      `The robot server did not accept "${robotFlags.join(" ")}": ${asked.stderr.toString().split(/\r?\n/)[0]}`,
    );
}

/** What the clock needs from the program: a way to give a turn, and the single way out. */
export type Clock = {
  name: string;
  everySeconds: number;
  forMinutes: number | null;
  takeTurn: (text: string) => Promise<void>;
  stop: (why: string) => void;
  untilStopped: Promise<unknown>;
  isStopped: () => boolean;
};

/** Autonomous mode: a wake-up every everySeconds until --for is over or something else stops the program. */
export async function autonomous(clock: Clock): Promise<void> {
  const { name, everySeconds, forMinutes, takeTurn, stop, untilStopped, isStopped } = clock;
  const why = `the ${forMinutes} min of --for are over`;
  const end = forMinutes === null ? Infinity : Date.now() + forMinutes * 60_000;
  console.log(`${name} wakes up every ${everySeconds} s${forMinutes === null ? "" : ` for ${forMinutes} min`}.`);
  // the deadline has its own timer: a turn that is running when the time is up is interrupted by the end, like Ctrl+C.
  // A timer waits at most 2^31 - 1 ms (about 24 days), so a longer --for sets it again until the time is up.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = () => {
    const left = end - Date.now();
    if (left <= 0) stop(why);
    else deadline = setTimeout(armDeadline, Math.min(left, 2 ** 31 - 1));
  };
  if (forMinutes !== null) armDeadline();
  try {
    // wake-ups are on a fixed beat: when a turn takes longer than the beat, the next one starts right after it
    for (let next = Date.now(); !isStopped() && next < end; next = Math.max(next + everySeconds * 1000, Date.now())) {
      await Promise.race([new Promise((resolve) => setTimeout(resolve, next - Date.now())), untilStopped]);
      if (isStopped()) return;
      const now = new Date();
      console.log(`tick ${localTime(now)}`);
      await takeTurn(tickMessage(now));
    }
    // no wake-up is left before the deadline: the robot stays on until the deadline or another way out
    await untilStopped;
  } finally {
    clearTimeout(deadline);
  }
}

// ---------------------------------------------------------------- 3, 4, 5: the program

async function main(): Promise<number> {
  const settings = parseArgs(process.argv.slice(2));
  if (settings.help) {
    console.log(USAGE);
    return 0;
  }
  const mission = readMission(settings.missionFile ?? DEFAULT_MISSION_FILE);
  checkRobotFlags(settings.robotFlags);
  console.log(
    `${mission.name} is waking up (model ${MODEL}, budget $${settings.maxUsd.toFixed(2)}). Ctrl+C stops the robot and ends.`,
  );

  // ---- the way out. Everything that ends the program calls stop(); the first reason wins.
  type Stop = { why: string; failed: boolean };
  let stopped: Stop | null = null;
  let announceStop: (stop: Stop) => void = () => {};
  const untilStopped = new Promise<Stop>((done) => (announceStop = done));
  const stop = (why: string, failed = false) => {
    stopped ??= { why, failed };
    announceStop(stopped);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => stop(signal === "SIGINT" ? "Ctrl+C" : signal));

  // ---- messages in. The SDK reads them from this generator, one at a time, for as long as it stays open:
  // that is what makes it one conversation with a memory, and not a new stranger at every message.
  const outbox: string[] = [];
  let inputOpen = true;
  let wake = () => {};
  async function* userMessages(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const text = outbox.shift();
      if (text !== undefined)
        yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
      else if (!inputOpen) return;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  }

  const session = query({ prompt: userMessages(), options: buildOptions(mission, settings) });

  // ---- messages out. 4. THE LOOP: everything Claude says and does arrives here, in order.
  let turn = 0;
  let totalUsd = 0;
  let turnRunning = false;
  let turnDone = () => {};
  const reading = (async () => {
    for await (const message of session) {
      if (message.type === "system" && message.subtype === "init") {
        // the SDK says what it connected: fail loudly when the robot's server is not there
        const server = message.mcp_servers.find((s) => s.name === SERVER);
        if (server?.status !== "connected")
          return stop(
            `the ${SERVER} server did not start (${server?.status ?? "missing"}). Try: bun ${SPINECORD_MAIN} --help`,
            true,
          );
        const foreign = message.tools.filter((tool) => !tool.startsWith(TOOL_PREFIX));
        if (foreign.length > 0)
          return stop(`the agent has tools that are not the robot's: ${foreign.join(", ")}`, true);
      } else if (message.type === "assistant") {
        if (message.error === "authentication_failed")
          return stop("Claude did not accept the login. Set ANTHROPIC_API_KEY (README, step 2).", true);
        if (message.error) console.log(`  (Claude answered with an error: ${message.error})`);
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) console.log(`${mission.name}> ${block.text.trim()}`);
          else if (block.type === "tool_use") {
            const robot = (block.input as { robot_id?: unknown }).robot_id;
            console.log(
              `  -> ${block.name.replace(TOOL_PREFIX, "")}${typeof robot === "string" ? ` (robot_id ${robot})` : ""}`,
            );
          }
        }
      } else if (message.type === "result") {
        // one result per turn: the turn is over, and this is what it cost
        turn += 1;
        console.log(costLine(turn, totalUsd, message, settings.maxUsd));
        totalUsd = message.total_cost_usd;
        if (message.subtype === "error_max_turns") console.log(`  (turn cut after ${MAX_STEPS_PER_TURN} steps)`);
        if (message.subtype === "error_max_budget_usd" || totalUsd >= settings.maxUsd)
          stop(`the budget of $${settings.maxUsd.toFixed(2)} is spent`);
        turnRunning = false;
        turnDone();
      }
    }
  })();
  // the SDK throws when Claude Code cannot start or dies; the session ending by itself is also a way out
  reading.then(
    () => stop("the session ended"),
    (error) => stop(`the session failed: ${error instanceof Error ? error.message : String(error)}`, true),
  );

  /** One turn: hand a message to Claude and wait until its answer is complete (or the program is stopping). */
  const takeTurn = async (text: string): Promise<void> => {
    if (stopped) return;
    turnRunning = true;
    const done = new Promise<void>((resolve) => (turnDone = resolve));
    outbox.push(text);
    wake();
    await Promise.race([done, untilStopped]);
  };

  // ---- 3. HOW it gets a turn
  const keyboard =
    settings.mode.kind === "chat"
      ? createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " })
      : null;
  keyboard?.on("SIGINT", () => stop("Ctrl+C")); // while it waits for a line, the keyboard reader gets Ctrl+C first

  const chat = async (): Promise<void> => {
    console.log(`Write to ${mission.name} and press Enter. Write bye to end.`);
    keyboard!.prompt();
    for await (const line of keyboard!) {
      if (line.trim().toLowerCase() === "bye") break;
      if (line.trim()) await takeTurn(line.trim());
      if (stopped) return;
      keyboard!.prompt();
    }
    stop("the chat is closed");
  };

  void (
    settings.mode.kind === "chat"
      ? chat()
      : autonomous({
          name: mission.name,
          everySeconds: settings.mode.everySeconds,
          forMinutes: settings.mode.forMinutes,
          takeTurn,
          stop,
          untilStopped,
          isStopped: () => stopped !== null,
        })
  ).catch((error) => stop(`the program failed: ${error instanceof Error ? error.message : String(error)}`, true));

  // ---- 5. THE END. One path for Ctrl+C, the budget, --for, "bye" and every error.
  const { why, failed } = await untilStopped;
  console.log(`\nStopping: ${why}.`);
  keyboard?.close();
  const patiently = (work: Promise<unknown>) =>
    Promise.race([work.catch(() => {}), new Promise((resolve) => setTimeout(resolve, PATIENCE_MS))]);
  // a. Claude is in the middle of a turn: interrupt it. The SDK cancels the tool call that is running, and
  //    spinecord brakes a robot whose call is cancelled.
  if (turnRunning) await patiently(session.interrupt());
  // b. No more messages: the generator returns, and the SDK ends the conversation.
  inputOpen = false;
  wake();
  await patiently(reading);
  // c. Close the SDK. It ends Claude Code, which ends the spinecord server, and spinecord stops every motor
  //    of every robot before it exits (its log says "stopped" and "exit").
  session.close();
  console.log(
    `${mission.name} is off. ${turn} turn(s), $${totalUsd.toFixed(4)} in total (an estimate of the SDK, not a bill).`,
  );
  return failed ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    // a mistake at the keyboard or in assistant.md: say it in one line, without a stack trace
    // (written straight to stderr: bun's console.error adds color codes, which some Windows terminals print raw)
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof UsageError) process.stderr.write(`\n${USAGE}\n`);
    process.exit(2);
  }
}
