// Inputs of the local server: command line, or one config file. Everything is checked here, before anything is
// built, and every failure names the flag or the field. A relative path on the command line is taken from the
// repository root, one in a config file from that file's folder: the working directory of the process (the folder
// an MCP client was started in) decides nothing.
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import nodePath, { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { parseRobotFile, type RobotFile } from "../../../packages/driver-ev3/robot-file";
import type { Ev3devHardware } from "../../../packages/driver-ev3dev/src/provider";
import type { SshOptions } from "../../../packages/driver-ev3dev/src/ssh";
import type { RobotProfile } from "../../../packages/protocol/types";
import { parseWorld } from "../../../packages/sim-world/world";
import type { LanConfig } from "./lan";
import { DEFAULT_PAGE_PORT } from "./pages";

export const DEFAULT_PORT = 8767;
/** The repository root: where a relative path on the command line is taken from. */
export const REPO = join(import.meta.dir, "..", "..", "..");
/** The path rules of one operating system (`node:path`'s `posix` or `win32`); tests pass the other one. */
export type PathRules = Pick<typeof nodePath, "resolve" | "join">;
/**
 * `p` when it is absolute, `p` inside the home folder when it starts with `~` (`~/x`, `~\\x`: a shell expands
 * neither inside `--flag=~/x` nor in a config file), else `p` inside `base`. Never the working directory: `base`
 * and `home` are absolute.
 */
export function pathFrom(base: string, p: string, rules: PathRules = nodePath, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return rules.join(home, p.slice(2));
  return rules.resolve(base, p);
}
const fromRepo = (p: string): string => pathFrom(REPO, p);
/** What a bare `bun apps/local/main.ts` runs: the example robot's twin in an empty walled room. */
export const EXAMPLE = {
  robot: join(REPO, "deployments", "example", "robots", "r1.json"),
  /** The robot of `--pages` without a file: no body, only the devices of the pages that join it. */
  pages: join(REPO, "deployments", "example", "robots", "pages.json"),
  world: join(import.meta.dir, "..", "examples", "room.json"),
};

export const USAGE = `usage: bun apps/local/main.ts [robots...]        MCP server over stdio; logs on stderr

  --help                         this text
  --print-add [robots...]        print the "claude mcp add" command that registers this server with those
                                 robots, with absolute paths, quoted for this computer's shells (on Windows:
                                 PowerShell and cmd.exe); starts nothing

  (no arguments)                 the example robot's twin (deployments/example/robots/r1.json) in
                                 apps/local/examples/room.json
  --twin [robot.json]            a simulated twin of that robot, id "<profile.id>-sim"
    --world <world.json>         its world, schema spinecord/world@1 (default apps/local/examples/room.json)
    --seed <n>                   seed of the world's noise (default 1)
  --ev3 [robot.json]             a stock-firmware EV3 on USB, lent by a page in Chrome or Edge (WebHID)
    --port <n>                   port of that page on 127.0.0.1 (default ${DEFAULT_PORT})
  --ev3dev [robot.json]          an EV3 running ev3dev, over ssh; a brick that is off or out of reach is
                                 listed offline and connected as soon as it answers
    --ssh <user@host[:port]>     where it is (required with --ev3dev); ssh must connect with a key, without
                                 asking for a password or about the host key
    --ssh-key <file>             private key file, which must exist (default: ssh's own keys and agent)
    --install-bridge             copy the bridge to the brick before connecting
  --pages [robot.json]           a robot with no body (default deployments/example/robots/pages.json),
                                 id "<profile.id>", whose devices are lent by browser pages; with it
                                 every robot of the process takes pages
    --page-port <n>              port of the page listener on 127.0.0.1 (default ${DEFAULT_PAGE_PORT}; 0 takes
                                 a free port, and list_robots' join names it)
    --lan                        also listen on this computer's private network address (HTTPS, port
                                 --page-port + 1) so a phone on the same network joins; the join link and
                                 its QR code are on stderr and on http://127.0.0.1:<page-port>/console. The
                                 certificate is the public one of local-ip.sh, fetched at start (cached)
      --lan-interface <name|ip>  the interface to listen on (default: the only private one, else the one of
                                 the default route)
      --lan-cert <cert> <key>    a certificate of your own (PEM files, e.g. from mkcert);
                                 local-ip.sh's is then not fetched
      --lan-host <name>          the name that certificate is for, when it does not name the address itself
    --page-origin <https url>    the origin of a tunnel you run yourself (cloudflared, pinggy): pages join through
                                 it at a listener on 127.0.0.1, port --page-port + 2
  --log-file <path>              also append every JSON log line of stderr to this file; its folder is
                                 created, and a file that cannot be opened ends the start
  --config <file.json>           the robots and the port as a file, for more than one robot of a kind:
                                 {"port"?: n, "pages"?: {"port"?: n, "lan"?: true | {"interface"?: s,
                                   "cert"?: path, "key"?: path, "host"?: s}, "origin"?: url}, "robots": [
                                   {"source": "twin", "robot": path, "world": path, "seed"?: n, "id"?: s},
                                   {"source": "ev3", "robot": path, "id"?: s},
                                   {"source": "ev3dev", "robot": path, "id"?: s, "install_bridge"?: bool,
                                    "ssh": {"host": s, "user": s, "port"?: n, "identity_file"?: path}},
                                   {"source": "pages", "robot": path, "id"?: s}]}
                                 "pages" or a robot of source "pages" makes every robot take pages

A robot file is {hardware, profile, pair?}; one for --pages is {profile} alone. For --ev3dev its hardware also needs speech_volume_pct. pair and
profile.drivetrain are for a robot with a synced pair of wheels: deployments/example/robots/arm.json has neither.
--twin, --ev3 and --ev3dev without a file use the example robot, deployments/example/robots/r1.json.

Paths: an absolute path is used as it is, and a leading ~ is the home folder. A relative path on the command line is taken from the repository
root, a relative path inside a --config file from that file's folder. The folder the server is started in
decides nothing. A file that is not there ends the start with its absolute path. The repository root is
  ${REPO}`;

/** --help: main.ts prints the usage and exits 0. */
export class HelpAsked extends Error {}

export type RobotSource =
  | { source: "twin"; id: string; robot: RobotFile; world: unknown; seed: number }
  | { source: "ev3"; id: string; robot: RobotFile }
  | {
      source: "ev3dev";
      id: string;
      robot: RobotFile;
      hardware: Ev3devHardware;
      ssh: SshOptions;
      installBridge: boolean;
    }
  | { source: "pages"; id: string; profile: RobotProfile };
export interface LocalConfig {
  robots: RobotSource[];
  /** Port of the page that lends a stock EV3. Bound only when a robot of source "ev3" exists. */
  port: number;
  /** `--log-file`, absolute: the file that gets every JSON log line of stderr too. */
  logFile?: string;
  /** Peripheral pages (CONTRACT §2.4): null when off. On, every robot gets a page hub, and the page listener binds this port. */
  pages?: PagesConfig | null;
}

export interface PagesConfig {
  port: number;
  /** `--lan`: the network listener. Absent when off. */
  lan?: LanConfig;
  /** `--page-origin`: the origin of the person's tunnel. Absent when off. */
  origin?: string;
}

const ROBOT_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readJson(where: string, path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`${where}: cannot read ${path}: ${(e as Error).message}`, { cause: e });
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${where}: ${path} is not valid JSON: ${(e as Error).message}`, { cause: e });
  }
}
function int(where: string, raw: unknown, min: number, max: number): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max)
    throw new Error(`${where} must be an integer ${min}..${max}, got ${JSON.stringify(raw)}`);
  return n;
}
/** `--page-origin`: an https origin and nothing else (no path, query or fragment). */
export function parseOrigin(where: string, raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${where} must be an https origin such as https://name.example, got ${raw}`);
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.pathname !== "/" && u.pathname !== "")
  )
    throw new Error(`${where} must be an https origin such as https://name.example (no path), got ${raw}`);
  // the join link (origin + "/#t=<22>&robot=<48>") must fit the QR code the person scans (qr.ts: 213 bytes)
  const most = 213 - "/#t=&robot=".length - 22 - 48;
  if (u.origin.length > most)
    throw new Error(`${where} is ${u.origin.length} characters; its join link must fit a QR code: at most ${most}`);
  return u.origin;
}
/** A certificate and its key of the person's own, read at start: a file that is not there ends the start. */
function ownCert(where: string, certPath: string, keyPath: string): NonNullable<LanConfig["own"]> {
  const read = (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch (e) {
      throw new Error(`${where}: cannot read ${path}: ${(e as Error).message}`, { cause: e });
    }
  };
  return { cert: read(certPath), key: read(keyPath), certPath, keyPath };
}

