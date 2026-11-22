// Inputs of the local server: command line, or one config file. Everything is checked here, before anything is
// built, and every failure names the flag or the field. Paths on the command line are relative to the working
// directory; paths in a config file are relative to that file.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseRobotFile, type RobotFile } from "../../../packages/driver-ev3/robot-file";
import type { Ev3devHardware } from "../../../packages/driver-ev3dev/src/provider";
import type { SshOptions } from "../../../packages/driver-ev3dev/src/ssh";
import { parseWorld } from "../../../packages/sim-world/world";

export const DEFAULT_PORT = 8767;
const REPO = join(import.meta.dir, "..", "..", "..");
/** What a bare `bun apps/local/main.ts` runs: the example robot's twin in an empty walled room. */
export const EXAMPLE = {
  robot: join(REPO, "deployments", "example", "robots", "r1.json"),
  world: join(import.meta.dir, "..", "examples", "room.json"),
};

export const USAGE = `usage: bun apps/local/main.ts [robots...]        MCP server over stdio; logs on stderr

  --help                         this text

  (no arguments)                 the example robot's twin (deployments/example/robots/r1.json) in
                                 apps/local/examples/room.json
  --twin <robot.json>            a simulated twin of that robot, id "<profile.id>-sim"
    --world <world.json>         its world, schema spinecord/world@1 (required with --twin)
    --seed <n>                   seed of the world's noise (default 1)
  --ev3 <robot.json>             a stock-firmware EV3 on USB, lent by a page in Chrome or Edge (WebHID)
    --port <n>                   port of that page on 127.0.0.1 (default ${DEFAULT_PORT})
  --ev3dev <robot.json>          an EV3 running ev3dev, over ssh
    --ssh <user@host[:port]>     where it is (required with --ev3dev); the key must already be accepted
    --ssh-key <file>             private key file (default: ssh's own keys and agent)
    --install-bridge             copy the bridge to the brick before connecting
  --config <file.json>           all of the above as a file, for more than one robot of a kind:
                                 {"port"?: n, "robots": [
                                   {"source": "twin", "robot": path, "world": path, "seed"?: n, "id"?: s},
                                   {"source": "ev3", "robot": path, "id"?: s},
                                   {"source": "ev3dev", "robot": path, "id"?: s, "install_bridge"?: bool,
                                    "ssh": {"host": s, "user": s, "port"?: n, "identity_file"?: path}}]}

A robot file is {pair, hardware, profile} (deployments/example/robots/r1.json); for --ev3dev its hardware also
needs speech_volume_pct.`;

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
    };
export interface LocalConfig {
  robots: RobotSource[];
  /** Port of the page that lends a stock EV3. Bound only when a robot of source "ev3" exists. */
  port: number;
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
function robotFile(where: string, path: string): { file: RobotFile; raw: unknown } {
  const raw = readJson(where, path);
  return { file: parseRobotFile(raw, `${where} ${path}`), raw };
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
  };
}
const twinId = (base: string): string => (base.endsWith("-sim") ? base : `${base}-sim`);

/** "user@host" or "user@host:port". The driver checks the characters of each part. */
export function parseSshTarget(where: string, target: string): SshOptions {
  const m = target.match(/^([^@\s]+)@([^@\s:]+)(?::(\d+))?$/);
  if (!m) throw new Error(`${where} must look like user@host or user@host:port, got ${target}`);
  return { user: m[1]!, host: m[2]!, ...(m[3] ? { port: int(`${where} port`, m[3], 1, 65535) } : {}) };
}

