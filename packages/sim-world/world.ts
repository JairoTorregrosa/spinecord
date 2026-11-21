// Deterministic 2D world for a differential-drive robot body.
// Units: cm, ms; radians inside, degrees at the edges.
// Axes: x to the right, y UP (the renderer flips y). Angles are counter-clockwise-positive seen from above.
// No Math.random and no real clocks: everything comes from the seed, and time is virtual.
//
// The world file describes the environment and where the sensors sit on the body. It does NOT describe the
// drivetrain: wheel size, axle track and which motors drive come from the robot profile, handed in by whoever
// puts a robot body in this world (see `World.drive`).

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
  /** Distance sensor (ultrasonic or infrared): cm ahead of the axle, looking forward. */
  distance_sensor_x_cm: number;
}
/** Drivetrain geometry the physics needs. It comes from the robot profile, never from the world file. */
export interface DriveGeometry {
  axle_track_cm: number;
}

export interface NoiseConfig {
  /** Relative standard deviation, per physics step, of each wheel's real travel. */
  motor: number;
  /** Mean fraction of wheel rotation lost to slip. */
  slip: number;
  /** Fixed bias between the wheels (relative std dev, drawn from the seed): the robot veers. */
  wheel_bias: number;
  ultrasonic_cm: number;
  reflect_pct: number;
  gyro_deg: number;
  gyro_drift_deg_s: number;
}

export interface WorldConfig {
  name: string;
  /** Sections of the file that belong to other packages (e.g. what is plugged into a brick). Not interpreted here. */
  extensions: Record<string, unknown>;
  width: number;
  height: number;
  boxes: Rect[];
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
};

export const DEFAULT_NOISE: NoiseConfig = {
  motor: 0.01,
  slip: 0.01,
  wheel_bias: 0.003,
  ultrasonic_cm: 0.3,
  reflect_pct: 1,
  gyro_deg: 0.3,
  gyro_drift_deg_s: 0,
};
export const NO_NOISE: NoiseConfig = {
  motor: 0,
  slip: 0,
  wheel_bias: 0,
  ultrasonic_cm: 0,
  reflect_pct: 0,
  gyro_deg: 0,
  gyro_drift_deg_s: 0,
};

