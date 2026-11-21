// Inputs of the twin runner: command line and files. Everything is checked here, before anything is built,
// and every failure names the flag or the field (fail loud: no defaults for a missing input).
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Ev3Hardware } from "../../packages/driver-ev3/provider";
import type { Limits, RobotProfile } from "../../packages/protocol/types";
import type { MotorPort } from "../../packages/sim-ev3/ports";
import { parseWorld } from "../../packages/sim-world/world";

export const USAGE = `usage: bun apps/twin-runner/main.ts --server <ws url> --token-file <path> --profile <robot.json> --world <world.json>
         [--robot-id <id>-sim]... [--seed <n>] [--view [--view-port <port>]]

  --server      relay WebSocket endpoint, e.g. ws://127.0.0.1:8787/ws/robot
  --token-file  file holding the bearer token of a principal that may see the robot ids
  --profile     robot file: {pair: {left, right}, hardware: {...}, profile: RobotProfile} (deployments/example/robots/r1.json)
  --world       world file, schema spinecord/world@1 (packages/sim-world/examples/)
  --robot-id    twin to run, must end in -sim; repeat it to run several twins of the same robot.
                Without it: the profile's id plus -sim
  --seed        seed of the world's noise (integer, default 1)
  --view        serve the viewer for the running twins on http://127.0.0.1:<view-port> (default port 8765)`;

/** The robot file: what a provider and a twin need beyond the contract's profile. */
export interface RobotFile {
  pair: { left: MotorPort; right: MotorPort };
  hardware: Ev3Hardware;
  profile: RobotProfile;
}
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
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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

/** Validates a robot file. `where` prefixes every message (the path it was read from). */
export function parseRobotFile(json: unknown, where: string): RobotFile {
  const fail = (field: string, why: string): never => {
    throw new Error(`${where}: ${field} ${why}`);
  };
  const obj = (v: unknown, field: string): Record<string, unknown> => (isObj(v) ? v : fail(field, "must be an object"));
  const positive = (v: unknown, field: string): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0
      ? v
      : fail(field, `must be a number > 0, got ${JSON.stringify(v)}`);
  const text = (v: unknown, field: string): string =>
    typeof v === "string" && v !== "" ? v : fail(field, `must be a non-empty string, got ${JSON.stringify(v)}`);
  const port = (v: unknown, field: string): MotorPort =>
    v === "A" || v === "B" || v === "C" || v === "D"
      ? v
      : fail(field, `must be a motor port A, B, C or D, got ${JSON.stringify(v)}`);

  const root = obj(json, "the file");
  const pairIn = obj(root.pair, "pair");
  const pair = { left: port(pairIn.left, "pair.left"), right: port(pairIn.right, "pair.right") };
  if (pair.left === pair.right) fail("pair", `needs two different ports, got ${pair.left} twice`);

  const hw = obj(root.hardware, "hardware");
  const hardware: Ev3Hardware = {
    low_battery_v: positive(hw.low_battery_v, "hardware.low_battery_v"),
    max_tone_ms: positive(hw.max_tone_ms, "hardware.max_tone_ms"),
    tone_volume_pct: positive(hw.tone_volume_pct, "hardware.tone_volume_pct"),
  };

  const p = obj(root.profile, "profile");
  const roles = obj(p.roles, "profile.roles");
  for (const [role, device] of Object.entries(roles)) text(device, `profile.roles.${role}`);
  const lim = obj(p.limits, "profile.limits");
  const limits: Limits = {
    max_speed_pct: positive(lim.max_speed_pct, "profile.limits.max_speed_pct"),
    max_command_ms: positive(lim.max_command_ms, "profile.limits.max_command_ms"),
    max_drive_cm: positive(lim.max_drive_cm, "profile.limits.max_drive_cm"),
    max_turn_deg: positive(lim.max_turn_deg, "profile.limits.max_turn_deg"),
    max_program_ms: positive(lim.max_program_ms, "profile.limits.max_program_ms"),
  };
  if (!Array.isArray(p.notes) || p.notes.some((n) => typeof n !== "string"))
    fail("profile.notes", "must be an array of strings");
  const profile: RobotProfile = {
    id: text(p.id, "profile.id"),
    roles: roles as Record<string, string>,
    limits,
    notes: p.notes as string[],
  };
  if (p.drivetrain !== undefined) {
    const d = obj(p.drivetrain, "profile.drivetrain");
    if (d.type !== "differential")
      fail("profile.drivetrain.type", `must be "differential", got ${JSON.stringify(d.type)}`);
    if (d.forward_sign !== 1 && d.forward_sign !== -1)
      fail("profile.drivetrain.forward_sign", `must be 1 or -1, got ${JSON.stringify(d.forward_sign)}`);
    profile.drivetrain = {
      type: "differential",
      pair_device: text(d.pair_device, "profile.drivetrain.pair_device"),
      wheel_diameter_cm: positive(d.wheel_diameter_cm, "profile.drivetrain.wheel_diameter_cm"),
      axle_track_cm: positive(d.axle_track_cm, "profile.drivetrain.axle_track_cm"),
      forward_sign: d.forward_sign as 1 | -1,
    };
  }
  return { pair, hardware, profile };
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
