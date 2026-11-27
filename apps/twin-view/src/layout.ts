// Where each part goes when the look does not say: a part tries the default mounts of its kind in order and takes
// the first where it touches nothing placed before it; if every mount is taken, it rises from the first until it
// is clear. A part the look places in full stays exactly where the look says. Then nothing floats: a part that
// touches nothing solid is held by a beam pinned through its own hole to the nearest solid part (`hold`).
import * as THREE from "three";
import { BEAM, MODULE } from "./dims";
import type { Facing, Place } from "./look";
import { boxOf, facingDir, orient, P, upFor, type Kit } from "./parts";

export interface Mount {
  x: number;
  y: number;
  z: number;
  facing: Facing;
}
export interface Placed {
  /** Centre of the part, robot frame. */
  at: THREE.Vector3;
  /** Where it faces, and its top. */
  dir: THREE.Vector3;
  up: THREE.Vector3;
  q: THREE.Quaternion;
  box: THREE.Box3;
}

export class Occupancy {
  readonly boxes: THREE.Box3[] = [];
  /** What is there, as opposed to room kept free (over the screen): what can hold a part. */
  readonly solids: THREE.Box3[] = [];
  add(b: THREE.Box3, solid = true): void {
    this.boxes.push(b);
    if (solid) this.solids.push(b);
  }
  /** Whether `b` touches (or nearly, within 2.5 mm) a solid other than itself. */
  held(b: THREE.Box3): boolean {
    const s = b.clone().expandByScalar(0.25);
    return b.min.z <= 0.05 || this.solids.some((o) => o !== b && o.intersectsBox(s));
  }
  hits(b: THREE.Box3): boolean {
    // parts may touch: a few mm of overlap is a part pressed against another
    const s = b.clone().expandByScalar(-0.15);
    return this.boxes.some((o) => o.intersectsBox(s));
  }
}

/** Places a part whose own box (facing +x, top +z, around its centre) is `min`..`max`. A part whose facing names
 *  where its top looks (`top`: a gyro's arrows) faces ahead (or up, when its top looks ahead or back). */
export function placePart(
  p: Place,
  min: THREE.Vector3,
  max: THREE.Vector3,
  mounts: Mount[],
  occ: Occupancy,
  top = false,
): Placed {
  if (mounts.length === 0) throw new Error("a part has no mount to fall back on");
  const given = p.x !== null && p.y !== null && p.z !== null;
  const at = (m: Mount, dz = 0): Placed => {
    const f = facingDir(p.facing ?? m.facing, p.yaw);
    const dir = !top ? f : Math.abs(f.z) > 0.9 ? facingDir("forward", p.yaw) : new THREE.Vector3(0, 0, 1);
    const up = top ? f : upFor(dir, p.yaw);
    const q = orient(dir, up);
    const c = new THREE.Vector3(p.x ?? m.x, p.y ?? m.y, (p.z ?? m.z) + dz);
    return { at: c, dir, up, q, box: boxOf(min, max, q, c) };
  };
  let chosen: Placed | null = null;
  if (given) chosen = at(mounts[0]!);
  else {
    for (const m of mounts) {
      const t = at(m);
      if (!occ.hits(t.box)) {
        chosen = t;
        break;
      }
    }
    // every mount is taken: rise from the first until clear (a part the look puts at a height keeps it)
    for (let dz = 0.5; !chosen && dz <= 60; dz += 0.5) {
      const t = at(mounts[0]!, p.z === null ? dz : 0);
      if (!occ.hits(t.box) || p.z !== null) chosen = t;
    }
    chosen ??= at(mounts[0]!);
  }
  occ.add(chosen.box);
  return chosen;
}

/** Rounds a length to the half-module grid. */
export const onGrid = (v: number): number => Math.round(v / (MODULE / 2)) * (MODULE / 2);

/** A beam of `holes` holes whose first hole is at `from` (robot frame), running along `along`, its holes along
 *  `axis` (both unit vectors at right angles). */
