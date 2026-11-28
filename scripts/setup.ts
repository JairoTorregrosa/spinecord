// `bun scripts/setup.ts <step>`: the deterministic steps of the setup skill (.claude/skills/setup-spinecord), once
// git, bun, ant, Claude Code and this clone exist. Every step is idempotent: it checks first, acts only when the
// check fails, and checks again. `status` acts never and names the next step, so an agent resumes from any state.
// The robots come from the skill's robots.json; what no command can detect (the person's answers, the smoke
// test) is kept in <workshop>/.spinecord-setup.json. Each line is `ok|warn|todo|fail  <what>  <why>  ->  <next>`, the
// last line `setup <step>: ok` (exit 0) or `setup <step>: not done` (exit 1). Nothing here prints a secret.
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, isAbsolute, join, posix, win32 } from "node:path";
import { parseRobotName } from "../apps/local/src/config";
import { MOVES } from "../apps/local/src/twin-build";
import { PAYS_AHEAD, paysBeforeProfile, type Env } from "../examples/assistant/setup";

const REPO = join(import.meta.dir, "..");
const MAIN = join(REPO, "apps", "local", "main.ts");
const SKILL = join(REPO, ".claude", "skills", "setup-spinecord");
export const WORKSHOP = join(homedir(), "mi-robot");
const STATE_FILE = join(WORKSHOP, ".spinecord-setup.json");
const SETTINGS = join(WORKSHOP, ".claude", "settings.json");
const RULE = "mcp__spinecord";
/** A step's commands end within this, so that an agent's default 2-minute command limit holds. */
const STEP_MS = 100_000;
/** `ant auth login` waits this long for the browser (its own --timeout). */
const LOGIN_TIMEOUT = "5m";
const MIN_BUN = (
  JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { packageManager: string }
).packageManager.replace(/^bun@/, "");

export interface Line {
  status: Status;
  what: string;
  why: string;
  next?: string;
}
export interface Robots {
  /** The robot flags of a person without an EV3, paths from the repository root. */
  twin: string[];
  /** The robot file of an EV3, from the repository root. */
  ev3: string;
}
export interface State {
  profile: string;
  ev3?: boolean;
  /** The name the person gave the robot (`--name` of the registration); absent: no name. */
  name?: string;
  /** The organization the person confirmed pays. */
  org?: string;
  smoke?: { args: string; answer: string; cost_usd: number };
  /** The person saw the robot move in the 3D view, or on the floor. */
  moved?: boolean;
  /** The EV3 drove forward when asked to. */
  forward?: boolean;
}
/** `warn`: done, with something the person must know; the step still ends `ok`. */
export type Status = "ok" | "warn" | "todo" | "fail";

// ---- pure parts (setup-skill.test.ts) ----

/** `claude auth status --text`: the profile that pays, its organization, or the login method of another login. */
export function parseAuth(text: string): { profile?: string; org?: string; loginMethod?: string } {
  const profile = text.match(/^Profile:.*\bprofile (\S+)\s*$/m)?.[1];
  const org = text
    .match(/^Organization:\s*(.+)$/m)?.[1]
    ?.split(" · ")[0]
    ?.trim();
  const loginMethod = text.match(/^Login method:\s*(.+)$/m)?.[1]?.trim();
  return { profile, org, loginMethod };
}

/**
 * `ant --profile <p> auth status`: the organization of the profile. Its name is there after a login and is gone
 * after a token refresh, its id stays. After that refresh Claude Code 2.1.332 prints no `Organization:` line either.
 */
export function parseAntOrg(text: string): { name?: string; id?: string } {
  const m = text.match(/^\s*organization:\s*(.+?)\s*\(([0-9a-f-]{36})\)\s*$/m);
  const id = m?.[2] ?? text.match(/\borganization_id\s+([0-9a-f-]{36})\s*$/m)?.[1];
  return { name: m?.[1], id };
}

/** `claude mcp get spinecord`: its scope (lowercase), Command and Args lines, or nothing when it is not registered. */
export function parseMcpGet(text: string): { scope?: string; command?: string; args?: string } {
  return {
    scope: text.match(/^\s*Scope:\s*(\w+)/m)?.[1]?.toLowerCase(),
    command: text.match(/^\s*Command:\s*(.*)$/m)?.[1]?.trim(),
    args: text.match(/^\s*Args:\s*(.*)$/m)?.[1]?.trim(),
  };
}

/** Paths as Claude Code prints them back: on Windows the slashes and the case may differ. */
const norm = (x: string, platform: string = process.platform) =>
  platform === "win32" ? x.replaceAll("/", "\\").toLowerCase() : x;

/**
 * The registration runs this bun by its full path: the person's terminal may not have bun on PATH (the bun
 * installer writes no PATH line on a Mac without ~/.zshrc), and then Claude Code cannot start the server.
 */
export function isRegistered(
  reg: { scope?: string; command?: string; args?: string },
  bun: string,
  args: string[],
  platform: string = process.platform,
): boolean {
  const n = (s: string) => norm(s, platform);
  return reg.scope === "local" && n(reg.command ?? "") === n(bun) && n(reg.args ?? "") === n(args.join(" "));
}

/**
 * The robot flags of the registration, with every path absolute, and the person's name for the robot last.
 * `own` is the person's own robot file: once it exists it is the twin's robot, whatever robots.json names.
 */
export function robotArgs(
  robots: Robots,
  ev3File: string | null,
  repo: string = REPO,
  name?: string,
  own: string | null = null,
): string[] {
  const abs = (p: string) => (isAbsolute(p) ? p : join(repo, p));
  const out: string[] = [];
  if (ev3File !== null) out.push("--ev3", abs(ev3File));
  const pathFlags = new Set(["--twin", "--world", "--ev3", "--config"]);
  robots.twin.forEach((a, i) => {
    const prev = robots.twin[i - 1];
    const next = robots.twin[i + 1];
    if (prev !== undefined && pathFlags.has(prev) && !a.startsWith("-"))
      out.push(prev === "--twin" && own ? own : abs(a));
    else {
      out.push(a);
      if (a === "--twin" && own && (next === undefined || next.startsWith("-"))) out.push(own);
    }
  });
  if (name !== undefined) out.push("--name", name);
  return out;
}

/** The launch line of the person's terminal: Sonnet, so that one robot session does not use up the credits. */
export function launchLine(platform: string, profile: string): string {
  return platform === "win32"
    ? `cd $HOME\\mi-robot; $env:ANTHROPIC_PROFILE = "${profile}"; claude --model sonnet`
    : `cd ~/mi-robot && ANTHROPIC_PROFILE=${profile} claude --model sonnet`;
}

