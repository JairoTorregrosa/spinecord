// A robot's build, as its twin needs it (CONTRACT §3, `twin`): the footprint, what is plugged into each port and
// how it looks, carried by the robot file so that the twin is that robot in any world. The packages read these
// as world sections (`body`, `extensions.ev3`, `extensions.view`), so the build is merged into the world's JSON
// here, before anything is built: the brick, the physics, `load_world` by name and the 3D view then all see the
// robot's own build. Pure: no I/O.
import type { RobotFile } from "../../../packages/driver-ev3/robot-file";
import { TREAD_GRIP, type PhysicalDrive, type Tread } from "../../../packages/sim-ev3/brick";
import { parseBrickPorts, type BrickPorts } from "../../../packages/sim-ev3/ports";
import { parseWorld, type BodyShape } from "../../../packages/sim-world/world";
import rolling from "../../../packages/lego-parts/data/rolling.json";

/** The top-level keys of a robot file; anything else is a typo that would otherwise go unnoticed. */
const FILE_KEYS = ["description", "name", "hardware", "profile", "pair", "twin"];
const TWIN_KEYS = ["body", "ev3", "view", "drive", "unconfirmed"];
const DRIVE_KEYS = ["wheel_diameter_cm", "axle_track_cm", "turn_scrub", "mass_g", "grip", "tread"] as const;
const NUMERIC_DRIVE_KEYS = ["wheel_diameter_cm", "axle_track_cm", "turn_scrub", "mass_g", "grip"] as const;

/** What of a build nobody confirmed (CONTRACT §3, `twin.unconfirmed`). The ones that change how the robot moves first. */
export const MOVES = [
  "A",
  "B",
  "C",
  "D",
  "S1",
  "S2",
  "S3",
  "S4",
  "left_right",
  "front",
  "drive",
  "wheel_diameter",
  "axle_track",
] as const;
export const UNCONFIRMED = [...MOVES, "footprint", "places"] as const;
export type Unconfirmed = (typeof UNCONFIRMED)[number];

export interface TwinBuild {
  body?: unknown;
  ev3?: unknown;
  view?: unknown;
  /** The drivetrain as the robot physically is (CONTRACT §3, `twin.drive`), checked; absent fields are the profile's. */
  drive?: PhysicalDrive;
  unconfirmed?: Unconfirmed[];
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
  if (isObj(t.view) && "unconfirmed" in t.view)
    throw new Error(
      `${where}: twin.view.unconfirmed is not a field of the look: list what is unconfirmed in twin.unconfirmed, the page receives it from there`,
    );
  const profile = isObj(raw.profile) ? raw.profile : {};
  const unconfirmed = readUnconfirmed(t.unconfirmed, where, {
    pair: raw.pair !== undefined,
    drivetrain: profile.drivetrain !== undefined,
  });
  const drive = readDrive(t.drive, where, profile.drivetrain !== undefined);
  return {
    ...t,
    ...(drive === undefined ? {} : { drive }),
    ...(unconfirmed === undefined ? {} : { unconfirmed }),
  } as TwinBuild;
}

/**
 * `twin.drive`: what the drivetrain physically is, where it differs from what the profile believes. The twin rolls
 * on these and the runtime plans with the profile, so correcting the profile corrects the twin as it does the robot.
 */
