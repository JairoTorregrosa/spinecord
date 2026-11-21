// Inputs of the twin runner: command line and files. Everything is checked here, before anything is built,
// and every failure names the flag or the field (fail loud: no defaults for a missing input).
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseRobotFile, type RobotFile } from "../../packages/driver-ev3/robot-file";
import { parseWorld } from "../../packages/sim-world/world";

export const USAGE = `usage: bun apps/twin-runner/main.ts --server <ws url> --token-file <path> --profile <robot.json> --world <world.json>
         [--robot-id <id>-sim]... [--seed <n>] [--view [--view-port <port>]]

  --server      relay WebSocket endpoint, e.g. ws://127.0.0.1:8787/ws/robot
  --token-file  file holding the token of a "runtime" credential bound to the robot ids
  --profile     robot file: {pair: {left, right}, hardware: {...}, profile: RobotProfile} (deployments/example/robots/r1.json)
  --world       world file, schema spinecord/world@1 (packages/sim-world/examples/)
  --robot-id    twin to run, must end in -sim; repeat it to run several twins of the same robot.
                Without it: the profile's id plus -sim
  --seed        seed of the world's noise (integer, default 1)
  --view        serve the viewer for the running twins on http://127.0.0.1:<view-port> (default port 8765)`;

export interface RunnerConfig {
  server: string;
  token: string;
  robot: RobotFile;
  /** The world file as written (parsed JSON, already validated). */
  world: unknown;
  worldName: string;
  robotIds: string[];
  seed: number;
  view: { port: number } | null;
}

const ROBOT_ID = /^[a-z0-9][a-z0-9_-]{0,43}-sim$/;

function readText(flag: string, path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`${flag}: cannot read ${path}: ${(e as Error).message}`, { cause: e });
  }
}
function readJson(flag: string, path: string): unknown {
  const text = readText(flag, path);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${flag}: ${path} is not valid JSON: ${(e as Error).message}`, { cause: e });
  }
}

/** Reads the command line and every file it names. Throws with a message for the person at the terminal. */
export function loadConfig(argv: string[]): RunnerConfig {
  let values: {
    server?: string;
    "token-file"?: string;
    profile?: string;
    world?: string;
    "robot-id"?: string[];
    seed?: string;
    view?: boolean;
    "view-port"?: string;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        server: { type: "string" },
        "token-file": { type: "string" },
        profile: { type: "string" },
        world: { type: "string" },
        "robot-id": { type: "string", multiple: true },
        seed: { type: "string" },
        view: { type: "boolean" },
        "view-port": { type: "string" },
      },
    }));
  } catch (e) {
    throw new Error((e as Error).message, { cause: e });
  }
  const need = (flag: "server" | "token-file" | "profile" | "world"): string => {
    const v = values[flag];
    if (v === undefined || v === "") throw new Error(`--${flag} is required`);
    return v;
  };

  const server = need("server");
  let url: URL | undefined;
  try {
    url = new URL(server);
  } catch {
    /* reported below */
  }
  if (!url || (url.protocol !== "ws:" && url.protocol !== "wss:"))
    throw new Error(`--server must be a ws:// or wss:// URL (the relay's /ws/robot), got ${server}`);

  const tokenFile = need("token-file");
  const token = readText("--token-file", tokenFile).trim();
  if (token === "") throw new Error(`--token-file: ${tokenFile} is empty`);
  if (/\s/.test(token)) throw new Error(`--token-file: ${tokenFile} must hold one token and nothing else`);

  const profilePath = need("profile");
  const robot = parseRobotFile(readJson("--profile", profilePath), `--profile ${profilePath}`);

  const worldPath = need("world");
  const world = readJson("--world", worldPath);
  let worldName: string;
  try {
    worldName = parseWorld(world).name;
  } catch (e) {
    throw new Error(`--world ${worldPath}: ${(e as Error).message}`, { cause: e });
  }

  const base = robot.profile.id;
  const robotIds = values["robot-id"] ?? [base.endsWith("-sim") ? base : `${base}-sim`];
  for (const id of robotIds)
    if (!ROBOT_ID.test(id))
      throw new Error(
        `--robot-id ${id}: a twin id is lowercase letters, digits, _ and -, at most 48 characters, and ends in -sim`,
      );
  if (new Set(robotIds).size !== robotIds.length)
    throw new Error(`--robot-id: each twin needs its own id, got ${robotIds.join(", ")}`);

  const int = (flag: string, raw: string, min: number, max: number): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`--${flag} must be an integer ${min}..${max}, got ${raw}`);
    return n;
  };
  const seed = values.seed === undefined ? 1 : int("seed", values.seed, 0, 0xffffffff);
  if (values["view-port"] !== undefined && !values.view) throw new Error("--view-port needs --view");
  const view = values.view
    ? { port: values["view-port"] === undefined ? 8765 : int("view-port", values["view-port"], 0, 65535) }
    : null;

  return { server, token, robot, world, worldName, robotIds, seed, view };
}