/**
 * The person's own robot file is the EV3's too: what nobody confirmed in it that changes how the robot moves (a
 * port, the front, a wheel size read from a photo) plans the real robot's moves until state 6 CALIBRATE of the
 * robot-twin skill. One warn line, or none.
 */
export function ev3DraftWarn(file: string, unconfirmed: readonly string[] | undefined): Line | null {
  const moves = (unconfirmed ?? []).filter((u) => (MOVES as readonly string[]).includes(u));
  if (moves.length === 0) return null;
  return {
    status: "warn",
    what: "ev3 draft",
    why: `${file} drives the real EV3 too, and nobody confirmed ${moves.join(", ")} (twin.unconfirmed): its moves are planned from guesses`,
    next: "robot-twin skill, state 6 CALIBRATE, before any other move of the real robot",
  };
}

// ---- the environment of a new terminal (pure parts, with the probe injected) ----
//
// The agent that runs setup is often a child of a host (the Claude desktop app, an Agent SDK app, Claude Code) that
// passes its own login in the environment of every command. The person's launch line runs in a new terminal, which
// has none of that. So every check of who pays runs `claude` and `ant` with the environment of a new terminal: the
// login shell of the person started from an empty environment (macOS, Linux), or the Machine, volatile and User
// environment of the registry (Windows). It does not depend on the names of the host's variables.

/**
 * What the probe gives: the environment of a new terminal, or why it could not be read, never what the shell
 * printed. `row`: the fixes.md row, when it is not "The environment of a new terminal could not be read". `warn`:
 * the login session could not be read, so a key set only there is not seen.
 */
export type Probe = { env: Env; warn?: string } | { error: string; row?: string };

export const PROBE_MS = 20_000;
/** The PATH a login shell starts from; /etc/zprofile (path_helper) and /etc/profile add the rest. */
const POSIX_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/** Values that Windows computes for every new process and that the registry does not hold. */
const WINDOWS_COMPUTED = [
  "ALLUSERSPROFILE",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "COMPUTERNAME",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "PUBLIC",
  "SystemDrive",
  "SystemRoot",
];
/**
 * Carried from this session to the launch line's environment. ANTHROPIC_CONFIG_DIR: the fixes.md row "No
 * `Profile:` line on Windows" sets it in this session and in the launch line. TMPDIR: macOS gives every login one.
 */
const CARRIED = ["ANTHROPIC_CONFIG_DIR", "TMPDIR"];
/**
 * The desktop session gives these to every terminal, not a shell profile; the browser of `ant auth login` needs
 * them on Linux. Carried from this session when a new terminal lacks them. None of them is a login.
 */
const SESSION = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
];
/** Shells that take `-l` only alone, so `-l -i -c` cannot start them. */
const NO_LOGIN_COMMAND = ["csh", "tcsh"];

/** Writes the Machine, volatile and User environment as JSON (UTF-8, no BOM) to `file`. */
const windowsScript = (file: string) =>
  [
    "$v = @{}",
    "$k = Get-Item -LiteralPath 'HKCU:\\Volatile Environment' -ErrorAction SilentlyContinue",
    "if ($k) { foreach ($n in $k.GetValueNames()) { $v[$n] = [string]$k.GetValue($n) } }",
    "$j = @{ machine = [Environment]::GetEnvironmentVariables('Machine'); volatile = $v; user = [Environment]::GetEnvironmentVariables('User') } | ConvertTo-Json -Compress",
    `[IO.File]::WriteAllText('${file.replaceAll("'", "''")}', $j)`,
  ].join("; ");

/** A variable by name, without case on Windows, where `Path` and `PATH` are one variable. */
function keyOf(env: Env, name: string, platform: string): string {
  if (platform !== "win32") return name;
  return Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
}
function setVar(env: Env, name: string, v: string, platform: string): void {
  env[keyOf(env, name, platform)] = v;
}
export function deleteVar(env: Env, name: string, platform: string): void {
  delete env[keyOf(env, name, platform)];
}