/** The file of a robot of source "pages": {profile: {id, roles, limits, notes}}, with no hardware, pair or drivetrain. */
export function parsePagesRobot(json: unknown, where: string): RobotProfile {
  const fail = (field: string, why: string): never => {
    throw new Error(`${where}: ${field} ${why}`);
  };
  if (!isObj(json)) return fail("the file", "must be an object {profile}");
  const extra = Object.keys(json).filter((k) => k !== "profile" && k !== "description");
  if (extra.length) fail(extra.join(", "), "is not part of a robot without a body: its file is {profile} alone");
  const p = isObj(json.profile) ? json.profile : fail("profile", "must be an object");
  const known = ["id", "roles", "limits", "notes"];
  const more = Object.keys(p).filter((k) => !known.includes(k));
  if (more.length)
    fail(`profile.${more[0]}`, `is not part of a robot without a body; its profile is {${known.join(", ")}}`);
  if (typeof p.id !== "string" || p.id === "") fail("profile.id", "must be a non-empty string");
  const roles = isObj(p.roles) ? p.roles : fail("profile.roles", "must be an object");
  for (const [role, device] of Object.entries(roles))
    if (typeof device !== "string" || device === "") fail(`profile.roles.${role}`, "must be a device id");
  const lim = isObj(p.limits) ? p.limits : fail("profile.limits", "must be an object");
  const positive = (k: string): number => {
    const v = lim[k];
    return typeof v === "number" && Number.isFinite(v) && v > 0
      ? v
      : fail(`profile.limits.${k}`, "must be a number > 0");
  };
  if (!Array.isArray(p.notes) || p.notes.some((n) => typeof n !== "string"))
    fail("profile.notes", "must be an array of strings");
  return {
    id: p.id as string,
    roles: roles as Record<string, string>,
    limits: {
      max_speed_pct: positive("max_speed_pct"),
      max_command_ms: positive("max_command_ms"),
      max_program_ms: positive("max_program_ms"),
      max_loop_ms: positive("max_loop_ms"),
    },
    notes: p.notes as string[],
  };
}

