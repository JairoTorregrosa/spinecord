// Deterministic 2D world for a differential-drive robot body.
// Units: cm, ms; radians inside, degrees at the edges.
// Axes: x to the right, y UP (the renderer flips y). Angles are counter-clockwise-positive seen from above.
// No Math.random and no real clocks: everything comes from the seed, and time is virtual.
//
// The world file describes the environment and where the sensors sit on the body. It does NOT describe the
// drivetrain: wheel size, axle track, how much a turn scrubs and which motors drive belong to the robot, handed in
// by whoever puts a robot body in this world (see `World.drive`).

export type Vec = [number, number];
export interface Pose {
  x: number;
  y: number;
  th: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Floor colour ids, the numbering of contract §2.2 (`color` channel). */
export const COLOR = { none: 0, black: 1, blue: 2, green: 3, yellow: 4, red: 5, white: 6, brown: 7 } as const;
export type ColorId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const COLOR_NAMES = ["none", "black", "blue", "green", "yellow", "red", "white", "brown"] as const;
/** Approximate reflected light (%, red LED) of each floor colour. An approximation: calibrate on the real floor. */
export const REFLECT_BY_COLOR: readonly number[] = [0, 6, 14, 12, 72, 62, 85, 22];
export const COLOR_RGB: readonly (readonly [number, number, number])[] = [
  [40, 40, 40],
  [20, 20, 20],
  [52, 120, 220],
  [60, 170, 90],
  [245, 205, 60],
  [220, 70, 60],
  [245, 243, 236],
  [140, 95, 60],
];

/** A box on the floor. `id` names it for as long as it exists: a page and the event log refer to it by that. */
export interface Obstacle extends Rect {
  id: string;
  /**
   * How tall it stands (cm). Absent: higher than any sensor looks over. A sensor sees it only where its beam comes
   * down to that height; the body is stopped by a box of any height (wheels and tracks meet it at the floor).
   */
  height_cm?: number;
  /**
   * Its mass (g), for a box the robot can push across the floor (a cardboard box, a cup). Absent: fixed in place.
   * It slides when the robot pushes harder than its friction on the floor (BOX_FLOOR_FRICTION x weight).
   */
  mass_g?: number;
  /**
   * How much of the infrared sensor's light it sends back, relative to a white wall (0 < r <= 1; absent: 1). The
   * stock firmware read 40-41 % from a white wall at 38 cm and 88-90 % from black (issue518, IR_PCT_PER_CM): under
   * the twin's model (the reading grows with one over the square root of the light) black is about (41 / 89)^2 =
   * 0.21. Walls of the arena reflect as white. Only the infrared sensor sees it.
   */
  ir_reflectivity?: number;
}
/** A box as it is handed to the world: without `id` the world gives it the next free `box<n>`. */
export type ObstacleInput = Rect & { id?: string; height_cm?: number; mass_g?: number; ir_reflectivity?: number };
/** The parts of an obstacle the world keeps (also what a world file may say of one). */
const OBSTACLE_KEYS = ["id", "x", "y", "w", "h", "height_cm", "mass_g", "ir_reflectivity"] as const;
/** `b` with only the fields of an obstacle, the optional ones only when present. */
function obstacleOf(b: ObstacleInput, id: string): Obstacle {
  return {
    id,
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    ...(b.height_cm === undefined ? {} : { height_cm: b.height_cm }),
    ...(b.mass_g === undefined ? {} : { mass_g: b.mass_g }),
    ...(b.ir_reflectivity === undefined ? {} : { ir_reflectivity: b.ir_reflectivity }),
  };
}
/** Why the world refused to change its obstacles (it then changed nothing). */
export type ObstacleErrorCode = "invalid" | "outside" | "on_robot" | "no_such_box" | "id_taken";
export class ObstacleError extends Error {
  constructor(
    readonly code: ObstacleErrorCode,
    message: string,
  ) {
    super(message);
  }
}
/** Obstacle ids: letters, digits, _ and - (they appear in events and in a page's messages). */
const OBSTACLE_ID = /^[A-Za-z0-9_-]{1,32}$/;

export interface Zone extends Rect {
  color: ColorId;
  label?: string;
}
/** A named point of the map (a generic label: its meaning belongs to the world file). */
export interface NamedPoint {
  label: string;
  x: number;
  y: number;
  radius: number;
}
export interface Line {
  points: Vec[];
  width: number;
  closed: boolean;
}

/** Outline of the robot body and where its sensors sit, measured from the centre of the wheel axle. */
export interface BodyShape {
  /** Rectangular footprint: how far it reaches ahead of and behind the axle, and half its width. */
  front_cm: number;
  back_cm: number;
  half_width_cm: number;
  /** Colour sensor: cm ahead of the axle, looking down; radius of the spot it averages. */
  color_sensor_x_cm: number;
  color_spot_radius_cm: number;
  /**
   * Distance sensor (ultrasonic or infrared): where its eye is and where it looks. Every ray of its beam starts at
   * that point and is aimed from that heading; the 3D view draws the sensor there (apps/twin-view/src/sensor-pose.ts).
   * `x` cm ahead of the axle (negative: behind it; within -back_cm..front_cm), `y` cm to the left of the centre line
   * (negative: to the right). The rays see walls and boxes only, never the robot's own body: a sensor at the front
   * looking back reads through the robot to what is behind it.
   */
  distance_sensor_x_cm: number;
  distance_sensor_y_cm: number;
  /** Where the distance sensor looks: degrees counter-clockwise from straight ahead, seen from above (-180..180). */
  distance_sensor_yaw_deg: number;
  /**
   * How high the distance sensor is mounted (cm above the floor, the centre of its beam). It sees a box only where its
   * beam, spreading up and down as it does sideways, comes down to the box's height: mounted at 20 cm it looks over a
   * 10 cm box until about 47 cm away. Physics, not the look (`extensions.view.sensors.<port>.z_cm` only draws it).
   */
  distance_sensor_z_cm: number;
  /** How high above the floor the lowest part of the bumper on the touch sensor is: a box lower than that passes under it. */
  touch_z_cm: number;
}
/**
 * The drivetrain as it physically is: what the body really does, which may differ from what the robot profile
 * believes (a twin's `twin.drive`, else the profile). It belongs to the robot, never to the world file.
 */
export interface DriveGeometry {
  axle_track_cm: number;
  /**
   * Fraction of a turn that a skid-steer base (tracks) loses to the treads scrubbing sideways: it turns
   * (1 - turn_scrub) of what its encoders say, while driving straight is untouched. 0 (the default) for wheels; below 1.
   * A property of the robot's tracks on its floor, so it travels with the robot from room to room.
   */
  turn_scrub?: number;
  /**
   * The most the drive pushes a box (N): it slides a box whose friction is no more than this, and stalls against a
   * heavier one as against a wall. Default DEFAULT_PUSH_N.
   */
  push_n?: number;
}

export interface NoiseConfig {
  /** Relative standard deviation, per MOTION_NOISE_MS of world time, of each wheel's real travel. */
  motor: number;
  /** Mean fraction of wheel rotation lost to slip. */
  slip: number;
  /** Fixed bias between the wheels (relative std dev, drawn from the seed): the robot veers. */
  wheel_bias: number;
  ultrasonic_cm: number;
  /** Std dev of infrared proximity at 40 %, in %; it grows in proportion to the reading (a weaker return is noisier). */
  ir_pct: number;
  reflect_pct: number;
  gyro_deg: number;
  gyro_drift_deg_s: number;
  /**
   * Scale error of the gyro (relative std dev, drawn from the seed): it counts (1 + e) degrees per real degree. LEGO
   * gives the EV3 gyro (45505) an accuracy of +-3 deg on a 90 deg turn
   * (https://education.lego.com/ar-ae/lessons/ev3-space/turn-using-sensor/); 0.017 makes that about two std devs.
   */
  gyro_scale: number;
}

export interface WorldConfig {
  name: string;
  /** What a person does in this world, in one or two sentences of their language (absent: nothing said). */
  description?: string;
  /** Sections of the file that belong to other packages (e.g. what is plugged into a brick). Not interpreted here. */
  extensions: Record<string, unknown>;
  width: number;
  height: number;
  /**
   * The obstacles, each with its id. Read-only: the world replaces the list on every change (a person's, a push),
   * so clones keep theirs and `World.obstacles_rev` counts the changes. Change it through World's methods.
   */
  readonly boxes: readonly Obstacle[];
  zones: Zone[];
  lines: Line[];
  points: NamedPoint[];
  body: BodyShape;
  noise: NoiseConfig;
  start: Pose;
}

/** Body used when the world file has no `body` section: a compact 18 x 12 cm base with front sensors. */
export const DEFAULT_BODY: BodyShape = {
  front_cm: 8,
  back_cm: 10,
  half_width_cm: 6,
  color_sensor_x_cm: 7,
  color_spot_radius_cm: 1,
  distance_sensor_x_cm: 8,
  distance_sensor_y_cm: 0,
  distance_sensor_yaw_deg: 0,
  // a sensor nobody measured: about where the EV3 educator base carries it; walls and boxes without a height are
  // higher than any mount, so in a world of those it changes nothing
  distance_sensor_z_cm: 6,
  touch_z_cm: 0,
};

export const DEFAULT_NOISE: NoiseConfig = {
  motor: 0.01,
  slip: 0.01,
  wheel_bias: 0.003,
  ultrasonic_cm: 0.3,
  ir_pct: 0.5,
  reflect_pct: 1,
  gyro_deg: 0.3,
  gyro_drift_deg_s: 0,
  gyro_scale: 0.017,
};
export const NO_NOISE: NoiseConfig = {
  motor: 0,
  slip: 0,
  wheel_bias: 0,
  ultrasonic_cm: 0,
  ir_pct: 0,
  reflect_pct: 0,
  gyro_deg: 0,
  gyro_drift_deg_s: 0,
  gyro_scale: 0,
};

/** Physics step (ms of simulated time). */
export const DT_MS = 20;
/**
 * Motion noise is one draw per wheel for each slice this long of world time, made from the seed and the slice's
 * index: a step that spans slices takes from each its share. How time is cut into steps (a viewer that ticks the
 * physics every frame) therefore changes neither the noise drawn nor the path, beyond float rounding.
 */
export const MOTION_NOISE_MS = DT_MS;
/** The EV3 ultrasonic sensor (45504) measures 3..250 cm (LEGO); with no echo it reads 255 (LEGO's EV3 user guide). */
export const ULTRASONIC_MIN_CM = 3;
export const ULTRASONIC_MAX_CM = 250;
export const ULTRASONIC_NO_ECHO_CM = 255;
/** Half angle of the ultrasonic cone (an approximation: the real one is around +-10..20 deg). */
export const CONE_HALF_DEG = 12;
/** Rays across the ultrasonic cone, evenly from -CONE_HALF_DEG to +CONE_HALF_DEG. */
export const ULTRASONIC_RAYS = 9;
/**
 * A ray echoes off a surface it meets within this angle of square, so a flat wall stops echoing when the sensor
 * looks more than CONE_HALF_DEG + this (25 deg) off its normal. 25 is what one EV3 project measured ("the sensors
 * need to be within a +/- 25 deg angle to the wall to operate",
 * https://github.com/jamesjackson/ev3-localization/blob/master/overview.md); others quote 40-45 deg. The stricter
 * number: a strategy that works with it also works where the sensor is more forgiving.
 */
export const ULTRASONIC_ECHO_DEG = 13;
/**
 * A convex corner of a box (an edge, seen from above) scatters sound back from every direction, where a flat face
 * returns it only near square on: sonar finds edges over a wide range of bearings, more weakly than planes
 * (Leonard and Durrant-Whyte, "Directed Sonar Sensing for Mobile Robot Navigation", 1992, ch. 2: planes, corners
 * and edges as the three target types; https://ecse.monash.edu/centres/irrc/LKPubs/IJRR95.PDF summarises). So a box
 * corner inside the cone and in plain view echoes whatever the angle. How far an edge still returns enough for the
 * EV3 sensor is not measured: this short range is chosen so that a strategy that relies on seeing a corner sees it
 * on the robot too. Where two walls of the room meet, see ULTRASONIC_CORNER_MAX_CM.
 */
export const ULTRASONIC_EDGE_MAX_CM = 60;
/**
 * Where two walls of the room meet square (a concave corner), sound that hits either wall near the corner comes back
 * along the way it came after two bounces, whatever the angle: a corner reflector, the strongest of the three sonar
 * targets (Leonard and Durrant-Whyte 1992, ch. 2). So a room corner inside the cone and in plain view echoes at its
 * distance. How far is not measured: the edges' short range, for the same reason (a strategy that relies on it sees
 * it on the robot too; at the sensor's full range the twin's learning example, reach-D, no longer learns its task).
 * Corners where a box meets a wall or another box are not modelled (the faces' rule decides).
 */
export const ULTRASONIC_CORNER_MAX_CM = ULTRASONIC_EDGE_MAX_CM;
/**
 * Infrared proximity (45509) per cm of a large light surface square on: the stock firmware (EV3-G) read 40-41 % with
 * a white wall at 38 cm, 88-90 % with black on it (https://github.com/ev3dev/ev3dev-lang-python/issues/518); ev3dev's
 * guide: "for large white objects the proximity value is VERY roughly equal to the distance in cm". 100 % with
 * nothing in range.
 */
export const IR_PCT_PER_CM = 40.5 / 38;
/** Half angle of the infrared beam. No measurement found: an estimate, wider than the ultrasonic cone. */
export const IR_CONE_HALF_DEG = 25;
/** Rays across the infrared beam. */
export const IR_RAYS = 11;

/** The value the ultrasonic sensor gives for an echo at `d` cm (Infinity: none): tenths of a cm, 255 out of range. */
function ultrasonicReading(d: number): number {
  if (!(d <= ULTRASONIC_MAX_CM)) return ULTRASONIC_NO_ECHO_CM;
  return Math.round(Math.max(ULTRASONIC_MIN_CM, d) * 10) / 10;
}
/** How far ahead of the front the bumper of a touch sensor feels a wall or a box. */
const TOUCH_REACH_CM = 0.7;
/**
 * What happened in the world, for a model that asks after a move (sim.world `events`). `with` names what the body
 * touches: a box's id, or the wall it meets (`wall_west` x 0, `wall_east` x width, `wall_south` y 0, `wall_north`
 * y height). Recording one spends no noise and changes nothing.
 */
export type WorldEvent = { n: number; t_ms: number } & (
  | { kind: "contact_began" | "contact_ended"; with: string }
  | { kind: "push_began"; box: string }
  | { kind: "push_ended"; box: string; moved_cm: number }
  | { kind: "stall_began" | "stall_ended" | "slip_began" | "slip_ended" }
  | { kind: "echo_lost"; why: "slant" | "range" }
  | { kind: "echo_back"; cm: number }
  | { kind: "placed"; how: "reset" | "carried" }
  | { kind: "obstacle_changed"; box: string; change: "added" | "moved" | "removed" }
);
type EventBody = WorldEvent extends infer E ? (E extends unknown ? Omit<E, "n" | "t_ms"> : never) : never;
/** Events the world keeps; older ones are dropped (a reader learns how many it missed). */
export const EVENT_LOG_MAX = 200;
/** Within this gap (cm) the body touches something, for contact events (a body at rest against a wall is that close). */
const CONTACT_CM = 0.01;

/** Halvings of a blocked step: the body comes to rest within 2^-12 of a step's travel from the obstacle. */
const CONTACT_BISECTIONS = 12;
/** The trip meter follows a line only while the axle centre is within this distance of it. */
export const LINE_TRACK_CM = 12;

// ---------- Seeded PRNG ----------
export class Rng {
  private s: number;
  private spare: number | null = null;
  constructor(seed: number) {
    if (!Number.isFinite(seed)) throw new Error(`Rng: invalid seed ${seed}`);
    this.s = Math.floor(seed) >>> 0 || 0x9e3779b9;
  }
  /** mulberry32: uniform in [0, 1). */
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  gauss(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    while (u < 1e-12) u = this.next();
    const r = Math.sqrt(-2 * Math.log(u)),
      a = 2 * Math.PI * this.next();
    this.spare = r * Math.sin(a);
    return r * Math.cos(a);
  }
}

/** Two 32-bit integers to one well-mixed seed (murmur3's finaliser), so that neighbouring slices get unrelated streams. */
function mixSeed(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b + 0x632be5ab) | 0, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// ---------- Geometry helpers ----------
/** A closed rounded-rectangle circuit as a polyline (counter-clockwise). Handy for generating world files. */
export function roundedLoop(cx: number, cy: number, w: number, h: number, r: number, segsPerCorner = 8): Vec[] {
  const pts: Vec[] = [];
  const corners: [number, number, number][] = [
    [cx + w / 2 - r, cy - h / 2 + r, -Math.PI / 2],
    [cx + w / 2 - r, cy + h / 2 - r, 0],
    [cx - w / 2 + r, cy + h / 2 - r, Math.PI / 2],
    [cx - w / 2 + r, cy - h / 2 + r, Math.PI],
  ];
  for (const [ox, oy, a0] of corners) {
    for (let i = 0; i <= segsPerCorner; i++) {
      const a = a0 + (i / segsPerCorner) * (Math.PI / 2);
      pts.push([ox + r * Math.cos(a), oy + r * Math.sin(a)]);
    }
  }
  return pts;
}

export const WORLD_SCHEMA = "spinecord/world@1";

/**
 * Validates a world given as JSON (see world.schema.json) and converts it to a WorldConfig.
 * Worlds are data: arena, obstacles, coloured zones, lines, named points, body shape. Fails naming the exact field.
 */
export function parseWorld(json: unknown): WorldConfig {
  const fail = (path: string, why: string): never => {
    throw new Error(`world file: ${path} ${why}`);
  };
  const obj = (v: unknown, path: string): Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : fail(path, "must be an object");
  const num = (v: unknown, path: string, min = -Infinity): number =>
    typeof v === "number" && Number.isFinite(v) && v >= min
      ? v
      : fail(path, `must be a finite number${min > -Infinity ? ` >= ${min}` : ""}, got ${JSON.stringify(v)}`);
  const arr = (v: unknown, path: string): unknown[] =>
    v === undefined ? [] : Array.isArray(v) ? v : fail(path, "must be an array");
  const str = (v: unknown, path: string): string =>
    typeof v === "string" && v !== "" ? v : fail(path, "must be a non-empty string");
  const rect = (v: unknown, path: string): Rect => {
    const o = obj(v, path);
    return {
      x: num(o.x, `${path}.x`),
      y: num(o.y, `${path}.y`),
      w: num(o.w, `${path}.w`, 0),
      h: num(o.h, `${path}.h`, 0),
    };
  };
  // the fields that may be negative: a side of the centre line, a direction
  const SIGNED: Record<string, [number, number]> = {
    distance_sensor_x_cm: [-Infinity, Infinity], // behind the axle: checked against back_cm below
    distance_sensor_y_cm: [-Infinity, Infinity],
    distance_sensor_yaw_deg: [-180, 180],
  };
  const partial = <T extends object>(v: unknown, path: string, base: T): T => {
    if (v === undefined) return { ...base };
    const o = obj(v, path),
      out = { ...base } as Record<string, number>;
    for (const [k, val] of Object.entries(o)) {
      if (!(k in base)) fail(`${path}.${k}`, `is not a known field (${Object.keys(base).join(", ")})`);
      const [lo, hi] = SIGNED[k] ?? [0, Infinity];
      out[k] = num(val, `${path}.${k}`, lo);
      if (out[k]! > hi) fail(`${path}.${k}`, `must be a finite number from ${lo} to ${hi}, got ${JSON.stringify(val)}`);
    }
    return out as T;
  };
  const root = obj(json, "root");
  const body = partial(root.body, "body", DEFAULT_BODY);
  // the sensor's place against the footprint, only where the file states it (a body without a distance sensor
  // leaves it out, and its default must not refuse a short body)
  const stated = (k: string) => typeof root.body === "object" && root.body !== null && k in root.body;
  const x = body.distance_sensor_x_cm;
  if (stated("distance_sensor_x_cm") && x < -body.back_cm)
    fail(
      "body.distance_sensor_x_cm",
      `is ${x}: the distance sensor's eye would be ${-x} cm behind the axle, past the back of the body (back_cm ${body.back_cm}); a sensor at the back is at most back_cm behind the axle`,
    );
  if (stated("distance_sensor_x_cm") && x > body.front_cm)
    fail(
      "body.distance_sensor_x_cm",
      `is ${x}: the distance sensor's eye would be ${x} cm ahead of the axle, past the front of the body (front_cm ${body.front_cm}); the body reaches at least as far as the sensor on it`,
    );
  const y = body.distance_sensor_y_cm;
  if (stated("distance_sensor_y_cm") && Math.abs(y) > body.half_width_cm)
    fail(
      "body.distance_sensor_y_cm",
      `is ${y}: the distance sensor's eye would be ${Math.abs(y)} cm to the ${y < 0 ? "right" : "left"} of the centre line, past the side of the body (half_width_cm ${body.half_width_cm}); the body is at least as wide as the sensor on it`,
    );
  const KNOWN = [
    "schema",
    "name",
    "description",
    "arena",
    "obstacles",
    "zones",
    "lines",
    "points",
    "start",
    "body",
    "noise",
    "extensions",
  ];
  const noise = root.noise as Record<string, unknown> | undefined;
  if (noise && typeof noise === "object" && "turn_scrub" in noise)
    fail(
      "noise.turn_scrub",
      "is not a field of the room: how much a tracked base loses on a turn belongs to the robot (its robot file's twin.drive.turn_scrub), so it goes with the robot into every world",
    );
  for (const k of Object.keys(root)) {
    if (k === "robot")
      fail(
        k,
        `is not a section: the body outline and sensor placement go under "body"; wheel size and axle track come from the robot profile, not from the world file`,
      );
    if (!KNOWN.includes(k))
      fail(k, `is not a known section (${KNOWN.join(", ")}); data for other packages goes under "extensions"`);
  }
  if (root.schema !== WORLD_SCHEMA) fail("schema", `must be "${WORLD_SCHEMA}", got ${JSON.stringify(root.schema)}`);
  const arena = obj(root.arena, "arena");
  const start = obj(root.start, "start");
  const labels = new Set<string>();
  return {
    name: str(root.name, "name"),
    ...(root.description === undefined ? {} : { description: str(root.description, "description") }),
    extensions: root.extensions === undefined ? {} : { ...obj(root.extensions, "extensions") },
    width: num(arena.width_cm, "arena.width_cm", 1),
    height: num(arena.height_cm, "arena.height_cm", 1),
    boxes: withIds(
      arr(root.obstacles, "obstacles").map((b, i) => {
        const o = obj(b, `obstacles[${i}]`);
        for (const k of Object.keys(o))
          if (!(OBSTACLE_KEYS as readonly string[]).includes(k))
            fail(`obstacles[${i}].${k}`, `is not a known field (${OBSTACLE_KEYS.join(", ")})`);
        if (o.id !== undefined && (typeof o.id !== "string" || !OBSTACLE_ID.test(o.id)))
          fail(`obstacles[${i}].id`, `must be 1 to 32 letters, digits, _ or -, got ${JSON.stringify(o.id)}`);
        const more = (k: "height_cm" | "mass_g") =>
          o[k] === undefined ? {} : { [k]: num(o[k], `obstacles[${i}].${k}`, Number.MIN_VALUE) };
        if (o.ir_reflectivity !== undefined) {
          const r = num(o.ir_reflectivity, `obstacles[${i}].ir_reflectivity`, Number.MIN_VALUE);
          if (r > 1) fail(`obstacles[${i}].ir_reflectivity`, `is relative to a white wall: at most 1, got ${r}`);
        }
        return {
          ...rect(b, `obstacles[${i}]`),
          ...(o.id === undefined ? {} : { id: o.id as string }),
          ...more("height_cm"),
          ...more("mass_g"),
          ...(o.ir_reflectivity === undefined ? {} : { ir_reflectivity: o.ir_reflectivity as number }),
        };
      }),
      (i, why) => fail(`obstacles[${i}].id`, why),
    ),
    zones: arr(root.zones, "zones").map((z, i) => {
      const o = obj(z, `zones[${i}]`);
      const color = COLOR_NAMES.indexOf(o.color as (typeof COLOR_NAMES)[number]);
      if (color < 1)
        fail(`zones[${i}].color`, `must be one of ${COLOR_NAMES.slice(1).join(", ")}, got ${JSON.stringify(o.color)}`);
      return {
        ...rect(z, `zones[${i}]`),
        color: color as ColorId,
        ...(o.label === undefined ? {} : { label: str(o.label, `zones[${i}].label`) }),
      };
    }),
    lines: arr(root.lines, "lines").map((l, i) => {
      const o = obj(l, `lines[${i}]`);
      const pts = arr(o.points, `lines[${i}].points`).map((p, j) => {
        if (!Array.isArray(p) || p.length !== 2) fail(`lines[${i}].points[${j}]`, "must be [x, y]");
        const q = p as unknown[];
        return [num(q[0], `lines[${i}].points[${j}][0]`), num(q[1], `lines[${i}].points[${j}][1]`)] as Vec;
      });
      if (pts.length < 2) fail(`lines[${i}].points`, "needs at least 2 points");
      if (o.closed !== undefined && typeof o.closed !== "boolean") fail(`lines[${i}].closed`, "must be true or false");
      return { points: pts, width: num(o.width_cm, `lines[${i}].width_cm`, 0.1), closed: o.closed === true };
    }),
    points: arr(root.points, "points").map((p, i) => {
      const o = obj(p, `points[${i}]`);
      const label = str(o.label, `points[${i}].label`);
      if (!/^[A-Za-z0-9_-]+$/.test(label))
        fail(
          `points[${i}].label`,
          `"${label}" may only use letters, digits, _ and - (it becomes part of channel names)`,
        );
      if (labels.has(label)) fail(`points[${i}].label`, `"${label}" is repeated`);
      labels.add(label);
      return {
        label,
        x: num(o.x, `points[${i}].x`),
        y: num(o.y, `points[${i}].y`),
        radius: num(o.radius_cm, `points[${i}].radius_cm`, 0.1),
      };
    }),
    body,
    noise: partial(root.noise, "noise", DEFAULT_NOISE),
    start: {
      x: num(start.x, "start.x"),
      y: num(start.y, "start.y"),
      th: (num(start.heading_deg, "start.heading_deg") * Math.PI) / 180,
    },
  };
}

/** Standard gravity, m/s2. */
const G = 9.81;
/**
 * Friction of a box on the floor, static: it slides once pushed with this times its weight. No measurement of
 * cardboard on a classroom floor found; tables give 0.25-0.5 for wood on wood
 * (https://www.engineeringtoolbox.com/friction-coefficients-d_778.html) and a textbook cardboard box of books on
 * concrete slides at 0.19. 0.4 is near the top: a box that slides on the twin slides on the floor too.
 */
export const BOX_FLOOR_FRICTION = 0.4;
/**
 * The most a robot pushes (N) when its build does not say what it weighs and how its tread grips (twin.drive):
 * about 1 kg of robot (no published weight for an EV3 base; a large motor is 76 g) times a grip of 0.5, between the
 * plastic EV3 track links (0.25) and LEGO rubber tyres (1.0-1.2) that Brick Experiment Channel measured on wood
 * (https://www.youtube.com/watch?v=cDpcdVf39kA). It pushes a box of up to about 1.25 kg of floor friction 0.4.
 */
export const DEFAULT_PUSH_N = 1 * 0.5 * G;
/** The force (N) that slides box `b`, or null for a box that is fixed in place. */
export function slideForceN(b: Obstacle): number | null {
  return b.mass_g === undefined ? null : (BOX_FLOOR_FRICTION * b.mass_g * G) / 1000;
}
/** Gap (cm) a pushed box is left at from the body, so that the next step starts free of it. */
const PUSH_GAP_CM = 1e-6;
/** Whether a convex quadrilateral (corners in order) and a box meet, touching included (separating axes). */
function polygonsMeet(q: Vec[], b: Rect): boolean {
  const bc: Vec[] = [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ];
  const axes: Vec[] = [
    [1, 0],
    [0, 1],
    ...q.map((a, i) => {
      const n = q[(i + 1) % q.length]!;
      return [a[1] - n[1], n[0] - a[0]] as Vec;
    }),
  ];
  for (const [nx, ny] of axes) {
    const a = q.map(([x, y]) => x * nx + y * ny),
      o = bc.map(([x, y]) => x * nx + y * ny);
    if (Math.max(...a) < Math.min(...o) || Math.max(...o) < Math.min(...a)) return false;
  }
  return true;
}
/** Whether two boxes overlap by more than touching. */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
}
/**
 * The least translation of box `b` that clears the footprint at `p` (corners `cs`): of the four separating axes
 * (the world's x and y, the body's forward and sideways), the one with the smallest overlap, away from the body.
 */
