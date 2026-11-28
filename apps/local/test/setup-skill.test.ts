// The setup skill (.claude/skills/setup-spinecord) is written in Simplified Technical English: a sentence in a list
// item (a procedure step) has at most 20 words, any other sentence at most 25. Frontmatter, headings, tables and
// code blocks are not prose and are skipped. Inline code and a link's text count as one word each. Its SKILL.md
// stays short, every file it names exists, and every `setup <step>` it names is a step of scripts/setup.ts.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIRM,
  ev3DraftWarn,
  hostOnly,
  launchEnv,
  nextState,
  parseEnvironmentD,
  readLoginSession,
  summarize,
  type Line,
  paysPlan,
  execDetached,
  type Exec,
  probeTerminal,
  windowsEnv,
  isRegistered,
  launchLine,
  parseAntOrg,
  parseAuth,
  parseMcpGet,
  restartLine,
  paysTodo,
  robotArgs,
  STEPS,
  whoPays,
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
  // a name with a space and an accent comes back as claude mcp add got it, joined by spaces (Claude Code 2.1.332)
  const spaced = get.replace("--twin /h/x.json", "--twin /h/x.json --name Doña Tuerca");
  expect(parseMcpGet(spaced).args).toBe(
    ["/h/spinecord/apps/local/main.ts", "--twin", "/h/x.json", "--name", "Doña Tuerca"].join(" "),
  );
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

test("PAYS waits for the person with a name or only an id; the report prints an id as an id", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const named = paysTodo("credits", "Acme Labs");
  expect(named.status).toBe("todo");
  expect(named.next).toContain('ask the person if "Acme Labs" holds the credits');
  const bare = paysTodo("credits", `id ${id}`);
  expect(bare.status).toBe("todo");
  expect(bare.next).toContain("platform.claude.com");
  expect(bare.next).toContain(id);
  expect(bare.next).not.toContain("without a question");
  expect(whoPays("Acme Labs", "credits")).toBe('Who pays: Console organization "Acme Labs", ant profile credits');
  expect(whoPays(`id ${id}`, "credits")).toBe(`Who pays: Console organization with id ${id}, ant profile credits`);
  expect(whoPays(undefined, "credits")).toBe("Who pays: Console organization not confirmed, ant profile credits");
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
  // the person's own robot file, once written, is the twin of every later registration: the room and the view stay
  expect(robotArgs(robots, null, "/r", undefined, "/home/a/mi-robot/robot.json")).toEqual([
    "--twin",
    "/home/a/mi-robot/robot.json",
    "--world",
    "/r/d/w.json",
    "--view",
  ]);
  expect(robotArgs({ twin: ["--twin", "--view"], ev3: "d/r.json" }, null, "/r", undefined, "/o.json")).toEqual([
    "--twin",
    "/o.json",
    "--view",
  ]);
  // the person's name for the robot comes last, as one argument: a second run gives the same registration, and a
  // new name changes only its value
  const named = robotArgs(robots, "/m/r.json", "/r", "Doña Tuerca");
  expect(named.slice(-2)).toEqual(["--name", "Doña Tuerca"]);
  expect(robotArgs(robots, "/m/r.json", "/r", "Doña Tuerca")).toEqual(named);
  expect(robotArgs(robots, "/m/r.json", "/r", "Rayo")).toEqual([...named.slice(0, -1), "Rayo"]);
  expect(robotArgs(robots, "/m/r.json", "/r")).toEqual(named.slice(0, -2));
  expect(launchLine("linux", "credits")).toBe("cd ~/mi-robot && ANTHROPIC_PROFILE=credits claude --model sonnet");
  expect(launchLine("win32", "credits")).toBe(
    'cd $HOME\\mi-robot; $env:ANTHROPIC_PROFILE = "credits"; claude --model sonnet',
  );
  const json = JSON.parse(readFileSync(join(DIR, "robots.json"), "utf8")) as typeof robots;
  for (const p of [json.ev3, ...json.twin.filter((a) => a.endsWith(".json"))])
    expect(existsSync(join(DIR, "..", "..", "..", p))).toBe(true);
});

