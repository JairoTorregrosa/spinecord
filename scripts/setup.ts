// `bun scripts/setup.ts <step>`: the deterministic steps of the setup skill (.claude/skills/setup-spinecord), once
// git, bun, ant, Claude Code and this clone exist. Every step is idempotent: it checks first, acts only when the
// check fails, and checks again. `status` acts never and names the next step, so an agent resumes from any state.
// The robots come from the skill's robots.json; what no command can detect (the person's answers, the smoke
// test) is kept in <workshop>/.spinecord-setup.json. Each line is `ok|todo|fail  <what>  <why>  ->  <next>`, the
// last line `setup <step>: ok` (exit 0) or `setup <step>: not done` (exit 1). Nothing here prints a secret.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { paysBeforeProfile, type Env } from "../examples/assistant/setup";

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

export interface Robots {
  /** The robot flags of a person without an EV3, paths from the repository root. */
  twin: string[];
  /** The robot file of an EV3, from the repository root. */
  ev3: string;
}
export interface State {
  profile: string;
  ev3?: boolean;
  /** The organization the person confirmed pays. */
  org?: string;
  smoke?: { args: string; answer: string; cost_usd: number };
  /** The person saw the robot move in the 3D view, or on the floor. */
  moved?: boolean;
  /** The EV3 drove forward when asked to. */
  forward?: boolean;
}
type Status = "ok" | "todo" | "fail";
interface Line {
  status: Status;
  what: string;
  why: string;
  next?: string;
}

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

/** `claude mcp get spinecord`: its scope (lowercase) and its Args line, or nothing when it is not registered. */
export function parseMcpGet(text: string): { scope?: string; args?: string } {
  return {
    scope: text.match(/^\s*Scope:\s*(\w+)/m)?.[1]?.toLowerCase(),
    args: text.match(/^\s*Args:\s*(.*)$/m)?.[1]?.trim(),
  };
}

/** The robot flags of the registration, with every path absolute. */
export function robotArgs(robots: Robots, ev3File: string | null, repo: string = REPO): string[] {
  const abs = (p: string) => (isAbsolute(p) ? p : join(repo, p));
  const out: string[] = [];
  if (ev3File !== null) out.push("--ev3", abs(ev3File));
  const pathFlags = new Set(["--twin", "--world", "--ev3", "--config"]);
  robots.twin.forEach((a, i) => out.push(i > 0 && pathFlags.has(robots.twin[i - 1]!) ? abs(a) : a));
  return out;
}