/** Physics step (ms of simulated time). */
export const DT_MS = 20;
export const ULTRASONIC_MIN_CM = 3;
export const ULTRASONIC_MAX_CM = 250;
/** Half angle of the ultrasonic cone (an approximation: the real one is around +-10..20 deg). */
export const CONE_HALF_DEG = 12;
/** Infrared proximity is a percentage, not cm: here 100 % is about 70 cm, linear. */
export const IR_FULL_SCALE_CM = 70;
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
  const partial = <T extends object>(v: unknown, path: string, base: T): T => {
    if (v === undefined) return { ...base };
    const o = obj(v, path),
      out = { ...base } as Record<string, number>;
    for (const [k, val] of Object.entries(o)) {
      if (!(k in base)) fail(`${path}.${k}`, `is not a known field (${Object.keys(base).join(", ")})`);
      out[k] = num(val, `${path}.${k}`, 0);
    }
    return out as T;
  };
  const root = obj(json, "root");
  const KNOWN = [
    "schema",
    "name",
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
    extensions: root.extensions === undefined ? {} : { ...obj(root.extensions, "extensions") },
    width: num(arena.width_cm, "arena.width_cm", 1),
    height: num(arena.height_cm, "arena.height_cm", 1),
    boxes: arr(root.obstacles, "obstacles").map((b, i) => rect(b, `obstacles[${i}]`)),
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
    body: partial(root.body, "body", DEFAULT_BODY),
    noise: partial(root.noise, "noise", DEFAULT_NOISE),
    start: {
      x: num(start.x, "start.x"),
      y: num(start.y, "start.y"),
      th: (num(start.heading_deg, "start.heading_deg") * Math.PI) / 180,
    },
  };
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
  private segs: Seg[] = [];
  private trackLine = -1;
  private trackS = 0;
  /** Length of each line (cm), in file order. */
  readonly line_lengths_cm: number[] = [];

  constructor(cfg: WorldConfig, seed = 1, drive: DriveGeometry | null = null) {
    if (!(cfg.width > 0 && cfg.height > 0)) throw new Error("world: the arena needs width and height > 0");
    if (drive && !(drive.axle_track_cm > 0))
      throw new Error(`world: drive.axle_track_cm must be > 0, got ${drive.axle_track_cm}`);
    this.cfg = cfg;
    this.seed = seed;
    this.drive = drive;
    this.motionRng = new Rng(seed);
    this.sensorRng = new Rng(seed ^ 0x5bd1e995);
    this.gainL = 1 + cfg.noise.wheel_bias * this.motionRng.gauss();
    this.gainR = 1 + cfg.noise.wheel_bias * this.motionRng.gauss();
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
    this.pose = { ...cfg.start };
    this.gyroZeroTh = this.pose.th;
    if (this.collides(this.pose))
      throw new Error(
        `world "${cfg.name}": the robot does not fit at the start pose (${cfg.start.x}, ${cfg.start.y}): it overlaps a wall or obstacle`,
      );
    this.resetTrip();
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
  }
  resetGyro(): void {
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
    const { width, height, boxes, body: g } = this.cfg;
    const cs = this.corners(p);
    let minx = Infinity,
      maxx = -Infinity,
      miny = Infinity,
      maxy = -Infinity;
    for (const [x, y] of cs) {
      if (x < 0 || x > width || y < 0 || y > height) return true;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    }
    const c = Math.cos(p.th),
      s = Math.sin(p.th);
    for (const b of boxes) {
      if (maxx < b.x || minx > b.x + b.w || maxy < b.y || miny > b.y + b.h) continue;
      // The body's own axes (separating axis theorem).
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
      if (umax < -g.back_cm || umin > g.front_cm || vmax < -g.half_width_cm || vmin > g.half_width_cm) continue;
      return true;
    }
    return false;
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
   * Returns true if the footprint would hit something: then the wheels are blocked and the robot does not move.
   */
  stepWheels(dl_cm: number, dr_cm: number, dt_ms: number): boolean {
    this.t_ms += dt_ms;
    if (dl_cm === 0 && dr_cm === 0) {
      this.rate_deg_s = 0;
      this.last_stalled = false;
      return false;
    }
    if (!this.drive)
      throw new Error(
        "world: this body has no drivetrain geometry (set World.drive from the robot profile before rolling the wheels)",
      );
    const nz = this.cfg.noise;
    const tl = dl_cm * this.gainL * (1 + nz.motor * this.motionRng.gauss()) * (1 - nz.slip * 2 * this.motionRng.next());
    const tr = dr_cm * this.gainR * (1 + nz.motor * this.motionRng.gauss()) * (1 - nz.slip * 2 * this.motionRng.next());
    const d = (tl + tr) / 2,
      dth = (tr - tl) / this.drive.axle_track_cm;
    const mid = this.pose.th + dth / 2;
    const np: Pose = { x: this.pose.x + d * Math.cos(mid), y: this.pose.y + d * Math.sin(mid), th: this.pose.th + dth };
    if (this.collides(np)) {
      this.rate_deg_s = 0;
      this.last_stalled = true;
      return true;
    }
    this.pose = np;
    this.last_stalled = false;
    this.rate_deg_s = dt_ms > 0 ? ((dth * 180) / Math.PI / dt_ms) * 1000 : 0;
    // A spin in place only wobbles the axle centre (wheel noise): that is not travel.
    if (Math.abs(d) > (0.1 * (Math.abs(tl) + Math.abs(tr))) / 2) this.odometer_cm += Math.abs(d);
    if (this.segs.length > 0) this.followLine();
    return false;
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

  // ----- sensors (every read spends noise from the sensor generator, never from the motion one) -----
  /** Reflected light 0..100 %: the average of the spot under the sensor, so the edge of a line reads in between. */
  senseReflect(): number {
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
    const v = sum / n + this.cfg.noise.reflect_pct * this.sensorRng.gauss();
    return Math.round(Math.min(100, Math.max(0, v)));
  }

  /** Colour id 0..7 of the floor right under the centre of the sensor. */
  senseColorId(): ColorId {
    const [sx, sy] = this.pointAhead(this.cfg.body.color_sensor_x_cm);
    return this.floorColorAt(sx, sy);
  }

  /** True distance (no noise, no clamp) of one ray from the distance sensor to a wall or obstacle. */
  rayDistance(p: Pose = this.pose, offset_rad = 0): number {
    const [ox, oy] = this.pointAhead(this.cfg.body.distance_sensor_x_cm, p);
    const dx = Math.cos(p.th + offset_rad),
      dy = Math.sin(p.th + offset_rad);
    const { width, height, boxes } = this.cfg;
    if (ox <= 0 || ox >= width || oy <= 0 || oy >= height) return 0;
    let best = Infinity;
    if (dx > 1e-12) best = Math.min(best, (width - ox) / dx);
    else if (dx < -1e-12) best = Math.min(best, -ox / dx);
    if (dy > 1e-12) best = Math.min(best, (height - oy) / dy);
    else if (dy < -1e-12) best = Math.min(best, -oy / dy);
    for (const b of boxes) {
      let t0 = 0,
        t1 = Infinity,
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
        if (a > t0) t0 = a;
        if (c < t1) t1 = c;
        if (t0 > t1) {
          hit = false;
          break;
        }
      }
      if (hit && t0 < best) best = t0;
    }
    return best;
  }

  /** A real ultrasonic sensor sees a cone, not a ray: here the nearest echo of three rays (0 and +-CONE_HALF_DEG). */
  coneDistance(p: Pose = this.pose): number {
    const a = (CONE_HALF_DEG * Math.PI) / 180;
    return Math.min(this.rayDistance(p, -a), this.rayDistance(p, 0), this.rayDistance(p, a));
  }

  /** Ultrasonic distance in cm, with noise, clamped to 3..250 like the real sensor. */
  senseUltrasonic(): number {
    const d = this.coneDistance() + this.cfg.noise.ultrasonic_cm * this.sensorRng.gauss();
    return Math.round(Math.min(ULTRASONIC_MAX_CM, Math.max(ULTRASONIC_MIN_CM, d)) * 10) / 10;
  }

  /** Infrared proximity in % (0 touching, 100 far). Approximate: the real one depends on the material. */
  senseIrProximity(): number {
    const d = this.rayDistance() + this.cfg.noise.ultrasonic_cm * 2 * this.sensorRng.gauss();
    return Math.round(Math.min(100, Math.max(0, (d / IR_FULL_SCALE_CM) * 100)));
  }

  /** Front bumper: 1 if a wall or obstacle is less than 0.7 cm ahead. */
  senseTouch(): 0 | 1 {
    const p = this.pose;
    return this.collides({ x: p.x + 0.7 * Math.cos(p.th), y: p.y + 0.7 * Math.sin(p.th), th: p.th }) ? 1 : 0;
  }

  /** Accumulated gyro angle in whole degrees since the last reset, counter-clockwise-positive. */
  senseGyro(): number {
    const nz = this.cfg.noise;
    const deg =
      ((this.pose.th - this.gyroZeroTh) * 180) / Math.PI +
      (nz.gyro_drift_deg_s * (this.t_ms - this.gyroZeroMs)) / 1000 +
      nz.gyro_deg * this.sensorRng.gauss();
    return Math.round(deg) + 0;
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