function clearOf(b: Rect, p: Pose, cs: Vec[], g: BodyShape): Vec {
  const bc: Vec[] = [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ];
  const c = Math.cos(p.th),
    s = Math.sin(p.th);
  const mid: Vec = [b.x + b.w / 2, b.y + b.h / 2];
  let best: Vec = [0, 0],
    least = Infinity;
  for (const [nx, ny] of [
    [1, 0],
    [0, 1],
    [c, s],
    [-s, c],
  ] as Vec[]) {
    const proj = (q: Vec) => q[0] * nx + q[1] * ny;
    const a = cs.map(proj),
      o = bc.map(proj);
    const amin = Math.min(...a),
      amax = Math.max(...a),
      omin = Math.min(...o),
      omax = Math.max(...o);
    // away from the body's centre (its centre of area, not the axle: front and back differ)
    const centre = proj([p.x + ((g.front_cm - g.back_cm) / 2) * c, p.y + ((g.front_cm - g.back_cm) / 2) * s]);
    const sign = proj(mid) >= centre ? 1 : -1;
    const need = sign > 0 ? amax - omin : omax - amin;
    if (need < least) {
      least = need;
      best = [nx * sign * (need + PUSH_GAP_CM), ny * sign * (need + PUSH_GAP_CM)];
    }
  }
  return best;
}

