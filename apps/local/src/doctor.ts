// `--doctor [robots...]`: a read-only check of this computer for the robots those flags name. Each check is one
// line (ok, warn or fail, why, and the next command), the last line is `doctor: ok` or `doctor: <n> to fix` (n
// counts the fails), and the exit code is 1 when anything fails. It writes no file and prints no secret; the only
// network it touches is a port probe on 127.0.0.1. Every probe is injected, so the tests run none of them.
import { spawn, spawnSync } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { join, posix, win32 } from "node:path";
import { paysBeforeProfile, type Env } from "../../../examples/assistant/setup";
import { loadConfig, REPO, type LocalConfig } from "./config";
import { chooseInterface, defaultRouteAddress } from "./lan";
import { describeTwin, describeUnconfirmed, footprintClash } from "./twin-build";

export type Status = "ok" | "warn" | "fail";
export interface Line {
  status: Status;
  check: string;
  reason: string;
  /** The command, or the one action, that fixes it. */
  next?: string;
}
export interface RunResult {
  /** null when the command was stopped at its timeout or could not start. */
  code: number | null;
  /** stdout and stderr together. Parsed, never printed. */
  out: string;
  timedOut: boolean;
}
export interface Probes {
  platform: string;
  bunVersion: string;
  /** The bun that runs this process: the program a firewall must let accept connections. */
  execPath: string;
  env: Env;
  home: string;
  repo: string;
  exists(path: string): boolean;
  which(cmd: string): string | null;
  run(cmd: string[], timeoutMs: number): Promise<RunResult>;
  /** true when nothing listens on 127.0.0.1:port. */
  portFree(port: number): Promise<boolean>;
  interfaces(): NodeJS.Dict<NetworkInterfaceInfo[]>;
  defaultRoute(): Promise<string | null>;
  realpath(path: string): string;
}