function readDrive(v: unknown, where: string, hasDrivetrain: boolean): PhysicalDrive | undefined {
  if (v === undefined) return undefined;
  const at = `${where}: twin.drive`;
  if (!isObj(v)) throw new Error(`${at} must be an object {${DRIVE_KEYS.join("?, ")}?}, got ${JSON.stringify(v)}`);
  if (!hasDrivetrain)
    throw new Error(
      `${at} is how the drivetrain physically is, and this file has no profile.drivetrain: remove twin.drive`,
    );
  const out: PhysicalDrive = {};
  for (const [k, x] of Object.entries(v)) {
    if (!(DRIVE_KEYS as readonly string[]).includes(k))
      throw new Error(`${at}.${k} is not a part of twin.drive (${DRIVE_KEYS.join(", ")})`);
    if (k === "tread") {
      // the kind of tread names its grip (TREAD_GRIP); a measured grip says it more precisely, so not both
      if (typeof x !== "string" || !(x in TREAD_GRIP))
        throw new Error(`${at}.tread must be one of ${Object.keys(TREAD_GRIP).join(", ")}, got ${JSON.stringify(x)}`);
      if ("grip" in v)
        throw new Error(`${at}: give tread or grip, not both (tread ${x} means grip ${TREAD_GRIP[x as Tread]})`);
      out.grip = TREAD_GRIP[x as Tread];
      continue;
    }
    const scrub = k === "turn_scrub";
    const what = scrub
      ? "a number from 0 up to (not including) 1, the share of a turn lost"
      : k === "mass_g"
        ? "a number > 0 (what the robot weighs, in grams)"
        : k === "grip"
          ? "a number > 0 (the friction coefficient of its tread on the floor)"
          : "a number > 0 (cm)";
    if (typeof x !== "number" || !Number.isFinite(x) || (scrub ? !(x >= 0 && x < 1) : !(x > 0)))
      throw new Error(`${at}.${k} must be ${what}, got ${JSON.stringify(x)}`);
    out[k as (typeof NUMERIC_DRIVE_KEYS)[number]] = x;
  }
  if ((out.mass_g === undefined) !== (out.grip === undefined))
    throw new Error(
      `${at}: mass_g and grip (or tread) go together (the tread's traction is grip x weight): give both, or neither for the default push and no slip`,
    );
  return out;
}

function readUnconfirmed(
  v: unknown,
  where: string,
  has: { pair: boolean; drivetrain: boolean },
): Unconfirmed[] | undefined {
  if (v === undefined) return undefined;
  const at = `${where}: twin.unconfirmed`;
  if (!Array.isArray(v))
    throw new Error(
      `${at} must be a list of what nobody confirmed, from ${UNCONFIRMED.join(", ")}; got ${JSON.stringify(v)}`,
    );
  const seen = new Set<string>();
  for (const x of v) {
    if (typeof x !== "string" || !(UNCONFIRMED as readonly string[]).includes(x))
      throw new Error(`${at}: ${JSON.stringify(x)} is not one of ${UNCONFIRMED.join(", ")}`);
    if (seen.has(x)) throw new Error(`${at}: ${x} is listed twice`);
    seen.add(x);
    if (x === "left_right" && !has.pair)
      throw new Error(
        `${at}: left_right needs a pair (which of its two ports drives the left side); this file has no pair: remove left_right`,
      );
    if ((x === "wheel_diameter" || x === "axle_track") && !has.drivetrain)
      throw new Error(`${at}: ${x} needs profile.drivetrain, and this file has none: remove ${x}`);
  }
  return v as Unconfirmed[];
}

