// The robot's trail on the floor, as numbers: which poses become points, where the path breaks, and the buffers a
// ribbon is drawn from (src/trail-view.ts draws them). No WebGL here.
//
// A point is taken when the robot has moved STEP_CM from the last one, or turned TURN_STEP in place: a pivot leaves
// a fan of points on one spot, which the ribbon draws as a dot (a full turn) or a wedge (part of one). Each point
// carries how the robot got there: forward, in reverse, or turning in place. The ribbon lies across the robot's
// heading, so a turn in place sweeps it round its centre.
//
// The path is fed the robot's states as the process sends them (about 30 a second, whether the page draws frames or
// not: a hidden tab still records the path it could not show), each step between two states cut into points.
// The path breaks where the robot could not have driven: a jump farther or a turn faster than its motors allow (a
// person carried it, the world was restored), or a step too long to know what lay between (states the page missed);
// the next point starts a new piece, with nothing drawn across the gap.
//
// Memory is bounded: at most `max` points; when full, the oldest half goes. Each point is two vertices (its left and
// right edge) and one quad back to the point before it, unless it starts a piece. Quads are stored newest first in
// the index, so a stencil that lets each pixel be drawn once keeps the newest part on top where the path crosses
// itself.

/** Distance between points, cm. Jitter under it is skipped. */
export const STEP_CM = 1;
/** Turn in place that adds a point, rad (5°): a pivot's wedge stays round. */
export const TURN_STEP = (5 * Math.PI) / 180;
/** Large motor at 100 % speed, deg/s (packages/sim-ev3 LARGE_DEG_S; the page imports only three.js). */
export const LARGE_DEG_S = 1020;
/** What a carry may move or turn without being noticed: noise of the pose, cm and rad. */
const SLACK_CM = 2,
  SLACK_RAD = 0.05;
/** Above the drive's top speed a step must be to count as a carry: twice for a move, a quarter more for a turn (a
 *  turn by hand in place is short; the drive's own turn rate is well known). */
const MOVE_OVER = 2,
  TURN_OVER = 1.25;
/** Longest step between two states drawn as a straight band, cm: past it what lay between is not known. */
export const JOIN_CM = 10;

/** How the robot reached a point: driving forward, in reverse, or turning where it stands. */
export const KIND = { forward: 1, reverse: -1, pivot: 0 } as const;
export type Kind = (typeof KIND)[keyof typeof KIND];

export interface TimedPose {
  x: number;
  y: number;
  /** Heading, rad, counter-clockwise from +x. */
  th: number;
  t_ms: number;
}

/** The fastest the drivetrain can carry the robot: cm/s of its wheels at full speed, rad/s spinning in place. A
 *  robot without a drive cannot move itself at all. */
