// The plumbing around the agent: the command line, assistant.md, and the numbers printed after each turn.
// Nothing here talks to Claude or to the robot; agent.ts does that.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------- the command line

export const DEFAULT_EVERY_SECONDS = 60;
export const MIN_EVERY_SECONDS = 10;
export const DEFAULT_MAX_USD = 1;

export const USAGE = `usage: bun agent.ts [options] [-- robot flags]

  (no options)          chat: you write, your assistant answers and drives the robot
  --every [seconds]     autonomous: the assistant wakes up by itself every N seconds
                        (default ${DEFAULT_EVERY_SECONDS}, minimum ${MIN_EVERY_SECONDS})
  --for <minutes>       with --every: stop after this many minutes
  --max-usd <amount>    stop at the first turn that brings the session to this amount
                        (default ${DEFAULT_MAX_USD})
  --mission <file>      the assistant's file (default assistant.md, next to agent.ts)
  --help                this text

Everything after a lone -- goes to the spinecord server and chooses the robot, for example
  bun agent.ts -- --ev3
Without it the robot is a simulated twin. Every robot flag: bun ../../apps/local/main.ts --help

Stop with Ctrl+C: the robot stops before the program ends.`;

/** How the assistant gets its turns. */
export type Mode = { kind: "chat" } | { kind: "autonomous"; everySeconds: number; forMinutes: number | null };

export type Settings = {
  mode: Mode;
  maxUsd: number;
  /** null = assistant.md next to agent.ts */
  missionFile: string | null;
  /** passed to the spinecord server untouched */
  robotFlags: string[];
  help: boolean;
};

/** A mistake of the person at the keyboard: shown as one line and the usage, without a stack trace. */
export class UsageError extends Error {}

const OWN_FLAGS = ["--help", "-h", "--every", "--for", "--max-usd", "--mission"];
const isNumber = (text: string | undefined): text is string => text !== undefined && /^\d+(\.\d+)?$/.test(text);

export function parseArgs(argv: string[]): Settings {
  // Robot flags start at a lone --, or at the first option that is not one of this program:
  // bun itself removes a -- that comes right after the file name (bun agent.ts -- --ev3 arrives as --ev3).
  const first = argv.findIndex((arg) => arg === "--" || (arg.startsWith("-") && !OWN_FLAGS.includes(arg)));
  const own = first >= 0 ? argv.slice(0, first) : argv;
  const robotFlags = first >= 0 ? argv.slice(argv[first] === "--" ? first + 1 : first) : [];

  let every: number | null = null;
  let forMinutes: number | null = null;
  let maxUsd = DEFAULT_MAX_USD;
  let missionFile: string | null = null;
  let help = false;

  for (let i = 0; i < own.length; i++) {
    const flag = own[i]!;
    const value = own[i + 1];
    if (flag === "--help" || flag === "-h") help = true;
    else if (flag === "--every") {
      // the number is optional: a bare --every is every 60 seconds
      every = isNumber(value) ? Number(own[++i]) : DEFAULT_EVERY_SECONDS;
      if (every < MIN_EVERY_SECONDS)
        throw new UsageError(`--every ${every}: the minimum is ${MIN_EVERY_SECONDS} seconds, each wake-up costs money`);
    } else if (flag === "--for") {
      if (!isNumber(value) || Number(value) <= 0)
        throw new UsageError("--for needs a number of minutes, for example --for 5");
      forMinutes = Number(own[++i]);
    } else if (flag === "--max-usd") {
      if (!isNumber(value) || Number(value) <= 0)
        throw new UsageError("--max-usd needs an amount, for example --max-usd 0.50");
      maxUsd = Number(own[++i]);
    } else if (flag === "--mission") {
      if (value === undefined || value.startsWith("--"))
        throw new UsageError("--mission needs a file, for example --mission missions/waiter.md");
      missionFile = resolve(own[++i]!);
    } else
      throw new UsageError(
        `"${flag}" is not an option. Robot flags go after a lone --, for example: bun agent.ts -- --ev3`,
      );
  }
  if (forMinutes !== null && every === null)
    throw new UsageError("--for only works with --every: a chat ends when you close it");

  const mode: Mode = every === null ? { kind: "chat" } : { kind: "autonomous", everySeconds: every, forMinutes };
  return { mode, maxUsd, missionFile, robotFlags, help };
}