/** The output of `env -0`: NAME=value entries, each ended by a NUL. */
export function parseEnvDump(out: string): Env {
  const env: Env = {};
  for (const entry of out.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/**
 * The environment of a new Windows terminal from the registry: the values Windows computes, then Machine, the
 * volatile environment (USERPROFILE, APPDATA, LOCALAPPDATA), then User. `Path` is Machine's, then User's.
 */
export function windowsEnv(json: string, inherited: Env): Env {
  const j = JSON.parse(json) as Record<"machine" | "volatile" | "user", Record<string, string> | null>;
  const env: Env = {};
  for (const n of WINDOWS_COMPUTED) {
    const v = inherited[keyOf(inherited, n, "win32")];
    if (v) setVar(env, n, v, "win32");
  }
  for (const part of [j.machine, j.volatile, j.user])
    for (const [k, v] of Object.entries(part ?? {})) setVar(env, k, String(v), "win32");
  const path = (part: Record<string, string> | null) => (part ? (part[keyOf(part, "Path", "win32")] ?? "") : "");
  setVar(env, "Path", [path(j.machine), path(j.user)].filter(Boolean).join(win32.delimiter), "win32");
  return env;
}

/**
 * Reads the environment of a new terminal of the person. The shell writes it to a file of its own and the probe
 * reads no pipe, so a job that a shell profile leaves running cannot hold the deadline open. A failure names the
 * exit or the timeout, never what the shell printed: with `set -x`, that holds the values.
 */
export async function probeTerminal(
  platform: string,
  inherited: Env,
  run: Exec,
  user: { homedir: string; username: string; shell: string | null },
  o: { ms?: number; session?: Session } = {},
): Promise<Probe> {
  const ms = o.ms ?? PROBE_MS;
  const failed = (code: number | null) => (code === null ? `no answer in ${ms / 1000} s` : `exit ${code}`);
  if (platform !== "win32") {
    if (!user.shell) return { error: "this user has no login shell in the user database" };
    if (NO_LOGIN_COMMAND.includes(basename(user.shell)))
      return {
        error: `the login shell is ${user.shell}, which cannot run a command as a login shell`,
        row: "The login shell is csh or tcsh",
      };
  }
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "spinecord-env-"));
  } catch (e) {
    return { error: `no temporary folder in ${tmpdir()}: ${(e as NodeJS.ErrnoException).code ?? "error"}` };
  }
  const file = join(dir, "env");
  const dump = () => (existsSync(file) ? readFileSync(file, "utf8").replace(/^\uFEFF/, "") : "");
  try {
    if (platform === "win32") {
      const code = await run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", windowsScript(file)],
        inherited,
        ms,
      );
      if (code !== 0 || dump() === "")
        return {
          error: `PowerShell, reading the User and Machine environment: ${code === 0 ? "no output" : failed(code)}`,
        };
      try {
        return { env: windowsEnv(dump(), inherited) };
      } catch {
        return { error: `PowerShell wrote a file that is not valid JSON (${dump().length} characters)` };
      }
    }
    const shell = user.shell!;
    if (file.includes("'")) return { error: `the temporary folder ${dir} has a ' in its path` };
    const clean: Env = {
      HOME: user.homedir,
      USER: user.username,
      LOGNAME: user.username,
      SHELL: shell,
      TERM: "xterm-256color",
      PATH: POSIX_PATH,
    };
    const code = await run([shell, "-l", "-i", "-c", `exec /usr/bin/env -0 > '${file}'`], clean, ms);
    const env = code === 0 ? parseEnvDump(dump()) : {};
    if (Object.keys(env).length === 0)
      return {
        error: `${shell} -l -i, started with an empty environment: ${code === 0 ? "it wrote no environment" : failed(code)}; to see what it prints, the person runs \`${shell} -l -i -c true\` in a new terminal`,
      };
    // the login session gives these to every terminal too (launchctl setenv, ~/.config/environment.d)
    const session = o.session ? await o.session(PAYS_AHEAD.filter((n) => !env[n])) : { env: {} };
    return session.warn ? { env: { ...session.env, ...env }, warn: session.warn } : { env: { ...session.env, ...env } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The environment of the launch line: a new terminal's, then ANTHROPIC_PROFILE. PATH is the new terminal's, then
 * this session's, so that a tool this session installed is found before the shell profile has its PATH line.
 */
export function launchEnv(terminalEnv: Env, inherited: Env, profile: string, platform: string): Env {
  const env: Env = { ...terminalEnv };
  for (const n of CARRIED) {
    const v = inherited[keyOf(inherited, n, platform)];
    if (v) setVar(env, n, v, platform);
  }
  for (const n of SESSION) {
    const v = inherited[keyOf(inherited, n, platform)];
    if (v && !env[keyOf(env, n, platform)]) setVar(env, n, v, platform);
  }
  const delim = platform === "win32" ? win32.delimiter : posix.delimiter;
  const path = [env[keyOf(env, "PATH", platform)], inherited[keyOf(inherited, "PATH", platform)]].filter(Boolean);
  setVar(env, "PATH", path.join(delim), platform);
  setVar(env, "ANTHROPIC_PROFILE", profile, platform);
  return env;
}

/**
 * One environment.d file (systemd 262, environment.d(5)): KEY=VALUE lines; `#` and `;` lines and empty lines are
 * ignored; a backslash at the end of a line continues it; surrounding quotes are stripped; `$X`, `${X}`,
 * `${X:-default}` and `${X:+alternate}` expand from what came before, inside single quotes too; `$$` is a dollar
 * sign. Only whether a name is set matters here, so backslash escapes are kept as they are.
 */
export function parseEnvironmentD(text: string, before: Env = {}): Env {
  const env: Env = { ...before };
  for (const raw of text.replaceAll(/\\\r?\n/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!;
    const quoted = v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0];
    if (quoted) v = v.slice(1, -1);
    v = v.replaceAll(
      /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([-+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (all, n, op, alt, bare) => {
        if (all === "$$") return "$";
        const cur = env[(n ?? bare) as string] ?? "";
        return op === "-" ? cur || alt : op === "+" ? (cur ? alt : "") : cur;
      },
    );
    env[m[1]!] = v;
  }
  return env;
}

/**
 * /etc/environment as pam_env reads it: leading whitespace and `#` lines skipped, an `export ` prefix dropped, the
 * value cut at its first `#`, surrounding quotes stripped, no expansion.
 */
export function parsePamEnvironment(text: string, before: Env = {}): Env {
  const env: Env = { ...before };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimStart().replace(/^export\s+/, "");
    if (line === "" || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2]!.split("#")[0]!.trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    env[m[1]!] = v;
  }
  return env;
}

/**
 * The files that give a Linux login session its environment, in the order they apply: the *.conf files of the
 * environment.d folders, sorted together by file name, where a file of the user's folder ($XDG_CONFIG_HOME, else
 * ~/.config) masks one of the system's of the same name, and /etc wins over /run, /usr/local/lib and /usr/lib;
 * then /etc/environment, with pam_env's rules. `unreadable`: files or folders that exist and could not be read.
 */
export function readLoginSession(
  home: string,
  system = "/",
  configHome: string = join(home, ".config"),
): { env: Env; unreadable: string[] } {
  const unreadable: string[] = [];
  const read = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") unreadable.push(path);
      return null;
    }
  };
  const confs = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter((f) => f.endsWith(".conf"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") unreadable.push(dir);
      return [];
    }
  };
  let env: Env = {};
  const byName = new Map<string, string>();
  const dirs = ["usr/lib", "usr/local/lib", "run", "etc"].map((d) => join(system, d, "environment.d"));
  for (const dir of [...dirs, join(configHome, "environment.d")])
    for (const f of confs(dir)) byName.set(f, join(dir, f));
  for (const f of [...byName.keys()].sort()) {
    const text = read(byName.get(f)!);
    if (text !== null) env = parseEnvironmentD(text, env);
  }
  const etc = read(join(system, "etc", "environment"));
  if (etc !== null) env = parsePamEnvironment(etc, env);
  return { env, unreadable };
}

export const terminalFail = (p: { error: string; row?: string }): Line => ({
  status: "fail",
  what: "terminal",
  why: `the environment of a new terminal could not be read (${p.error})`,
  next: `fixes.md, row "${p.row ?? "The environment of a new terminal could not be read"}"`,
});

/**
 * The names (never the values) of the Claude and Anthropic variables this session has and a new terminal does
 * not: the agent's host passes its own login. The checks leave them out.
 */
export function hostOnly(terminalEnv: Env, inherited: Env, platform: string): string[] {
  return Object.keys(inherited)
    .filter((n) => /^(ANTHROPIC_|CLAUDE)/i.test(n) && !CARRIED.includes(n) && n !== "ANTHROPIC_PROFILE")
    .filter((n) => (inherited[n] ?? "") !== "" && !terminalEnv[keyOf(terminalEnv, n, platform)])
    .sort();
}