/** The bun this repository pins (root package.json `packageManager`), which the README states as the minimum. */
export const MIN_BUN = (() => {
  const pm = (JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { packageManager?: unknown })
    .packageManager;
  const m = typeof pm === "string" ? pm.match(/^bun@(\d+\.\d+\.\d+)$/) : null;
  if (!m) throw new Error(`package.json: packageManager must be bun@x.y.z, got ${JSON.stringify(pm)}`);
  return m[1]!;
})();
/** Each check ends within this, `claude mcp get` within CLAUDE_MS: it starts the registered server once. */
export const CHECK_MS = 5000;
export const CLAUDE_MS = 10_000;
export const FIREWALL = "/usr/libexec/ApplicationFirewall/socketfilterfw";
const ASSISTANT_VARS = ["ANTHROPIC_PROFILE", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

const value = (env: Env, name: string) => (env[name] ?? "").trim();
const isSet = (env: Env, name: string) => value(env, name) !== "";
const unset = (platform: string, name: string) => (platform === "win32" ? `Remove-Item Env:${name}` : `unset ${name}`);
const setVar = (platform: string, name: string, v: string) =>
  platform === "win32" ? `$env:${name} = "${v}"` : `export ${name}=${v}`;

/** The places Chrome and Edge install to. On Linux they are looked up on PATH. */
export function browserPaths(p: Pick<Probes, "platform" | "env" | "home">): { name: string; path: string }[] {
  if (p.platform === "darwin")
    return ["/Applications", posix.join(p.home, "Applications")].flatMap((dir) => [
      { name: "Google Chrome", path: posix.join(dir, "Google Chrome.app") },
      { name: "Microsoft Edge", path: posix.join(dir, "Microsoft Edge.app") },
    ]);
  if (p.platform === "win32")
    return [p.env.ProgramFiles, p.env["ProgramFiles(x86)"], p.env.LOCALAPPDATA]
      .filter((dir): dir is string => !!dir)
      .flatMap((dir) => [
        { name: "Google Chrome", path: win32.join(dir, "Google", "Chrome", "Application", "chrome.exe") },
        { name: "Microsoft Edge", path: win32.join(dir, "Microsoft", "Edge", "Application", "msedge.exe") },
      ]);
  return [];
}
const LINUX_BROWSERS = [
  ["Google Chrome", "google-chrome"],
  ["Google Chrome", "google-chrome-stable"],
  ["Microsoft Edge", "microsoft-edge"],
  ["Microsoft Edge", "microsoft-edge-stable"],
] as const;

/** The ports the server would bind for that config, on 127.0.0.1 unless said. */
export function portsOf(c: LocalConfig): { port: number; what: string }[] {
  const out: { port: number; what: string }[] = [];
  if (c.robots.some((r) => r.source === "ev3")) out.push({ port: c.port, what: "the EV3 bridge page, --port" });
  if (c.pages && c.pages.port !== 0) {
    out.push({ port: c.pages.port, what: "the page listener, --page-port" });
    if (c.pages.lan) out.push({ port: c.pages.port + 1, what: "the --lan listener, probed on 127.0.0.1 only" });
    if (c.pages.origin) out.push({ port: c.pages.port + 2, what: "the --page-origin listener" });
  }
  if (c.view && c.view.port !== 0) out.push({ port: c.view.port, what: "the 3D view of the twins, --view-port" });
  return out;
}

function checkBun(p: Probes): Line {
  const ok = Bun.semver.order(p.bunVersion, MIN_BUN) >= 0;
  return ok
    ? { status: "ok", check: "bun", reason: `${p.bunVersion}, at least ${MIN_BUN}` }
    : {
        status: "fail",
        check: "bun",
        reason: `${p.bunVersion} is older than ${MIN_BUN}`,
        next: "bun upgrade",
      };
}

function checkBrowser(p: Probes, needs: { ev3: boolean; pages: boolean }): Line {
  const found =
    p.platform === "linux"
      ? LINUX_BROWSERS.map(([name, cmd]) => ({ name, path: p.which(cmd) })).find((b) => b.path !== null)
      : browserPaths(p).find((b) => p.exists(b.path));
  const why = needs.ev3
    ? " --ev3 needs one: WebHID, the USB link of a stock EV3, runs in Chrome and Edge only."
    : needs.pages
      ? " --pages needs one: the page runs in Chrome or Edge."
      : "";
  if (found) return { status: "ok", check: "browser", reason: `${found.name} at ${found.path}${why ? `.${why}` : ""}` };
  if (!needs.ev3 && !needs.pages)
    return {
      status: "ok",
      check: "browser",
      reason: "no Chrome or Edge found; these robots need none (--ev3 and --pages do)",
    };
  return {
    status: "fail",
    check: "browser",
    reason: `no Chrome or Edge found.${why}`,
    next: "install Google Chrome (https://www.google.com/chrome/) or Microsoft Edge (https://www.microsoft.com/edge)",
  };
}

async function checkPorts(p: Probes, c: LocalConfig): Promise<Line[]> {
  const ports = portsOf(c);
  if (ports.length === 0) return [{ status: "ok", check: "ports", reason: "these robots listen on no port" }];
  const out: Line[] = [];
  // run from inside a Claude Code session, the holder is most likely that session's own spinecord
  const inSession = isSet(p.env, "CLAUDECODE");
  for (const { port, what } of ports)
    out.push(
      (await p.portFree(port))
        ? { status: "ok", check: "port", reason: `${port} is free (${what})` }
        : {
            status: "fail",
            check: "port",
            reason: inSession
              ? `${port} is held (${what}), most likely by this Claude Code session's own spinecord`
              : `${port} is held (${what}), most likely by another spinecord that another Claude Code session started`,
            next: inSession
              ? "expected while this session's spinecord tools answer (list_robots); else close the other Claude Code session"
              : "close the other Claude Code session (or its bun process), then run this again",
          },
    );
  return out;
}

function checkLan(p: Probes, c: LocalConfig, route: string | null): Line {
  try {
    const at = chooseInterface(p.interfaces(), route, c.pages?.lan?.interface);
    return { status: "ok", check: "lan", reason: `listens on ${at.interface} ${at.address}` };
  } catch (e) {
    return {
      status: "fail",
      check: "lan",
      reason: (e as Error).message,
      next: c.pages?.lan?.interface
        ? "pick an interface the message lists with --lan-interface <name>"
        : "join the network the phone is on (its hotspot, for example), then run this again",
    };
  }
}

async function checkFirewall(p: Probes): Promise<Line | null> {
  if (p.platform === "win32")
    return {
      status: "ok",
      check: "firewall",
      reason:
        "Windows asks once whether bun may accept connections on this network: allow it on private networks, or phones cannot join",
    };
  if (p.platform !== "darwin") return null;
  const r = await p.run([FIREWALL, "--getstealthmode", "--getglobalstate"], CHECK_MS);
  const state = r.out.match(/State = (\d)/)?.[1];
  const stealth = /stealth mode is on/i.test(r.out) ? "on" : /stealth mode is off/i.test(r.out) ? "off" : null;
  const allow = `sudo ${FIREWALL} --add "${p.execPath}" --unblockapp "${p.execPath}"`;
  if (r.code !== 0 || state === undefined || stealth === null)
    return {
      status: "warn",
      check: "firewall",
      reason: `could not read the macOS firewall's state (${r.timedOut ? "no answer" : `exit ${r.code}`}); if it is on, it must let ${p.execPath} accept incoming connections`,
      next: allow,
    };
  if (state === "0") return { status: "ok", check: "firewall", reason: "the macOS firewall is off" };
  if (state === "2")
    return {
      status: "fail",
      check: "firewall",
      reason: "the macOS firewall blocks every incoming connection: no phone can join",
      next: 'System Settings > Network > Firewall > Options: turn off "Block all incoming connections"',
    };
  return {
    status: "warn",
    check: "firewall",
    reason: `the macOS firewall is on, stealth mode ${stealth}: it must let ${p.execPath} accept incoming connections, or a phone's connection is dropped${stealth === "on" ? " without an answer" : ""}`,
    next: allow,
  };
}

/** `claude mcp get spinecord` has no JSON form; its Scope, Status and Args lines are read, and nothing is printed. */
async function checkClaude(p: Probes, robotArgs: string[], portHeld: boolean): Promise<Line> {
  const main = join(p.repo, "apps", "local", "main.ts");
  // by its full path: the doctor runs in the folder Claude Code starts in, and the printed line registers there
  const printAdd = [`bun "${main}" --print-add`, ...robotArgs].join(" ");
  if (p.which("claude") === null)
    return {
      status: "fail",
      check: "claude code",
      reason: "claude is not on PATH",
      next: "install Claude Code (https://code.claude.com/docs/en/setup), open a new terminal, then run this again",
    };
  // a claude.cmd that npm installs on Windows starts only through cmd.exe
  const cmd = p.platform === "win32" ? ["cmd.exe", "/d", "/c", "claude"] : ["claude"];
  const r = await p.run([...cmd, "mcp", "get", "spinecord"], CLAUDE_MS);
  if (r.timedOut)
    return {
      status: "fail",
      check: "claude code",
      reason: `claude mcp get spinecord did not answer within ${CLAUDE_MS / 1000} s`,
      next: "claude mcp get spinecord",
    };
  const scope = r.out.match(/^\s*Scope:\s*(\w+)/m)?.[1]?.toLowerCase();
  const args = r.out.match(/^\s*Args:\s*(.*)$/m)?.[1]?.trim() ?? "";
  if (r.code !== 0 || scope === undefined)
    return {
      status: "fail",
      check: "claude code",
      reason: "spinecord is not registered where Claude Code in this folder sees it",
      next: `${printAdd}, then run the line it prints in this folder`,
    };
  const again = `claude mcp remove -s ${scope} spinecord, then ${printAdd} and run the line it prints in this folder`;
  const norm = (s: string) => (p.platform === "win32" ? s.replaceAll("/", "\\").toLowerCase() : s);
  const mains = [main, p.realpath(main)].map(norm);
  if (!mains.some((m) => norm(args).startsWith(m)))
    return {
      status: "fail",
      check: "claude code",
      reason: `spinecord is registered (${scope} scope), but it runs ${args.split(" ")[0] || "nothing"}, not this clone's ${main}`,
      next: again,
    };
  const flags = norm(args)
    .slice(mains.find((m) => norm(args).startsWith(m))!.length)
    .trim();
  const status = r.out.match(/^\s*Status:\s*(.*)$/m)?.[1]?.trim() ?? "";
  if (/fail|error/i.test(status))
    return {
      status: portHeld ? "warn" : "fail",
      check: "claude code",
      reason: `spinecord is registered (${scope} scope), but Claude Code could not start it${portHeld ? ": the held port above is the likely cause" : ""}`,
      next: portHeld ? "fix the port above" : `bun "${main}" ${flags} --help, then claude --debug`,
    };
  const runs = `with this clone's main.ts${flags ? ` ${flags}` : ""}`;
  // local and project scope are deliberate: only sessions opened in this folder start a robot link (CONTRACT §6)
  if (scope === "user")
    return {
      status: "warn",
      check: "claude code",
      reason: `spinecord is registered for every folder (user scope), ${runs}: every Claude Code session on this computer starts its own server with these robots`,
      next: `claude mcp remove -s user spinecord, then ${printAdd} and run the line it prints in the folder you start Claude Code in`,
    };
  return {
    status: "ok",
    check: "claude code",
    reason: `spinecord is registered in ${scope} scope: only sessions opened in this folder see it, ${runs}`,
  };
}

async function checkAssistant(p: Probes): Promise<Line[]> {
  const env = p.env;
  const profile = isSet(env, "ANTHROPIC_PROFILE") ? value(env, "ANTHROPIC_PROFILE") : null;
  const set = ASSISTANT_VARS.filter((n) => isSet(env, n));
  const notSet = ASSISTANT_VARS.filter((n) => !isSet(env, n));
  const names = [
    set.length ? `set: ${set.map((n) => (n === "ANTHROPIC_PROFILE" ? `${n} (${profile})` : n)).join(", ")}` : "",
    notSet.length ? `not set: ${notSet.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  const first = paysBeforeProfile(env);
  const out: Line[] = [];
  if (profile !== null && first !== null)
    out.push({
      status: "fail",
      check: "assistant",
      reason: `${names}. ${first} is set too and pays ahead of the profile ${profile}`,
      next: unset(p.platform, first),
    });
  else if (profile === null && first === null)
    out.push({
      status: "warn",
      check: "assistant",
      reason: `${names}: this computer's Claude Code login pays (examples/assistant/README.md, step 2)`,
      next: `${setVar(p.platform, "ANTHROPIC_PROFILE", "<profile>")}, the profile ant auth status shows`,
    });
  else
    out.push({
      status: "ok",
      check: "assistant",
      reason: `${names}: ${profile !== null ? `the ant profile ${profile}` : first} pays`,
    });
  if (profile === null) return out;
  if (p.which("ant") === null) {
    out.push({
      status: "fail",
      check: "ant",
      reason: `ANTHROPIC_PROFILE=${profile} needs the ant CLI, and ant is not on PATH`,
      next: "install it: https://platform.claude.com/docs/en/cli-sdks-libraries/cli/authentication",
    });
    return out;
  }
  const r = await p.run(["ant", "--profile", profile, "auth", "status"], CHECK_MS);
  // greedy up to the last " as ": an organization's name may hold " as " itself
  const org = r.code === 0 ? r.out.match(/^\s*Logged in to (.+) as \S+\s*$/m)?.[1]?.trim() : undefined;
  out.push(
    org
      ? { status: "ok", check: "ant", reason: `the profile ${profile} is logged in to ${org}` }
      : {
          status: "fail",
          check: "ant",
          reason: `the profile ${profile} has no login${r.timedOut ? " (ant auth status did not answer)" : ""}: Claude Code would skip it, and another login would pay`,
          next: `ant --profile ${profile} auth login`,
        },
  );
  return out;
}

