// The setup skill (.claude/skills/setup-spinecord) is written in Simplified Technical English: a sentence in a list
// item (a procedure step) has at most 20 words, any other sentence at most 25. Frontmatter, headings, tables and
// code blocks are not prose and are skipped. Inline code and a link's text count as one word each. Its SKILL.md
// stays short, every file it names exists, and every `setup <step>` it names is a step of scripts/setup.ts.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIRM,
  isRegistered,
  launchLine,
  parseAntOrg,
  parseAuth,
  parseMcpGet,
  robotArgs,
  STEPS,
} from "../../../scripts/setup";

const DIR = join(import.meta.dir, "..", "..", "..", ".claude", "skills", "setup-spinecord");
const SKILL = join(DIR, "SKILL.md");
const MD = readdirSync(DIR).filter((f) => f.endsWith(".md"));

/** The words of one sentence: inline code is one word, a link is its text. */
export function words(sentence: string): string[] {
  return sentence
    .replaceAll(/`[^`]*`/g, "CODE")
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
}

/** Sentences end at . ! or ? followed by a space or the end of the line, outside inline code. */
export function sentences(line: string): string[] {
  const masked = line.replaceAll(/`[^`]*`/g, (c) => c.replaceAll(/[.!?]/g, "_"));
  const out: string[] = [];
  let start = 0;
  for (const m of masked.matchAll(/[.!?](?=\s|$)/g)) {
    out.push(line.slice(start, m.index + 1));
    start = m.index + 1;
  }
  out.push(line.slice(start));
  return out.map((s) => s.trim()).filter((s) => words(s).length > 0);
}

/** Every prose sentence with its line number, its limit and its length. */
export function check(text: string): { line: number; limit: number; count: number; sentence: string }[] {
  const lines = text.split(/\r?\n/);
  const out: { line: number; limit: number; count: number; sentence: string }[] = [];
  let fence = false;
  let front = lines[0] === "---";
  lines.forEach((raw, i) => {
    if (i > 0 && front && raw === "---") return void (front = false);
    if (front) return;
    if (/^\s*```/.test(raw)) return void (fence = !fence);
    if (fence || /^\s*(#|\|)/.test(raw) || raw.trim() === "") return;
    const item = /^\s*(\d+\.|-)\s+/.exec(raw);
    const limit = item ? 20 : 25;
    for (const s of sentences(item ? raw.slice(item[0].length) : raw))
      out.push({ line: i + 1, limit, count: words(s).length, sentence: s });
  });
  return out;
}

test("the counter: inline code and links are one word, sentences split outside code", () => {
  expect(words("Run `bun apps/local/main.ts --doctor --twin` in [the folder](x.md).")).toHaveLength(5);
  expect(sentences("Run `a.b c`. Then stop.")).toEqual(["Run `a.b c`.", "Then stop."]);
  const long = Array.from({ length: 21 }, () => "go").join(" ");
  expect(check(`- ${long}.`)[0]).toMatchObject({ limit: 20, count: 21 });
  expect(check(`${long}.`)[0]).toMatchObject({ limit: 25, count: 21 });
  expect(check(`---\nname: x\n---\n\`\`\`\n${long}\n\`\`\`\n| ${long} |`)).toEqual([]);
});

test("every sentence of every file of the setup skill is within its STE limit", () => {
  expect(MD).toEqual(expect.arrayContaining(["SKILL.md", "install.md", "fixes.md", "facts.md"]));
  for (const f of MD) {
    const found = check(readFileSync(join(DIR, f), "utf8"));
    expect(found.length).toBeGreaterThan(2);
    const over = found
      .filter((s) => s.count > s.limit)
      .map((s) => `${f}:${s.line}: ${s.count}/${s.limit} ${s.sentence}`);
    expect(over).toEqual([]);
  }
});

test("SKILL.md is short, its description fits, and the files and steps it names exist", () => {
  const text = readFileSync(SKILL, "utf8");
  expect(text.split("\n").length).toBeLessThan(150);
  const description = text.match(/^description: (.*)$/m)?.[1] ?? "";
  expect(description.length).toBeGreaterThan(100);
  expect(description.length).toBeLessThanOrEqual(1024);
  for (const f of new Set(text.match(/\b[\w-]+\.(?:md|json)\b/g)))
    if (f !== "settings.json") expect(existsSync(join(DIR, f))).toBe(true);
  for (const f of MD) {
    const body = readFileSync(join(DIR, f), "utf8");
    for (const [, step, arg] of body.matchAll(/\bsetup(?: |\.ts )([a-z]+)(?: ([a-z]+))?/g)) {
      expect(STEPS).toContain(step!);
      if (step === "confirm") expect(CONFIRM).toContain(arg!);
    }
  }
});