function robotFile(where: string, path: string): { file: RobotFile; raw: unknown } {
  const raw = readJson(where, path);
  return { file: parseRobotFile(raw, `${where} ${path}`), raw };
}
/** A private key ssh is told to use. Checked here: ssh itself goes on with its default keys when the file is missing. */
function keyFile(where: string, path: string): string {
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
    accessSync(path, constants.R_OK);
  } catch (e) {
    throw new Error(`${where}: cannot read ${path}: ${(e as Error).message}`, { cause: e });
  }
  return path;
}
function world(where: string, path: string): unknown {
  const json = readJson(where, path);
  try {
    parseWorld(json);
  } catch (e) {
    throw new Error(`${where} ${path}: ${(e as Error).message}`, { cause: e });
  }
  return json;
}
function ev3devHardware(where: string, file: RobotFile, raw: unknown): Ev3devHardware {
  const speech = isObj(raw) && isObj(raw.hardware) ? raw.hardware.speech_volume_pct : undefined;
  if (typeof speech !== "number" || !(speech >= 1 && speech <= 100))
    throw new Error(
      `${where}: hardware.speech_volume_pct is required for an ev3dev brick (1..100), got ${JSON.stringify(speech)}`,
    );
  return {
    low_battery_v: file.hardware.low_battery_v,
    max_tone_ms: file.hardware.max_tone_ms,
    speech_volume_pct: speech,
    ...(file.hardware.ir_channel === undefined ? {} : { ir_channel: file.hardware.ir_channel }),
  };
}
const twinId = (base: string): string => (base.endsWith("-sim") ? base : `${base}-sim`);

/** "user@host" or "user@host:port". The driver checks the characters of each part. */
export function parseSshTarget(where: string, target: string): SshOptions {
  const m = target.match(/^([^@\s]+)@([^@\s:]+)(?::(\d+))?$/);
  if (!m) throw new Error(`${where} must look like user@host or user@host:port, got ${target}`);
  return { user: m[1]!, host: m[2]!, ...(m[3] ? { port: int(`${where} port`, m[3], 1, 65535) } : {}) };
}

