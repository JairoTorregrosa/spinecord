// Where each part goes when the look does not say: a part tries the default mounts of its kind in order and takes
// the first where it touches nothing placed before it; if every mount is taken, it rises from the first until it
// is clear. A part the look places in full stays exactly where the look says.
import * as THREE from "three";
import type { Facing, Place } from "./look";
import { boxOf, facingDir, orient, upFor } from "./parts";

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
  add(b: THREE.Box3): void {
    this.boxes.push(b);
  }
  hits(b: THREE.Box3): boolean {
    // parts may touch: a few mm of overlap is a part pressed against another
    const s = b.clone().expandByScalar(-0.15);
    return this.boxes.some((o) => o.intersectsBox(s));
  }
}

/** Places a part whose own box (facing +x, top +z, around its centre) is `min`..`max`. */
export function placePart(p: Place, min: THREE.Vector3, max: THREE.Vector3, mounts: Mount[], occ: Occupancy): Placed {
  if (mounts.length === 0) throw new Error("a part has no mount to fall back on");
  const given = p.x !== null && p.y !== null && p.z !== null;
  const at = (m: Mount, dz = 0): Placed => {
    const dir = facingDir(p.facing ?? m.facing, p.yaw);
    const up = upFor(dir, p.yaw);
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
