// Inputs of the local server: command line, or one config file. Everything is checked here, before anything is
// built, and every failure names the flag or the field. A relative path on the command line is taken from the
// repository root, one in a config file from that file's folder: the working directory of the process (the folder
// an MCP client was started in) decides nothing.
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import nodePath, { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { parseRobotFile, type RobotFile } from "../../../packages/driver-ev3/robot-file";
import type { Ev3devHardware } from "../../../packages/driver-ev3dev/src/provider";
import type { SshOptions } from "../../../packages/driver-ev3dev/src/ssh";
import type { RobotProfile } from "../../../packages/protocol/types";
import { parseWorld, WORLD_SCHEMA } from "../../../packages/sim-world/world";
import type { LanConfig } from "./lan";
import { DEFAULT_PAGE_PORT } from "./pages";
import { readBuild, withBuild, type TwinBuild, type Unconfirmed } from "./twin-build";

/** Port of the 3D view of the twins (`--view`), on 127.0.0.1. */
export const DEFAULT_VIEW_PORT = 8769;
/** `--chat` (experimental, CONTRACT §6): the model and the budget of the process, US dollars. */
export const DEFAULT_CHAT_MODEL = "claude-haiku-5-5";
export const DEFAULT_CHAT_USD = 1;
export interface ChatConfig {
  model: string;
  usd: number;
}
/** A model id as the API names them: letters, digits, dots and dashes. */
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{2,63}$/;
function chatConfig(where: string, model: unknown, usd: unknown): ChatConfig {
  const m = model === undefined ? DEFAULT_CHAT_MODEL : model;
  if (typeof m !== "string" || !MODEL_ID.test(m))
    throw new Error(
      `${where}: the chat model must be a model id such as ${DEFAULT_CHAT_MODEL}, got ${JSON.stringify(model)}`,
    );
  const n = usd === undefined ? DEFAULT_CHAT_USD : typeof usd === "string" && usd.trim() !== "" ? Number(usd) : usd;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 100)
    throw new Error(
      `${where}: the chat budget must be a number of US dollars above 0 and up to 100, got ${JSON.stringify(usd)}`,
    );
  return { model: m, usd: n };
}

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