/**
 * Before PAYS asks Claude Code: the environment of the launch line, with an `ok` line that names the host's own
 * variables, or a `fail` line: the new terminal cannot be read, or a variable of it pays ahead of the profile.
 */
export function paysPlan(
  probe: Probe,
  inherited: Env,
  profile: string,
  platform: string,
): { env: Env; notes: Line[] } | { lines: Line[] } {
  if ("error" in probe) return { lines: [terminalFail(probe)] };
  // Windows names have no case: a User variable may be stored as Anthropic_Api_Key
  const first = paysBeforeProfile(
    platform === "win32"
      ? Object.fromEntries(Object.entries(probe.env).map(([k, v]) => [k.toUpperCase(), v]))
      : probe.env,
  );
  if (first !== null)
    return {
      lines: [
        {
          status: "fail",
          what: "pays",
          why: `${first} is set in a new terminal of the person and pays ahead of the profile`,
          next: `fixes.md, row "Another credential pays" (${first})`,
        },
      ],
    };
  const host = hostOnly(probe.env, inherited, platform);
  const shown = host.length > 5 ? `${host.slice(0, 5).join(", ")} and ${host.length - 5} more` : host.join(", ");
  const notes: Line[] = host.length
    ? [
        {
          status: "ok",
          what: "host",
          why: `this agent's host sets ${shown}; a new terminal does not, so the checks leave them out`,
        },
      ]
    : [];
  if (probe.warn) notes.push({ status: "warn", what: "session", why: probe.warn });
  return { env: launchEnv(probe.env, inherited, profile, platform), notes };
}

// ---- probes ----

const readJson = <T>(path: string): T => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`, { cause: e });
  }
};
const robots = (): Robots => readJson<Robots>(join(SKILL, "robots.json"));
const loadState = (): State => (existsSync(STATE_FILE) ? readJson<State>(STATE_FILE) : { profile: "credits" });
function saveState(s: State): void {
  mkdirSync(WORKSHOP, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(s, null, 2)}\n`);
}
/** The person's own robot file, written by the robot-twin skill. A later setup run keeps it registered. */
const ownRobot = (): string | null => (existsSync(join(WORKSHOP, "robot.json")) ? join(WORKSHOP, "robot.json") : null);
/** The EV3 robot file in the workshop folder: the person's own, or the copy `flip` makes. It wins over the clone's. */
const ev3Copy = (): string => ownRobot() ?? join(WORKSHOP, "robots", basename(robots().ev3));
const ev3File = (s: State): string | null =>
  s.ev3 ? (existsSync(ev3Copy()) ? ev3Copy() : join(REPO, robots().ev3)) : null;
const wanted = (s: State): string[] => robotArgs(robots(), ev3File(s), REPO, s.name, ownRobot());
/**
 * The smoke test drives the twin only, so its record holds the twin flags, which an EV3 change and a new name
 * leave alone.
 */
const twinKey = (): string => robotArgs(robots(), null).join(" ");

interface Ran {
  code: number | null;
  out: string;
  err: string;
}
/** One command, stopped at `ms`. `claude` and `ant` go through cmd.exe on Windows, where npm installs .cmd files. */
async function run(cmd: string[], o: { ms?: number; cwd?: string; env?: Env; inherit?: boolean } = {}): Promise<Ran> {
  const full =
    process.platform === "win32" && ["claude", "ant"].includes(cmd[0]!) ? ["cmd.exe", "/d", "/c", ...cmd] : cmd;
  if (Bun.which(full[0]!) === null) return { code: null, out: "", err: `${cmd[0]} is not on PATH` };
  const child = Bun.spawn(full, {
    cwd: o.cwd ?? WORKSHOP,
    env: (o.env ?? process.env) as Record<string, string>,
    stdin: o.inherit ? "inherit" : "ignore",
    stdout: o.inherit ? "inherit" : "pipe",
    stderr: o.inherit ? "inherit" : "pipe",
    timeout: o.ms ?? STEP_MS,
    windowsHide: true,
  });
  const [out, err, code] = await Promise.all([
    o.inherit ? "" : new Response(child.stdout as ReadableStream).text(),
    o.inherit ? "" : new Response(child.stderr as ReadableStream).text(),
    child.exited,
  ]);
  return { code: child.signalCode ? null : code, out, err };
}
/** One command with its own environment and no pipes: its exit code, or null when `ms` passed first. */
export type Exec = (cmd: string[], env: Env, ms: number) => Promise<number | null>;
/**
 * The shell runs in a process group of its own, and the whole group ends with it: a job that a shell profile
 * starts, or the command it hangs in, does not outlive the probe. On Windows the PowerShell probe reads no profile
 * (`-NoProfile`); its process tree is killed only at the deadline, since after an exit taskkill no longer finds it.
 */
export const execDetached: Exec = async (cmd, env, ms) => {
  if (Bun.which(cmd[0]!) === null) return 127;
  const win = process.platform === "win32";
  const child = Bun.spawn(cmd, {
    cwd: homedir(),
    env: env as Record<string, string>,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: !win,
    windowsHide: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((done) => (timer = setTimeout(() => done("late"), ms)));
  const end = await Promise.race([child.exited, late]);
  clearTimeout(timer);
  if (win) {
    if (end === "late")
      Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(child.pid)], { stdout: "ignore", stderr: "ignore" });
  } else
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // ESRCH: nothing of the group is left
    }
  if (end === "late") {
    child.kill("SIGKILL");
    return null;
  }
  return child.signalCode ? null : end;
};

/**
 * The values that the login session gives every terminal, for these names (no shell profile sets them). `warn`:
 * a file of the session could not be read; it names the file, never a value. It asks nothing of the person.
 */
export type Session = (names: string[]) => Promise<{ env: Env; warn?: string }>;
/** macOS: `launchctl getenv`. Linux: /etc/environment and the environment.d files, read from disk. */
const loginSession: Session = async (names) => {
  const out: Env = {};
  if (process.platform === "darwin")
    for (const n of names) {
      const r = await run(["launchctl", "getenv", n], { ms: 5000, cwd: homedir() });
      if (r.code === 0 && r.out.trim()) out[n] = r.out.trim();
    }
  else if (process.platform === "linux") {
    const home = homedir();
    const r = readLoginSession(home, "/", process.env.XDG_CONFIG_HOME || join(home, ".config"));
    for (const n of names) if (r.env[n]) out[n] = r.env[n];
    if (r.unreadable.length)
      return {
        env: out,
        warn: `${r.unreadable.join(", ")} could not be read: a key that the login session takes from there is not seen`,
      };
  }
  return { env: out };
};