export function driveLimits(d: { wheel_diameter_cm: number; axle_track_cm: number } | null): {
  cm_s: number;
  rad_s: number;
} {
  if (!d) return { cm_s: 0, rad_s: 0 };
  const cm_s = (LARGE_DEG_S / 360) * Math.PI * d.wheel_diameter_cm;
  return { cm_s, rad_s: (2 * cm_s) / d.axle_track_cm };
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Whether the robot went from `a` to `b` in a way its motors could not have done (twice their top speed, plus the
 * pose's noise): a person carried it, or the world put it back. Time running backwards is a new world.
 */
export function teleported(a: TimedPose, b: TimedPose, lim: Limits): boolean {
  return jumped(a.x, a.y, a.th, a.t_ms, b.x, b.y, b.th, b.t_ms, lim);
}
type Limits = { cm_s: number; rad_s: number };
function jumped(
  ax: number,
  ay: number,
  ath: number,
  at: number,
  bx: number,
  by: number,
  bth: number,
  bt: number,
  lim: Limits,
): boolean {
  const dt = (bt - at) / 1000;
  if (dt < 0) return true;
  const moved = Math.hypot(bx - ax, by - ay),
    turned = Math.abs(wrap(bth - ath));
  return moved > SLACK_CM + MOVE_OVER * lim.cm_s * dt || turned > SLACK_RAD + TURN_OVER * lim.rad_s * dt;
}

/** What one state did to the trail: the first of a robot, a step drawn, or a break (a carry, or a step too long). */
export type Fed = "first" | "drawn" | "carried" | "gap";

/**
 * Turns the robot's states into the trail's points: each step between two states is cut into pieces of at most half
 * STEP_CM and TURN_STEP (an arc stays an arc, a pivot a round wedge, however far apart the states), and a step no
 * drive could make, or one longer than JOIN_CM, breaks the path instead.
 */
export class TrailFeed {
  private has = false;
  private x = 0;
  private y = 0;
  private th = 0;
  private t = 0;
  private lim: Limits = { cm_s: 0, rad_s: 0 };

  constructor(readonly path: TrailPath) {}

  /** Another robot (or none): forget the last state, and drive at most as fast as this one can. */
  reset(lim: Limits): void {
    this.has = false;
    this.lim = lim;
  }

  /** The robot is at (x, y) cm, heading `th` rad, at world time `t_ms`. */
  state(x: number, y: number, th: number, t_ms: number): Fed {
    const p = this.path;
    let fed: Fed;
    if (!this.has) fed = "first";
    else if (jumped(this.x, this.y, this.th, this.t, x, y, th, t_ms, this.lim)) fed = "carried";
    else if (Math.hypot(x - this.x, y - this.y) > JOIN_CM) fed = "gap";
    else fed = "drawn";
    if (fed === "drawn") {
      const dx = x - this.x,
        dy = y - this.y,
        dth = wrap(th - this.th);
      // half steps: the path takes a point once a whole one is reached, so points stay 1 to 1.5 steps apart
      const n = Math.max(1, Math.ceil((2 * Math.hypot(dx, dy)) / STEP_CM), Math.ceil((2 * Math.abs(dth)) / TURN_STEP));
      for (let i = 1; i <= n; i++) p.add(this.x + (dx * i) / n, this.y + (dy * i) / n, this.th + (dth * i) / n);
    } else {
      p.break();
      p.add(x, y, th);
    }
    this.has = true;
    this.x = x;
    this.y = y;
    this.th = th;
    this.t = t_ms;
    return fed;
  }
}

/** Floats per vertex in `aux`: side (+1 left edge, -1 right), distance driven (cm), kind, progress (cm). */
export const AUX = 4;

export class TrailPath {
  readonly max: number;
  /** Per vertex, three.js scene coordinates of the point's centre (x, height, -y); both edges share it. */
  readonly pos: Float32Array;
  /** Per vertex, the floor's unit vector to the robot's left, scene x and z. */
  readonly nrm: Float32Array;
  /** Per vertex: side, distance driven (cm, chevrons), kind, progress (cm, fading; a pivot counts its sweep). */
  readonly aux: Float32Array;
  /** Six per quad, newest first: quad k (back from point k to k-1) at slot max-1-k. */
  readonly index: Uint16Array;
  /** Per point: 1 when it starts a piece (no quad back). */
  private readonly starts: Uint8Array;
  private n = 0;
  private broken = true;
  private lx = 0;
  private ly = 0;
  private lth = 0;
  private dist = 0;
  private prog = 0;
  /** Points changed since `takeDirty`, [lo, hi); the whole buffer after a compaction. */
  private dlo = Infinity;
  private dhi = -Infinity;

  constructor(
    max: number,
    private readonly height: number,
    /** Half the ribbon's width, cm: a pivot's progress is its sweep at the edge. */
    private readonly half: number,
  ) {
    if (max < 4 || 2 * max > 65536) throw new Error(`a trail holds 4 to 32768 points, not ${max}`);
    this.max = max;
    this.pos = new Float32Array(2 * max * 3);
    this.nrm = new Float32Array(2 * max * 2);
    this.aux = new Float32Array(2 * max * AUX);
    this.index = new Uint16Array(max * 6);
    this.starts = new Uint8Array(max);
  }

  /** Points held. */
  get count(): number {
    return this.n;
  }
  /** Progress at the newest point, cm: how far back a point is, for its fade. */
  get head(): number {
    return this.prog;
  }
  /** The index range to draw: newest quad first. */
  get drawStart(): number {
    return (this.max - this.n) * 6;
  }
  get drawCount(): number {
    return Math.max(0, this.n - 1) * 6;
  }

  /** Nothing drawn; the next point starts afresh. */
  clear(): void {
    this.n = 0;
    this.broken = true;
    this.dist = this.prog = 0;
    this.dlo = 0;
    this.dhi = 0;
  }
  /** The next point starts a new piece: nothing is drawn between the last one and it. */
  break(): void {
    this.broken = true;
  }

  /**
   * The robot is at (x, y) cm, heading `th` rad. Returns whether a point was added: the first of a piece, or one
   * STEP_CM from the last, or TURN_STEP turned from it in place.
   */
  add(x: number, y: number, th: number): boolean {
    if (this.broken) {
      this.put(x, y, th, KIND.forward, true);
      this.broken = false;
      return true;
    }
    const dx = x - this.lx,
      dy = y - this.ly;
    const moved = Math.hypot(dx, dy),
      turned = Math.abs(wrap(th - this.lth));
    let kind: Kind;
    if (moved >= STEP_CM) {
      kind = dx * Math.cos(th) + dy * Math.sin(th) >= 0 ? KIND.forward : KIND.reverse;
      this.dist += moved;
      this.prog += moved;
    } else if (turned >= TURN_STEP) {
      kind = KIND.pivot;
      this.prog += turned * this.half;
    } else return false;
    // a piece's first point takes the kind of the move that leaves it, so its first quad is one colour
    if (this.starts[this.n - 1]) this.setKind(this.n - 1, kind);
    this.put(x, y, th, kind, false);
    return true;
  }

  /** The points changed since the last call, [dirtyLo, dirtyHi); false when none. Resets the record. */
  takeDirty(): boolean {
    if (this.dlo >= this.dhi) return false;
    this.dirtyLo = this.dlo;
    this.dirtyHi = this.dhi;
    this.dlo = Infinity;
    this.dhi = -Infinity;
    return true;
  }
  /** Set by `takeDirty`. */
  dirtyLo = 0;
  dirtyHi = 0;

  private put(x: number, y: number, th: number, kind: Kind, start: boolean): void {
    if (this.n >= this.max) this.compact();
    const k = this.n++;
    this.lx = x;
    this.ly = y;
    this.lth = th;
    this.starts[k] = start ? 1 : 0;
    // left of the heading: (-sin, cos) on the floor, (-sin, -cos) in the scene (z = -y)
    const nx = -Math.sin(th),
      nz = -Math.cos(th);
    for (let e = 0; e < 2; e++) {
      const v = 2 * k + e;
      this.pos[3 * v] = x;
      this.pos[3 * v + 1] = this.height;
      this.pos[3 * v + 2] = -y;
      this.nrm[2 * v] = nx;
      this.nrm[2 * v + 1] = nz;
      this.aux[AUX * v] = e === 0 ? 1 : -1;
      this.aux[AUX * v + 1] = this.dist;
      this.aux[AUX * v + 2] = kind;
      this.aux[AUX * v + 3] = this.prog;
    }
    this.quad(k);
    this.dirty(k, k + 1);
  }

  private setKind(k: number, kind: Kind): void {
    this.aux[AUX * 2 * k + 2] = this.aux[AUX * (2 * k + 1) + 2] = kind;
    this.dirty(k, k + 1);
  }

  /** Quad k: back from point k to k-1, or nothing (six times one vertex) when k starts a piece. */
  private quad(k: number): void {
    if (k === 0) return;
    const at = (this.max - 1 - k) * 6;
    const a = 2 * (k - 1),
      b = 2 * k;
    if (this.starts[k]) this.index.fill(b, at, at + 6);
    else {
      const ix = this.index;
      ix[at] = a;
      ix[at + 1] = ix[at + 3] = a + 1;
      ix[at + 2] = ix[at + 5] = b;
      ix[at + 4] = b + 1;
    }
  }

  /** Full: the oldest half goes, the rest moves to the front. */
  private compact(): void {
    const keep = this.max >> 1,
      drop = this.n - keep;
    this.pos.copyWithin(0, 2 * drop * 3, 2 * this.n * 3);
    this.nrm.copyWithin(0, 2 * drop * 2, 2 * this.n * 2);
    this.aux.copyWithin(0, 2 * drop * AUX, 2 * this.n * AUX);
    this.starts.copyWithin(0, drop, this.n);
    this.n = keep;
    this.starts[0] = 1;
    for (let k = 1; k < keep; k++) this.quad(k);
    this.dirty(0, this.max);
  }

  private dirty(lo: number, hi: number): void {
    this.dlo = Math.min(this.dlo, lo);
    this.dhi = Math.max(this.dhi, hi);
  }
}