function fromFile(file: string): LocalConfig {
  const where = `--config ${file}`;
  const json = readJson("--config", file);
  if (!isObj(json)) throw new Error(`${where}: must be an object {"robots": [...]}`);
  const unknown = Object.keys(json).filter((k) => k !== "port" && k !== "robots" && k !== "pages");
  if (unknown.length) throw new Error(`${where}: unknown field ${unknown.join(", ")}; allowed: port, pages, robots`);
  let pages: PagesConfig | null = null;
  if (json.pages !== undefined) {
    const shape = '{"port"?: n, "lan"?: true | {"interface"?, "cert"?, "key"?, "host"?}, "origin"?: url}';
    if (!isObj(json.pages) || Object.keys(json.pages).some((k) => !["port", "lan", "origin"].includes(k)))
      throw new Error(`${where}: pages must be ${shape}`);
    const jp = json.pages;
    pages = {
      port: jp.port === undefined ? DEFAULT_PAGE_PORT : int(`${where}: pages.port`, jp.port, 1, 65535),
    };
    if (jp.lan !== undefined && jp.lan !== false) {
      const l = jp.lan === true ? {} : jp.lan;
      if (!isObj(l) || Object.keys(l).some((k) => !["interface", "cert", "key", "host"].includes(k)))
        throw new Error(
          `${where}: pages.lan must be true or {"interface"?: s, "cert"?: path, "key"?: path, "host"?: s}`,
        );
      for (const k of ["interface", "cert", "key", "host"] as const)
        if (l[k] !== undefined && (typeof l[k] !== "string" || l[k] === ""))
          throw new Error(`${where}: pages.lan.${k} must be a non-empty string`);
      if ((l.cert === undefined) !== (l.key === undefined))
        throw new Error(`${where}: pages.lan.cert and pages.lan.key go together`);
      if (l.host !== undefined && l.cert === undefined)
        throw new Error(`${where}: pages.lan.host names the host of pages.lan.cert: it needs cert and key`);
      const base = dirname(file);
      pages.lan = {
        ...(l.interface !== undefined ? { interface: l.interface as string } : {}),
        ...(l.cert !== undefined
          ? {
              own: ownCert(
                `${where}: pages.lan.cert`,
                pathFrom(base, l.cert as string),
                pathFrom(base, l.key as string),
              ),
            }
          : {}),
        ...(l.host !== undefined ? { host: l.host as string } : {}),
      };
    }
    if (jp.origin !== undefined) {
      if (typeof jp.origin !== "string") throw new Error(`${where}: pages.origin must be a string`);
      pages.origin = parseOrigin(`${where}: pages.origin`, jp.origin);
    }
  }
  if (!Array.isArray(json.robots) || json.robots.length === 0)
    throw new Error(`${where}: robots must be a non-empty array`);
  const at = (p: unknown, field: string): string => {
    if (typeof p !== "string" || p === "") throw new Error(`${where}: ${field} must be a path`);
    return pathFrom(dirname(file), p);
  };
  const robots = json.robots.map((r, i): RobotSource => {
    const f = `robots[${i}]`;
    if (!isObj(r)) throw new Error(`${where}: ${f} must be an object`);
    const robotPath = at(r.robot, `${f}.robot`);
    if (r.id !== undefined && typeof r.id !== "string") throw new Error(`${where}: ${f}.id must be a string`);
    if (r.source === "pages") {
      const profile = parsePagesRobot(readJson(`${where}: ${f}.robot`, robotPath), `${where}: ${f}.robot ${robotPath}`);
      pages ??= { port: DEFAULT_PAGE_PORT };
      return { source: "pages", id: r.id ?? profile.id, profile };
    }
    const { file, raw } = robotFile(`${where}: ${f}.robot`, robotPath);
    switch (r.source) {
      case "twin":
        return {
          source: "twin",
          id: r.id ?? twinId(file.profile.id),
          robot: file,
          world: world(`${where}: ${f}.world`, at(r.world, `${f}.world`)),
          seed: r.seed === undefined ? 1 : int(`${where}: ${f}.seed`, r.seed, 0, 0xffffffff),
        };
      case "ev3":
        return { source: "ev3", id: r.id ?? file.profile.id, robot: file };
      case "ev3dev": {
        if (!isObj(r.ssh) || typeof r.ssh.host !== "string" || typeof r.ssh.user !== "string")
          throw new Error(`${where}: ${f}.ssh must be {"host": string, "user": string, "port"?, "identity_file"?}`);
        if (r.install_bridge !== undefined && typeof r.install_bridge !== "boolean")
          throw new Error(`${where}: ${f}.install_bridge must be true or false`);
        return {
          source: "ev3dev",
          id: r.id ?? file.profile.id,
          robot: file,
          hardware: ev3devHardware(`${where}: ${f}.robot ${robotPath}`, file, raw),
          ssh: {
            host: r.ssh.host,
            user: r.ssh.user,
            ...(r.ssh.port !== undefined ? { port: int(`${where}: ${f}.ssh.port`, r.ssh.port, 1, 65535) } : {}),
            ...(r.ssh.identity_file !== undefined
              ? {
                  identityFile: keyFile(
                    `${where}: ${f}.ssh.identity_file`,
                    at(r.ssh.identity_file, `${f}.ssh.identity_file`),
                  ),
                }
              : {}),
          },
          installBridge: r.install_bridge === true,
        };
      }
      default:
        throw new Error(
          `${where}: ${f}.source must be "twin", "ev3", "ev3dev" or "pages", got ${JSON.stringify(r.source)}`,
        );
    }
  });
  return {
    robots,
    port: json.port === undefined ? DEFAULT_PORT : int(`${where}: port`, json.port, 1, 65535),
    pages,
  };
}