let probed: Promise<Probe> | undefined;
/** The environment of a new terminal of the person, read once per run of this script. */
const terminal = (): Promise<Probe> =>
  (probed ??= probeTerminal(process.platform, process.env, execDetached, userInfo(), { session: loginSession }));

/** The environment of the launch line with this profile, or the fail line when the new terminal cannot be read. */
async function launchEnvOf(profile: string): Promise<{ env: Env } | { line: Line }> {
  const p = await terminal();
  return "error" in p ? { line: terminalFail(p) } : { env: launchEnv(p.env, process.env, profile, process.platform) };
}
/** The same environment for `ant`, which takes the profile as `--profile` and must not see a key or a token. */
async function antEnvOf(profile: string): Promise<{ env: Env } | { line: Line }> {
  const r = await launchEnvOf(profile);
  if ("line" in r) return r;
  for (const n of ["ANTHROPIC_PROFILE", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])
    deleteVar(r.env, n, process.platform);
  return r;
}
const cwd = () => (existsSync(WORKSHOP) ? WORKSHOP : REPO);

async function version(cmd: string): Promise<string | null> {
  const r = await run([cmd, "--version"], { ms: 20_000, cwd: cwd() });
  return r.code === 0 ? (r.out.match(/\d+\.\d+\.\d+/)?.[0] ?? null) : null;
}

// ---- the checks ----

async function checkTools(): Promise<Line[]> {
  const out: Line[] = [];
  const bunOk = Bun.semver.order(Bun.version, MIN_BUN) >= 0;
  out.push(
    bunOk
      ? { status: "ok", what: "bun", why: Bun.version }
      : { status: "fail", what: "bun", why: `${Bun.version} is older than ${MIN_BUN}`, next: "bun upgrade" },
  );
  for (const cmd of ["git", "ant", "claude"]) {
    const v = await version(cmd);
    out.push(
      v
        ? { status: "ok", what: cmd, why: v }
        : { status: "fail", what: cmd, why: "not found", next: "install it (install.md of the skill)" },
    );
  }
  return out;
}

/** `ant models list` answers only with a login: `ant auth status` exits 0 without one. */
async function checkLogin(s: State): Promise<Line> {
  const e = await antEnvOf(s.profile);
  if ("line" in e) return e.line;
  const r = await run(["ant", "--profile", s.profile, "models", "list", "--limit", "1"], {
    ms: 30_000,
    cwd: cwd(),
    env: e.env,
  });
  return r.code === 0
    ? { status: "ok", what: "login", why: `the ant profile ${s.profile} is logged in` }
    : {
        status: "todo",
        what: "login",
        why: `the ant profile ${s.profile} has no login`,
        next: "bun scripts/setup.ts login",
      };
}

/**
 * PAYS, its states, from `paysPlan` and then `claude auth status` with the launch line's environment:
 * - TERMINAL UNREADABLE: the new terminal's environment could not be read -> `fail terminal`.
 * - PAID AHEAD: a variable of the new terminal or its login session pays ahead of the profile -> `fail pays`, row
 *   "Another credential pays".
 * - NOT THE PROFILE: Claude Code does not name the profile -> `fail pays`, row "Login method with the profile set".
 * - NO ORGANIZATION: the profile pays, and neither Claude Code nor ant names its organization -> `fail pays`.
 * - UNCONFIRMED: an organization, and the person has not confirmed it (State.org) -> `todo pays`; `confirm org`
 *   records it and goes to CONFIRMED. A new profile (`login --profile`) clears it and goes back here.
 * - CONFIRMED: State.org is the organization that pays -> `ok pays`.
 * The notes `ok host` and `warn session` come with every state after PAID AHEAD. They ask nothing, and they never
 * open or close a state.
 */
async function checkPays(s: State): Promise<Line[]> {
  const plan = paysPlan(await terminal(), process.env, s.profile, process.platform);
  if ("lines" in plan) return plan.lines;
  const r = await run(["claude", "auth", "status", "--text"], { ms: 30_000, cwd: cwd(), env: plan.env });
  const a = parseAuth(r.out);
  const org = a.profile === s.profile ? await orgOf(s.profile, a.org) : undefined;
  if (a.profile !== s.profile || !org)
    return [
      ...plan.notes,
      {
        status: "fail",
        what: "pays",
        why:
          a.profile === s.profile
            ? `Claude Code uses the profile ${s.profile}, but neither it nor ant names its organization`
            : a.loginMethod
              ? `Claude Code does not use the profile ${s.profile}: another login pays (${a.loginMethod})`
              : `Claude Code shows no profile ${s.profile} (exit ${r.code})`,
        next: `fixes.md, row "Login method with the profile set"`,
      },
    ];
  if (s.org !== org) return [...plan.notes, paysTodo(s.profile, org)];
  return [...plan.notes, { status: "ok", what: "pays", why: `Claude Code pays with "${org}", profile ${s.profile}` }];
}

/** PAYS before the person confirmed: a name or only an id, the person compares it with the credits either way. */
export function paysTodo(profile: string, org: string): Line {
  const id = org.startsWith("id ") ? org.slice(3) : undefined;
  return {
    status: "todo",
    what: "pays",
    why: id
      ? `Claude Code pays with the organization of the profile ${profile}, id ${id}: ant shows no name`
      : `Claude Code pays with the organization "${org}"`,
    next: id
      ? `ask the person to open platform.claude.com, Settings, Organization, and compare its id with ${id}; if it is the organization with the credits: bun scripts/setup.ts confirm org; if not, or the person cannot find it: fixes.md, row "Wrong Console organization"`
      : `ask the person if "${org}" holds the credits; if yes: bun scripts/setup.ts confirm org`,
  };
}

/** The report's line on who pays: a name in quotes, an id as an id. */
export function whoPays(org: string | undefined, profile: string): string {
  const who = !org ? "not confirmed" : org.startsWith("id ") ? `with ${org}` : `"${org}"`;
  return `Who pays: Console organization ${who}, ant profile ${profile}`;
}

/** The organization that pays: Claude Code's name for it, else ant's name, else `id <uuid>`, else nothing. */
async function orgOf(profile: string, fromClaude?: string): Promise<string | undefined> {
  if (fromClaude) return fromClaude;
  const e = await antEnvOf(profile);
  if ("line" in e) return undefined;
  const r = await run(["ant", "--profile", profile, "auth", "status"], { ms: 30_000, cwd: cwd(), env: e.env });
  const o = parseAntOrg(r.out + r.err);
  return o.name ?? (o.id ? `id ${o.id}` : undefined);
}