test("setup.ts reads claude auth status and claude mcp get", () => {
  const paid = "Login: ok\nProfile: credentials-file · user_oauth · profile credits\nOrganization: Acme Labs · 1f2e\n";
  expect(parseAuth(paid)).toEqual({ profile: "credits", org: "Acme Labs", loginMethod: undefined });
  expect(parseAuth("Login method: Claude Max account\nOrganization: Me · 9\n")).toMatchObject({
    profile: undefined,
    loginMethod: "Claude Max account",
  });
  const get =
    "spinecord:\n  Scope: Local config (private to you in this project)\n  Status: ✓ Connected\n  Command: bun\n  Args: /h/spinecord/apps/local/main.ts --twin /h/x.json\n";
  expect(parseMcpGet(get)).toEqual({
    scope: "local",
    command: "bun",
    args: "/h/spinecord/apps/local/main.ts --twin /h/x.json",
  });
  expect(parseMcpGet("No MCP server found with name: spinecord")).toEqual({
    scope: undefined,
    command: undefined,
    args: undefined,
  });
});

test("setup.ts takes the organization from ant when Claude Code names none", () => {
  // Claude Code 2.1.332 with a profile: one Profile line, no Organization line
  expect(parseAuth("Profile: credentials-file · user_oauth · profile credits\n")).toEqual({
    profile: "credits",
    org: undefined,
    loginMethod: undefined,
  });
  const id = "11111111-2222-4333-8444-555555555555";
  // ant 2.14.0 right after a login: the Credentials block names the organization
  const fresh = `Credentials\n               organization:   Acme Labs (${id})\n\nOrganization\n  (active) * Profile organization_id                        ${id}\n`;
  expect(parseAntOrg(fresh)).toEqual({ name: "Acme Labs", id });
  // after a token refresh only the id is left
  expect(parseAntOrg(`Organization\n  (active) * Profile organization_id                        ${id}\n`)).toEqual({
    name: undefined,
    id,
  });
  expect(parseAntOrg("Config dir:      /h/.config/anthropic\n")).toEqual({ name: undefined, id: undefined });
});

test("setup.ts registers bun by its full path, so a terminal without bun on PATH still starts spinecord", () => {
  const args = ["/h/spinecord/apps/local/main.ts", "--twin", "/h/x.json"];
  const reg = { scope: "local", command: "/h/.bun/bin/bun", args: args.join(" ") };
  expect(isRegistered(reg, "/h/.bun/bin/bun", args, "darwin")).toBe(true);
  // a registration with a bare `bun` is done again: Claude Code finds no bun in a new macOS terminal
  expect(isRegistered({ ...reg, command: "bun" }, "/h/.bun/bin/bun", args, "darwin")).toBe(false);
  expect(isRegistered({ ...reg, scope: "user" }, "/h/.bun/bin/bun", args, "darwin")).toBe(false);
  const win = { scope: "local", command: "C:/Users/a/.bun/bin/bun.exe", args: "C:/S/main.ts" };
  expect(isRegistered(win, "c:\\users\\a\\.bun\\bin\\bun.exe", ["c:\\s\\main.ts"], "win32")).toBe(true);
});

test("setup.ts registers absolute paths, the EV3 first, and prints a launch line per shell", () => {
  const robots = { twin: ["--twin", "d/r.json", "--world", "d/w.json", "--view"], ev3: "d/r.json" };
  expect(robotArgs(robots, null, "/r")).toEqual(["--twin", "/r/d/r.json", "--world", "/r/d/w.json", "--view"]);
  expect(robotArgs(robots, "/home/a/mi-robot/robots/r.json", "/r").slice(0, 3)).toEqual([
    "--ev3",
    "/home/a/mi-robot/robots/r.json",
    "--twin",
  ]);
  // the example twin, without a file: --view after --twin is a flag, not a path
  expect(robotArgs({ twin: ["--twin", "--view"], ev3: "d/r.json" }, null, "/r")).toEqual(["--twin", "--view"]);
  expect(launchLine("linux", "credits")).toBe("cd ~/mi-robot && ANTHROPIC_PROFILE=credits claude");
  expect(launchLine("win32", "credits")).toBe('cd $HOME\\mi-robot; $env:ANTHROPIC_PROFILE = "credits"; claude');
  const json = JSON.parse(readFileSync(join(DIR, "robots.json"), "utf8")) as typeof robots;
  for (const p of [json.ev3, ...json.twin.filter((a) => a.endsWith(".json"))])
    expect(existsSync(join(DIR, "..", "..", "..", p))).toBe(true);
});