/** Fails loud on a drivetrain the physics cannot roll. */
export function checkDrive(d: DriveGeometry): void {
  if (!(d.axle_track_cm > 0)) throw new Error(`world: drive.axle_track_cm must be > 0, got ${d.axle_track_cm}`);
  if (d.push_n !== undefined && !(d.push_n >= 0))
    throw new Error(`world: drive.push_n must be a number >= 0, got ${d.push_n}`);
  const s = d.turn_scrub ?? 0;
  if (!(s >= 0 && s < 1))
    throw new Error(`world: drive.turn_scrub must be 0 or more and below 1 (the share of a turn lost), got ${s}`);
}

/** Gives each box without an id the next free `box<n>` (n from 1, in list order). `fail` names a repeated id. */
function withIds(list: readonly ObstacleInput[], fail: (i: number, why: string) => never): Obstacle[] {
  const taken = new Set<string>();
  list.forEach((b, i) => {
    if (b.id === undefined) return;
    if (taken.has(b.id)) fail(i, `"${b.id}" is repeated`);
    taken.add(b.id);
  });
  let n = 0;
  return list.map((b) => {
    if (b.id !== undefined) return obstacleOf(b, b.id);
    let id: string;
    do id = `box${++n}`;
    while (taken.has(id));
    taken.add(id);
    return obstacleOf(b, id);
  });
}