/** A check that ends within `ms`, or becomes a fail that says so. */
async function bounded<T extends Line | Line[] | null>(
  check: string,
  ms: number,
  f: () => Promise<T>,
): Promise<T | Line> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Line>((resolve) => {
    timer = setTimeout(
      () => resolve({ status: "fail", check, reason: `did not finish within ${ms / 1000} s`, next: "run this again" }),
      ms,
    );
  });
  try {
    return await Promise.race([f(), late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface DoctorOptions {
  /** The robot flags, as they would follow --print-add. */
  robotArgs: string[];
  assistant: boolean;
  /** Only the robot files: no line about this computer, so the exit code is the files' own. */
  filesOnly?: boolean;
  /** Per check, CHECK_MS; tests pass less. */
  checkMs?: number;
}

export async function doctor(o: DoctorOptions, p: Probes): Promise<{ lines: Line[]; code: 0 | 1 }> {
  const ms = o.checkMs ?? CHECK_MS;
  const lines: Line[] = [];
  const add = (l: Line | Line[] | null) => {
    if (l) lines.push(...(Array.isArray(l) ? l : [l]));
  };
  if (!o.filesOnly) add(checkBun(p));
  let config: LocalConfig | null = null;
  try {
    config = loadConfig(o.robotArgs);
    add({
      status: "ok",
      check: "robots",
      reason: config.robots.map((r) => `${r.source} ${r.id}`).join(", "),
    });
    // what each twin will have, so that a person can compare it with the robot on the table
    for (const r of config.robots)
      if (r.source === "twin") {
        add({
          status: "ok",
          check: `twin ${r.id}`,
          reason: describeTwin(r.robot, r.world, r.ownBuild === true, r.build?.drive),
        });
        const clash = footprintClash(r.robot, r.world, r.build);
        if (clash)
          add({
            status: "warn",
            check: `footprint ${r.id}`,
            reason: clash,
            next: "a measured value wins; else a recognised build's axle track wins over a footprint read from the photo unless the wheels are visibly further apart (then axle_track_cm = its width minus one wheel or track width), and a default footprint loses (half_width_cm = half of axle track plus one wheel or track width)",
          });
        if (r.unconfirmed?.length)
          add({
            status: "warn",
            check: `draft ${r.id}`,
            reason: describeUnconfirmed(r.unconfirmed),
            next: "confirm each with the person, the brick or a calibration on the real robot, then take it out of twin.unconfirmed",
          });
      }
  } catch (e) {
    add({
      status: "fail",
      check: "robots",
      reason: (e as Error).message.replaceAll(/\s*\n\s*/g, " "),
      next: "fix the flag or the file it names; bun apps/local/main.ts --help lists every flag",
    });
  }
  if (o.filesOnly) return { lines, code: lines.some((l) => l.status === "fail") ? 1 : 0 };
  const needs = config
    ? { ev3: config.robots.some((r) => r.source === "ev3"), pages: !!config.pages }
    : { ev3: o.robotArgs.some((a) => a.startsWith("--ev3")), pages: o.robotArgs.some((a) => a.startsWith("--pages")) };
  add(checkBrowser(p, needs));
  // ahead of `claude mcp get`, which starts the registered server and so binds its ports for a moment
  if (config) {
    const c = config;
    add(await bounded("ports", ms * 2, () => checkPorts(p, c)));
    if (c.pages?.lan) {
      add(await bounded("lan", ms, async () => checkLan(p, c, await p.defaultRoute())));
      add(await bounded("firewall", ms, () => checkFirewall(p)));
    }
  } else add({ status: "warn", check: "ports", reason: "not checked: the robot flags above do not parse" });
  const held = lines.some((l) => l.check === "port" && l.status === "fail");
  add(await bounded("claude code", CLAUDE_MS + ms, () => checkClaude(p, o.robotArgs, held)));
  if (o.assistant) add(await bounded("assistant", ms * 2, () => checkAssistant(p)));
  return { lines, code: lines.some((l) => l.status === "fail") ? 1 : 0 };
}

export function report(lines: Line[]): string {
  const width = Math.max(...lines.map((l) => l.check.length));
  const body = lines.map(
    (l) => `${l.status.padEnd(4)}  ${l.check.padEnd(width)}  ${l.reason}${l.next ? `  ->  ${l.next}` : ""}`,
  );
  const fails = lines.filter((l) => l.status === "fail").length;
  return `${[...body, fails === 0 ? "doctor: ok" : `doctor: ${fails} to fix`].join("\n")}\n`;
}

/** Whether nothing listens on 127.0.0.1:port: a bind there succeeds, and then a connection there finds no one. */
async function portFree(port: number): Promise<boolean> {
  const bindable = await new Promise<boolean>((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen({ port, host: "127.0.0.1", exclusive: true }, () => s.close(() => resolve(true)));
  });
  if (!bindable) return false;
  // after the probe's own listener closed: a listener on every address (0.0.0.0) lets a bind on 127.0.0.1
  // through on macOS, and a connection finds it
  const answers = await new Promise<boolean>((resolve) => {
    const c = createConnection({ port, host: "127.0.0.1" });
    const done = (v: boolean) => {
      c.destroy();
      resolve(v);
    };
    c.setTimeout(1000, () => done(false));
    c.once("connect", () => done(true));
    c.once("error", () => done(false));
  });
  return !answers;
}

/** Stops a probe and every process it started: its process group on macOS and Linux, its tree on Windows. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 3000 });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/**
 * One probe command, bounded: at `timeoutMs` it and everything it started are stopped. The answer comes when the
 * command exits; a process it left behind that still holds its output is stopped too, at most DRAIN_MS later.
 */
export function runBounded(cmd: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    let settled = false;
    let drain: ReturnType<typeof setTimeout> | undefined;
    // its own process group on macOS and Linux, so that killTree reaches what it starts
    const child = spawn(cmd[0]!, cmd.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      resolve({ code: timedOut ? null : code, out, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.once("error", (e) => {
      out += e.message;
      finish(null);
    });
    child.once("close", (code) => finish(code));
    child.once("exit", (code) => {
      drain = setTimeout(() => {
        killTree(child.pid);
        finish(code);
      }, DRAIN_MS);
    });
  });
}
const DRAIN_MS = 500;

export const realProbes = (): Probes => ({
  platform: process.platform,
  bunVersion: Bun.version,
  execPath: process.execPath,
  env: process.env,
  home: homedir(),
  repo: REPO,
  exists: (path) => {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  },
  which: (cmd) => Bun.which(cmd),
  run: runBounded,
  portFree,
  interfaces: networkInterfaces,
  defaultRoute: defaultRouteAddress,
  realpath: (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  },
});

/** main.ts `--doctor`: `argv` without --doctor. Writes the report on stdout and returns the exit code. */
export async function doctorMain(argv: string[], p: Probes = realProbes()): Promise<0 | 1> {
  const assistant = argv.includes("--assistant");
  const filesOnly = argv.includes("--files-only");
  const robotArgs = argv.filter((a) => a !== "--assistant" && a !== "--files-only");
  const { lines, code } = await doctor({ robotArgs, assistant, filesOnly }, p);
  await new Promise<void>((resolve) => process.stdout.write(report(lines), () => resolve()));
  return code;
}