const ROBOT_FLAGS = ["--twin", "--ev3", "--ev3dev", "--pages"];
/** `--twin`, `--ev3`, `--ev3dev` and `--pages` with no file after them get the example robot. */
function withExampleRobot(argv: string[]): string[] {
  return argv.map((arg, i) => {
    const next = argv[i + 1];
    if (!ROBOT_FLAGS.includes(arg) || (next !== undefined && !next.startsWith("-"))) return arg;
    return `${arg}=${arg === "--pages" ? EXAMPLE.pages : EXAMPLE.robot}`;
  });
}

/** `--lan-cert <cert.pem> <key.pem>` takes two files: written here as `--lan-cert=<cert> --lan-key=<key>`. */
function withLanCertPair(argv: string[]): string[] {
  const i = argv.indexOf("--lan-cert");
  if (i === -1) return argv;
  const [cert, key] = [argv[i + 1], argv[i + 2]];
  if (cert === undefined || cert.startsWith("-") || key === undefined || key.startsWith("-"))
    throw new Error("--lan-cert needs two files: --lan-cert <cert.pem> <key.pem>");
  return [...argv.slice(0, i), `--lan-cert=${cert}`, `--lan-key=${key}`, ...argv.slice(i + 3)];
}

/** Reads the command line and every file it names. Throws with a message for the person at the terminal. */
export function loadConfig(argv: string[]): LocalConfig {
  const { values } = parseArgs({
    args: withLanCertPair(withExampleRobot(argv)),
    strict: true,
    allowPositionals: false,
    options: {
      help: { type: "boolean" },
      config: { type: "string" },
      twin: { type: "string" },
      world: { type: "string" },
      seed: { type: "string" },
      ev3: { type: "string" },
      port: { type: "string" },
      ev3dev: { type: "string" },
      ssh: { type: "string" },
      "ssh-key": { type: "string" },
      "install-bridge": { type: "boolean" },
      "log-file": { type: "string" },
      pages: { type: "string" },
      "page-port": { type: "string" },
      lan: { type: "boolean" },
      "lan-interface": { type: "string" },
      "lan-cert": { type: "string" },
      "lan-key": { type: "string" },
      "lan-host": { type: "string" },
      "page-origin": { type: "string" },
    },
  });
  if (values.help) throw new HelpAsked();
  // --log-file says where the log goes, not which robots run: it stands beside --config and beside no robot flag
  const given = Object.keys(values).filter((k) => k !== "log-file");
  if (values["log-file"] === "") throw new Error("--log-file needs a path");
  let config: LocalConfig;
  if (values.config !== undefined) {
    if (given.length > 1)
      throw new Error(
        `--config holds everything: remove ${given
          .filter((k) => k !== "config")
          .map((k) => `--${k}`)
          .join(", ")}`,
      );
    config = fromFile(fromRepo(values.config));
  } else {
    const robots: RobotSource[] = [];
    const needs = (flag: string, owner: string, on: boolean) => {
      if (!on) throw new Error(`--${flag} needs --${owner}`);
    };
    if (values.world !== undefined) needs("world", "twin", values.twin !== undefined);
    if (values.seed !== undefined) needs("seed", "twin", values.twin !== undefined);
    if (values.port !== undefined) needs("port", "ev3", values.ev3 !== undefined);
    if (values["page-port"] !== undefined) needs("page-port", "pages", values.pages !== undefined);
    if (values.lan !== undefined) needs("lan", "pages", values.pages !== undefined);
    if (values["page-origin"] !== undefined) needs("page-origin", "pages", values.pages !== undefined);
    for (const flag of ["lan-interface", "lan-cert", "lan-key", "lan-host"] as const)
      if (values[flag] !== undefined) needs(flag, "lan", values.lan === true);
    if ((values["lan-cert"] === undefined) !== (values["lan-key"] === undefined))
      throw new Error("--lan-cert needs two files: --lan-cert <cert.pem> <key.pem>");
    if (values["lan-host"] !== undefined && values["lan-cert"] === undefined)
      throw new Error("--lan-host names the host of a certificate of your own: it needs --lan-cert");
    for (const flag of ["ssh", "ssh-key", "install-bridge"] as const)
      if (values[flag] !== undefined) needs(flag, "ev3dev", values.ev3dev !== undefined);
    if (given.length === 0)
      robots.push({
        source: "twin",
        id: twinId(robotFile("example robot", EXAMPLE.robot).file.profile.id),
        robot: robotFile("example robot", EXAMPLE.robot).file,
        world: world("example world", EXAMPLE.world),
        seed: 1,
      });
    if (values.ev3 !== undefined) {
      const { file } = robotFile("--ev3", fromRepo(values.ev3));
      robots.push({ source: "ev3", id: file.profile.id, robot: file });
    }
    if (values.ev3dev !== undefined) {
      if (values.ssh === undefined) throw new Error("--ev3dev needs --ssh <user@host>");
      const robotPath = fromRepo(values.ev3dev);
      const { file, raw } = robotFile("--ev3dev", robotPath);
      robots.push({
        source: "ev3dev",
        id: file.profile.id,
        robot: file,
        hardware: ev3devHardware(`--ev3dev ${robotPath}`, file, raw),
        ssh: {
          ...parseSshTarget("--ssh", values.ssh),
          ...(values["ssh-key"] !== undefined
            ? { identityFile: keyFile("--ssh-key", fromRepo(values["ssh-key"])) }
            : {}),
        },
        installBridge: values["install-bridge"] === true,
      });
    }
    if (values.twin !== undefined) {
      const { file } = robotFile("--twin", fromRepo(values.twin));
      robots.push({
        source: "twin",
        id: twinId(file.profile.id),
        robot: file,
        world: world("--world", values.world === undefined ? EXAMPLE.world : fromRepo(values.world)),
        seed: values.seed === undefined ? 1 : int("--seed", values.seed, 0, 0xffffffff),
      });
    }
    if (values.pages !== undefined) {
      const path = fromRepo(values.pages);
      const profile = parsePagesRobot(readJson("--pages", path), `--pages ${path}`);
      robots.push({ source: "pages", id: profile.id, profile });
    }
    config = {
      robots,
      port: values.port === undefined ? DEFAULT_PORT : int("--port", values.port, 1, 65535),
      pages:
        values.pages === undefined
          ? null
          : {
              port:
                values["page-port"] === undefined
                  ? DEFAULT_PAGE_PORT
                  : int("--page-port", values["page-port"], 0, 65535),
              ...(values.lan
                ? {
                    lan: {
                      ...(values["lan-interface"] !== undefined ? { interface: values["lan-interface"] } : {}),
                      ...(values["lan-cert"] !== undefined
                        ? {
                            own: ownCert(
                              "--lan-cert",
                              fromRepo(values["lan-cert"]),
                              fromRepo(values["lan-key"] as string),
                            ),
                          }
                        : {}),
                      ...(values["lan-host"] !== undefined ? { host: values["lan-host"] } : {}),
                    },
                  }
                : {}),
              ...(values["page-origin"] !== undefined
                ? { origin: parseOrigin("--page-origin", values["page-origin"]) }
                : {}),
            },
    };
  }
  if (config.pages && (config.pages.lan || config.pages.origin) && config.pages.port > 65533)
    throw new Error(
      `the page port is ${config.pages.port}: --lan takes the port after it and --page-origin the one after that; pick one up to 65533`,
    );
  const ids = config.robots.map((r) => r.id);
  for (const id of ids)
    if (!ROBOT_ID.test(id))
      throw new Error(`robot id ${JSON.stringify(id)}: lowercase letters, digits, _ and -, at most 48 characters`);
  const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (twice.length) throw new Error(`each robot needs its own id, got ${twice[0]} twice: set "id" in a --config file`);
  if (config.robots.filter((r) => r.source === "ev3").length > 1)
    throw new Error("one stock-firmware EV3 per process: the page lends one brick");
  if (values["log-file"] !== undefined) config.logFile = fromRepo(values["log-file"]);
  return config;
}