test("setup.ts name ends with the restart the person must do, and runs no doctor", () => {
  // the robot's own Claude Code holds the ports a doctor checks, so a doctor in `name` could never end ok there
  expect(restartLine("linux", "credits")).toEqual({
    status: "ok",
    what: "restart",
    why: "Claude Code reads the new registration when it starts again",
    next: "the person types /exit in Claude Code, then starts it again with: cd ~/mi-robot && ANTHROPIC_PROFILE=credits claude --model sonnet",
  });
  expect(restartLine("win32", "p").next).toEndWith(launchLine("win32", "p"));
  const src = readFileSync(join(DIR, "..", "..", "..", "scripts", "setup.ts"), "utf8");
  const nameStep = src.slice(src.indexOf("async function name("), src.indexOf("async function report("));
  expect(nameStep).toContain("register(s)");
  // the step function that runs the doctor, by what it runs
  const fns = [...src.matchAll(/^async function (\w+)\(/gm)].map((m) => ({ name: m[1]!, at: m.index }));
  const doctorAt = src.indexOf('"--doctor"');
  const runsDoctor = fns.filter((f) => f.at < doctorAt).at(-1)!.name;
  expect(nameStep).not.toContain(`${runsDoctor}(`);
});

test("setup.ts warns when the person's robot file drives the EV3 with guesses that change how it moves", () => {
  const file = "/home/a/mi-robot/robot.json";
  expect(ev3DraftWarn(file, undefined)).toBeNull();
  expect(ev3DraftWarn(file, [])).toBeNull();
  // the footprint and where the sensors sit change only the twin
  expect(ev3DraftWarn(file, ["footprint", "places"])).toBeNull();
  const w = ev3DraftWarn(file, ["footprint", "wheel_diameter", "S4"])!;
  expect(w.status).toBe("warn");
  expect(w.why).toBe(
    `${file} drives the real EV3 too, and nobody confirmed wheel_diameter, S4 (twin.unconfirmed): its moves are planned from guesses`,
  );
  expect(w.next).toContain("CALIBRATE");
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

// ---- the environment of a new terminal: the checks of who pays never use the agent host's login ----

const NEW_TERMINAL: Record<string, string> = {
  HOME: "/home/p",
  USER: "p",
  SHELL: "/bin/zsh",
  PATH: "/opt/homebrew/bin:/usr/bin:/bin",
};
/** What a host such as the Claude desktop app passes to the commands of its agent. */
const HOST: Record<string, string> = {
  ...NEW_TERMINAL,
  PATH: "/host/bin:/usr/bin",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
  CLAUDE_CODE_OAUTH_TOKEN: "host-token-value",
  CLAUDE_CODE_SESSION_ACCESS_TOKEN: "host-session-value",
  ANTHROPIC_BASE_URL: "https://host.invalid",
};
const dump = (env: Record<string, string>) =>
  `${Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\0")}\0`;
const user = { homedir: "/home/p", username: "p", shell: "/bin/zsh" };
/** The file that the probe's command writes its environment to. */
const outFile = (cmd: string[]) => cmd.at(-1)!.match(/'([^']*spinecord-env-[^']*)'/)![1]!;
/** A probe command that writes `text` to its file and exits with `code`. */
const writes =
  (text: string, code: number | null = 0): Exec =>
  async (cmd) => {
    writeFileSync(outFile(cmd), text);
    return code;
  };

test("the probe starts the login shell with an empty environment, not the agent's, and reads its file", async () => {
  const calls: { cmd: string[]; env: Record<string, string | undefined> }[] = [];
  const p = await probeTerminal(
    "darwin",
    HOST,
    async (cmd, env, ms) => {
      calls.push({ cmd, env });
      return writes(dump({ ...NEW_TERMINAL, X: "a=b" }))(cmd, env, ms);
    },
    user,
  );
  expect(calls[0]!.cmd.slice(0, 4)).toEqual(["/bin/zsh", "-l", "-i", "-c"]);
  expect(Object.keys(calls[0]!.env).sort()).toEqual(["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]);
  expect(p).toEqual({ env: { ...NEW_TERMINAL, X: "a=b" } });
  // the file is gone after the read
  expect(existsSync(outFile(calls[0]!.cmd))).toBe(false);
});

test("(a) a host login in the agent's environment does not reach PAYS: the checks use a new terminal's", () => {
  const plan = paysPlan({ env: NEW_TERMINAL }, HOST, "credits", "darwin");
  if (!("env" in plan)) throw new Error(`no env: ${JSON.stringify(plan)}`);
  for (const n of ["CLAUDECODE", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "ANTHROPIC_BASE_URL"])
    expect(plan.env[n]).toBeUndefined();
  expect(plan.env.ANTHROPIC_PROFILE).toBe("credits");
  expect(plan.env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin:/host/bin:/usr/bin");
  expect(plan.notes.map((l) => l.status)).toEqual(["ok"]);
  expect(plan.notes[0]!.why).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  expect(plan.notes[0]!.why).not.toContain("host-token-value");
  // nothing from the host: no note
  const same = paysPlan({ env: NEW_TERMINAL }, NEW_TERMINAL, "credits", "darwin");
  expect("env" in same && same.notes).toEqual([]);
});

test("the desktop session's variables reach the launch environment; a new terminal's own value wins", () => {
  const session = { ...HOST, DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:x" };
  const env = launchEnv({ ...NEW_TERMINAL, DISPLAY: ":1" }, session, "credits", "linux");
  expect([env.DISPLAY, env.XDG_RUNTIME_DIR, env.DBUS_SESSION_BUS_ADDRESS]).toEqual([":1", "/run/user/1000", "unix:x"]);
});

test("(b) a key that a new terminal has pays ahead of the profile: a fail that names it, never its value", () => {
  const plan = paysPlan({ env: { ...NEW_TERMINAL, ANTHROPIC_API_KEY: "sk-secret" } }, HOST, "credits", "darwin");
  expect("lines" in plan).toBe(true);
  const [line] = "lines" in plan ? plan.lines : [];
  expect(line!.status).toBe("fail");
  expect(line!.why).toContain("ANTHROPIC_API_KEY is set in a new terminal");
  expect(line!.next).toContain(`row "Another credential pays"`);
  expect(JSON.stringify(plan)).not.toContain("sk-secret");
});

test("(c) a new terminal that cannot be read is a fail with its reason, never the agent's environment", async () => {
  const timeout = await probeTerminal("linux", HOST, async () => null, user);
  const empty = await probeTerminal("linux", HOST, writes(""), user);
  const exit = await probeTerminal("linux", HOST, writes(dump(NEW_TERMINAL), 1), user);
  const noShell = await probeTerminal("linux", HOST, async () => 0, { ...user, shell: null });
  const ps = await probeTerminal("win32", HOST, async () => 1, user);
  for (const p of [timeout, empty, exit, noShell, ps]) {
    expect("error" in p).toBe(true);
    const plan = paysPlan(p, HOST, "credits", "linux");
    expect("lines" in plan && plan.lines.map((l) => [l.status, l.what])).toEqual([["fail", "terminal"]]);
    expect("lines" in plan && plan.lines[0]!.next).toContain(
      `row "The environment of a new terminal could not be read"`,
    );
  }
  expect("error" in timeout && timeout.error).toContain("no answer in 20 s");
  expect("error" in exit && exit.error).toContain(
    "exit 1; to see what it prints, the person runs `/bin/zsh -l -i -c true`",
  );
  expect("error" in ps && ps.error).toContain("exit 1");
  // csh and tcsh take -l only alone: their own row, and no command runs
  let ran = false;
  const csh = await probeTerminal("linux", HOST, async () => ((ran = true), 0), { ...user, shell: "/bin/tcsh" });
  expect(ran).toBe(false);
  expect(paysPlan(csh, HOST, "credits", "linux")).toMatchObject({
    lines: [{ status: "fail", what: "terminal", next: `fixes.md, row "The login shell is csh or tcsh"` }],
  });
});

const posixOnly = process.platform === "win32" ? test.skip : test;
/** The process ended within 2 s. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(50);
  }
  return false;
}
const pids = (file: string) => readFileSync(file, "utf8").trim().split(/\s+/).map(Number);

posixOnly("the deadline holds, and no job that a shell profile starts outlives the probe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spinecord-shell-"));
  try {
    // a shell whose profile starts a background job, then runs the command: $4 after -l -i -c
    const bg = join(dir, "bg-sh");
    writeFileSync(bg, `#!/bin/sh\nsleep 30 &\necho $! > '${join(dir, "bg.pid")}'\nexec /bin/sh -c "$4"\n`, {
      mode: 0o755,
    });
    let t0 = Date.now();
    const ok = await probeTerminal("linux", {}, execDetached, { ...user, shell: bg }, { ms: 3000 });
    expect("env" in ok && ok.env.HOME).toBe("/home/p");
    expect(Date.now() - t0).toBeLessThan(2500);
    for (const pid of pids(join(dir, "bg.pid"))) expect(await gone(pid)).toBe(true);
    // a shell that hangs in its profile: a fail at the deadline, and its jobs end with it
    const hang = join(dir, "hang-sh");
    writeFileSync(hang, `#!/bin/sh\nsleep 30 &\nsleep 31 &\necho $(jobs -p) > '${join(dir, "hang.pid")}'\nwait\n`, {
      mode: 0o755,
    });
    t0 = Date.now();
    const late = await probeTerminal("linux", {}, execDetached, { ...user, shell: hang }, { ms: 500 });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect("error" in late && late.error).toContain("no answer in 0.5 s");
    const hung = pids(join(dir, "hang.pid"));
    expect(hung.length).toBe(2);
    for (const pid of hung) expect(await gone(pid)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

posixOnly("a temporary folder that cannot be made is a fail line, not a crash", async () => {
  const before = process.env.TMPDIR;
  process.env.TMPDIR = join(import.meta.dir, "setup-skill.test.ts", "no");
  try {
    const p = await probeTerminal("linux", {}, writes(""), user);
    expect("error" in p && p.error).toContain("no temporary folder in");
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
});

test("a key that only the login session gives (launchctl setenv, environment.d) is a new terminal's", async () => {
  const asked: string[][] = [];
  const p = await probeTerminal("darwin", HOST, writes(dump(NEW_TERMINAL)), user, {
    session: async (names) => (asked.push(names), { env: { ANTHROPIC_API_KEY: "sk-session" } }),
  });
  expect(asked[0]).toContain("ANTHROPIC_API_KEY");
  expect(asked[0]).toContain("CLAUDE_CODE_USE_BEDROCK");
  expect(paysPlan(p, HOST, "credits", "darwin")).toMatchObject({
    lines: [{ status: "fail", what: "pays", why: expect.stringContaining("ANTHROPIC_API_KEY") }],
  });
  // the shell's own value wins over the session's
  const shell = await probeTerminal("darwin", HOST, writes(dump({ ...NEW_TERMINAL, X: "1" })), user, {
    session: async () => ({ env: { X: "session" } }),
  });
  expect("env" in shell && shell.env.X).toBe("1");
});

test("environment.d files: comments, quotes, continuations and expansions, as systemd reads them", () => {
  const env = parseEnvironmentD(
    [
      "# a comment",
      "; another",
      "",
      "A = 1",
      'B="two words"',
      "C='$A'",
      "D=${A}-$A",
      "E=${NOPE:-fallback}",
      "F=${A:+alt}",
      "G=${NOPE:+alt}",
      "H=$$A",
      "I=x # not a comment",
      "J=one\\",
      "two",
      "not a line",
    ].join("\n"),
  );
  expect(env).toEqual({
    A: "1",
    B: "two words",
    C: "$A",
    D: "1-1",
    E: "fallback",
    F: "alt",
    G: "",
    H: "$A",
    I: "x # not a comment",
    J: "onetwo",
  });
});

posixOnly("the login session: /etc/environment, the system's environment.d by name, then the user's", () => {
  const root = mkdtempSync(join(tmpdir(), "spinecord-session-"));
  try {
    const put = (path: string, text: string) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    put("etc/environment", "ANTHROPIC_AUTH_TOKEN=from-pam\n");
    put("usr/lib/environment.d/10-a.conf", "X=lib\n");
    put("etc/environment.d/10-a.conf", "X=etc\n");
    put("usr/lib/environment.d/20-b.conf", "Y=$X\n");
    put("home/.config/environment.d/50-key.conf", "ANTHROPIC_API_KEY=sk-user\nnot-a-conf=1\n");
    put("home/.config/environment.d/notes.txt", "CLAUDE_CODE_OAUTH_TOKEN=ignored\n");
    const r = readLoginSession(join(root, "home"), root);
    expect(r).toEqual({
      env: { ANTHROPIC_AUTH_TOKEN: "from-pam", X: "etc", Y: "etc", ANTHROPIC_API_KEY: "sk-user" },
      unreadable: [],
    });
    // a key there is a new terminal's: the named fail, never the value
    const plan = paysPlan({ env: { ...NEW_TERMINAL, ...r.env } }, HOST, "credits", "linux");
    expect(plan).toMatchObject({
      lines: [{ status: "fail", what: "pays", next: expect.stringContaining("Another credential pays") }],
    });
    expect(JSON.stringify(plan)).not.toContain("sk-user");
    // a folder that exists and cannot be read is named; a missing one is not
    expect(readLoginSession(join(root, "nobody"), root).unreadable).toEqual([]);
    put("odd/.config/environment.d", "a file, not a folder");
    expect(readLoginSession(join(root, "odd"), root).unreadable).toEqual([
      join(root, "odd", ".config", "environment.d"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session file that cannot be read is an informational warn: no question, PAYS goes on", async () => {
  const p = await probeTerminal("linux", HOST, writes(dump(NEW_TERMINAL)), user, {
    session: async () => ({ env: {}, warn: "/etc/environment could not be read: ..." }),
  });
  const plan = paysPlan(p, NEW_TERMINAL, "credits", "linux");
  if (!("env" in plan)) throw new Error(`no env: ${JSON.stringify(plan)}`);
  expect(plan.notes).toEqual([{ status: "warn", what: "session", why: "/etc/environment could not be read: ..." }]);
});

test("status combines a state's lines: fail, then todo, then warn, then ok; a warn never holds next", () => {
  const ok: Line = { status: "ok", what: "host", why: "h" };
  const warn: Line = { status: "warn", what: "session", why: "s" };
  const todo: Line = { status: "todo", what: "pays", why: "p", next: "ask the person" };
  const fail: Line = { status: "fail", what: "pays", why: "f", next: "fixes.md" };
  expect(summarize("PAYS", [ok, warn])).toMatchObject({ status: "warn", next: undefined });
  expect(summarize("PAYS", [warn, todo])).toMatchObject({ status: "todo", next: "ask the person" });
  expect(summarize("PAYS", [warn, fail])).toMatchObject({ status: "fail", next: "fixes.md" });
  expect(summarize("PAYS", [ok])).toMatchObject({ status: "ok", why: "host: h" });
  expect(
    nextState([
      ["PAYS", [ok, warn]],
      ["NEXT", [todo]],
    ]),
  ).toBe("NEXT");
  expect(
    nextState([
      ["PAYS", [warn, todo]],
      ["NEXT", [todo]],
    ]),
  ).toBe("PAYS");
  expect(nextState([["PAYS", [warn]]])).toBe("REPORT");
});

test("a new Windows terminal: computed values, then Machine, volatile, User; Path is Machine's then User's", () => {
  const json = JSON.stringify({
    machine: { Path: "C:\\Windows", ComSpec: "C:\\Windows\\cmd.exe", TEMP: "C:\\Windows\\Temp" },
    volatile: { APPDATA: "C:\\Users\\p\\AppData\\Roaming", USERPROFILE: "C:\\Users\\p" },
    user: { Path: "C:\\Users\\p\\.bun\\bin", TEMP: "C:\\Users\\p\\Temp" },
  });
  const inherited = { SystemRoot: "C:\\Windows", PATH: "C:\\host", CLAUDE_CODE_OAUTH_TOKEN: "t" };
  const env = windowsEnv(json, inherited);
  expect(env).toEqual({
    SystemRoot: "C:\\Windows",
    Path: "C:\\Windows;C:\\Users\\p\\.bun\\bin",
    ComSpec: "C:\\Windows\\cmd.exe",
    TEMP: "C:\\Users\\p\\Temp",
    APPDATA: "C:\\Users\\p\\AppData\\Roaming",
    USERPROFILE: "C:\\Users\\p",
  });
  const launch = launchEnv(env, inherited, "credits", "win32");
  // one Path, without case
  expect(Object.keys(launch).filter((k) => k.toLowerCase() === "path")).toEqual(["Path"]);
  expect(launch.Path).toBe("C:\\Windows;C:\\Users\\p\\.bun\\bin;C:\\host");
  expect(launch.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(hostOnly(env, inherited, "win32")).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
});

test("the Windows probe reads the JSON that PowerShell writes, with or without a BOM", async () => {
  const json = JSON.stringify({ machine: { Path: "C:\\W" }, volatile: null, user: { ANTHROPIC_API_KEY: "k" } });
  const p = await probeTerminal("win32", { SystemRoot: "C:\\W" }, writes(`\uFEFF${json}`), user);
  expect(p).toEqual({ env: { SystemRoot: "C:\\W", Path: "C:\\W", ANTHROPIC_API_KEY: "k" } });
  // the key at User level is a new terminal's: a named fail
  expect(paysPlan(p, {}, "credits", "win32")).toMatchObject({ lines: [{ status: "fail", what: "pays" }] });
  // Windows names have no case
  expect(paysPlan({ env: { Anthropic_Api_Key: "k" } }, {}, "credits", "win32")).toMatchObject({
    lines: [{ status: "fail", what: "pays", why: expect.stringContaining("ANTHROPIC_API_KEY") }],
  });
});