export interface AdvanceResult {
  /** Wheel travel that actually happened before a stall, as commanded cm of wheel (not what was asked). */
  left_cm: number;
  right_cm: number;
  ms: number;
  stalled: boolean;
}

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  len: number;
  s0: number;
  line: number;
  half: number;
}

export class World {
  readonly cfg: WorldConfig;
  readonly seed: number;
  pose: Pose;
  /**
   * Drivetrain geometry of the body currently in this world. Set by whoever owns the body, from the robot
   * profile. While null the body cannot roll: moving the wheels fails loud.
   */
  drive: DriveGeometry | null;
  /** Simulated time so far. */
  t_ms = 0;
  /** True if the last physics step was blocked by a wall or obstacle. */
  last_stalled = false;
  /** Force (N) the drive spent in the last physics step sliding the boxes it pushed: 0 when it pushed none. */
  last_push_n = 0;
  /** Fraction (0..1) of its wheel travel the last physics step did: below 1 when the body came to rest against something. */
  last_step_fraction = 1;
  /** Real turning rate during the last physics step (deg/s, counter-clockwise-positive). */
  rate_deg_s = 0;
  /** Trip meter since the last teleport: path length of the axle centre (turning on the spot adds nothing). */
  odometer_cm = 0;
  /** Trip meter since the last teleport: net signed distance along the line the body has been following. */
  line_travel_cm = 0;
  private motionRng: Rng;
  private sensorRng: Rng;
  private gainL = 1;
  private gainR = 1;
  private gyroZeroTh: number;
  private gyroZeroMs = 0;
  /** deg/s the gyro took as its zero when it was last reset: the turning rate at that moment (0 when still). */
  private gyroOffset = 0;
  private readonly gyroGain: number;
  private segs: Seg[] = [];
  private trackLine = -1;
  private trackS = 0;
  /**
   * Whether an ultrasonic sensor listens (the host sets it: a brick with one plugged in). Then the world notes when
   * its echo is lost and comes back; computing that spends no noise.
   */
  watch_echo = false;
  private readonly log: WorldEvent[] = [];
  private logged = 0;
  private touching = new Set<string>();
  /** Boxes being pushed: where each was when the push began. */
  private pushing = new Map<string, Vec>();
  private echo: "echo" | "slant" | "range" | null = null;
  /** Counts every change of the obstacles (a person's, a push): a viewer that saw another number shows them again. */
  obstacles_rev = 0;
  /** The highest n of the `box<n>` ids so far: a box set down later never takes an id one had before. */
  private lastBoxN = 0;
  /** Length of each line (cm), in file order. */
  readonly line_lengths_cm: number[] = [];