function fromFile(path: string): LocalConfig {
  const where = `--config ${path}`;
  const json = readJson("--config", path);
  if (!isObj(json)) throw new Error(`${where}: must be an object {"robots": [...]}`);
  const unknown = Object.keys(json).filter((k) => k !== "port" && k !== "robots");
  if (unknown.length) throw new Error(`${where}: unknown field ${unknown.join(", ")}; allowed: port, robots`);
  if (!Array.isArray(json.robots) || json.robots.length === 0)
    throw new Error(`${where}: robots must be a non-empty array`);
  const at = (p: unknown, field: string): string => {
    if (typeof p !== "string" || p === "") throw new Error(`${where}: ${field} must be a path`);
    return resolve(dirname(path), p);
  };
  const robots = json.robots.map((r, i): RobotSource => {
    const f = `robots[${i}]`;
    if (!isObj(r)) throw new Error(`${where}: ${f} must be an object`);
    const { file, raw } = robotFile(`${where}: ${f}.robot`, at(r.robot, `${f}.robot`));
    if (r.id !== undefined && typeof r.id !== "string") throw new Error(`${where}: ${f}.id must be a string`);
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
          hardware: ev3devHardware(`${where}: ${f}.robot`, file, raw),
          ssh: {
            host: r.ssh.host,
            user: r.ssh.user,
            ...(r.ssh.port !== undefined ? { port: int(`${where}: ${f}.ssh.port`, r.ssh.port, 1, 65535) } : {}),
            ...(r.ssh.identity_file !== undefined
              ? { identityFile: at(r.ssh.identity_file, `${f}.ssh.identity_file`) }
              : {}),
          },
          installBridge: r.install_bridge === true,
        };
      }
      default:
        throw new Error(`${where}: ${f}.source must be "twin", "ev3" or "ev3dev", got ${JSON.stringify(r.source)}`);
    }
  });
  return {
    robots,
    port: json.port === undefined ? DEFAULT_PORT : int(`${where}: port`, json.port, 1, 65535),
  };
}

/** Reads the command line and every file it names. Throws with a message for the person at the terminal. */
export function loadConfig(argv: string[]): LocalConfig {
  const { values } = parseArgs({
    args: argv,
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
    },
  });
  if (values.help) throw new HelpAsked();
  const given = Object.keys(values);
  let config: LocalConfig;
  if (values.config !== undefined) {
    if (given.length > 1)
      throw new Error(
        `--config holds everything: remove ${given
          .filter((k) => k !== "config")
          .map((k) => `--${k}`)
          .join(", ")}`,
      );
    config = fromFile(resolve(values.config));
  } else {
    const robots: RobotSource[] = [];
    const needs = (flag: string, owner: string, on: boolean) => {
      if (!on) throw new Error(`--${flag} needs --${owner}`);
    };
    if (values.world !== undefined) needs("world", "twin", values.twin !== undefined);
    if (values.seed !== undefined) needs("seed", "twin", values.twin !== undefined);
    if (values.port !== undefined) needs("port", "ev3", values.ev3 !== undefined);
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
      const { file } = robotFile("--ev3", resolve(values.ev3));
      robots.push({ source: "ev3", id: file.profile.id, robot: file });
    }
    if (values.ev3dev !== undefined) {
      if (values.ssh === undefined) throw new Error("--ev3dev needs --ssh <user@host>");
      const { file, raw } = robotFile("--ev3dev", resolve(values.ev3dev));
      robots.push({
        source: "ev3dev",
        id: file.profile.id,
        robot: file,
        hardware: ev3devHardware(`--ev3dev ${values.ev3dev}`, file, raw),
        ssh: {
          ...parseSshTarget("--ssh", values.ssh),
          ...(values["ssh-key"] !== undefined ? { identityFile: resolve(values["ssh-key"]) } : {}),
        },
        installBridge: values["install-bridge"] === true,
      });
    }
    if (values.twin !== undefined) {
      if (values.world === undefined) throw new Error("--twin needs --world <world.json>");
      const { file } = robotFile("--twin", resolve(values.twin));
      robots.push({
        source: "twin",
        id: twinId(file.profile.id),
        robot: file,
        world: world("--world", resolve(values.world)),
        seed: values.seed === undefined ? 1 : int("--seed", values.seed, 0, 0xffffffff),
      });
    }
    config = { robots, port: values.port === undefined ? DEFAULT_PORT : int("--port", values.port, 1, 65535) };
  }
  const ids = config.robots.map((r) => r.id);
  for (const id of ids)
    if (!ROBOT_ID.test(id))
      throw new Error(`robot id ${JSON.stringify(id)}: lowercase letters, digits, _ and -, at most 48 characters`);
  const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (twice.length) throw new Error(`each robot needs its own id, got ${twice[0]} twice: set "id" in a --config file`);
  if (config.robots.filter((r) => r.source === "ev3").length > 1)
    throw new Error("one stock-firmware EV3 per process: the page lends one brick");
  return config;
}
