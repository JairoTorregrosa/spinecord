// The plumbing around the agent: the command line, assistant.md, and the numbers printed after each turn.
// Nothing here talks to Claude or to the robot; agent.ts does that.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
  /** the line "Page: <language>" under "## My robot": the robot's eyes, ears and voice are a browser page. null: no page */
  page: { lang: string } | null;
};

/** A language tag as browsers take it: es-ES, es-MX, en-US, pt-BR, fr. */
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

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
  const pageLine = bodies.get("My robot")!.find((line) => /^page\s*:/i.test(line));
  let page: Mission["page"] = null;
  if (pageLine !== undefined) {
    const lang = pageLine.replace(/^page\s*:/i, "").trim();
    if (!LANGUAGE.test(lang))
      throw new Error(
        `${file}: the line "${pageLine}" under "## My robot" needs the language the page listens and speaks in, for example "Page: es-ES".`,
      );
    page = { lang };
  }
  return { name: bodies.get("Name")![0]!, text: text.trim(), page };
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
export type ChatLine =
  | { kind: "empty" }
  | { kind: "bye" }
  | { kind: "command" }
  | { kind: "file-mention" }
  | { kind: "message"; text: string };

/**
 * Reads one chat line. A line that starts with / would be a Claude Code command (/clear, /model, ...): one of them
 * resets the SDK's budget, so no command reaches Claude. A word that starts with @ (@README.md, @/home/me/notes.txt)
 * is a file mention for Claude Code. The guarantee that no file comes in is verbatimPrompts in agent.ts; this check
 * only tells the person, in one line, that such a line is not passed on. An @ inside a word (a@b.com) passes.
 */
export function readChatLine(line: string): ChatLine {
  const text = line.trim();
  if (!text) return { kind: "empty" };
  if (text.toLowerCase() === "bye") return { kind: "bye" };
  if (text.startsWith("/")) return { kind: "command" };
  if (/(^|\s)@/.test(text)) return { kind: "file-mention" };
  return { kind: "message", text };
}

// ---------------------------------------------------------------- who pays
//
// Claude Code decides which credential pays; its accountInfo() says which one it took. The environment only names
// it. When the two do not agree, the program does not start: someone else than the person expects would pay.

/** The environment, as process.env gives it. A variable set to "" counts as not set. */
export type Env = Record<string, string | undefined>;
const value = (env: Env, name: string) => (env[name] ?? "").trim();
const isSet = (env: Env, name: string) => value(env, name) !== "";
/** A switch such as CLAUDE_CODE_USE_BEDROCK: on unless it is empty, 0, false, no or off, as Claude Code reads it. */
const isOn = (env: Env, name: string) =>
  isSet(env, name) && !["0", "false", "no", "off"].includes(value(env, name).toLowerCase());

/** The switches that send Claude Code to a cloud provider in place of Anthropic's API. */
export const CLOUD_SWITCHES = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
];

/** The Anthropic credentials that pay before an ant profile. */
const ABOVE_PROFILE = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

/** The names of accountInfo().apiProvider. */
const PROVIDERS: Record<string, string> = {
  bedrock: "Amazon Bedrock",
  vertex: "Google Cloud Vertex AI",
  foundry: "Microsoft Foundry",
  anthropicAws: "Claude Platform on AWS",
  anthropicGoogleCloud: "Claude Platform on Google Cloud",
  mantle: "Mantle",
  gateway: "an enterprise gateway",
};

/** Every variable that can pay ahead of an ant profile. */
export const PAYS_AHEAD: readonly string[] = [...CLOUD_SWITCHES, ...ABOVE_PROFILE];

/** The first variable set that pays ahead of an ant profile (a cloud switch, a key or a token), or null. */
export const paysBeforeProfile = (env: Env): string | null =>
  CLOUD_SWITCHES.find((name) => isOn(env, name)) ?? ABOVE_PROFILE.find((name) => isSet(env, name)) ?? null;

/** The profile named in ANTHROPIC_PROFILE, or null. */
const namedProfile = (env: Env): string | null =>
  isSet(env, "ANTHROPIC_PROFILE") ? value(env, "ANTHROPIC_PROFILE") : null;

/**
 * Before Claude Code starts: a profile set together with a cloud switch, a key or a token never pays, because those
 * come first. One line names both.
 */
export function checkEnv(env: Env): void {
  const profile = namedProfile(env);
  if (profile === null) return;
  const first = paysBeforeProfile(env);
  if (first)
    throw new Error(
      `ANTHROPIC_PROFILE=${profile} is set, but ${first} is set too and would pay first. Unset one of the two (README, step 2).`,
    );
}

/** Where the ant CLI keeps its profiles: ANTHROPIC_CONFIG_DIR, else $XDG_CONFIG_HOME/anthropic, else ~/.config/anthropic. */
export function antConfigDir(env: Env, home: string = homedir()): string {
  if (isSet(env, "ANTHROPIC_CONFIG_DIR")) return value(env, "ANTHROPIC_CONFIG_DIR");
  if (isSet(env, "XDG_CONFIG_HOME")) return join(value(env, "XDG_CONFIG_HOME"), "anthropic");
  return join(home, ".config", "anthropic");
}

