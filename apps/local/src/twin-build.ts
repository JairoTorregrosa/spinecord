// A robot's build, as its twin needs it (CONTRACT §3, `twin`): the footprint, what is plugged into each port and
// how it looks, carried by the robot file so that the twin is that robot in any world. The packages read these
// as world sections (`body`, `extensions.ev3`, `extensions.view`), so the build is merged into the world's JSON
// here, before anything is built: the brick, the physics, `load_world` by name and the 3D view then all see the
// robot's own build. Pure: no I/O.
import type { RobotFile } from "../../../packages/driver-ev3/robot-file";
import { parseBrickPorts, type BrickPorts } from "../../../packages/sim-ev3/ports";
import { parseWorld, type BodyShape } from "../../../packages/sim-world/world";

/** The top-level keys of a robot file; anything else is a typo that would otherwise go unnoticed. */
const FILE_KEYS = ["description", "hardware", "profile", "pair", "twin"];
const TWIN_KEYS = ["body", "ev3", "view"];

export interface TwinBuild {
  body?: unknown;
  ev3?: unknown;
  view?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The top-level keys of a robot file and its `twin` section, checked on every read of a robot file (any source).
 * The section's fields are checked by `withBuild`, against the world they go into. `where` prefixes every message.
 */
export function readBuild(raw: unknown, where: string): TwinBuild | null {
  if (!isObj(raw)) return null; // parseRobotFile says what is wrong with it
  for (const k of Object.keys(raw))
    if (!FILE_KEYS.includes(k))
      throw new Error(`${where}: ${k} is not a part of a robot file (${FILE_KEYS.join(", ")})`);
  if (raw.twin === undefined) return null;
  if (!isObj(raw.twin))
    throw new Error(`${where}: twin must be an object {body?, ev3?, view?}, got ${JSON.stringify(raw.twin)}`);
  for (const k of Object.keys(raw.twin))
    if (!TWIN_KEYS.includes(k)) throw new Error(`${where}: twin.${k} is not a part of twin (${TWIN_KEYS.join(", ")})`);
  const t = raw.twin;
  if (t.view !== undefined && !isObj(t.view))
    throw new Error(
      `${where}: twin.view must be an object (how the twin looks; see the header of apps/twin-view/src/look.ts)`,
    );
  // the fields, without a world: a twin's file and a robot on hardware fail on the same bad field
  ownSections(t, where);
  return { ...t };
}

/** `body` and `ev3` of a build, each through the packages' own validator, its errors named `twin.<field>`. */
function ownSections(t: TwinBuild, where: string): { body: BodyShape | null; ports: BrickPorts | null } {
  const rename = (e: unknown, from: string, to: string): never => {
    const m = (e as Error).message.replace(`world file: ${from}`, `twin.${to}`);
    throw new Error(`${where}: ${m}`, { cause: e });
  };
  let body: BodyShape | null = null;
  if (t.body !== undefined)
    try {
      body = parseWorld({ ...EMPTY_WORLD, body: t.body }).body;
    } catch (e) {
      rename(e, "body", "body");
    }
  let ports: BrickPorts | null = null;
  if (t.ev3 !== undefined)
    try {
      ports = parseBrickPorts(t.ev3);
    } catch (e) {
      rename(e, "extensions.ev3", "ev3");
    }
  return { body, ports };
}
/** The smallest world: only so that `body` goes through the one body validator there is. */
const EMPTY_WORLD = {
  schema: "spinecord/world@1",
  name: "twin",
  arena: { width_cm: 1, height_cm: 1 },
  start: { x: 0, y: 0, heading_deg: 0 },
};

/**
 * The world JSON a twin runs in: the room, with the robot's build in place of the world's when the robot file has
 * `twin` (the whole build: a section it leaves out takes the package default, never another robot's). Then the
 * ports are checked against the profile. Throws naming the file and the field.
 */
export function withBuild(
  world: unknown,
  build: TwinBuild | null,
  robot: RobotFile,
  names: { robot: string; world: string },
): unknown {
  const w = world as Record<string, unknown>;
  let out = w;
  if (build) {
    const ext = isObj(w.extensions) ? { ...w.extensions } : {};
    delete ext.ev3;
    delete ext.view;
    if (build.ev3 !== undefined) ext.ev3 = build.ev3;
    if (build.view !== undefined) ext.view = build.view;
    out = { ...w, extensions: ext };
    delete out.body;
    if (build.body !== undefined) out.body = build.body;
  }
  const cfg = parseWorld(out); // the world itself was checked when it was read, the build by readBuild
  const ev3 = cfg.extensions.ev3;
  const from = build ? `${names.robot}: twin.ev3` : `${names.world}: extensions.ev3`;
  let ports: BrickPorts = { motors: {}, sensors: {} };
  try {
    if (ev3 !== undefined) ports = parseBrickPorts(ev3);
  } catch (e) {
    // the build's own ev3 was checked by readBuild: this is the world's
    throw new Error(`${names.world}: ${(e as Error).message}`, { cause: e });
  }
  checkPorts(robot, ports, { build: !!build, from, robot: names.robot, world: names.world });
  return out;
}

/** Roles, heading and pair against the ports the twin has. */
function checkPorts(
  robot: RobotFile,
  ports: BrickPorts,
  at: { build: boolean; from: string; robot: string; world: string },
): void {
  const where = at.build
    ? `${at.from} (in the robot file)`
    : `${at.from} (in the world: this robot file has no twin section, so its twin takes the world's ports)`;
  const fix = (field: string, plug: string) =>
    at.build
      ? `add ${plug} to twin.ev3 of ${at.robot}, or change ${field}`
      : `add a twin section to ${at.robot} with ${plug} in twin.ev3 (what is plugged into this robot), or change ${field}`;
  const list = (o: object) =>
    Object.entries(o)
      .map(([p, k]) => `${p} ${k}`)
      .join(", ") || "nothing";
  const plugged = `motors: ${list(ports.motors)}; sensors: ${list(ports.sensors)}`;
  const need = (field: string, device: string) => {
    const m = /^ev3\.([A-D])$/.exec(device);
    if (m && !ports.motors[m[1] as keyof BrickPorts["motors"]])
      throw new Error(
        `${at.robot}: ${field} names ${device}, and the twin has no motor on port ${m[1]} (${where} has ${plugged}): ${fix(field, `"motors": {"${m[1]}": "large"} (or "medium")`)}`,
      );
    const s = /^ev3\.S([1-4])$/.exec(device);
    if (s && !ports.sensors[s[1] as keyof BrickPorts["sensors"]])
      throw new Error(
        `${at.robot}: ${field} names ${device}, and the twin has no sensor on port ${s[1]} (${where} has ${plugged}): ${fix(field, `"sensors": {"${s[1]}": "<touch|color|ultrasonic|gyro|ir>"}`)}`,
      );
  };
  const { profile, pair } = robot;
  for (const [role, device] of Object.entries(profile.roles)) need(`profile.roles.${role}`, device);
  const d = profile.drivetrain;
  if (d?.heading && !(d.heading.device in profile.roles)) need("profile.drivetrain.heading.device", d.heading.device);
  if (d && d.pair_device.startsWith("ev3.") && d.pair_device !== "ev3.pair")
    throw new Error(
      `${at.robot}: profile.drivetrain.pair_device must be "ev3.pair" (the synced pair of the ports in pair), got ${JSON.stringify(d.pair_device)}`,
    );
  if (pair)
    for (const side of ["left", "right"] as const)
      if (!ports.motors[pair[side]])
        throw new Error(
          `${at.robot}: pair.${side} is port ${pair[side]}, and the twin has no motor there (${where} has ${plugged}): ${fix(`pair.${side}`, `"motors": {"${pair[side]}": "large"}`)}`,
        );
}

/** One line of what a twin will have, for `--doctor`: ports, pair and drivetrain, footprint, and where they came from. */
export function describeTwin(robot: RobotFile, world: unknown, ownBuild: boolean): string {
  const cfg = parseWorld(world);
  const ports = cfg.extensions.ev3 === undefined ? { motors: {}, sensors: {} } : parseBrickPorts(cfg.extensions.ev3);
  const roleOf = new Map(Object.entries(robot.profile.roles).map(([r, dev]) => [dev, r]));
  const port = (id: string, kind: string) =>
    `${id} ${kind}${roleOf.has(`ev3.${id}`) ? ` (${roleOf.get(`ev3.${id}`)})` : ""}`;
  const motors = Object.entries(ports.motors).map(([p, k]) => port(p, k));
  const sensors = Object.entries(ports.sensors).map(([p, k]) => port(`S${p}`, k));
  const d = robot.profile.drivetrain;
  const drive = d
    ? `pair ${robot.pair!.left}+${robot.pair!.right}, wheel ${d.wheel_diameter_cm} cm, axle track ${d.axle_track_cm} cm, forward_sign ${d.forward_sign}, heading from ${d.heading ? `${d.heading.device}.${d.heading.channel}` : "the wheel encoders"}`
    : robot.pair
      ? `pair ${robot.pair.left}+${robot.pair.right}, no drivetrain`
      : "no drivetrain";
  const b = cfg.body;
  const kinds: string[] = Object.values(ports.sensors);
  const look = cfg.extensions.view;
  return [
    `ports ${[...motors, ...sensors].join(", ") || "none"}`,
    drive,
    [
      `footprint ${b.front_cm} cm ahead of the axle, ${b.back_cm} behind, ${2 * b.half_width_cm} wide`,
      ...(kinds.includes("color") ? [`color sensor ${b.color_sensor_x_cm} cm ahead`] : []),
      ...(kinds.includes("ultrasonic") || kinds.includes("ir")
        ? [`distance sensor ${b.distance_sensor_x_cm} cm ahead`]
        : []),
    ].join(", "),
    `look ${isObj(look) ? Object.keys(look).join(", ") || "default" : "default"}`,
    ownBuild ? "build from the robot file's twin" : "build from the world (the robot file has no twin)",
  ].join("; ");
}