async function registration(): Promise<{ scope?: string; command?: string; args?: string }> {
  if (!existsSync(WORKSHOP)) return {};
  const r = await run(["claude", "mcp", "get", "spinecord"], { ms: 30_000 });
  return r.code === 0 ? parseMcpGet(r.out + r.err) : {};
}

/**
 * The skills the robot's own Claude Code needs: a photo of the person's robot becomes its twin, and the setup goes on
 * later (a new name, an EV3, a fix). Claude Code loads
 * skills from the folder it starts in, and it never starts in the clone, so the workshop folder holds a copy.
 */
const PERSON_SKILLS = ["robot-twin", "setup-spinecord"] as const;
const skillFile = (root: string, name: string) => join(root, ".claude", "skills", name, "SKILL.md");
const skillCurrent = (name: string): boolean =>
  existsSync(skillFile(WORKSHOP, name)) &&
  readFileSync(skillFile(WORKSHOP, name), "utf8") === readFileSync(skillFile(REPO, name), "utf8");

async function checkWorkshop(s: State): Promise<Line[]> {
  if (s.ev3 === undefined)
    return [
      {
        status: "todo",
        what: "ev3",
        why: "not asked yet",
        next: "ask the person if a LEGO EV3 is here; then bun scripts/setup.ts workshop --ev3 yes (or no)",
      },
    ];
  const out: Line[] = [];
  const settings = existsSync(SETTINGS) ? readJson<{ permissions?: { allow?: string[] } }>(SETTINGS) : {};
  out.push(
    settings.permissions?.allow?.includes(RULE)
      ? { status: "ok", what: "settings", why: `${SETTINGS} allows ${RULE}` }
      : {
          status: "todo",
          what: "settings",
          why: `${SETTINGS} does not allow ${RULE}`,
          next: "bun scripts/setup.ts workshop",
        },
  );
  const stale = PERSON_SKILLS.filter((n) => !skillCurrent(n));
  out.push(
    stale.length === 0
      ? { status: "ok", what: "skills", why: `${PERSON_SKILLS.join(", ")} in ${join(WORKSHOP, ".claude", "skills")}` }
      : {
          status: "todo",
          what: "skills",
          why: `${stale.join(", ")} missing or older than the clone's in ${WORKSHOP}`,
          next: "bun scripts/setup.ts workshop",
        },
  );
  const reg = await registration();
  out.push(
    isRegistered(reg, process.execPath, [MAIN, ...wanted(s)])
      ? { status: "ok", what: "registration", why: `local scope in ${WORKSHOP}: ${wanted(s).join(" ")}` }
      : {
          status: "todo",
          what: "registration",
          why: reg.scope
            ? `${reg.scope} scope, with another bun, other robots or another clone`
            : `none in ${WORKSHOP}`,
          next: "bun scripts/setup.ts workshop",
        },
  );
  return out;
}

const checkSmoke = (s: State): Line =>
  s.smoke && s.smoke.args === twinKey()
    ? { status: "ok", what: "smoke", why: `${s.smoke.answer} (USD ${s.smoke.cost_usd})` }
    : {
        status: "todo",
        what: "smoke",
        why: "no request has driven these robots yet",
        next: "bun scripts/setup.ts smoke",
      };

const checkMoved = (s: State): Line =>
  s.moved
    ? { status: "ok", what: "moved", why: "the person saw the robot move" }
    : { status: "todo", what: "moved", why: "the person has not seen it move yet", next: "SKILL.md, state SEE IT" };

const checkEv3 = (s: State): Line =>
  s.ev3 === undefined
    ? { status: "todo", what: "ev3", why: "not asked yet (WORKSHOP asks)" }
    : !s.ev3
      ? { status: "ok", what: "ev3", why: "no EV3: the twin only" }
      : s.forward
        ? { status: "ok", what: "ev3", why: "online, and it drives forward" }
        : { status: "todo", what: "ev3", why: "not connected and checked yet", next: "SKILL.md, state EV3" };

// ---- the steps ----

/** A warn line is done: it says what the person must know, and asks nothing. */
const isOpen = (l: Line) => l.status !== "ok" && l.status !== "warn";
/** The first state with a line that is not done, else REPORT. */
export const nextState = (per: [string, Line[]][]): string => per.find(([, ls]) => ls.some(isOpen))?.[0] ?? "REPORT";
/**
 * One line of `setup status` for a state: fail if a line fails, else todo if one is open, else warn if one warns,
 * else ok. Its `next` is the first open line's, else the first warn line's.
 */
export function summarize(name: string, ls: Line[]): Line {
  const open = ls.find(isOpen);
  return {
    status: open
      ? ls.some((l) => l.status === "fail")
        ? "fail"
        : "todo"
      : ls.some((l) => l.status === "warn")
        ? "warn"
        : "ok",
    what: name,
    why: ls.map((l) => `${l.what}: ${l.why}`).join("; "),
    next: (open ?? ls.find((l) => l.status === "warn"))?.next,
  };
}

async function status(s: State): Promise<Line[]> {
  const per: [string, Line[]][] = [["TOOLS", await checkTools()]];
  const login = await checkLogin(s);
  per.push(["LOGIN", [login]]);
  per.push([
    "PAYS",
    login.status === "ok" ? await checkPays(s) : [{ status: "todo", what: "pays", why: "after LOGIN" }],
  ]);
  per.push(["WORKSHOP", await checkWorkshop(s)]);
  per.push(["SMOKE", [checkSmoke(s)]]);
  per.push(["SEE IT", [checkMoved(s)]]);
  per.push(["EV3", [checkEv3(s)]]);
  return [...per.map(([name, ls]) => summarize(name, ls)), { status: "ok", what: "next", why: nextState(per) }];
}

async function login(s: State): Promise<Line[]> {
  const before = await checkLogin(s);
  if (before.status === "ok") return [before];
  if (before.status === "fail") return [before];
  const e = await antEnvOf(s.profile);
  if ("line" in e) return [e.line];
  const env = e.env;
  // the browser opens on platform.claude.com; ant waits on a 127.0.0.1 port for its answer
  await run(["ant", "auth", "login", "--profile", s.profile, "--timeout", LOGIN_TIMEOUT], {
    ms: 330_000,
    cwd: cwd(),
    env,
    inherit: true,
  });
  const after = await checkLogin(s);
  return after.status === "ok"
    ? [after]
    : [{ ...after, status: "fail", next: `fixes.md, row "The login did not finish"` }];
}