// ---------------------------------------------------------------- assistant.md

/** The titles every assistant file has, written as "## Title". */
export const SECTIONS = ["Name", "Who I help", "My robot", "My mission", "When I act on my own", "Rules"] as const;

export type Mission = {
  /** first line under "## Name": the label in front of what the assistant says */
  name: string;
  /** the whole file, as the person wrote it: this is what Claude reads */
  text: string;
};

export function parseMission(text: string, file: string): Mission {
  const bodies = new Map<string, string[]>();
  let current: string[] | null = null;
  // \r?\n: Notepad on Windows ends lines with \r\n
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const title = line.match(/^##\s+(.+?)\s*$/)?.[1];
    if (title !== undefined) bodies.set(title, (current = []));
    else if (line.trim() !== "") current?.push(line.trim());
  }
  const missing = SECTIONS.filter((title) => (bodies.get(title) ?? []).length === 0);
  if (missing.length > 0)
    throw new Error(
      `${file}: ${missing.map((title) => `"## ${title}"`).join(", ")} ${missing.length === 1 ? "is" : "are"} missing or empty. ` +
        `An assistant file has these titles, each with some words under it: ${SECTIONS.map((t) => `"## ${t}"`).join(", ")}.`,
    );
  return { name: bodies.get("Name")![0]!, text: text.trim() };
}

export function readMission(file: string): Mission {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`${file}: this assistant file cannot be read. Is the name right?`);
  }
  return parseMission(text, file);
}

// ---------------------------------------------------------------- the numbers after each turn

/** What the SDK's result message says about tokens (the fields this example reads). */
export type TurnResult = {
  /** tokens of this turn alone */
  usage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  };
};

/**
 * What the session has spent, which never goes down. The SDK's running total (total_cost_usd) starts again at 0
 * after a conversation reset, so the program keeps its own sum of what each turn cost.
 */
export class Spend {
  /** Everything spent since the program started. */
  total = 0;
  /** The SDK's running total at the last result, since its last reset. */
  private sdkTotal = 0;

  /** A result arrived: returns what this turn cost. A running total lower than the last one is a reset. */
  add(runningTotalUsd: number): number {
    const turnUsd = runningTotalUsd >= this.sdkTotal ? runningTotalUsd - this.sdkTotal : runningTotalUsd;
    this.sdkTotal = runningTotalUsd;
    this.total += Math.max(0, turnUsd);
    return Math.max(0, turnUsd);
  }

  /** The SDK said its conversation was reset: its next running total starts at 0 again. */
  reset(): void {
    this.sdkTotal = 0;
  }
}

/** One line: this turn's cost and tokens, then what the session has spent against the budget. */
export function costLine(turn: number, turnUsd: number, totalUsd: number, result: TurnResult, maxUsd: number): string {
  const u = result.usage;
  const read = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  return (
    `[turn ${turn}: $${turnUsd.toFixed(4)}, ${read} tokens read (${u.cache_read_input_tokens} from cache), ` +
    `${u.output_tokens} written | total $${totalUsd.toFixed(4)} of $${maxUsd.toFixed(2)}]`
  );
}

/** What a line typed in the chat is. */
export type ChatLine = { kind: "empty" } | { kind: "bye" } | { kind: "command" } | { kind: "message"; text: string };

/**
 * Reads one chat line. A line that starts with / would be a Claude Code command (/clear, /model, ...): one of them
 * resets the SDK's budget, so no command reaches Claude.
 */
export function readChatLine(line: string): ChatLine {
  const text = line.trim();
  if (!text) return { kind: "empty" };
  if (text.toLowerCase() === "bye") return { kind: "bye" };
  if (text.startsWith("/")) return { kind: "command" };
  return { kind: "message", text };
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const two = (n: number) => String(n).padStart(2, "0");

/** The computer's local date and time, the same on every system: "Sunday 2026-11-22 18:05". */
export function localTime(now: Date): string {
  return `${DAYS[now.getDay()]} ${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
}
