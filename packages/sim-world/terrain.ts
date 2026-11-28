// Terrain of a world: raised platforms and ramps on the floor, and how a body rests on them.
// Units: cm; radians inside. Axes as world.ts: x right, y up, heights above the floor (z up).
//
// The terrain is a set of axis-aligned rectangles that do not overlap. A platform has one height; a ramp rises in a
// straight line from `low_cm` on one side to `high_cm` on the opposite side (`rises` names the side it goes up
// toward). Where no piece is, the floor is at 0. Between two pieces that touch, or a piece and the floor, the
// surface may jump: that is an edge (a step up, a drop).
//
// A body rests on two tracks, its sides (y = +-half_width in its own frame) from its back to its front. Each track
// rests on the highest points under it, and tips over the edge it is on once the body's centre of mass (taken at
// the axle centre) passes that edge: in its own vertical plane, a track lies along the upper convex hull of the
// surface under it, on the hull's segment over the axle. The body's height is the mean of the two tracks' heights
// at the axle, its pitch the mean of their slopes, its roll from the difference of their heights. Treating each
// track as resting on its own is an approximation of a rigid body resting on three points (it is exact on a plane,
// on a platform edge square to the body, and on an edge along one track).

export type Rise = "east" | "west" | "north" | "south";
export const RISES: readonly Rise[] = ["east", "west", "north", "south"];

export interface TerrainPiece {
  id: string;
  kind: "platform" | "ramp";
  x: number;
  y: number;
  w: number;
  h: number;
  /** Surface height (cm) on the low side; a platform's height. */
  low_cm: number;
  /** Surface height (cm) on the high side; a platform's height. */
  high_cm: number;
  /** A ramp: the side it rises toward (east = +x, north = +y). A platform: absent. */
  rises?: Rise;
}

/** How a body lies on the terrain at one pose. */
export interface Rest {
  /** Height of the axle centre's footprint on the surface (cm). */
  z_cm: number;
  /** Nose up positive (rad). */
  pitch: number;
  /** Left side up positive (rad). */
  roll: number;
  /** Each track's height at the axle and its slope (dz per cm ahead): [left, right]. */
  tracks: [{ z: number; slope: number }, { z: number; slope: number }];
  /** The highest and lowest surface under the tracks, with the piece of the highest (null: the floor). */
  top_cm: number;
  bottom_cm: number;
  top_piece: string | null;
}

export interface BodyOutline {
  front_cm: number;
  back_cm: number;
  half_width_cm: number;
}

/** A point of a track: where along it (cm from the axle, + ahead), the world point, its surface height. */
interface Sample {
  s: number;
  x: number;
  y: number;
  z: number;
}

/** Just past an edge, on either side of it: an edge is found exactly, not to the spacing of a sampling grid. */
const EDGE_EPS = 1e-7;

/** Slope of a piece's surface: z = a + bx * x + by * y over its rectangle. */
export function surfacePlane(p: TerrainPiece): { a: number; bx: number; by: number } {
  const d = p.high_cm - p.low_cm;
  switch (p.rises) {
    case undefined:
      return { a: p.low_cm, bx: 0, by: 0 };
    case "east":
      return { a: p.low_cm - (d / p.w) * p.x, bx: d / p.w, by: 0 };
    case "west":
      return { a: p.low_cm + (d / p.w) * (p.x + p.w), bx: -d / p.w, by: 0 };
    case "north":
      return { a: p.low_cm - (d / p.h) * p.y, bx: 0, by: d / p.h };
    case "south":
      return { a: p.low_cm + (d / p.h) * (p.y + p.h), bx: 0, by: -d / p.h };
  }
}
/** A ramp's slope angle (deg); 0 for a platform. */
export function slopeDeg(p: TerrainPiece): number {
  if (!p.rises) return 0;
  const run = p.rises === "east" || p.rises === "west" ? p.w : p.h;
  return (Math.atan2(p.high_cm - p.low_cm, run) * 180) / Math.PI;
}

/** Upper convex hull of points sorted by s (Andrew's monotone chain, the upper half). */
function upperHull(pts: readonly Sample[]): Sample[] {
  const out: Sample[] = [];
  for (const p of pts) {
    while (out.length >= 2) {
      const a = out[out.length - 2]!,
        b = out[out.length - 1]!;
      // b lies on or under the segment a-p: drop it
      if ((b.s - a.s) * (p.z - a.z) - (b.z - a.z) * (p.s - a.s) >= 0) out.pop();
      else break;
    }
    out.push(p);
  }
  return out;
}

export class Terrain {
  readonly pieces: readonly TerrainPiece[];
  private readonly planes: { a: number; bx: number; by: number }[];