/** The ant CLI's active profile (the file active_config in its folder), or null when there is none. */
export function activeProfile(
  configDir: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | null {
  try {
    return read(join(configDir, "active_config")).trim() || null;
  } catch {
    return null;
  }
}

/** The tokenSource and apiKeySource values of accountInfo() that paidBy names. */
const KNOWN_SOURCES = [
  "none",
  "claude.ai",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "/login managed key",
  "apiKeyHelper",
];

/** What the SDK's accountInfo() says about the login in use (the fields this example reads; none is a secret). */
export type Account = { apiKeySource?: string; tokenSource?: string; subscriptionType?: string; apiProvider?: string };

/**
 * The line "paid by: ..." from Claude Code's answer, named with the environment. Throws when they disagree.
 * `active` is the ant CLI's active profile, which Claude Code uses when nothing else is set.
 */
export function paidBy(account: Account, env: Env, active: string | null): string {
  const profile = namedProfile(env);
  const refuse = (why: string) => new Error(`${why} Nothing was sent (README, step 2)`);
  const skipped = (payer: string) =>
    refuse(
      `ANTHROPIC_PROFILE=${profile} is set, but Claude Code skipped that profile and uses ${payer}. ` +
        `Is the name right, and is it logged in? Check with: ant auth status.`,
    );

  // 1. a cloud provider
  if (account.apiProvider !== undefined && account.apiProvider !== "firstParty") {
    const provider = PROVIDERS[account.apiProvider] ?? account.apiProvider;
    const unused = profile !== null ? "ANTHROPIC_PROFILE" : ABOVE_PROFILE.find((name) => isSet(env, name));
    if (unused) throw refuse(`Claude Code uses ${provider}, so ${unused} would not pay.`);
    return `paid by: ${provider}, through your cloud account`;
  }
  const cloud = CLOUD_SWITCHES.find((name) => isOn(env, name));
  if (cloud) throw refuse(`${cloud} is on, but Claude Code uses Anthropic's API.`);

  // every credential source this program can name; another one would get a wrong label, so it stops the start
  const unknown = [account.tokenSource, account.apiKeySource].find(
    (source) => source !== undefined && !KNOWN_SOURCES.includes(source),
  );
  if (unknown !== undefined)
    throw refuse(`Claude Code pays with "${unknown}", a credential this program does not know.`);

  // 2. no credential at all
  if (account.tokenSource === "none" && account.apiKeySource === undefined)
    throw refuse(
      profile !== null
        ? `ANTHROPIC_PROFILE=${profile}: Claude Code found no login in that profile. Check with: ant auth status.`
        : "Claude Code has no login on this computer.",
    );

  // 3. the apiKeyHelper command of Claude Code's settings, which comes before a token and a profile
  if (account.tokenSource === "apiKeyHelper" || account.apiKeySource === "apiKeyHelper") {
    if (profile !== null) throw skipped("the apiKeyHelper command of Claude Code's settings");
    return "paid by: the apiKeyHelper command of Claude Code's settings";
  }

  // 4. a Claude plan: a subscription token, or this computer's claude.ai login
  if (account.tokenSource === "CLAUDE_CODE_OAUTH_TOKEN") {
    if (profile !== null) throw skipped("a Claude subscription token");
    return "paid by: Claude subscription token";
  }
  if (isSet(env, "CLAUDE_CODE_OAUTH_TOKEN"))
    throw refuse("CLAUDE_CODE_OAUTH_TOKEN is set, but Claude Code does not use it.");
  if (account.subscriptionType) {
    if (profile !== null) throw skipped(`this computer's Claude Code login (${account.subscriptionType} plan)`);
    return `paid by: this computer's Claude Code login (${account.subscriptionType} plan)`;
  }

  // 5. Console billing
  if (account.apiKeySource === "ANTHROPIC_API_KEY") return "paid by: API key";
  if (isSet(env, "ANTHROPIC_API_KEY")) throw refuse("ANTHROPIC_API_KEY is set, but Claude Code does not use it.");
  if (account.tokenSource === "ANTHROPIC_AUTH_TOKEN") return "paid by: the bearer token in ANTHROPIC_AUTH_TOKEN";
  if (isSet(env, "ANTHROPIC_AUTH_TOKEN")) throw refuse("ANTHROPIC_AUTH_TOKEN is set, but Claude Code does not use it.");
  if (account.apiKeySource === "/login managed key") {
    if (profile !== null) throw skipped("a Console API key saved by Claude Code's /login");
    return "paid by: a Console API key saved by this computer's Claude Code (/login)";
  }
  if (profile !== null) return `paid by: Console login, ant profile ${profile}`;
  if (isSet(env, "ANTHROPIC_FEDERATION_RULE_ID") && isSet(env, "ANTHROPIC_ORGANIZATION_ID"))
    return "paid by: workload identity federation";
  if (active !== null) return `paid by: Console login, ant profile ${active} (active profile)`;
  return "paid by: a Console credential this program cannot name";
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const two = (n: number) => String(n).padStart(2, "0");

/** The computer's local date and time, the same on every system: "Sunday 2026-11-22 18:05". */
export function localTime(now: Date): string {
  return `${DAYS[now.getDay()]} ${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
}

// ---------------------------------------------------------------- the page: eyes, ears and voice
//
// A mission with a "Page:" line gets a page listener: the spinecord server's --pages. The server says on its log
// (--log-file) where the page is served and when a page has joined; the program reads that file, because the
// server itself is started by Claude Code and its stderr does not reach this program.

/** The repository root: the spinecord server takes a relative path on its command line from there. */
const REPO = resolve(import.meta.dir, "..", "..");

const flagValue = (flags: string[], name: string): string | undefined => {
  const i = flags.findIndex((f) => f === name || f.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return flags[i] === name ? flags[i + 1] : flags[i]!.slice(name.length + 1);
};
const hasFlag = (flags: string[], name: string) => flags.some((f) => f === name || f.startsWith(`${name}=`));

/** A path of the server's command line as the server reads it: as it is, from the home folder (~), or from the repository. */
export function serverPath(path: string, home: string = homedir()): string {
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return isAbsolute(path) ? path : resolve(REPO, path);
}

/**
 * The robot flags with the page listener on, and the server log the program reads. No flags: the twin and a page
 * (--pages alone would start only the robot without a body). A --log-file the person gave is kept and read.
 */
export function withPages(robotFlags: string[], ownLogFile: string): { robotFlags: string[]; logFile: string } {
  const flags = robotFlags.length === 0 ? ["--twin"] : [...robotFlags];
  // a --config file says itself whether its robots take pages; the start checks it on the server's log
  if (!hasFlag(flags, "--pages") && !hasFlag(flags, "--config")) flags.push("--pages");
  const given = flagValue(flags, "--log-file");
  if (given !== undefined) return { robotFlags: flags, logFile: serverPath(given) };
  return { robotFlags: [...flags, "--log-file", ownLogFile], logFile: ownLogFile };
}

/** One JSON line of the server's log: {"ev": ..., ...fields}. */
export type LogEvent = { ev: string } & Record<string, unknown>;

/** The lines the server appends to its log file once this reader exists. Lines already in it (an earlier run) are skipped. */
export class ServerLog {
  private offset: number;
  private rest = "";
  readonly events: LogEvent[] = [];
  constructor(readonly path: string) {
    this.offset = existsSync(path) ? statSync(path).size : 0;
  }
  /** Reads what was appended since the last call and returns every event so far. */
  read(): LogEvent[] {
    if (!existsSync(this.path)) return this.events;
    const all = readFileSync(this.path);
    if (all.length < this.offset) this.offset = 0; // the file was emptied: read it from the start
    const parts = (this.rest + all.subarray(this.offset).toString("utf8")).split(/\r?\n/);
    this.offset = all.length;
    this.rest = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.startsWith("{")) continue;
      try {
        const event = JSON.parse(line) as LogEvent;
        if (typeof event.ev === "string") this.events.push(event);
      } catch {
        // not a log line
      }
    }
    return this.events;
  }
}

/** Where a page joins: the address the server serves it on, and the robot it should join. */
export type PageListener = { url: string; robot: string };

/**
 * From the server's "robot" lines: the address of the page and the robot it joins. A robot with a body comes
 * first, because the page lends its eyes, ears and voice to the robot that drives; else the robot without a body.
 */
export function pageListener(events: LogEvent[]): PageListener | null {
  const robots = events.filter((e) => e.ev === "robot" && typeof e.join === "string");
  const robot = robots.find((e) => e.backend !== "page") ?? robots[0];
  const url = typeof robot?.join === "string" ? robot.join.match(/https?:\/\/\S+?\//)?.[0] : undefined;
  return robot && url ? { url, robot: String(robot.id) } : null;
}

/** The link the person opens: the page's address with the robot and the language in its fragment. */
export function pageLink(listener: PageListener, lang: string): string {
  return `${listener.url}#robot=${encodeURIComponent(listener.robot)}&lang=${encodeURIComponent(lang)}`;
}

/** A page joined the robot and answered: the server's "page" line that says so, or null. */
export function joinedPage(events: LogEvent[], robot: string): { name: string; kinds: string[] } | null {
  const joined = events.find((e) => e.ev === "page" && e.robot_id === robot && e.to === "active");
  if (!joined) return null;
  return { name: String(joined.name), kinds: Array.isArray(joined.kinds) ? joined.kinds.map(String) : [] };
}

/** Reads the log every pollMs until `found` returns a value, or `ended` settles first (the program is stopping). */
export async function watchLog<T>(
  log: ServerLog,
  found: (events: LogEvent[]) => T | null,
  ended: Promise<unknown>,
  pollMs = 200,
): Promise<T | null> {
  let over = false;
  void ended.then(
    () => (over = true),
    () => (over = true),
  );
  while (!over) {
    const value = found(log.read());
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}