/** The draft line of `--doctor`: `ports B, C, S4; front; wheel diameter`, in the order of UNCONFIRMED. */
export function describeUnconfirmed(list: readonly Unconfirmed[]): string {
  const ports = UNCONFIRMED.filter((u) => /^S?[A-D1-4]$/.test(u) && list.includes(u));
  const rest = UNCONFIRMED.filter((u) => !/^S?[A-D1-4]$/.test(u) && list.includes(u)).map((u) =>
    u === "left_right" ? "left/right" : u.replace("_", " "),
  );
  const moves = list.filter((u) => (MOVES as readonly string[]).includes(u)).length;
  return `${list.length} unconfirmed (${moves} change how it moves): ${[...(ports.length ? [`port${ports.length > 1 ? "s" : ""} ${ports.join(", ")}`] : []), ...rest].join("; ")}`;
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
    // the page reads only extensions.view, so the draft list rides there
    if (build.unconfirmed?.length)
      ext.view = { ...(isObj(build.view) ? build.view : {}), unconfirmed: build.unconfirmed };
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
    if (device === "ev3.pair" && !robot.pair)
      throw new Error(
        `${at.robot}: ${field} names ev3.pair, and the file has no pair: add "pair": {"left": <port>, "right": <port>} with the two drive motors, or change ${field}`,
      );
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
/** A build no robot can have: wheels further apart than the body is wide. Null when the file is consistent. */
/** One tyre's or track's width in cm, from the parts map: the track the look names (else the one rolling nearest the
 * wheel diameter), or the EV3 tyre nearest the wheel diameter. */
function treadWidthCm(build: TwinBuild | undefined, diameter: number): number {
  const part = (key: string) => {
    const p = rolling.parts.find((x) => x.key === key);
    if (!p) throw new Error(`lego-parts: no ${key} in rolling.json`);
    return { d: (p.outer_diameter_mm?.value ?? 0) / 10, w: p.width_mm.value / 10 };
  };
  const view = build?.view as { drive?: string; track?: string } | undefined;
  if (view?.drive === "tracks") {
    const kind = view.track ?? (Math.abs(diameter - 3.68) <= Math.abs(diameter - 5.52) ? "rubber" : "links");
    return part(kind === "rubber" ? "track_rubber" : "tread_link").w;
  }
  const tyres = ["tyre_56x28", "tyre_43x22", "tyre_69x36"].map(part);
  return tyres.reduce((a, b) => (Math.abs(b.d - diameter) < Math.abs(a.d - diameter) ? b : a)).w;
}

/** A footprint the file writes is at least the axle track plus one tyre or track width on each side; the package's
 * default footprint (no `twin.body.half_width_cm`) only at least the axle track. */
export function footprintClash(robot: RobotFile, world: unknown, build?: TwinBuild): string | null {
  const d = robot.profile.drivetrain;
  if (d?.axle_track_cm === undefined) return null;
  const width = 2 * parseWorld(world).body.half_width_cm;
  const written = (build?.body as { half_width_cm?: number } | undefined)?.half_width_cm !== undefined;
  if (!written)
    return d.axle_track_cm > width ? `axle track ${d.axle_track_cm} cm is wider than the footprint (${width} cm wide)` : null;
  const need = Math.round((d.axle_track_cm + 2 * treadWidthCm(build, d.wheel_diameter_cm)) * 10) / 10;
  return width < need
    ? `footprint ${width} cm wide is narrower than the axle track ${d.axle_track_cm} cm plus a tyre or track width each side (${need} cm)`
    : null;
}

export function describeTwin(
  robot: RobotFile,
  world: unknown,
  ownBuild: boolean,
  physical: PhysicalDrive = {},
): string {
  const cfg = parseWorld(world);
  const ports = cfg.extensions.ev3 === undefined ? { motors: {}, sensors: {} } : parseBrickPorts(cfg.extensions.ev3);
  const roleOf = new Map(Object.entries(robot.profile.roles).map(([r, dev]) => [dev, r]));
  const port = (id: string, kind: string) =>
    `${id} ${kind}${roleOf.has(`ev3.${id}`) ? ` (${roleOf.get(`ev3.${id}`)})` : ""}`;
  const motors = Object.entries(ports.motors).map(([p, k]) => port(p, k));
  const sensors = Object.entries(ports.sensors).map(([p, k]) => port(`S${p}`, k));
  const d = robot.profile.drivetrain;
  // what the twin physically has, where it is not what the profile believes (the profile is what a person calibrates)
  const really = (k: "wheel_diameter_cm" | "axle_track_cm") =>
    physical[k] !== undefined && physical[k] !== d?.[k] ? ` (really ${physical[k]} cm)` : "";
  const scrub = physical.turn_scrub ? `, turns scrub ${physical.turn_scrub}` : "";
  const drive = d
    ? `pair ${robot.pair!.left}+${robot.pair!.right}, wheel ${d.wheel_diameter_cm} cm${really("wheel_diameter_cm")}, axle track ${d.axle_track_cm} cm${really("axle_track_cm")}${scrub}, forward_sign ${d.forward_sign}, heading from ${d.heading ? `${d.heading.device}.${d.heading.channel}` : "the wheel encoders"}`
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
    `look ${
      (isObj(look)
        ? Object.keys(look)
            .filter((k) => k !== "unconfirmed")
            .join(", ")
        : "") || "default"
    }`,
    ownBuild ? "build from the robot file's twin" : "build from the world (the robot file has no twin)",
  ].join("; ");
}