  constructor(pieces: readonly TerrainPiece[]) {
    this.pieces = pieces;
    this.planes = pieces.map(surfacePlane);
  }

  /** Index of the piece under (x, y), edges included (where two touch, the higher); -1 for the floor. */
  private indexAt(x: number, y: number): number {
    let best = -1,
      bz = 0;
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i]!;
      if (x < p.x || x > p.x + p.w || y < p.y || y > p.y + p.h) continue;
      const q = this.planes[i]!,
        z = q.a + q.bx * x + q.by * y;
      if (best < 0 || z > bz) {
        best = i;
        bz = z;
      }
    }
    return best;
  }
  /** Surface height at (x, y): the piece there, else the floor (0). */
  heightAt(x: number, y: number): number {
    const i = this.indexAt(x, y);
    if (i < 0) return 0;
    const q = this.planes[i]!;
    return Math.max(0, q.a + q.bx * x + q.by * y);
  }
  /** The id of the piece under (x, y), or null for the floor. */
  pieceAt(x: number, y: number): string | null {
    const i = this.indexAt(x, y);
    return i < 0 ? null : this.pieces[i]!.id;
  }

  /**
   * The points of one track (lateral offset `v`, left positive) of a body at pose (x, y, th): both ends, and both
   * sides of every edge it crosses. Between two of them the surface is one plane, so the hull of these is exact.
   */
  trackSamples(x: number, y: number, th: number, v: number, g: BodyOutline): Sample[] {
    const c = Math.cos(th),
      s = Math.sin(th);
    const x0 = x - v * s,
      y0 = y + v * c;
    const ss: number[] = [-g.back_cm, g.front_cm];
    const cut = (o: number, d: number, at: number) => {
      if (Math.abs(d) < 1e-12) return;
      const t = (at - o) / d;
      if (t > -g.back_cm && t < g.front_cm)
        ss.push(Math.max(-g.back_cm, t - EDGE_EPS), Math.min(g.front_cm, t + EDGE_EPS));
    };
    for (const p of this.pieces) {
      cut(x0, c, p.x);
      cut(x0, c, p.x + p.w);
      cut(y0, s, p.y);
      cut(y0, s, p.y + p.h);
    }
    ss.sort((a, b) => a - b);
    return ss.map((t) => {
      const px = x0 + t * c,
        py = y0 + t * s;
      return { s: t, x: px, y: py, z: this.heightAt(px, py) };
    });
  }

  /** How a body of outline `g` lies at pose (x, y, th). */
  rest(x: number, y: number, th: number, g: BodyOutline): Rest {
    let top = -Infinity,
      bottom = Infinity,
      topAt: Sample | null = null;
    const tracks = [g.half_width_cm, -g.half_width_cm].map((v) => {
      const pts = this.trackSamples(x, y, th, v, g);
      for (const p of pts) {
        if (p.z > top) {
          top = p.z;
          topAt = p;
        }
        if (p.z < bottom) bottom = p.z;
      }
      const hull = upperHull(pts);
      // the hull's segment over the axle (s = 0): the body's centre of mass decides which way the track tips
      let i = 0;
      while (i < hull.length - 2 && hull[i + 1]!.s <= 0) i++;
      const a = hull[i]!,
        b = hull[i + 1] ?? a;
      const slope = b.s > a.s ? (b.z - a.z) / (b.s - a.s) : 0;
      return { z: a.z + slope * (0 - a.s), slope };
    }) as Rest["tracks"];
    const [l, r] = tracks;
    const t = topAt as Sample | null;
    return {
      z_cm: (l.z + r.z) / 2,
      pitch: Math.atan((l.slope + r.slope) / 2),
      roll: Math.atan2(l.z - r.z, 2 * g.half_width_cm),
      tracks,
      top_cm: top,
      bottom_cm: bottom,
      top_piece: t ? this.pieceAt(t.x, t.y) : null,
    };
  }

  /**
   * The highest edge the tracks of a body that rests as `from` at pose `p0` must ride up to be at `p1`: for each
   * track, how far its points at `p1` stand above the line it lies along at `p0`. A body climbs an edge only up to
   * what its tracks can; a higher one stops it as a wall does. Returns the rise (cm) and the piece it belongs to.
   */
  climb(
    p0: { x: number; y: number; th: number },
    from: Rest,
    p1: { x: number; y: number; th: number },
    g: BodyOutline,
  ): { rise_cm: number; piece: string | null } {
    const c = Math.cos(p0.th),
      s = Math.sin(p0.th);
    let rise = -Infinity,
      piece: string | null = null;
    [g.half_width_cm, -g.half_width_cm].forEach((v, k) => {
      const line = from.tracks[k]!;
      for (const q of this.trackSamples(p1.x, p1.y, p1.th, v, g)) {
        const u = (q.x - p0.x) * c + (q.y - p0.y) * s;
        const up = q.z - (line.z + line.slope * u);
        if (up > rise) {
          rise = up;
          piece = this.pieceAt(q.x, q.y);
        }
      }
    });
    return { rise_cm: rise, piece };
  }

  /**
   * Where a ray from (ox, oy, oz), along the horizontal unit (dx, dy) and climbing `k` cm per cm (tan of its
   * elevation), first meets the terrain within `maxT` cm of horizontal travel: a piece's side (an edge it meets
   * square or slanted), a piece's top or the floor. `drop` (how many cm the beam's lower edge comes down per cm
   * ahead; Infinity for a camera, which sees every side) lets the beam find an edge the central ray passes over,
   * as it finds a low box (world.ts rayHit). Returns how far (cm: horizontal travel to a side or a surface; to the
   * top of an edge the lower edge of the beam finds, the straight line to it, as for a box), the cosine of the
   * angle to the surface's normal, and the height the edge's top stands at (Infinity for a surface).
   */
  ray(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    k: number,
    drop: number,
    maxT: number,
  ): { d: number; cos: number; top_cm: number } | null {
    const ce = 1 / Math.sqrt(1 + k * k),
      se = k * ce;
    let best: { d: number; cos: number; top_cm: number } | null = null;
    const take = (d: number, cos: number, top: number) => {
      if (d >= 0 && d < maxT && (!best || d < best.d)) best = { d, cos, top_cm: top };
    };
    // the floor, where the ray comes down to it (a piece over that spot is met first, at or before it)
    if (k < -1e-12) {
      const t = oz / -k;
      if (this.indexAt(ox + dx * t, oy + dy * t) < 0) take(t, Math.abs(se), Infinity);
    }
    this.pieces.forEach((p, i) => {
      let t0 = 0,
        t1 = Infinity,
        c0 = 1;
      for (const [o, d, lo, hi] of [
        [ox, dx, p.x, p.x + p.w],
        [oy, dy, p.y, p.y + p.h],
      ] as [number, number, number, number][]) {
        if (Math.abs(d) < 1e-12) {
          if (o < lo || o > hi) return;
          continue;
        }
        let a = (lo - o) / d,
          b = (hi - o) / d;
        if (a > b) [a, b] = [b, a];
        if (a > t0) {
          t0 = a;
          c0 = Math.abs(d);
        }
        if (b < t1) t1 = b;
        if (t0 > t1) return;
      }
      const q = this.planes[i]!;
      const surf = (t: number) => q.a + q.bx * (ox + dx * t) + q.by * (oy + dy * t);
      const gap = (t: number) => oz + k * t - surf(t);
      const g0 = gap(t0);
      if (g0 <= 0) {
        // through its side: a vertical face (or, from on top of it, its own surface under the sensor)
        if (t0 > 0) take(t0, c0 * ce, surf(t0));
        return;
      }
      // the beam's lower edge meets the top of the side the central ray passes over (only a real edge: higher
      // than the surface the ray crossed just before it)
      if (t0 > 0 && drop !== Infinity) {
        const before = this.heightAt(ox + dx * (t0 - 1e-6), oy + dy * (t0 - 1e-6));
        const top = surf(t0);
        const below = oz - top;
        if (top > before + 1e-6 && below <= t0 * drop)
          take(Math.hypot(t0, below), c0 * Math.cos(Math.atan2(Math.max(0, below), t0)), top);
      } else if (t0 > 0 && drop === Infinity && surf(t0) > 0) take(t0, c0 * ce, surf(t0));
      const g1 = gap(Math.min(t1, maxT));
      if (g1 > 0) return;
      // through its top
      const t = t0 + (g0 / (g0 - g1)) * (Math.min(t1, maxT) - t0);
      const n = Math.hypot(q.bx, q.by, 1);
      const cos = Math.abs(-q.bx * dx * ce - q.by * dy * ce + se) / n;
      take(t, cos, Infinity);
    });
    return best;
  }
}

/** Fails, naming the pieces, when two pieces of terrain overlap (touching along an edge is fine). */
export function checkTerrain(pieces: readonly TerrainPiece[], fail: (i: number, why: string) => never): void {
  for (let i = 0; i < pieces.length; i++)
    for (let j = 0; j < i; j++) {
      const a = pieces[i]!,
        b = pieces[j]!;
      if (a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9)
        fail(i, `overlaps terrain "${b.id}": pieces of terrain may touch along an edge, never overlap`);
    }
}