/** The workshop folder's settings, skills and registration, written when they differ, then checked again. */
async function register(s: State): Promise<Line[]> {
  mkdirSync(join(WORKSHOP, ".claude"), { recursive: true });
  const settings = existsSync(SETTINGS) ? readJson<{ permissions?: { allow?: string[] } }>(SETTINGS) : {};
  const allow = settings.permissions?.allow ?? [];
  if (!allow.includes(RULE)) {
    settings.permissions = { ...settings.permissions, allow: [...allow, RULE] };
    writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  }
  for (const name of PERSON_SKILLS)
    cpSync(join(REPO, ".claude", "skills", name), join(WORKSHOP, ".claude", "skills", name), { recursive: true });
  const reg = await registration();
  const want = [MAIN, ...wanted(s)];
  if (!isRegistered(reg, process.execPath, want)) {
    if (reg.scope) {
      const r = await run(["claude", "mcp", "remove", "-s", reg.scope, "spinecord"]);
      if (r.code !== 0)
        return [{ status: "fail", what: "registration", why: `claude mcp remove: ${(r.out + r.err).trim()}` }];
    }
    const r = await run(["claude", "mcp", "add", "-s", "local", "spinecord", "--", process.execPath, ...want]);
    if (r.code !== 0)
      return [{ status: "fail", what: "registration", why: `claude mcp add: ${(r.out + r.err).trim()}` }];
  }
  const lines = await checkWorkshop(s);
  return lines.map((l) => (l.status === "ok" ? l : { ...l, status: "fail" }));
}

async function workshop(s: State): Promise<Line[]> {
  const lines = await register(s);
  if (lines.some((l) => l.status !== "ok")) return lines;
  // the doctor reads the registration of the folder it runs in
  const d = await run([process.execPath, MAIN, "--doctor", ...wanted(s)]);
  process.stdout.write(d.out);
  lines.push(
    d.code === 0
      ? { status: "ok", what: "doctor", why: "doctor: ok" }
      : {
          status: "fail",
          what: "doctor",
          why: "a doctor line above is fail",
          next: "its fix after ->, then this step again",
        },
  );
  // after the doctor: a robot file it cannot read is its `robots` fail, not a throw here
  const own = ownRobot();
  if (own !== null && ev3File(s) === own && !/^fail\s+robots\b/m.test(d.out)) {
    const warn = ev3DraftWarn(own, readJson<{ twin?: { unconfirmed?: string[] } }>(own).twin?.unconfirmed);
    if (warn) lines.push(warn);
  }
  return lines;
}

async function smoke(s: State): Promise<Line[]> {
  // no id in the prompt: only a running spinecord can name the twin, so an answer without one proves nothing
  const prompt = "List the robots. Then drive the simulated one forward 5 cm. Answer in one line that names its id.";
  const plan = paysPlan(await terminal(), process.env, s.profile, process.platform);
  if ("lines" in plan) return plan.lines;
  const r = await run(
    ["claude", "-p", prompt, "--allowedTools", RULE, "--max-budget-usd", "0.50", "--output-format", "json"],
    { env: plan.env },
  );
  let j: { result?: string; is_error?: boolean; total_cost_usd?: number };
  try {
    j = JSON.parse(r.out) as typeof j;
  } catch {
    return [
      { status: "fail", what: "smoke", why: `no JSON from claude -p (exit ${r.code}): ${r.err.trim().slice(0, 300)}` },
    ];
  }
  if (j.is_error || typeof j.result !== "string")
    return [
      { status: "fail", what: "smoke", why: `${j.result ?? "no result"}`, next: "fixes.md, the row of this text" },
    ];
  if (!/\b[\w.]+-sim\b/.test(j.result))
    return [{ status: "fail", what: "smoke", why: `no twin id in the answer: ${j.result.slice(0, 300)}` }];
  s.smoke = {
    args: twinKey(),
    answer: j.result.replaceAll(/\s+/g, " ").trim(),
    cost_usd: j.total_cost_usd ?? 0,
  };
  saveState(s);
  return [checkSmoke(s)];
}