  constructor(cfg: WorldConfig, seed = 1, drive: DriveGeometry | null = null) {
    if (!(cfg.width > 0 && cfg.height > 0)) throw new Error("world: the arena needs width and height > 0");
    if (drive) checkDrive(drive);
    this.cfg = cfg;
    this.seed = seed;
    this.drive = drive;
    this.motionRng = new Rng(seed);
    this.sensorRng = new Rng(seed ^ 0x5bd1e995);
    this.gainL = 1 + cfg.noise.wheel_bias * this.motionRng.gauss();
    this.gainR = 1 + cfg.noise.wheel_bias * this.motionRng.gauss();
    // Its own stream, so the motion of a seed is the same whatever the gyro's error.
    this.gyroGain = 1 + cfg.noise.gyro_scale * new Rng(mixSeed(seed, 0x6779726f)).gauss();
    cfg.lines.forEach((line, li) => {
      const p = line.points;
      if (p.length < 2) throw new Error("world: a line needs at least 2 points");
      let s = 0;
      const n = line.closed ? p.length : p.length - 1;
      for (let i = 0; i < n; i++) {
        const a = p[i]!,
          b = p[(i + 1) % p.length]!;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len === 0) continue;
        this.segs.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], len, s0: s, line: li, half: line.width / 2 });
        s += len;
      }
      this.line_lengths_cm.push(s);
    });
    for (const b of cfg.boxes) {
      const m = /^box(\d+)$/.exec(b.id);
      if (m) this.lastBoxN = Math.max(this.lastBoxN, Number(m[1]));
    }
    this.pose = { ...cfg.start };
    this.gyroZeroTh = this.pose.th;
    if (this.collides(this.pose))
      throw new Error(
        `world "${cfg.name}": the robot does not fit at the start pose (${cfg.start.x}, ${cfg.start.y}): it overlaps a wall or obstacle`,
      );
    this.resetTrip();
    this.touching = this.touchedAt(this.pose, cfg.boxes);
  }

  /** Independent copy (same configuration, pose and drivetrain) with another seed. */
  clone(seed = this.seed): World {
    return new World({ ...this.cfg, start: { ...this.pose } }, seed, this.drive ? { ...this.drive } : null);
  }

  /** Teleports the robot (episode resets, the viewer). Fails if the pose overlaps something. Zeroes gyro and trip meters. */
  setPose(p: Pose): void {
    if (![p.x, p.y, p.th].every(Number.isFinite)) throw new Error("setPose: the pose must be finite numbers");
    if (this.collides(p))
      throw new Error(
        `setPose: the robot does not fit at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}): it overlaps a wall or obstacle`,
      );
    this.pose = { ...p };
    this.last_stalled = false;
    this.rate_deg_s = 0;
    this.resetGyro();
    this.resetTrip();
    this.notePlaced("reset");
  }
  /**
   * A person picks the robot up and sets it down at `p` (a viewer). Unlike setPose the gyro keeps counting: it
   * felt the turn, so its angle changes by the shortest rotation from the old heading to `p.th`. The trip meters
   * keep their totals; line tracking starts again from the new spot. Fails, changing nothing, if the robot would
   * overlap a wall or obstacle there.
   */
  carry(p: Pose): void {
    if (![p.x, p.y, p.th].every(Number.isFinite)) throw new Error("carry: the pose must be finite numbers");
    let turn = (p.th - this.pose.th) % (2 * Math.PI);
    if (turn > Math.PI) turn -= 2 * Math.PI;
    else if (turn < -Math.PI) turn += 2 * Math.PI;
    const next: Pose = { x: p.x, y: p.y, th: this.pose.th + turn };
    if (this.collides(next))
      throw new Error(
        `carry: the robot does not fit at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}): it overlaps a wall or obstacle`,
      );
    this.pose = next;
    this.last_stalled = false;
    this.rate_deg_s = 0;
    this.trackLine = -1;
    const n = this.nearestOnLine(next.x, next.y);
    if (n && n.dist <= LINE_TRACK_CM) {
      this.trackLine = n.line;
      this.trackS = n.s;
    }
    this.notePlaced("carried");
  }

  /** The box with this id, or undefined. */
  obstacle(id: string): Obstacle | undefined {
    return this.cfg.boxes.find((b) => b.id === id);
  }

  /**
   * A person sets a box down (a viewer). Returns its id: `r.id`, or the next free `box<n>`. Throws ObstacleError,
   * changing nothing: `invalid` (not finite, a side not > 0, a malformed id), `outside` (not wholly inside the
   * arena), `on_robot` (it would overlap the robot), `id_taken`.
   */
  addObstacle(r: ObstacleInput): string {
    const id = r.id ?? this.freeId();
    if (r.id !== undefined && this.obstacle(r.id))
      throw new ObstacleError("id_taken", `addObstacle: there is a box "${r.id}" already`);
    this.place([...this.cfg.boxes, this.checked("addObstacle", { ...r, id })]);
    this.noteByHand(id, "added");
    return id;
  }
  /** A person lifts box `id` and sets it down as `to` (a viewer): it keeps its id and its place in the list. Errors as addObstacle, and `no_such_box`. */
  moveObstacle(id: string, to: Rect): void {
    const b = this.existing("moveObstacle", id);
    const moved = this.checked("moveObstacle", { ...b, x: to.x, y: to.y, w: to.w, h: to.h });
    this.place(this.cfg.boxes.map((o) => (o.id === id ? moved : o)));
    this.noteByHand(id, "moved");
  }
  /** A person takes box `id` away (a viewer). Throws ObstacleError `no_such_box` when there is none. */
  removeObstacle(id: string): void {
    this.existing("removeObstacle", id);
    this.place(this.cfg.boxes.filter((o) => o.id !== id));
    this.noteByHand(id, "removed");
  }
  /**
   * Every obstacle at once (a viewer restores a world's own boxes), and the robot set down at `pose` when given
   * (a teleport, as setPose). Throws ObstacleError, changing nothing, as addObstacle would for any of them, or when
   * the robot does not fit among them.
   */
  setObstacles(list: readonly ObstacleInput[], pose?: Pose): void {
    const fail = (i: number, why: string): never => {
      throw new ObstacleError("id_taken", `setObstacles: obstacle ${i}: ${why}`);
    };
    const next = withIds(list, fail).map((b) => this.checked("setObstacles", b, false));
    const before = this.cfg.boxes;
    this.boxesNow(next);
    if (this.collides(pose ?? this.pose)) {
      this.boxesNow(before);
      throw new ObstacleError(
        "on_robot",
        "setObstacles: a box would overlap the robot; the obstacles stay as they were",
      );
    }
    this.obstacles_rev++;
    const ids = new Set(next.map((b) => b.id));
    for (const b of before) if (!ids.has(b.id)) this.note({ kind: "obstacle_changed", box: b.id, change: "removed" });
    for (const b of next) {
      const was = before.find((o) => o.id === b.id);
      if (!was || was.x !== b.x || was.y !== b.y || was.w !== b.w || was.h !== b.h)
        this.note({ kind: "obstacle_changed", box: b.id, change: was ? "moved" : "added" });
    }
    if (pose) this.setPose(pose);
    else this.settle();
  }

  private existing(op: string, id: string): Obstacle {
    const b = typeof id === "string" ? this.obstacle(id) : undefined;
    if (!b)
      throw new ObstacleError(
        "no_such_box",
        `${op}: no box ${JSON.stringify(id)}; this world has ${this.cfg.boxes.map((o) => o.id).join(", ") || "none"}`,
      );
    return b;
  }
  /** `b` if it can stand in this arena, else the ObstacleError that says why; with `robot`, also off the robot. */
  private checked(op: string, b: Obstacle, robot = true): Obstacle {
    if (![b.x, b.y, b.w, b.h].every(Number.isFinite) || !(b.w > 0 && b.h > 0))
      throw new ObstacleError("invalid", `${op}: x, y, w, h must be finite numbers, with w and h > 0`);
    if (!OBSTACLE_ID.test(b.id))
      throw new ObstacleError(
        "invalid",
        `${op}: an id is 1 to 32 letters, digits, _ or -, got ${JSON.stringify(b.id)}`,
      );
    const { width, height } = this.cfg;
    if (b.x < 0 || b.y < 0 || b.x + b.w > width || b.y + b.h > height)
      throw new ObstacleError("outside", `${op}: a box lies wholly inside the arena (0..${width} x 0..${height} cm)`);
    for (const k of ["height_cm", "mass_g"] as const)
      if (b[k] !== undefined && !(Number.isFinite(b[k]) && b[k] > 0))
        throw new ObstacleError("invalid", `${op}: ${k} must be a finite number > 0, got ${JSON.stringify(b[k])}`);
    const r = b.ir_reflectivity;
    if (r !== undefined && !(Number.isFinite(r) && r > 0 && r <= 1))
      throw new ObstacleError("invalid", `${op}: ir_reflectivity must be > 0 and at most 1, got ${JSON.stringify(r)}`);
    const out = obstacleOf(b, b.id);
    if (robot && this.boxCollides(out, this.pose))
      throw new ObstacleError("on_robot", `${op}: the box would overlap the robot; set it down somewhere free`);
    return out;
  }
  // ----- the event log -----
  /** Adds an event at `t_ms` (default now). A host (the brick) notes what only it knows: a wheel stalls or slips. */
  note(e: EventBody, t_ms = this.t_ms): void {
    this.log.push({ n: ++this.logged, t_ms, ...e } as WorldEvent);
    if (this.log.length > EVENT_LOG_MAX) this.log.shift();
  }
  /**
   * The events after number `since` (0: all that are kept), oldest first; `next` is the number to ask from next
   * time, `dropped` how many after `since` are no longer kept.
   */
  eventsSince(since = 0): { events: WorldEvent[]; next: number; dropped: number } {
    const first = this.log[0]?.n ?? this.logged + 1;
    return {
      events: this.log.filter((e) => e.n > since).map((e) => ({ ...e })),
      next: this.logged,
      dropped: Math.max(0, first - 1 - since),
    };
  }
  private notePlaced(how: "reset" | "carried"): void {
    this.note({ kind: "placed", how });
    this.settle();
  }
  private noteByHand(box: string, change: "added" | "moved" | "removed"): void {
    this.note({ kind: "obstacle_changed", box, change });
    this.settle();
  }
  /** After a person changed something: what the body touches now, and whether the echo is there, without a push. */
  private settle(): void {
    const now = this.touchedAt(this.pose, this.cfg.boxes);
    for (const id of this.touching) if (!now.has(id)) this.note({ kind: "contact_ended", with: id });
    for (const id of now) if (!this.touching.has(id)) this.note({ kind: "contact_began", with: id });
    this.touching = now;
    for (const [id] of this.pushing) if (!this.obstacle(id)) this.pushing.delete(id);
    this.noteEcho();
  }
  /** What the footprint at `p` touches (within CONTACT_CM): box ids and walls. */
  private touchedAt(p: Pose, boxes: readonly Obstacle[]): Set<string> {
    const g = this.cfg.body,
      e = CONTACT_CM,
      c = Math.cos(p.th),
      s = Math.sin(p.th);
    const cs = (
      [
        [g.front_cm + e, g.half_width_cm + e],
        [g.front_cm + e, -g.half_width_cm - e],
        [-g.back_cm - e, -g.half_width_cm - e],
        [-g.back_cm - e, g.half_width_cm + e],
      ] as Vec[]
    ).map(([lx, ly]) => [p.x + lx * c - ly * s, p.y + lx * s + ly * c] as Vec);
    const out = new Set<string>();
    const { width, height } = this.cfg;
    if (cs.some(([x]) => x <= 0)) out.add("wall_west");
    if (cs.some(([x]) => x >= width)) out.add("wall_east");
    if (cs.some(([, y]) => y <= 0)) out.add("wall_south");
    if (cs.some(([, y]) => y >= height)) out.add("wall_north");
    for (const b of boxes) if (polygonsMeet(cs, b)) out.add(b.id);
    return out;
  }
  /**
   * Contacts after a physics step that took the body along `pose(q)` for q in [0, f] of the step that began at `t0`
   * and lasted `dt`, among `boxes` as they were when it began. Each one that began or ended is stamped at the moment
   * within the step it did (to 2^-12 of the step), so how a viewer cuts the steps does not move it.
   */
  private noteContacts(pose: (q: number) => Pose, boxes: readonly Obstacle[], t0: number, dt: number, f: number): void {
    const now = this.touchedAt(this.pose, this.cfg.boxes);
    const when = (id: string, began: boolean): number => {
      const touches = (q: number) => this.touchedAt(pose(q), boxes).has(id);
      // began: the first moment it touches; ended: the last moment it still did
      let lo = 0,
        hi = f;
      if (began ? touches(0) : !touches(f)) return t0 + (began ? 0 : f) * dt;
      for (let i = 0; i < CONTACT_BISECTIONS; i++) {
        const m = (lo + hi) / 2;
        if (touches(m) === began) hi = m;
        else lo = m;
      }
      return t0 + (began ? hi : lo) * dt;
    };
    const changes: { t: number; e: EventBody }[] = [];
    for (const id of this.touching)
      if (!now.has(id)) changes.push({ t: when(id, false), e: { kind: "contact_ended", with: id } });
    for (const id of now)
      if (!this.touching.has(id)) changes.push({ t: when(id, true), e: { kind: "contact_began", with: id } });
    changes.sort((a, b) => a.t - b.t);
    for (const c of changes) this.note(c.e, c.t);
    this.touching = now;
  }
  /** A box that started or stopped sliding in the last step (stamped at the step's end). */
  private notePushes(before: readonly Obstacle[]): void {
    const moved = new Set<string>();
    this.cfg.boxes.forEach((b, i) => {
      const was = before[i];
      if (was && was.id === b.id && (was.x !== b.x || was.y !== b.y)) moved.add(b.id);
    });
    for (const [id, from] of this.pushing)
      if (!moved.has(id)) {
        const b = this.obstacle(id);
        this.pushing.delete(id);
        const cm = b ? Math.hypot(b.x - from[0], b.y - from[1]) : 0;
        this.note({ kind: "push_ended", box: id, moved_cm: Math.round(cm * 100) / 100 });
      }
    for (const id of moved)
      if (!this.pushing.has(id)) {
        const was = before.find((o) => o.id === id)!;
        this.pushing.set(id, [was.x, was.y]);
        this.note({ kind: "push_began", box: id });
      }
  }
  /** The ultrasonic echo came or went (only while one listens): stamped at the step's end. */
  private noteEcho(): void {
    if (!this.watch_echo) return;
    const d = this.coneDistance();
    let now: "echo" | "slant" | "range" = "echo";
    if (!(d <= ULTRASONIC_MAX_CM)) {
      // something within range that sends nothing back, or nothing within range at all
      let near = false;
      for (let i = 0; i < ULTRASONIC_RAYS && !near; i++)
        near =
          this.rayHit(this.pose, (((2 * i) / (ULTRASONIC_RAYS - 1) - 1) * CONE_HALF_DEG * Math.PI) / 180).d <=
          ULTRASONIC_MAX_CM;
      now = near ? "slant" : "range";
    }
    const had = this.echo;
    this.echo = now;
    if (had === null || (had === "echo") === (now === "echo")) return;
    if (now === "echo") this.note({ kind: "echo_back", cm: ultrasonicReading(d) });
    else this.note({ kind: "echo_lost", why: now });
  }

  /** The next `box<n>` no box has had in this world. */
  private freeId(): string {
    let id: string;
    do id = `box${++this.lastBoxN}`;
    while (this.obstacle(id));
    return id;
  }
  /** Replaces the list (never changed in place: clones keep theirs) and counts the change. */
  private place(next: Obstacle[]): void {
    this.boxesNow(next);
    this.obstacles_rev++;
  }
  private boxesNow(next: readonly Obstacle[]): void {
    (this.cfg as { boxes: readonly Obstacle[] }).boxes = next;
  }

  /**
   * The gyro angle without noise and not rounded (degrees since the last reset, counter-clockwise-positive), for a
   * display. It spends nothing of the sensor generator, so showing it never changes what the robot reads.
   */
  peekGyroDeg(): number {
    return (
      (((this.pose.th - this.gyroZeroTh) * 180) / Math.PI) * this.gyroGain +
      ((this.cfg.noise.gyro_drift_deg_s - this.gyroOffset) * (this.t_ms - this.gyroZeroMs)) / 1000
    );
  }
  /** The gyro's rate without noise and not rounded (deg/s, counter-clockwise-positive). */
  gyroRateDegS(): number {
    return this.rate_deg_s * this.gyroGain + this.cfg.noise.gyro_drift_deg_s - this.gyroOffset;
  }

  /**
   * Zeroes the angle (a reset, a mode switch, plugging it in). The real gyro also takes the rate it feels at that
   * moment as its zero: reset while the robot turns, it then drifts by that rate until the next reset while still.
   */
  resetGyro(): void {
    this.gyroOffset = this.rate_deg_s * this.gyroGain;
    this.gyroZeroTh = this.pose.th;
    this.gyroZeroMs = this.t_ms;
  }
  private resetTrip(): void {
    this.odometer_cm = 0;
    this.line_travel_cm = 0;
    this.trackLine = -1;
    const n = this.nearestOnLine(this.pose.x, this.pose.y);
    if (n && n.dist <= LINE_TRACK_CM) {
      this.trackLine = n.line;
      this.trackS = n.s;
    }
  }

  // ----- collisions -----
  corners(p: Pose = this.pose): Vec[] {
    const g = this.cfg.body,
      c = Math.cos(p.th),
      s = Math.sin(p.th);
    const loc: Vec[] = [
      [g.front_cm, g.half_width_cm],
      [g.front_cm, -g.half_width_cm],
      [-g.back_cm, -g.half_width_cm],
      [-g.back_cm, g.half_width_cm],
    ];
    return loc.map(([lx, ly]) => [p.x + lx * c - ly * s, p.y + lx * s + ly * c] as Vec);
  }

  collides(p: Pose): boolean {
    const { width, height, boxes } = this.cfg;
    const cs = this.corners(p);
    for (const [x, y] of cs) if (x < 0 || x > width || y < 0 || y > height) return true;
    return boxes.some((b) => this.boxCollides(b, p, cs));
  }
  /** Whether box `b` overlaps the footprint at pose `p` (touching counts), by the separating axis theorem. */
  boxCollides(b: Rect, p: Pose, cs: Vec[] = this.corners(p)): boolean {
    // the world's axes: the footprint's bounding box against the box
    let minx = Infinity,
      maxx = -Infinity,
      miny = Infinity,
      maxy = -Infinity;
    for (const [x, y] of cs) {
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    }
    if (maxx < b.x || minx > b.x + b.w || maxy < b.y || miny > b.y + b.h) return false;
    // the body's own axes
    const g = this.cfg.body,
      c = Math.cos(p.th),
      s = Math.sin(p.th);
    let umin = Infinity,
      umax = -Infinity,
      vmin = Infinity,
      vmax = -Infinity;
    for (const [bx, by] of [
      [b.x, b.y],
      [b.x + b.w, b.y],
      [b.x + b.w, b.y + b.h],
      [b.x, b.y + b.h],
    ] as Vec[]) {
      const dx = bx - p.x,
        dy = by - p.y;
      const u = dx * c + dy * s,
        v = -dx * s + dy * c;
      if (u < umin) umin = u;
      if (u > umax) umax = u;
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }
    return !(umax < -g.back_cm || umin > g.front_cm || vmax < -g.half_width_cm || vmin > g.half_width_cm);
  }

  // ----- motion -----
  /**
   * Rolls the wheels `left_cm` / `right_cm` (cm of wheel travel, signed) with the faster wheel at `speed_cm_s`.
   * Simulated time advances. If the footprint hits something the robot stays there and the result is stalled.
   */
  advance(left_cm: number, right_cm: number, speed_cm_s: number): AdvanceResult {
    if (![left_cm, right_cm, speed_cm_s].every(Number.isFinite))
      throw new Error("advance: arguments must be finite numbers");
    if (!(speed_cm_s > 0)) throw new Error(`advance: speed must be > 0, got ${speed_cm_s}`);
    const total = Math.max(Math.abs(left_cm), Math.abs(right_cm));
    const res: AdvanceResult = { left_cm: 0, right_cm: 0, ms: 0, stalled: false };
    this.last_stalled = false;
    if (total === 0) return res;
    const dur = (total / speed_cm_s) * 1000;
    const n = Math.max(1, Math.ceil(dur / DT_MS - 1e-9));
    const dl = left_cm / n,
      dr = right_cm / n,
      dt = dur / n;
    for (let i = 0; i < n; i++) {
      res.ms += dt;
      if (this.stepWheels(dl, dr, dt)) {
        res.left_cm += dl * this.last_step_fraction;
        res.right_cm += dr * this.last_step_fraction;
        res.stalled = true;
        break;
      }
      res.left_cm += dl;
      res.right_cm += dr;
    }
    return res;
  }

  /**
   * One physics step: the wheels want to roll `dl_cm` / `dr_cm` during `dt_ms`.
   * Returns true if the footprint would hit something: then the body rolls only up to contact (the fraction of the
   * travel it did is `last_step_fraction`) and the wheels are blocked there.
   */
  stepWheels(dl_cm: number, dr_cm: number, dt_ms: number): boolean {
    this.t_ms += dt_ms;
    this.last_step_fraction = 1;
    if (dl_cm === 0 && dr_cm === 0) {
      this.rate_deg_s = 0;
      this.last_stalled = false;
      this.last_push_n = 0;
      this.notePushes(this.cfg.boxes); // nothing pushes: a push in progress ends
      return false;
    }
    if (!this.drive)
      throw new Error(
        "world: this body has no drivetrain geometry (set World.drive from the robot profile before rolling the wheels)",
      );
    const axle = this.drive.axle_track_cm,
      scrub = this.drive.turn_scrub ?? 0;
    // Each slice of motion noise is its own arc, so the path does not depend on where steps begin and end.
    const arcs = this.wheelNoise(this.t_ms - dt_ms, dt_ms).map(({ w, l, r }) => {
      const tl = dl_cm * w * this.gainL * l,
        tr = dr_cm * w * this.gainR * r;
      return { w, tl, tr, d: (tl + tr) / 2, th: ((tr - tl) / axle) * (1 - scrub) };
    });
    const from = { ...this.pose };
    /** The pose after fraction `f` of this step's time, and the turn and travel done until then. */
    const at = (f: number): { pose: Pose; d: number; th: number; wheels: number } => {
      let { x, y, th } = from,
        c = 0,
        d = 0,
        turned = 0,
        wheels = 0;
      for (const a of arcs) {
        const q = Math.min(1, Math.max(0, (f - c) / a.w));
        c += a.w;
        if (q === 0) break;
        const sd = a.d * q,
          sth = a.th * q;
        // The exact arc of constant curvature, not its midpoint approximation.
        const chord = Math.abs(sth) > 1e-9 ? ((2 * sd) / sth) * Math.sin(sth / 2) : sd;
        x += chord * Math.cos(th + sth / 2);
        y += chord * Math.sin(th + sth / 2);
        th += sth;
        d += sd;
        turned += sth;
        wheels += (q * (Math.abs(a.tl) + Math.abs(a.tr))) / 2;
      }
      return { pose: { x, y, th }, d, th: turned, wheels };
    };
    let f = 1,
      end = at(1),
      push = this.pushTo(end.pose);
    const blocked = push === null;
    if (blocked) {
      // Bisect to the last free fraction: the body stops against the obstacle (or a box it pushes stops against
      // one), not up to a step short of it. Fraction 0 is where the body already is: free by construction.
      let lo = 0,
        hi = 1;
      for (let i = 0; i < CONTACT_BISECTIONS; i++) {
        const m = (lo + hi) / 2;
        if (this.pushTo(at(m).pose) === null) hi = m;
        else lo = m;
      }
      f = lo;
      end = at(lo);
      push = lo > 0 ? this.pushTo(end.pose) : { boxes: null, force_n: 0 };
    }
    this.last_step_fraction = f;
    this.pose = end.pose;
    this.last_stalled = blocked;
    this.last_push_n = push?.force_n ?? 0;
    const before = this.cfg.boxes;
    if (push?.boxes) this.place(push.boxes);
    this.noteContacts((q) => at(q).pose, before, this.t_ms - dt_ms, dt_ms, f);
    this.notePushes(before);
    this.noteEcho();
    this.rate_deg_s = dt_ms > 0 ? ((end.th * 180) / Math.PI / dt_ms) * 1000 : 0;
    // A spin in place only wobbles the axle centre (wheel noise): that is not travel.
    if (Math.abs(end.d) > 0.1 * end.wheels) this.odometer_cm += Math.abs(end.d);
    if (this.segs.length > 0) this.followLine();
    return blocked;
  }

  /**
   * Where the boxes go if the body moves to `p`: null when it cannot (a wall, a fixed box, boxes too heavy to push together, or
   * a pushed box that would meet a wall or another box), else the new list (null if nothing moves) and the force the
   * drive spends sliding them. A pushed box moves the least way that clears the body (the separating axis of the
   * smallest overlap), quasi-statically: a light box on a floor stops the instant nothing pushes it (sliding
   * friction stops a box at 20 cm/s in about 5 ms), so it carries no speed of its own. It translates and does not
   * turn: an off-centre push slides it straight instead of rotating it.
   */
  private pushTo(p: Pose): { boxes: Obstacle[] | null; force_n: number } | null {
    const { width, height, boxes } = this.cfg;
    const cs = this.corners(p);
    for (const [x, y] of cs) if (x < 0 || x > width || y < 0 || y > height) return null;
    const limit = this.drive?.push_n ?? DEFAULT_PUSH_N;
    let next: Obstacle[] | null = null,
      force = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      if (!this.boxCollides(b, p, cs)) continue;
      const resist = slideForceN(b);
      if (resist === null || resist > limit) return null;
      const [dx, dy] = clearOf(b, p, cs, this.cfg.body);
      const moved = { ...b, x: b.x + dx, y: b.y + dy };
      if (moved.x < 0 || moved.y < 0 || moved.x + moved.w > width || moved.y + moved.h > height) return null;
      (next ??= [...boxes])[i] = moved;
      force += resist;
    }
    if (!next) return { boxes: null, force_n: 0 };
    // the limit is what the drive pushes in all: boxes it touches at once share it
    if (force > limit) return null;
    // a pushed box stops against any box it did not already overlap (boxes stacked by hand may be dragged apart)
    for (let i = 0; i < next.length; i++) {
      if (next[i] === boxes[i]) continue;
      for (let j = 0; j < next.length; j++)
        if (j !== i && overlaps(next[i]!, next[j]!) && !overlaps(boxes[i]!, boxes[j]!)) return null;
      if (this.boxCollides(next[i]!, p, cs)) return null; // two pushes that undo each other
    }
    return { boxes: next, force_n: force };
  }

  /** The slices of motion noise that [t0, t0 + dt] of world time spans: each one's share of the time and wheel factors. */
  private wheelNoise(t0: number, dt: number): { w: number; l: number; r: number }[] {
    const nz = this.cfg.noise;
    if (nz.motor === 0 && nz.slip === 0) return [{ w: 1, l: 1, r: 1 }];
    const draw = (k: number, w: number) => {
      const g = new Rng(mixSeed(this.seed, k));
      const l = (1 + nz.motor * g.gauss()) * (1 - nz.slip * 2 * g.next());
      return { w, l, r: (1 + nz.motor * g.gauss()) * (1 - nz.slip * 2 * g.next()) };
    };
    if (!(dt > 0)) return [draw(Math.floor(t0 / MOTION_NOISE_MS), 1)];
    const out: { w: number; l: number; r: number }[] = [];
    const end = t0 + dt;
    let a = t0;
    while (end - a > 1e-9) {
      const k = Math.floor(a / MOTION_NOISE_MS + 1e-9),
        b = Math.min(end, (k + 1) * MOTION_NOISE_MS);
      out.push(draw(k, (b - a) / dt));
      a = b;
    }
    return out;
  }

  private followLine(): void {
    const n = this.nearestOnLine(this.pose.x, this.pose.y)!;
    if (n.dist > LINE_TRACK_CM) {
      this.trackLine = -1;
      return;
    }
    if (n.line === this.trackLine) {
      const L = this.line_lengths_cm[n.line]!;
      let d = n.s - this.trackS;
      if (this.cfg.lines[n.line]!.closed) {
        if (d > L / 2) d -= L;
        else if (d < -L / 2) d += L;
      }
      this.line_travel_cm += d;
    }
    this.trackLine = n.line;
    this.trackS = n.s;
  }

  /** Time passes while the robot stands still. */
  wait(ms: number): void {
    if (ms > 0) {
      this.t_ms += ms;
      this.rate_deg_s = 0;
      this.last_push_n = 0;
      if (this.pushing.size > 0) this.notePushes(this.cfg.boxes); // nothing pushes: a push in progress ends
    }
  }

  // ----- floor -----
  /** Nearest point of any line: which line, distance to its centre line, and position along it (cm). */
  nearestOnLine(x: number, y: number): { dist: number; s: number; line: number } | null {
    if (this.segs.length === 0) return null;
    let best = Infinity,
      bs = 0,
      bl = 0;
    for (const g of this.segs) {
      const vx = g.bx - g.ax,
        vy = g.by - g.ay;
      let t = ((x - g.ax) * vx + (y - g.ay) * vy) / (g.len * g.len);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (g.ax + vx * t),
        dy = y - (g.ay + vy * t);
      const d2 = dx * dx + dy * dy;
      if (d2 < best) {
        best = d2;
        bs = g.s0 + t * g.len;
        bl = g.line;
      }
    }
    return { dist: Math.sqrt(best), s: bs, line: bl };
  }

  /** Point and tangent direction of line `line` at position `s` (cm along it). */
  pointOnLine(s: number, line = 0): { x: number; y: number; th: number } {
    const L = this.line_lengths_cm[line];
    if (L === undefined) throw new Error(`pointOnLine: this world has no line ${line}`);
    if (this.cfg.lines[line]!.closed) s = ((s % L) + L) % L;
    else s = Math.min(L, Math.max(0, s));
    let last: Seg | null = null;
    for (const g of this.segs) {
      if (g.line !== line) continue;
      last = g;
      if (s <= g.s0 + g.len) {
        const t = (s - g.s0) / g.len;
        return { x: g.ax + (g.bx - g.ax) * t, y: g.ay + (g.by - g.ay) * t, th: Math.atan2(g.by - g.ay, g.bx - g.ax) };
      }
    }
    return { x: last!.bx, y: last!.by, th: Math.atan2(last!.by - last!.ay, last!.bx - last!.ax) };
  }

  floorColorAt(x: number, y: number): ColorId {
    const c = this.cfg;
    if (x < 0 || x > c.width || y < 0 || y > c.height) return COLOR.none;
    for (const g of this.segs) {
      const vx = g.bx - g.ax,
        vy = g.by - g.ay;
      let t = ((x - g.ax) * vx + (y - g.ay) * vy) / (g.len * g.len);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (g.ax + vx * t),
        dy = y - (g.ay + vy * t);
      if (dx * dx + dy * dy <= g.half * g.half) return COLOR.black;
    }
    for (let i = c.zones.length - 1; i >= 0; i--) {
      const z = c.zones[i]!;
      if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) return z.color;
    }
    return COLOR.white;
  }

  /** World position of a point `ahead` cm in front of the axle. */
  pointAhead(ahead: number, p: Pose = this.pose): Vec {
    return [p.x + ahead * Math.cos(p.th), p.y + ahead * Math.sin(p.th)];
  }

  /**
   * The distance sensor's eye in the world and the heading it looks along (rad): body.distance_sensor_x_cm ahead,
   * _y_cm to the left, turned by _yaw_deg. Every ray of the ultrasonic and the infrared starts here.
   */
  distanceSensorAxis(p: Pose = this.pose): { o: Vec; th: number } {
    const g = this.cfg.body,
      c = Math.cos(p.th),
      s = Math.sin(p.th);
    return {
      o: [
        p.x + g.distance_sensor_x_cm * c - g.distance_sensor_y_cm * s,
        p.y + g.distance_sensor_x_cm * s + g.distance_sensor_y_cm * c,
      ],
      th: p.th + (g.distance_sensor_yaw_deg * Math.PI) / 180,
    };
  }

  // ----- sensors (every read spends noise from the sensor generator, never from the motion one) -----
  /** Reflected light 0..100 %: the average of the spot under the sensor, so the edge of a line reads in between. */
  senseReflect(): number {
    const v = this.reflectSpot() + this.cfg.noise.reflect_pct * this.sensorRng.gauss();
    return Math.round(Math.min(100, Math.max(0, v)));
  }
  /** What senseReflect reads without noise and not rounded (a display): it spends nothing of the sensor generator. */
  reflectSpot(): number {
    const g = this.cfg.body;
    const [sx, sy] = this.pointAhead(g.color_sensor_x_cm);
    let sum = REFLECT_BY_COLOR[this.floorColorAt(sx, sy)]!,
      n = 1;
    for (const rr of [0.5, 1]) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * 2 * Math.PI + (rr === 1 ? 0 : Math.PI / 8),
          r = rr * g.color_spot_radius_cm;
        sum += REFLECT_BY_COLOR[this.floorColorAt(sx + r * Math.cos(a), sy + r * Math.sin(a))]!;
        n++;
      }
    }
    return sum / n;
  }

  /** Colour id 0..7 of the floor right under the centre of the sensor. */
  senseColorId(): ColorId {
    const [sx, sy] = this.pointAhead(this.cfg.body.color_sensor_x_cm);
    return this.floorColorAt(sx, sy);
  }

  /**
   * True distance (no noise, no clamp) of one ray from the distance sensor to a wall or obstacle it sees; `vHalfRad`
   * as rayHit (Math.PI / 2 sees every box, whatever its height: a camera's view).
   */
  rayDistance(p: Pose = this.pose, offset_rad = 0, vHalfRad = (CONE_HALF_DEG * Math.PI) / 180): number {
    return this.rayHit(p, offset_rad, vHalfRad).d;
  }
  /**
   * One ray from the distance sensor: how far it goes (cm, no noise, no clamp), the cosine of the angle between
   * it and the normal of the surface it hits (1 = square on), and how tall that is (Infinity: a wall, a box
   * without a height).
   */
  rayHit(
    p: Pose = this.pose,
    offset_rad = 0,
    vHalfRad = (CONE_HALF_DEG * Math.PI) / 180,
  ): { d: number; cos: number; top_cm: number; ir: number } {
    const {
      o: [ox, oy],
      th,
    } = this.distanceSensorAxis(p);
    const z = this.cfg.body.distance_sensor_z_cm,
      spread = vHalfRad >= Math.PI / 2 ? Infinity : Math.tan(vHalfRad);
    const dx = Math.cos(th + offset_rad),
      dy = Math.sin(th + offset_rad);
    const { width, height, boxes } = this.cfg;
    if (ox <= 0 || ox >= width || oy <= 0 || oy >= height) return { d: 0, cos: 1, top_cm: Infinity, ir: 1 };
    let best = Infinity,
      cos = 1,
      top = Infinity,
      ir = 1;
    const take = (t: number, c: number, h = Infinity, r = 1): void => {
      if (t < best) {
        best = t;
        cos = c;
        top = h;
        ir = r;
      }
    };
    if (dx > 1e-12) take((width - ox) / dx, Math.abs(dx));
    else if (dx < -1e-12) take(-ox / dx, Math.abs(dx));
    if (dy > 1e-12) take((height - oy) / dy, Math.abs(dy));
    else if (dy < -1e-12) take(-oy / dy, Math.abs(dy));
    for (const b of boxes) {
      let t0 = 0,
        t1 = Infinity,
        c0 = 1,
        hit = true;
      for (const [o, d, lo, hi] of [
        [ox, dx, b.x, b.x + b.w],
        [oy, dy, b.y, b.y + b.h],
      ] as [number, number, number, number][]) {
        if (Math.abs(d) < 1e-12) {
          if (o < lo || o > hi) {
            hit = false;
            break;
          }
          continue;
        }
        let a = (lo - o) / d,
          c = (hi - o) / d;
        if (a > c) {
          const t = a;
          a = c;
          c = t;
        }
        if (a > t0) {
          t0 = a;
          c0 = Math.abs(d); // the ray enters through a face across this axis
        }
        if (c < t1) t1 = c;
        if (t0 > t1) {
          hit = false;
          break;
        }
      }
      if (!hit) continue;
      const below = b.height_cm === undefined ? 0 : z - b.height_cm;
      const r = b.ir_reflectivity ?? 1;
      if (below <= 0 || spread === Infinity) take(t0, c0, b.height_cm, r);
      // a box lower than the sensor: seen only once the beam's lower edge comes down to its top, and then where the
      // beam meets its top edge, slanted down (the slant counts against the echo as a sideways one does)
      else if (below <= t0 * spread) take(Math.hypot(t0, below), c0 * Math.cos(Math.atan2(below, t0)), b.height_cm, r);
    }
    return { d: best, cos, top_cm: top, ir };
  }

  /**
   * What the ultrasonic sensor measures without noise, unclamped: the nearest echo across its cone, or Infinity when
   * no surface sends one back. A hard flat surface reflects like a mirror, so a ray echoes only off a surface it
   * meets within ULTRASONIC_ECHO_DEG of square: a wall slanted more than CONE_HALF_DEG + ULTRASONIC_ECHO_DEG gives
   * nothing back (the sensor then reads 255).
   */
  coneDistance(p: Pose = this.pose): number {
    return this.coneEcho(p).d;
  }
  /**
   * coneDistance and the bearing (rad from the heading, counter-clockwise) its nearest echo came back along: NaN
   * when none did. A display: it spends no noise.
   */
  coneEcho(p: Pose = this.pose): { d: number; off: number } {
    const minCos = Math.cos((ULTRASONIC_ECHO_DEG * Math.PI) / 180);
    let best = Infinity,
      bestOff = NaN;
    const cast = (off: number): void => {
      const h = this.rayHit(p, off);
      if (h.cos >= minCos - 1e-12 && h.d < best) {
        best = h.d;
        bestOff = off;
      }
    };
    const half = (CONE_HALF_DEG * Math.PI) / 180;
    for (let i = 0; i < ULTRASONIC_RAYS; i++) cast(((2 * i) / (ULTRASONIC_RAYS - 1) - 1) * half);
    // then between them: only a box nearer than the echo found so far can send a nearer one (a face it hides is
    // farther still), so the rest need no rays
    for (const off of this.echoBearings(p, best)) cast(off);
    const corner = this.cornerEcho(p);
    return corner.d < best ? corner : { d: best, off: bestOff };
  }
  /**
   * The bearings (rad, from the heading) the cone is searched along besides its ULTRASONIC_RAYS even rays: where its
   * nearest echo can lie between them, so that nothing inside the cone hides between two rays (a thin post far
   * away): toward the nearest point of each wall and of each face of each box nearer than `within` cm (where a flat
   * face sends its echo back), and just to either side of each such box's corners (where a nearer box stops hiding
   * a face behind it). Those inside the cone.
   */
  private echoBearings(p: Pose, within: number): number[] {
    const half = (CONE_HALF_DEG * Math.PI) / 180;
    const out: number[] = [];
    const {
      o: [ox, oy],
      th,
    } = this.distanceSensorAxis(p);
    const toward = (x: number, y: number): void => {
      let off = (Math.atan2(y - oy, x - ox) - th) % (2 * Math.PI);
      if (off > Math.PI) off -= 2 * Math.PI;
      else if (off < -Math.PI) off += 2 * Math.PI;
      if (Math.abs(off) <= half) out.push(off);
    };
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const { width, height, boxes } = this.cfg;
    // the walls: the nearest point of each is straight across
    toward(ox, 0);
    toward(ox, height);
    toward(0, oy);
    toward(width, oy);
    const NUDGE = 1e-4; // rad: just past a corner, onto the face it hid
    const bearing = (x: number, y: number): number => {
      let off = (Math.atan2(y - oy, x - ox) - th) % (2 * Math.PI);
      if (off > Math.PI) off -= 2 * Math.PI;
      else if (off < -Math.PI) off += 2 * Math.PI;
      return off;
    };
    for (const b of boxes) {
      // a box beyond the sensor's range, or wholly to one side of the cone, adds nothing
      const nx = clamp(ox, b.x, b.x + b.w) - ox,
        ny = clamp(oy, b.y, b.y + b.h) - oy;
      if (Math.hypot(nx, ny) >= Math.min(within, ULTRASONIC_NO_ECHO_CM)) continue;
      if (nx !== 0 || ny !== 0) {
        const bs = [bearing(b.x, b.y), bearing(b.x + b.w, b.y), bearing(b.x, b.y + b.h), bearing(b.x + b.w, b.y + b.h)];
        // a box subtends less than pi from outside it: unwrap its bearings around the first one
        const u = bs.map((v) => v - 2 * Math.PI * Math.round((v - bs[0]!) / (2 * Math.PI)));
        if (Math.min(...u) > half || Math.max(...u) < -half) continue;
      }
      // the nearest point of each face (a segment along x or y), a hair inside it so the ray meets the face
      const ix = (v: number) => clamp(v, b.x + 1e-6, b.x + b.w - 1e-6),
        iy = (v: number) => clamp(v, b.y + 1e-6, b.y + b.h - 1e-6);
      toward(ix(ox), b.y);
      toward(ix(ox), b.y + b.h);
      toward(b.x, iy(oy));
      toward(b.x + b.w, iy(oy));
      for (const [x, y] of [
        [b.x, b.y],
        [b.x + b.w, b.y],
        [b.x, b.y + b.h],
        [b.x + b.w, b.y + b.h],
      ] as Vec[]) {
        const n = out.length;
        toward(x, y);
        if (out.length > n) {
          const c = out.pop()!;
          for (const d of [c - NUDGE, c + NUDGE]) if (Math.abs(d) <= half) out.push(d);
        }
      }
    }
    return out;
  }
  /** The nearest box corner that echoes whatever the angle (ULTRASONIC_EDGE_MAX_CM): inside the cone and in plain view. */
  private cornerEcho(p: Pose): { d: number; off: number } {
    const { width, height, boxes } = this.cfg;
    const {
      o: [ox, oy],
      th,
    } = this.distanceSensorAxis(p);
    const half = (CONE_HALF_DEG * Math.PI) / 180;
    let best = Infinity,
      bestOff = NaN;
    const look = (x: number, y: number, max: number): void => {
      const d = Math.hypot(x - ox, y - oy);
      if (!(d > 1e-9) || d > max || d >= best) return;
      let off = (Math.atan2(y - oy, x - ox) - th) % (2 * Math.PI);
      if (off > Math.PI) off -= 2 * Math.PI;
      else if (off < -Math.PI) off += 2 * Math.PI;
      if (Math.abs(off) > half) return;
      // in plain view: the ray toward it meets nothing before it (the corner's own box is met at the corner)
      if (this.rayHit(p, off).d >= d - 1e-6) {
        best = d;
        bestOff = off;
      }
    };
    const inside = (x: number, y: number, skip: Rect): boolean =>
      x <= 0 ||
      x >= width ||
      y <= 0 ||
      y >= height ||
      boxes.some((b) => b !== skip && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    const z = this.cfg.body.distance_sensor_z_cm,
      spread = Math.tan(half);
    for (const b of boxes)
      for (const [x, y] of [
        [b.x, b.y],
        [b.x + b.w, b.y],
        [b.x, b.y + b.h],
        [b.x + b.w, b.y + b.h],
      ] as Vec[])
        // a corner on a wall or in another box is no edge: the surfaces meet there flush or hollow
        if (!inside(x, y, b) && !(b.height_cm !== undefined && z - b.height_cm > Math.hypot(x - ox, y - oy) * spread))
          look(x, y, ULTRASONIC_EDGE_MAX_CM);
    // the room's corners: two walls square to each other send sound back the way it came (a corner reflector)
    for (const [x, y] of [
      [0, 0],
      [width, 0],
      [0, height],
      [width, height],
    ] as Vec[])
      look(x, y, ULTRASONIC_CORNER_MAX_CM);
    return { d: best, off: bestOff };
  }
  /** What the ultrasonic sensor reads without noise (a display): 3..250 cm, 255 with no echo in range. */
  ultrasonicCm(): number {
    return ultrasonicReading(this.coneDistance());
  }
  /** Ultrasonic distance in cm, with noise: 3..250 like the real sensor, 255 when no echo comes back. */
  senseUltrasonic(): number {
    const d = this.coneDistance();
    return ultrasonicReading(Number.isFinite(d) ? d + this.cfg.noise.ultrasonic_cm * this.sensorRng.gauss() : d);
  }

  /**
   * What the infrared sensor reads without noise and not rounded (a display): 0..100 %. It measures the intensity of
   * its own light reflected back. Each ray of its beam (weighted by the beam's brightness) returns light falling
   * with the square of the distance and with the cosine of incidence (a matte surface), and the reading is the
   * distance at which a square, beam-filling white surface would return that much, times IR_PCT_PER_CM: linear for
   * a large white wall square on, farther for a wall at a slant, an object that fills only part of the beam, or a
   * darker one (an obstacle's ir_reflectivity: black at 0.21 reads 89 at 38 cm, as the stock firmware does).
   */
  irProximity(): number {
    return Math.min(100, this.irUncapped());
  }
  /** irProximity before the sensor's 100 % cap: noise goes on this, so far from everything it still reads 100. */
  private irUncapped(): number {
    return this.irBeam().pct;
  }
  /**
   * The infrared beam as irProximity casts it: each ray's bearing (rad from the heading), length (cm) and share of
   * the light that comes back (0..1, the shares sum to 1), and the reading before the 100 % cap. A display: it
   * spends no noise.
   */
  irBeam(p: Pose = this.pose): { rays: { off: number; d: number; share: number }[]; pct: number } {
    let sum = 0,
      full = 0;
    const rays: { off: number; d: number; share: number }[] = [];
    for (let i = 0; i < IR_RAYS; i++) {
      const u = (2 * i) / (IR_RAYS - 1) - 1,
        off = (u * IR_CONE_HALF_DEG * Math.PI) / 180,
        w = Math.cos((u * Math.PI) / 2) ** 2;
      const h = this.rayHit(p, off, (IR_CONE_HALF_DEG * Math.PI) / 180),
        d = Math.max(h.d, 0.1);
      const back = (w * h.cos * h.ir) / (d * d);
      sum += back;
      full += w * Math.cos(off) ** 3; // a square wall at distance 1
      rays.push({ off, d: h.d, share: back });
    }
    for (const r of rays) r.share = sum > 0 ? r.share / sum : 0;
    return { rays, pct: IR_PCT_PER_CM * Math.sqrt(full / sum) };
  }
  /** Infrared proximity in % (0 touching, 100 far), with noise that grows with the reading. */
  senseIrProximity(): number {
    const p = this.irUncapped(),
      v = p + ((this.cfg.noise.ir_pct * Math.min(100, p)) / 40) * this.sensorRng.gauss();
    return Math.round(Math.min(100, Math.max(0, v)));
  }

  /**
   * Front bumper: 1 if a wall, or a box at least as tall as the bumper's lowest part (body.touch_z_cm), is less than
   * TOUCH_REACH_CM ahead of the front, across the body's width. A wall along the robot's side does not press it.
   */
  senseTouch(): 0 | 1 {
    const p = this.pose,
      g = this.cfg.body,
      c = Math.cos(p.th),
      s = Math.sin(p.th);
    const strip: Vec[] = [
      [g.front_cm, g.half_width_cm],
      [g.front_cm + TOUCH_REACH_CM, g.half_width_cm],
      [g.front_cm + TOUCH_REACH_CM, -g.half_width_cm],
      [g.front_cm, -g.half_width_cm],
    ].map(([lx, ly]) => [p.x + lx! * c - ly! * s, p.y + lx! * s + ly! * c] as Vec);
    const { width, height, boxes } = this.cfg;
    if (strip.some(([x, y]) => x < 0 || x > width || y < 0 || y > height)) return 1;
    const tall = (b: Obstacle) => b.height_cm === undefined || b.height_cm > g.touch_z_cm;
    return boxes.some((b) => tall(b) && polygonsMeet(strip, b)) ? 1 : 0;
  }

  /** Accumulated gyro angle in whole degrees since the last reset, counter-clockwise-positive. */
  senseGyro(): number {
    return Math.round(this.peekGyroDeg() + this.cfg.noise.gyro_deg * this.sensorRng.gauss()) + 0;
  }

  /** A named point of the map. Fails if it does not exist, listing the ones that do. */
  point(label: string): NamedPoint {
    const p = this.cfg.points.find((q) => q.label === label);
    if (!p)
      throw new Error(
        `unknown point "${label}"; points in world "${this.cfg.name}": ${this.cfg.points.map((q) => q.label).join(", ") || "(none)"}`,
      );
    return p;
  }
}
