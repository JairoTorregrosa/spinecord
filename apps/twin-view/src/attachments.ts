// What a motor that does not drive moves, as the look names it: a bare axle with a short beam, an arm, a lift, a
// turntable, or a gripper. All but the gripper ride on the motor's hub and turn with it; the gripper's two claws
// open and close on the front of the motor as its tacho grows and falls.
import * as THREE from "three";
import type { Attachment } from "./look";
import type { Kit } from "./parts";

export interface Fit {
  kind: Attachment;
  /** An arm's or a lift's length, cm. */
  length: number;
  /** The tacho at which a gripper is fully open, degrees. */
  openDeg: number;
}

/**
 * Builds `fit` on a motor. `spin` turns with the hub, its three.js Z along the axle, `outZ` the side of it the
 * axle comes out of; `base` turns the attachment's beams from the spin's X to where they rest at tacho 0.
 * `front` is a frame that does not turn, at the hub, its X along the axle out of the motor and its Y up.
 * Returns what moves the gripper with the tacho (the others move with the hub).
 */
export function attach(
  kit: Kit,
  fit: Fit,
  spin: THREE.Object3D,
  outZ: number,
  front: THREE.Object3D,
): ((tachoDeg: number) => void) | null {
  const { mats } = kit;
  const a = new THREE.Group();
  a.rotation.z = restAngle(spin);
  spin.add(a);
  // a cross axle out of the hub; robot-style y is three.js -Z here, so an offset `d` along the axle is y = -d
  const along = (d: number) => -outZ * d;
  const holesFor = (cm: number) => Math.max(3, Math.round(cm / 0.8) + 1);
  if (fit.kind === "gripper") {
    kit.axleCyl(0.24, 1.4, 0, along(0.9), 0, mats.dark, spin, 12);
    // a bar across the front, two claws pivoting at its ends
    const g = new THREE.Group();
    front.add(g);
    kit.box(0.8, 4.8, 0.8, 1.6, 0, 0, mats.dark, 0.2, g);
    const claws: THREE.Object3D[] = [];
    for (const side of [1, -1]) {
      const pivot = kit.live(new THREE.Group());
      pivot.position.set(1.6, 0, -side * 2.0);
      g.add(pivot);
      kit.box(4.2, 0.6, 0.8, 2.1, 0, 0, mats.dark, 0.2, pivot);
      kit.box(0.8, 1.6, 0.8, 4.0, -side * 0.7, 0, mats.red, 0.2, pivot);
      claws.push(pivot);
    }
    return (deg) => {
      const open = Math.min(1, Math.max(0, deg / fit.openDeg));
      // closed the claws meet; open each swings 35° out
      claws[0]!.rotation.y = -0.05 + open * 0.6;
      claws[1]!.rotation.y = 0.05 - open * 0.6;
    };
  }
  if (fit.kind === "axle") {
    kit.axleCyl(0.24, 2.4, 0, along(1.2), 0, mats.dark, spin, 12);
    kit.beam(5, 1.6, along(1.5), 0, mats.dark, "y", a);
  } else if (fit.kind === "arm") {
    const n = holesFor(fit.length);
    kit.axleCyl(0.24, 1.6, 0, along(0.8), 0, mats.dark, spin, 12);
    kit.beam(n, ((n - 1) * 0.8) / 2, along(1.0), 0, mats.dark, "y", a);
    kit.axleCyl(0.3, 0.9, (n - 1) * 0.8, along(1.0), 0, mats.red, a, 12);
  } else if (fit.kind === "lift") {
    const n = holesFor(fit.length);
    kit.axleCyl(0.24, 3.6, 0, along(1.8), 0, mats.dark, spin, 12);
    for (const d of [0.7, 3.1]) kit.beam(n, ((n - 1) * 0.8) / 2, along(d), 0, mats.dark, "y", a);
    const end = (n - 1) * 0.8;
    kit.axleCyl(0.24, 3.4, end, along(1.9), 0, mats.dark, a, 12);
    // the fork: a plate across the beams' ends with two prongs reaching on
    kit.box(0.6, 3.2, 2.4, end + 0.6, along(1.9), -0.8, mats.black, 0.1, a);
    for (const d of [1.0, 2.8]) kit.box(4, 0.6, 0.35, end + 2.6, along(d), -1.85, mats.black, 0.1, a);
  } else {
    // turntable: a big ring turning on the hub, a beam across its top
    kit.axleCyl(2.8, 0.8, 0, along(0.6), 0, mats.dark, spin, 36);
    kit.axleCyl(2.3, 0.84, 0, along(0.6), 0, mats.light, spin, 36);
    kit.beam(7, 0, along(1.4), 0, mats.dark, "y", a);
  }
  return null;
}

/** The angle about the spin's Z that turns its X ahead (robot +x), or up when the axle itself points ahead. The
 *  robot's group is at the origin while it is built, so world axes are the robot's. */
function restAngle(spin: THREE.Object3D): number {
  spin.updateWorldMatrix(true, false);
  const x = new THREE.Vector3(),
    y = new THREE.Vector3(),
    z = new THREE.Vector3();
  spin.matrixWorld.extractBasis(x, y, z);
  // three.js X ahead, Y up: robot ahead is three (1, 0, 0), up is (0, 1, 0)
  const ahead = new THREE.Vector3(1, 0, 0);
  const want = Math.abs(z.dot(ahead)) > 0.8 ? new THREE.Vector3(0, 1, 0) : ahead;
  return Math.atan2(want.dot(y), want.dot(x));
}
