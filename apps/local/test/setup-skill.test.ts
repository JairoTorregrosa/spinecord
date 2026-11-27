// The setup skill (.claude/skills/setup-spinecord) is written in Simplified Technical English: a sentence in a list
// item (a procedure step) has at most 20 words, any other sentence at most 25. Frontmatter, headings, tables and
// code blocks are not prose and are skipped. Inline code and a link's text count as one word each. Its SKILL.md
// stays short, every file it names exists, and every `setup <step>` it names is a step of scripts/setup.ts.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIRM, launchLine, parseAuth, parseMcpGet, robotArgs, STEPS } from "../../../scripts/setup";

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
  expect(parseMcpGet(get)).toEqual({ scope: "local", args: "/h/spinecord/apps/local/main.ts --twin /h/x.json" });
  expect(parseMcpGet("No MCP server found with name: spinecord")).toEqual({ scope: undefined, args: undefined });
  // a name with a space and an accent comes back as claude mcp add got it, joined by spaces (Claude Code 2.1.332)
  const spaced = get.replace("--twin /h/x.json", "--twin /h/x.json --name Doña Tuerca");
  expect(parseMcpGet(spaced).args).toBe(
    ["/h/spinecord/apps/local/main.ts", "--twin", "/h/x.json", "--name", "Doña Tuerca"].join(" "),
  );
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
  // the person's name for the robot comes last, as one argument: a second run gives the same registration, and a
  // new name changes only its value
  const named = robotArgs(robots, "/m/r.json", "/r", "Doña Tuerca");
  expect(named.slice(-2)).toEqual(["--name", "Doña Tuerca"]);
  expect(robotArgs(robots, "/m/r.json", "/r", "Doña Tuerca")).toEqual(named);
  expect(robotArgs(robots, "/m/r.json", "/r", "Rayo")).toEqual([...named.slice(0, -1), "Rayo"]);
  expect(robotArgs(robots, "/m/r.json", "/r")).toEqual(named.slice(0, -2));
  expect(launchLine("linux", "credits")).toBe("cd ~/mi-robot && ANTHROPIC_PROFILE=credits claude");
  expect(launchLine("win32", "credits")).toBe('cd $HOME\\mi-robot; $env:ANTHROPIC_PROFILE = "credits"; claude');
  const json = JSON.parse(readFileSync(join(DIR, "robots.json"), "utf8")) as typeof robots;
  for (const p of [json.ev3, ...json.twin.filter((a) => a.endsWith(".json"))])
    expect(existsSync(join(DIR, "..", "..", "..", p))).toBe(true);
});

test("setup.ts keeps the robot's name across runs, and a new name changes only the name", () => {
  const home = mkdtempSync(join(tmpdir(), "spinecord-setup-home-"));
  try {
    // nothing on PATH (bun is started by its path): no claude, so nothing is registered, only the state is written
    const setup = (...args: string[]) =>
      Bun.spawnSync([process.execPath, join(DIR, "..", "..", "..", "scripts", "setup.ts"), ...args], {
        env: { HOME: home, USERPROFILE: home, PATH: join(home, "no-tools") },
        stdout: "pipe",
        stderr: "pipe",
      });
    const state = () => JSON.parse(readFileSync(join(home, "mi-robot", ".spinecord-setup.json"), "utf8"));
    expect(setup("name", "Doña", "Tuerca").stdout.toString()).toContain('ok    name  "Doña Tuerca"');
    expect(state().name).toBe("Doña Tuerca");
    // another step that writes the state keeps the name; the same name again changes nothing
    setup("confirm", "moved");
    const before = state();
    expect(before).toEqual({ profile: "credits", name: "Doña Tuerca", moved: true });
    setup("name", "Doña Tuerca");
    expect(state()).toEqual(before);
    setup("name", "Rayo");
    expect(state()).toEqual({ ...before, name: "Rayo" });
    const bad = setup("name", "Rayo\nX");
    expect(bad.exitCode).toBe(1);
    expect(bad.stdout.toString()).toContain('name holds "\\n"');
    expect(state().name).toBe("Rayo");
    setup("name", "none");
    expect(state().name).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  // seven processes that each load the server's config code: slow on a busy computer
}, 30_000);
