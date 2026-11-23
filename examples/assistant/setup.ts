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
  --max-usd <amount>    stop when the session has cost this much (default ${DEFAULT_MAX_USD})
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

/** What the SDK's result message says about money and tokens (the fields this example reads). */
export type TurnResult = {
  /** USD of the whole session so far: a running total, not this turn's cost */
  total_cost_usd: number;
  /** tokens of this turn alone */
  usage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  };
};

/** One line: this turn's cost and tokens, then the running total against the budget. */
export function costLine(turn: number, totalBeforeUsd: number, result: TurnResult, maxUsd: number): string {
  const u = result.usage;
  const read = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  const turnUsd = result.total_cost_usd - totalBeforeUsd;
  return (
    `[turn ${turn}: $${turnUsd.toFixed(4)}, ${read} tokens read (${u.cache_read_input_tokens} from cache), ` +
    `${u.output_tokens} written | total $${result.total_cost_usd.toFixed(4)} of $${maxUsd.toFixed(2)}]`
  );
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const two = (n: number) => String(n).padStart(2, "0");

/** The computer's local date and time, the same on every system: "Sunday 2026-11-22 18:05". */
export function localTime(now: Date): string {
  return `${DAYS[now.getDay()]} ${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
}