/** Waits for the 3D view that the person's Claude Code starts, then opens it in the default browser. */
async function view(): Promise<Line[]> {
  const url = "http://127.0.0.1:8769/";
  const t0 = Date.now();
  let up = false;
  while (!up && Date.now() - t0 < STEP_MS - 5000) {
    up = await fetch(url, { signal: AbortSignal.timeout(2000) }).then(
      (r) => r.ok,
      () => false,
    );
    if (!up) await Bun.sleep(1000);
  }
  if (!up)
    return [
      {
        status: "todo",
        what: "view",
        why: `nothing answers on ${url}: the person's Claude Code has not started spinecord yet`,
        next: "check that the person ran the launch line and chose Yes at the trust question, then this step again",
      },
    ];
  const opener =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["rundll32.exe", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  const r = await run(opener, { ms: 10_000, cwd: cwd() });
  return [
    r.code === 0
      ? { status: "ok", what: "view", why: `${url} answers, and the browser opened it` }
      : {
          status: "ok",
          what: "view",
          why: `${url} answers; the browser did not open by itself`,
          next: `the person opens ${url}`,
        },
  ];
}

/** The EV3 drove backward: a copy of its robot file in the workshop folder with forward_sign turned, registered. */
async function flip(s: State): Promise<Line[]> {
  if (!s.ev3) return [{ status: "fail", what: "flip", why: "no EV3 in this setup" }];
  const copy = ev3Copy();
  if (!existsSync(copy)) {
    mkdirSync(join(WORKSHOP, "robots"), { recursive: true });
    copyFileSync(join(REPO, robots().ev3), copy);
  }
  const robot = readJson<{ profile: { drivetrain?: { forward_sign?: number } } }>(copy);
  const d = robot.profile.drivetrain;
  if (d?.forward_sign !== 1 && d?.forward_sign !== -1)
    return [{ status: "fail", what: "flip", why: `${copy}: profile.drivetrain.forward_sign is not 1 or -1` }];
  d.forward_sign = -d.forward_sign;
  writeFileSync(copy, `${JSON.stringify(robot, null, 2)}\n`);
  s.forward = undefined;
  saveState(s);
  return [{ status: "ok", what: "flip", why: `${copy}: forward_sign ${d.forward_sign}` }, ...(await workshop(s))];
}

/** What the person does after a registration change: Claude Code reads its servers only when it starts. */
export function restartLine(platform: string, profile: string): Line {
  return {
    status: "ok",
    what: "restart",
    why: "Claude Code reads the new registration when it starts again",
    next: `the person types /exit in Claude Code, then starts it again with: ${launchLine(platform, profile)}`,
  };
}

/**
 * The person named the robot, renamed it, or took its name away (`none`): the name of setup's own registration
 * changes, and nothing else. A registration this setup did not write (the robot-twin skill's) is left alone: its
 * robot file holds the name. No doctor runs: the person often asks in the robot's own Claude Code, whose spinecord
 * holds the ports the doctor checks, so its `port` lines fail until the restart.
 */
async function name(s: State, raw: string): Promise<Line[]> {
  let next: string | undefined;
  try {
    next = raw === "none" ? undefined : parseRobotName(raw, "name");
  } catch (e) {
    return [{ status: "fail", what: "name", why: (e as Error).message, next: "ask the person for another name" }];
  }
  // register() below writes the registration again with the new name, whatever was registered before
  s.name = next;
  saveState(s);
  const said: Line = { status: "ok", what: "name", why: next === undefined ? "no name" : `"${next}"` };
  if (s.ev3 === undefined) return [said, ...(await checkWorkshop(s))];
  const lines = await register(s);
  return lines.every((l) => l.status === "ok")
    ? [said, ...lines, restartLine(process.platform, s.profile)]
    : [said, ...lines];
}

async function report(s: State): Promise<string> {
  const reg = await registration();
  const registered = reg.scope
    ? `registered with ${reg.scope} scope in ${WORKSHOP}: ${reg.args ?? "?"}`
    : `not registered in ${WORKSHOP} yet`;
  const v = Object.fromEntries(
    await Promise.all(["git", "ant", "claude"].map(async (c) => [c, (await version(c)) ?? "not found"] as const)),
  );
  return [
    `Installed: git ${v.git}, bun ${Bun.version}, ant ${v.ant}, Claude Code ${v.claude}`,
    whoPays(s.org, s.profile),
    `spinecord: ${REPO}, ${registered}`,
    `Robot name: ${s.name ?? "none"}`,
    `Smoke test: ${s.smoke ? `${s.smoke.answer} (USD ${s.smoke.cost_usd})` : "not run"}`,
    `Seen moving: ${s.moved ? "yes" : "no"}`,
    `EV3: ${s.ev3 === undefined ? "not asked" : !s.ev3 ? "none" : s.forward ? "online and forward" : "not checked"}`,
    `3D view: http://127.0.0.1:8769/ while Claude Code runs`,
    `Start Claude Code with: ${launchLine(process.platform, s.profile)}`,
  ].join("\n");
}

function print(step: string, lines: Line[]): 0 | 1 {
  const w = Math.max(...lines.map((l) => l.what.length));
  for (const l of lines)
    console.log(`${l.status.padEnd(4)}  ${l.what.padEnd(w)}  ${l.why}${l.next ? `  ->  ${l.next}` : ""}`);
  const done = lines.every((l) => l.status === "ok" || l.status === "warn");
  console.log(`setup ${step}: ${done ? "ok" : "not done"}`);
  return done ? 0 : 1;
}

export const STEPS = ["status", "login", "confirm", "workshop", "name", "smoke", "view", "flip", "report"];
export const CONFIRM = ["org", "moved", "forward"];
const USAGE = `usage: bun scripts/setup.ts <step>
  status                 every state, done or not, and the next one; changes nothing
  login [--profile <p>]  log the ant profile in (the browser opens); skipped when it is logged in
  confirm org            the person said the organization that pays holds the credits
  workshop --ev3 yes|no [--name <name>]
                         ${WORKSHOP}: settings, local registration, doctor; --name: the robot's name
  name <name>|none       give the robot a name, or take it away; registers again, no doctor (restart Claude Code)
  smoke                  one claude -p request drives the twin (at most USD 0.50)
  view                   wait for the 3D view of the person's Claude Code (under ${STEP_MS / 1000} s), open it
  confirm moved          the person saw the robot move
  flip                   the EV3 drove backward: turn forward_sign in a copy of its file, register again
  confirm forward        the EV3 drove forward
  report                 the report for the person`;

export async function main(argv: string[]): Promise<number> {
  const [step, ...rest] = argv;
  const s = loadState();
  const opt = (name: string) => {
    const i = rest.indexOf(name);
    return i === -1 ? undefined : rest[i + 1];
  };
  switch (step) {
    case "status": {
      const lines = await status(s);
      print(step, lines.slice(0, -1));
      console.log(`next ${lines.at(-1)!.why}`);
      return 0;
    }
    case "login": {
      const p = opt("--profile");
      if (p !== undefined && p !== s.profile) {
        s.profile = p;
        s.org = undefined;
        saveState(s);
      }
      return print(step, await login(s));
    }
    case "workshop": {
      const e = opt("--ev3");
      if (e !== undefined && e !== "yes" && e !== "no") break;
      // without --name the name stays as it is
      const n = opt("--name");
      if (n !== undefined) {
        try {
          s.name = parseRobotName(n, "--name");
        } catch (err) {
          return print(step, [{ status: "fail", what: "name", why: (err as Error).message }]);
        }
        saveState(s);
      }
      if (e !== undefined && (e === "yes") !== s.ev3) {
        s.ev3 = e === "yes";
        saveState(s);
      }
      if (s.ev3 === undefined) return print(step, await checkWorkshop(s));
      return print(step, await workshop(s));
    }
    case "name":
      // a name of two words may come unquoted: every word after the step is the name
      if (rest.length === 0) break;
      return print(step, await name(s, rest.join(" ")));
    case "smoke":
      return print(step, await smoke(s));
    case "view":
      return print(step, await view());
    case "flip":
      return print(step, await flip(s));
    case "confirm": {
      const what = rest[0];
      if (what === "org") {
        const plan = paysPlan(await terminal(), process.env, s.profile, process.platform);
        if ("lines" in plan) return print(step, plan.lines);
        const r = await run(["claude", "auth", "status", "--text"], { ms: 30_000, cwd: cwd(), env: plan.env });
        const a = parseAuth(r.out);
        const org = a.profile === s.profile ? await orgOf(s.profile, a.org) : undefined;
        if (!org) return print(step, await checkPays(s));
        s.org = org;
      } else if (what === "moved") s.moved = true;
      else if (what === "forward") s.forward = true;
      else break;
      saveState(s);
      return print(step, [{ status: "ok", what, why: "recorded" }]);
    }
    case "report":
      console.log(await report(s));
      return 0;
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