export function beamFrom(
  kit: Kit,
  holes: number,
  from: THREE.Vector3,
  along: THREE.Vector3,
  axis: THREE.Vector3,
): THREE.Box3 {
  const c = from.clone().addScaledVector(along, ((holes - 1) * MODULE) / 2);
  const m = kit.beam(holes, c.x, c.y, c.z, kit.mats.dark);
  // the beam's geometry runs along three.js X, its holes along Z, its thickness along Y
  const lx = P(along.x, along.y, along.z),
    lz = P(axis.x, axis.y, axis.z);
  m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(lx, new THREE.Vector3().crossVectors(lz, lx), lz));
  const half = new THREE.Vector3(1, 1, 1).multiplyScalar(BEAM.across / 2);
  return new THREE.Box3().expandByPoint(from.clone().sub(half)).expandByPoint(
    from
      .clone()
      .addScaledVector(along, (holes - 1) * MODULE)
      .add(half),
  );
}

/**
 * Holds a placed part that touches nothing solid: a beam pinned through its hole at `hole` (whose axis is `axis`),
 * set beside the part (`side` cm out along the axis), to the nearest solid straight above or below it, else back
 * toward the robot's middle at the same height, else up or down to the brick's frame and along it to the brick.
 * The beams are whole parts on the grid: one end hole at the part's hole.
 */
export function hold(
  kit: Kit,
  occ: Occupancy,
  part: THREE.Box3,
  hole: THREE.Vector3,
  axis: THREE.Vector3,
  side: number,
  brick: THREE.Box3,
): void {
  if (occ.held(part)) return;
  const ax = axis.clone().normalize();
  const at = hole.clone().addScaledVector(ax, side + BEAM.along / 2);
  const inXY = (b: THREE.Box3, p: THREE.Vector3) =>
    p.x >= b.min.x - 0.1 && p.x <= b.max.x + 0.1 && p.y >= b.min.y - 0.1 && p.y <= b.max.y + 0.1;
  const others = occ.solids.filter((b) => b !== part);
  const holes = (d: number) => Math.max(2, Math.round(d / MODULE) + 1);
  const add = (b: THREE.Box3) => occ.add(b);
  // straight up or down: the beam's holes along the part's axis need a horizontal axis
  if (Math.abs(ax.z) < 0.5) {
    const below = others.filter((b) => inXY(b, at) && b.max.z <= at.z + 0.05).map((b) => b.max.z);
    const above = others.filter((b) => inXY(b, at) && b.min.z >= at.z - 0.05).map((b) => b.min.z);
    const down = below.length ? at.z - Math.max(...below) : Infinity;
    const up = above.length ? Math.min(...above) - at.z : Infinity;
    if (Math.min(down, up) < 25) {
      const dir = new THREE.Vector3(0, 0, down <= up ? -1 : 1);
      add(beamFrom(kit, holes(Math.min(down, up) + BEAM.across / 2), at, dir, ax));
      return;
    }
  }
  // back toward the middle at the same height
  const toward = new THREE.Vector3(Math.sign((brick.min.x + brick.max.x) / 2 - at.x) || -1, 0, 0);
  if (Math.abs(ax.x) < 0.5)
    for (let d = MODULE; d <= 25; d += MODULE) {
      const p = at.clone().addScaledVector(toward, d);
      if (others.some((b) => b.containsPoint(p))) {
        add(beamFrom(kit, holes(d), at, toward, ax));
        return;
      }
    }
  // an L: up or down to the frame under the brick, then along it to the brick's end
  const level = brick.min.z - BEAM.along / 2;
  const vertical = new THREE.Vector3(0, 0, Math.sign(level - at.z) || 1);
  const rise = Math.abs(level - at.z);
  const horizAxis = Math.abs(ax.z) < 0.5 ? ax : new THREE.Vector3(0, 1, 0);
  let corner = at;
  if (rise > MODULE / 2) {
    const n = holes(rise);
    add(beamFrom(kit, n, at, vertical, horizAxis));
    corner = at.clone().addScaledVector(vertical, (n - 1) * MODULE);
  }
  const end = toward.x > 0 ? brick.min.x : brick.max.x;
  const run = Math.abs(end - corner.x) + MODULE;
  if (run > MODULE) add(beamFrom(kit, holes(run), corner, toward, new THREE.Vector3(0, 0, 1)));
}