/** The launch line of the person's terminal. */
export function launchLine(platform: string, profile: string): string {
  return platform === "win32"
    ? `cd $HOME\\mi-robot; $env:ANTHROPIC_PROFILE = "${profile}"; claude`
    : `cd ~/mi-robot && ANTHROPIC_PROFILE=${profile} claude`;
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
/** The EV3 robot file in the workshop folder, made by `flip`: it wins over the clone's. */
const ev3Copy = (): string => join(WORKSHOP, "robots", basename(robots().ev3));
const ev3File = (s: State): string | null =>
  s.ev3 ? (existsSync(ev3Copy()) ? ev3Copy() : join(REPO, robots().ev3)) : null;
const wanted = (s: State): string[] => robotArgs(robots(), ev3File(s));
const norm = (s: string) => (process.platform === "win32" ? s.replaceAll("/", "\\").toLowerCase() : s);

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
/** The environment without the credentials that pay ahead of a profile, and with ANTHROPIC_PROFILE set. */
function profileEnv(profile: string): Env {
  const env: Env = { ...process.env, ANTHROPIC_PROFILE: profile };
  for (const n of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) delete env[n];
  return env;
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
  const env = profileEnv(s.profile);
  delete env.ANTHROPIC_PROFILE;
  const r = await run(["ant", "--profile", s.profile, "models", "list", "--limit", "1"], {
    ms: 30_000,
    cwd: cwd(),
    env,
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

async function checkPays(s: State): Promise<Line[]> {
  const first = paysBeforeProfile(process.env);
  if (first !== null)
    return [
      {
        status: "fail",
        what: "pays",
        why: `${first} is set in this terminal and pays ahead of the profile`,
        next: `fixes.md, row "Another credential pays" (${first})`,
      },
    ];
  const r = await run(["claude", "auth", "status", "--text"], { ms: 30_000, cwd: cwd(), env: profileEnv(s.profile) });
  const a = parseAuth(r.out);
  if (a.profile !== s.profile || !a.org)
    return [
      {
        status: "fail",
        what: "pays",
        why: a.loginMethod
          ? `Claude Code does not use the profile ${s.profile}: another login pays (${a.loginMethod})`
          : `Claude Code shows no profile ${s.profile} (exit ${r.code})`,
        next: `fixes.md, row "Login method with the profile set"`,
      },
    ];
  if (s.org !== a.org)
    return [
      {
        status: "todo",
        what: "pays",
        why: `Claude Code pays with the organization "${a.org}"`,
        next: `ask the person if "${a.org}" holds the credits; if yes: bun scripts/setup.ts confirm org`,
      },
    ];
  return [{ status: "ok", what: "pays", why: `Claude Code pays with "${a.org}", profile ${s.profile}` }];
}

async function registration(): Promise<{ scope?: string; args?: string }> {
  if (!existsSync(WORKSHOP)) return {};
  const r = await run(["claude", "mcp", "get", "spinecord"], { ms: 30_000 });
  return r.code === 0 ? parseMcpGet(r.out + r.err) : {};
}

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
  const reg = await registration();
  const want = [MAIN, ...wanted(s)].join(" ");
  out.push(
    reg.scope === "local" && norm(reg.args ?? "") === norm(want)
      ? { status: "ok", what: "registration", why: `local scope in ${WORKSHOP}: ${wanted(s).join(" ")}` }
      : {
          status: "todo",
          what: "registration",
          why: reg.scope ? `${reg.scope} scope, with other robots or another clone` : `none in ${WORKSHOP}`,
          next: "bun scripts/setup.ts workshop",
        },
  );
  return out;
}

const checkSmoke = (s: State): Line =>
  s.smoke && s.smoke.args === wanted(s).join(" ")
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
  const next = per.find(([, ls]) => ls.some((l) => l.status !== "ok"))?.[0] ?? "REPORT";
  const lines = per.map(([name, ls]): Line => {
    const open = ls.find((l) => l.status !== "ok");
    return {
      status: open ? (ls.some((l) => l.status === "fail") ? "fail" : "todo") : "ok",
      what: name,
      why: ls.map((l) => `${l.what}: ${l.why}`).join("; "),
      next: open?.next,
    };
  });
  return [...lines, { status: "ok", what: "next", why: next }];
}

async function login(s: State): Promise<Line[]> {
  const before = await checkLogin(s);
  if (before.status === "ok") return [before];
  const env = profileEnv(s.profile);
  delete env.ANTHROPIC_PROFILE;
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

async function workshop(s: State): Promise<Line[]> {
  mkdirSync(join(WORKSHOP, ".claude"), { recursive: true });
  const settings = existsSync(SETTINGS) ? readJson<{ permissions?: { allow?: string[] } }>(SETTINGS) : {};
  const allow = settings.permissions?.allow ?? [];
  if (!allow.includes(RULE)) {
    settings.permissions = { ...settings.permissions, allow: [...allow, RULE] };
    writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  }
  const reg = await registration();
  const want = [MAIN, ...wanted(s)];
  if (!(reg.scope === "local" && norm(reg.args ?? "") === norm(want.join(" ")))) {
    if (reg.scope) {
      const r = await run(["claude", "mcp", "remove", "-s", reg.scope, "spinecord"]);
      if (r.code !== 0)
        return [{ status: "fail", what: "registration", why: `claude mcp remove: ${(r.out + r.err).trim()}` }];
    }
    const r = await run(["claude", "mcp", "add", "-s", "local", "spinecord", "--", "bun", ...want]);
    if (r.code !== 0)
      return [{ status: "fail", what: "registration", why: `claude mcp add: ${(r.out + r.err).trim()}` }];
  }
  const lines = await checkWorkshop(s);
  if (lines.some((l) => l.status !== "ok")) return lines.map((l) => (l.status === "ok" ? l : { ...l, status: "fail" }));
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
  return lines;
}

async function smoke(s: State): Promise<Line[]> {
  const twinId = `${readJson<{ profile: { id: string } }>(join(REPO, robots().twin[1]!)).profile.id}-sim`;
  const prompt = `List the robots. Then drive ${twinId} forward 5 cm. Answer in one line.`;
  const r = await run(
    ["claude", "-p", prompt, "--allowedTools", RULE, "--max-budget-usd", "0.50", "--output-format", "json"],
    { env: profileEnv(s.profile) },
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
  s.smoke = {
    args: wanted(s).join(" "),
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
        ? ["cmd.exe", "/d", "/c", "start", '""', url]
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

async function report(s: State): Promise<string> {
  const v = Object.fromEntries(
    await Promise.all(["git", "ant", "claude"].map(async (c) => [c, (await version(c)) ?? "not found"] as const)),
  );
  return [
    `Installed: git ${v.git}, bun ${Bun.version}, ant ${v.ant}, Claude Code ${v.claude}`,
    `Who pays: Console organization "${s.org ?? "not confirmed"}", ant profile ${s.profile}`,
    `spinecord: ${REPO}, registered with local scope in ${WORKSHOP}: ${wanted(s).join(" ")}`,
    `Smoke test: ${s.smoke ? `${s.smoke.answer} (USD ${s.smoke.cost_usd})` : "not run"}`,
    `Seen moving: ${s.moved ? "yes" : "no"}`,
    `EV3: ${!s.ev3 ? "none" : s.forward ? "online and forward" : "not checked"}`,
    `3D view: http://127.0.0.1:8769/ while Claude Code runs`,
    `Start Claude Code with: ${launchLine(process.platform, s.profile)}`,
  ].join("\n");
}

function print(step: string, lines: Line[]): 0 | 1 {
  const w = Math.max(...lines.map((l) => l.what.length));
  for (const l of lines)
    console.log(`${l.status.padEnd(4)}  ${l.what.padEnd(w)}  ${l.why}${l.next ? `  ->  ${l.next}` : ""}`);
  const done = lines.every((l) => l.status === "ok");
  console.log(`setup ${step}: ${done ? "ok" : "not done"}`);
  return done ? 0 : 1;
}

export const STEPS = ["status", "login", "confirm", "workshop", "smoke", "view", "flip", "report"];
export const CONFIRM = ["org", "moved", "forward"];
const USAGE = `usage: bun scripts/setup.ts <step>
  status                 every state, done or not, and the next one; changes nothing
  login [--profile <p>]  log the ant profile in (the browser opens); skipped when it is logged in
  confirm org            the person said the organization that pays holds the credits
  workshop --ev3 yes|no  ${WORKSHOP}: settings, local registration, doctor
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
      if (e !== undefined && (e === "yes") !== s.ev3) {
        s.ev3 = e === "yes";
        saveState(s);
      }
      if (s.ev3 === undefined) return print(step, await checkWorkshop(s));
      return print(step, await workshop(s));
    }
    case "smoke":
      return print(step, await smoke(s));
    case "view":
      return print(step, await view());
    case "flip":
      return print(step, await flip(s));
    case "confirm": {
      const what = rest[0];
      if (what === "org") {
        const r = await run(["claude", "auth", "status", "--text"], {
          ms: 30_000,
          cwd: cwd(),
          env: profileEnv(s.profile),
        });
        const a = parseAuth(r.out);
        if (a.profile !== s.profile || !a.org) return print(step, await checkPays(s));
        s.org = a.org;
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