/** Longest robot name: one line of the EV3's screen (22 characters), where the robot shows it. */
export const MAX_NAME = 22;
const NAME_CHARS = /^[\p{L}\p{M}\p{N} '.-]+$/u;
const NAME_RULE = `1 to ${MAX_NAME} letters (accents too), digits, spaces, ' . or -`;
export const USAGE = `usage: bun apps/local/main.ts [robots...]        MCP server over stdio; logs on stderr

  --help                         this text
  --print-add [robots...]        print the "claude mcp add" command that registers this server with those
                                 robots, with absolute paths, quoted for this computer's shells (on Windows:
                                 PowerShell and cmd.exe); starts nothing
  --doctor [robots...]           check this computer for those robots, read-only: bun, Chrome or Edge, the
                                 Claude Code registration, the ports, the robot files, --lan's address and
                                 firewall; one line per check with the next command, last line "doctor: ok"
                                 or "doctor: <n> to fix" (exit 1); starts nothing
    --assistant                  also check who pays for examples/assistant (names of variables, never values)
    --files-only                 check only the robot files those flags name, nothing of this computer: the
                                 robots, twin and draft lines; exit 1 only when a file is refused

  (no arguments)                 the example robot's twin (deployments/example/robots/r1.json) in
                                 apps/local/examples/room.json
  --twin [robot.json]            a simulated twin of that robot, id "<profile.id>-sim"
    --world <world.json>         its world, schema spinecord/world@1 (default apps/local/examples/room.json);
                                 every world of that file's folder is a map sim.world use_map (and load_world)
                                 takes by its file name
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
    --page-ext <folder>          serve the .js files of this folder next to the page, which loads each after its
                                 kit: devices of your own (deployments/example/page-ext)
  --view                         a 3D view of every twin on http://127.0.0.1:<view-port>/ in a browser: the
                                 robot, its motors, sensors, LED, screen, tones and speech move live with
                                 the MCP calls, and the person there can pick the robot up, set boxes down
                                 and press the brick's buttons (needs a twin)
    --view-port <n>              its port (default ${DEFAULT_VIEW_PORT}; 0 takes a free port)
    --chat                       experimental: a chat with Claude in the view, typed or spoken, as the first
                                 twin; Claude Code's login of this computer pays (ANTHROPIC_PROFILE selects
                                 an ant profile)
      --chat-model <id>          its model (default ${DEFAULT_CHAT_MODEL})
      --chat-usd <n>             its budget for this process, US dollars (default ${DEFAULT_CHAT_USD})
  --name <text>                  the name the person gave the robot: every robot of this command line takes it,
                                 over the "name" of its file (${NAME_RULE})
  --log-file <path>              also append every JSON log line of stderr to this file; its folder is
                                 created, and a file that cannot be opened ends the start
  --config <file.json>           the robots and the port as a file, for more than one robot of a kind:
                                 {"port"?: n, "view"?: true | {"port"?: n},
                                   "pages"?: {"port"?: n, "lan"?: true | {"interface"?: s,
                                   "cert"?: path, "key"?: path, "host"?: s}, "origin"?: url, "ext"?: path},
                                   "robots": [
                                   {"source": "twin", "robot": path, "world": path, "seed"?: n, "id"?: s},
                                   {"source": "ev3", "robot": path, "id"?: s},
                                   {"source": "ev3dev", "robot": path, "id"?: s, "install_bridge"?: bool,
                                    "ssh": {"host": s, "user": s, "port"?: n, "identity_file"?: path}},
                                   {"source": "pages", "robot": path, "id"?: s}]}
                                 "pages" or a robot of source "pages" makes every robot take pages

A robot file is {hardware, profile, pair?, twin?, description?, name?}; one for --pages is {profile, description?, name?}. For --ev3dev its hardware also needs speech_volume_pct. pair and
profile.drivetrain are for a robot with a synced pair of wheels: deployments/example/robots/arm.json has neither.
--twin, --ev3 and --ev3dev without a file use the example robot, deployments/example/robots/r1.json.

Paths: an absolute path is used as it is, and a leading ~ is the home folder. A relative path on the command line is taken from the repository
root, a relative path inside a --config file from that file's folder. The folder the server is started in
decides nothing. A file that is not there ends the start with its absolute path. The repository root is
  ${REPO}`;

/** --help: main.ts prints the usage and exits 0. */
export class HelpAsked extends Error {}

/** Every robot source has the name the person gave the robot: its file's `name`, or `--name`; null when none. */
export type RobotSource = (
  | {
      source: "twin";
      id: string;
      robot: RobotFile;
      /** The world's JSON with the robot's build (its file's `twin`) in place, checked against the profile. */
      world: unknown;
      seed: number;
      /** true when the build came from the robot file's `twin`, false when from the world. */
      ownBuild?: boolean;
      /** What of the build nobody confirmed (its file's `twin.unconfirmed`); empty for a twin that is not a draft. */
      unconfirmed?: Unconfirmed[];
      /**
       * The robot file's `twin`, checked (null without one): its `drive` is what the drivetrain physically is, and
       * every world `load_world` takes gets its build, like the one the twin started in.
       */
      build?: TwinBuild | null;
      /**
       * Every world of the folder its world file is in, its own included, by file name without `.json` (their
       * JSON as read, checked against the schema, not yet against this robot): the rooms `load_world` takes by name.
       */
      worlds?: Record<string, unknown>;
    }
  | { source: "ev3"; id: string; robot: RobotFile }
  | {
      source: "ev3dev";
      id: string;
      robot: RobotFile;
      hardware: Ev3devHardware;
      ssh: SshOptions;
      installBridge: boolean;
    }
  | { source: "pages"; id: string; profile: RobotProfile }
) & { name: string | null };
export interface LocalConfig {
  robots: RobotSource[];
  /** Port of the page that lends a stock EV3. Bound only when a robot of source "ev3" exists. */
  port: number;
  /** `--log-file`, absolute: the file that gets every JSON log line of stderr too. */
  logFile?: string;
  /** Peripheral pages (CONTRACT §2.4): null when off. On, every robot gets a page hub, and the page listener binds this port. */
  pages?: PagesConfig | null;
  /** `--view`: the 3D view of the twins on 127.0.0.1, at this port. Null or absent when off. */
  view?: { port: number; chat?: ChatConfig | null } | null;
}

export interface PagesConfig {
  port: number;
  /** `--lan`: the network listener. Absent when off. */
  lan?: LanConfig;
  /** `--page-origin`: the origin of the person's tunnel. Absent when off. */
  origin?: string;
  /** `--page-ext`: the absolute folder whose `.js` files the page loads after its kit. Absent when off. */
  ext?: string;
}

const ROBOT_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
/**
 * The name a person gave a robot (CONTRACT §3, `name`), trimmed and in NFC. Refused, naming `field`, when it is
 * not a string, empty, longer than MAX_NAME, or holds anything but letters, digits, spaces, ' . and - (so no
 * control character, line break, quote or shell character: it travels on command lines and onto the brick).
 */
export function parseRobotName(raw: unknown, field: string): string {
  if (typeof raw !== "string") throw new Error(`${field} must be a string (${NAME_RULE}), got ${JSON.stringify(raw)}`);
  const name = raw.normalize("NFC").trim();
  if (name === "") throw new Error(`${field} is empty: ${NAME_RULE}; leave it out for a robot with no name`);
  const length = [...name].length;
  if (length > MAX_NAME)
    throw new Error(`${field} has ${length} characters, at most ${MAX_NAME}: ${JSON.stringify(name)}`);
  if (!NAME_CHARS.test(name)) {
    const bad = [...name].find((c) => !NAME_CHARS.test(c))!;
    throw new Error(
      `${field} holds ${JSON.stringify(bad)} (U+${bad.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}): ${NAME_RULE}`,
    );
  }
  return name;
}
/** The `name` of a robot file's JSON, or null when it has none. */
function nameOf(raw: unknown, where: string): string | null {
  if (!isObj(raw) || raw.name === undefined) return null;
  return parseRobotName(raw.name, `${where}: name`);
}
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
  const extra = Object.keys(json).filter((k) => !["profile", "description", "name"].includes(k));
  if (extra.length)
    fail(extra.join(", "), "is not part of a robot without a body: its file is {profile, description?, name?}");
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

interface ReadRobot {
  file: RobotFile;
  raw: unknown;
  name: string | null;
  build: TwinBuild | null;
  path: string;
}
function robotFile(where: string, path: string): ReadRobot {
  const raw = readJson(where, path);
  const file = parseRobotFile(raw, `${where} ${path}`);
  return { file, raw, build: readBuild(raw, `${where} ${path}`), path, name: nameOf(raw, `${where} ${path}`) };
}
/** The world a twin of `r` runs in: the room read from `path`, with the robot's build in place. */
function twinWorld(
  r: ReadRobot,
  where: string,
  path: string,
): Pick<Source<"twin">, "world" | "ownBuild" | "unconfirmed" | "build" | "worlds"> {
  return {
    world: withBuild(world(where, path), r.build, r.file, { robot: r.path, world: `${where} ${path}` }),
    worlds: siblingWorlds(where, path),
    build: r.build,
    ownBuild: r.build !== null,
    unconfirmed: r.build?.unconfirmed ?? [],
  };
}
type Source<K extends RobotSource["source"]> = Extract<RobotSource, { source: K }>;
/** A private key ssh is told to use. Checked here: ssh itself goes on with its default keys when the file is missing. */
/** `--page-ext`: a folder that is there. Its files are listed at each request, so an edit shows on a reload. */
function extFolder(where: string, path: string): string {
  let dir: boolean;
  try {
    dir = statSync(path).isDirectory();
  } catch (e) {
    throw new Error(`${where}: cannot read the folder ${path}: ${(e as Error).message}`, { cause: e });
  }
  if (!dir) throw new Error(`${where}: ${path} is not a folder`);
  return path;
}
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
/** Largest file read as a possible world next to `--world` (a world file is a few kB). */
export const MAX_SIBLING_WORLD_BYTES = 1_000_000;
const DECLARES_WORLD = /"schema"\s*:\s*"spinecord\/world@1"/;
/**
 * The worlds of `path`'s folder by file name without `.json` (a folder cannot hold two of one name): each regular
 * `.json` file there, up to MAX_SIBLING_WORLD_BYTES, that declares `"schema": "spinecord/world@1"`. Anything else
 * there is not a world and is left alone: a folder, a dangling link, a bigger file, JSON of another kind, a file
 * that is not JSON and does not declare the schema. One that declares the schema and does not parse ends the start.
 * Whether this robot fits in each is checked when it is loaded, so a room another robot cannot use never stops this
 * one from starting.
 */
function siblingWorlds(where: string, path: string): Record<string, unknown> {
  const dir = dirname(path);
  const out: Record<string, unknown> = {};
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    const file = join(dir, f);
    let text: string;
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > MAX_SIBLING_WORLD_BYTES) continue;
      text = readFileSync(file, "utf8");
    } catch {
      continue; // gone, unreadable or a dangling link: not a world of this folder
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      if (!DECLARES_WORLD.test(text)) continue;
      throw new Error(`${where}: the world next to it ${file} is not valid JSON: ${(e as Error).message}`, {
        cause: e,
      });
    }
    if (!isObj(json) || json.schema !== WORLD_SCHEMA) continue;
    try {
      parseWorld(json);
    } catch (e) {
      throw new Error(`${where}: the world next to it ${file}: ${(e as Error).message}`, { cause: e });
    }
    out[f.slice(0, -".json".length)] = json;
  }
  return out;
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
  const unknown = Object.keys(json).filter((k) => !["port", "robots", "pages", "view"].includes(k));
  if (unknown.length)
    throw new Error(`${where}: unknown field ${unknown.join(", ")}; allowed: port, pages, view, robots`);
  let view: { port: number; chat?: ChatConfig | null } | null = null;
  if (json.view !== undefined && json.view !== false) {
    const v = json.view === true ? {} : json.view;
    if (!isObj(v) || Object.keys(v).some((k) => k !== "port" && k !== "chat"))
      throw new Error(`${where}: view must be true or {"port"?: n, "chat"?: true | {"model"?, "usd"?}}`);
    view = { port: v.port === undefined ? DEFAULT_VIEW_PORT : int(`${where}: view.port`, v.port, 0, 65535) };
    if (v.chat !== undefined && v.chat !== false) {
      const c = v.chat === true ? {} : v.chat;
      if (!isObj(c) || Object.keys(c).some((k) => k !== "model" && k !== "usd"))
        throw new Error(`${where}: view.chat must be true or {"model"?: id, "usd"?: n}`);
      view.chat = chatConfig(`${where}: view.chat`, c.model, c.usd);
    }
  }
  let pages: PagesConfig | null = null;
  if (json.pages !== undefined) {
    const shape = '{"port"?: n, "lan"?: true | {"interface"?, "cert"?, "key"?, "host"?}, "origin"?: url, "ext"?: path}';
    if (!isObj(json.pages) || Object.keys(json.pages).some((k) => !["port", "lan", "origin", "ext"].includes(k)))
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
    if (jp.ext !== undefined) {
      if (typeof jp.ext !== "string" || jp.ext === "") throw new Error(`${where}: pages.ext must be a path`);
      pages.ext = extFolder(`${where}: pages.ext`, pathFrom(dirname(file), jp.ext));
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
      const json = readJson(`${where}: ${f}.robot`, robotPath);
      const profile = parsePagesRobot(json, `${where}: ${f}.robot ${robotPath}`);
      pages ??= { port: DEFAULT_PAGE_PORT };
      return {
        source: "pages",
        id: r.id ?? profile.id,
        profile,
        name: nameOf(json, `${where}: ${f}.robot ${robotPath}`),
      };
    }
    const read = robotFile(`${where}: ${f}.robot`, robotPath);
    const { file, raw, name } = read;
    switch (r.source) {
      case "twin":
        return {
          source: "twin",
          id: r.id ?? twinId(file.profile.id),
          robot: file,
          ...twinWorld(read, `${where}: ${f}.world`, at(r.world, `${f}.world`)),
          seed: r.seed === undefined ? 1 : int(`${where}: ${f}.seed`, r.seed, 0, 0xffffffff),
          name,
        };
      case "ev3":
        return { source: "ev3", id: r.id ?? file.profile.id, robot: file, name };
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
          name,
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
    view,
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
      "page-ext": { type: "string" },
      view: { type: "boolean" },
      "view-port": { type: "string" },
      name: { type: "string" },
      chat: { type: "boolean" },
      "chat-model": { type: "string" },
      "chat-usd": { type: "string" },
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
    if (values["page-ext"] !== undefined) needs("page-ext", "pages", values.pages !== undefined);
    if (values["view-port"] !== undefined) needs("view-port", "view", values.view === true);
    if (values.chat !== undefined) needs("chat", "view", values.view === true);
    for (const flag of ["chat-model", "chat-usd"] as const)
      if (values[flag] !== undefined) needs(flag, "chat", values.chat === true);
    for (const flag of ["lan-interface", "lan-cert", "lan-key", "lan-host"] as const)
      if (values[flag] !== undefined) needs(flag, "lan", values.lan === true);
    if ((values["lan-cert"] === undefined) !== (values["lan-key"] === undefined))
      throw new Error("--lan-cert needs two files: --lan-cert <cert.pem> <key.pem>");
    if (values["lan-host"] !== undefined && values["lan-cert"] === undefined)
      throw new Error("--lan-host names the host of a certificate of your own: it needs --lan-cert");
    for (const flag of ["ssh", "ssh-key", "install-bridge"] as const)
      if (values[flag] !== undefined) needs(flag, "ev3dev", values.ev3dev !== undefined);
    // --view (with its chat flags, and --name) alone shows the twin a bare start runs
    if (
      given.length === 0 ||
      given.every((k) => ["view", "view-port", "chat", "chat-model", "chat-usd", "name"].includes(k))
    ) {
      const example = robotFile("example robot", EXAMPLE.robot);
      robots.push({
        source: "twin",
        id: twinId(example.file.profile.id),
        robot: example.file,
        ...twinWorld(example, "example world", EXAMPLE.world),
        seed: 1,
        name: example.name,
      });
    }
    if (values.ev3 !== undefined) {
      const { file, name } = robotFile("--ev3", fromRepo(values.ev3));
      robots.push({ source: "ev3", id: file.profile.id, robot: file, name });
    }
    if (values.ev3dev !== undefined) {
      if (values.ssh === undefined) throw new Error("--ev3dev needs --ssh <user@host>");
      const robotPath = fromRepo(values.ev3dev);
      const { file, raw, name } = robotFile("--ev3dev", robotPath);
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
        name,
      });
    }
    if (values.twin !== undefined) {
      const read = robotFile("--twin", fromRepo(values.twin));
      robots.push({
        source: "twin",
        id: twinId(read.file.profile.id),
        robot: read.file,
        ...twinWorld(read, "--world", values.world === undefined ? EXAMPLE.world : fromRepo(values.world)),
        seed: values.seed === undefined ? 1 : int("--seed", values.seed, 0, 0xffffffff),
        name: read.name,
      });
    }
    if (values.pages !== undefined) {
      const path = fromRepo(values.pages);
      const json = readJson("--pages", path);
      const profile = parsePagesRobot(json, `--pages ${path}`);
      robots.push({ source: "pages", id: profile.id, profile, name: nameOf(json, `--pages ${path}`) });
    }
    // the person's name for the robot wins over the files': a robot and its twin share it
    if (values.name !== undefined) {
      const name = parseRobotName(values.name, "--name");
      for (const r of robots) r.name = name;
    }
    config = {
      robots,
      port: values.port === undefined ? DEFAULT_PORT : int("--port", values.port, 1, 65535),
      view: values.view
        ? {
            port:
              values["view-port"] === undefined ? DEFAULT_VIEW_PORT : int("--view-port", values["view-port"], 0, 65535),
            ...(values.chat ? { chat: chatConfig("--chat", values["chat-model"], values["chat-usd"]) } : {}),
          }
        : null,
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
              ...(values["page-ext"] !== undefined
                ? { ext: extFolder("--page-ext", fromRepo(values["page-ext"])) }
                : {}),
            },
    };
  }
  if (config.pages && (config.pages.lan || config.pages.origin) && config.pages.port > 65533)
    throw new Error(
      `the page port is ${config.pages.port}: --lan takes the port after it and --page-origin the one after that; pick one up to 65533`,
    );
  if (config.view && !config.robots.some((r) => r.source === "twin"))
    throw new Error(
      '--view shows the simulated twins, and there is none: add --twin (a config file: a robot of source "twin")',
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
