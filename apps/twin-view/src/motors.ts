// The EV3 motors, at the parts map's sizes (dims.ts MOTOR), each in its LDraw-derived frame with the output at the
// origin. The large motor (45502, LDraw 95658): a boot-shaped case 10.72 long, 4.0 wide and 5.52 high, the red hub
// (Ø 2.32, 2.4 wide) turning in a round opening through the case at its low front end, the cable socket at the
// back. The medium motor (45503, LDraw 99455): a box 7.24 long behind its output, the red axle hub (Ø 1.6) flush
// with its front face. Both hubs turn with the motor's tacho; the real meshes (meshes.ts) replace the boxes.
import * as THREE from "three";
import { attach, type Fit } from "./attachments";
import { MOTOR } from "./dims";
import { boxOf, orient, P, pointOf, upFor, type Kit } from "./parts";

export interface MotorPart {
  port: string;
  /** Its group in the robot's (live: it can be carried by another motor's arm). */
  group: THREE.Object3D;
  /** The end of its arm or lift, where another part can ride, or null. */
  end: THREE.Object3D | null;
  /** The part's box in the robot frame. */
  box: THREE.Box3;
  /** Where its cable leaves it, robot frame, and the way it leaves. */
  socket: { at: THREE.Vector3; dir: THREE.Vector3 };
  /** Turns the hub to the tacho. */
  turn(tachoDeg: number): void;
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const LM = MOTOR.large,
  MM = MOTOR.medium;

/** A large motor with its hub at `hub` (robot frame), its output axle along `axis` and its body running along
 *  `body` (perpendicular to the axle). The hub turns clockwise about `ref` as the tacho grows (a drive passes the
 *  robot's right, -y, so both sides turn as their wheels do); by default about its own axle. An attachment rides
 *  on the side of the hub the axle points to. */
export function largeMotor(
  kit: Kit,
  port: string,
  hub: THREE.Vector3,
  axis: THREE.Vector3,
  body: THREE.Vector3,
  ref: THREE.Vector3 = axis,
  fit: Fit | null = null,
): MotorPart {
  const { mats } = kit;
  // local frame: the body along +x, the top up; the axle is then along local y
  const up = upFor(body);
  const q = orient(body, up);
  const ey = new THREE.Vector3().crossVectors(up, body).normalize();
  const side = axis.dot(ey) >= 0 ? 1 : -1;
  const g = kit.live(new THREE.Group());
  g.position.copy(P(hub.x, hub.y, hub.z));
  g.quaternion.copy(q);
  kit.group.add(g);
  const halfW = (LM.max[1] - LM.min[1]) / 2;
  kit.add(
    kit.cached("large motor case", () => largeCase()),
    mats.light,
    new THREE.Vector3(),
    g,
  );
  // the white top cover over the tall back
  kit.box(LM.max[0] - 3.2, 2 * halfW - 0.6, 0.5, (LM.max[0] + 2.4) / 2, 0, LM.max[2] - 0.22, mats.white, 0.2, g);
  const [sx, , sz] = LM.at.socket!;
  kit.box(0.3, 1.2, 0.9, sx - 0.1, 0, sz, mats.anthracite, 0.1, g);
  const spin = hubOn(kit, g, LM.hub.d / 2, LM.hub.w);
  // the spin turns about the group's three.js Z, which is the robot's -ey
  const k = -ey.dot(ref.clone().normalize()) >= 0 ? 1 : -1;
  let grip: ((deg: number) => void) | null = null;
  let end: THREE.Object3D | null = null;
  if (fit) {
    // what rides on the hub starts outside the case, on the side the axle points to (live groups: the real mesh
    // replaces the motor's boxes, never what it moves)
    const out = kit.live(new THREE.Group());
    out.position.copy(P(0, side * halfW, 0));
    spin.add(out);
    const front = kit.live(new THREE.Group());
    front.position.copy(P(0, side * halfW, 0));
    front.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    g.add(front);
    ({ grip, end } = attach(kit, fit, out, -side, front));
  }
  kit.real({ ldraw: LM.ldraw, holder: g, frame: "front", roles: { hub: { target: spin } } });
  return {
    port,
    group: g,
    end,
    box: largeMotorBox(hub, axis, body),
    socket: { at: pointOf(v3(sx + 0.1, 0, sz), q, hub), dir: body.clone().normalize() },
    turn(deg) {
      spin.rotation.z = (-k * deg * Math.PI) / 180;
      grip?.(deg);
    },
  };
}

/** The box a large motor would take with its hub at `hub`, without building it. */
export function largeMotorBox(hub: THREE.Vector3, axis: THREE.Vector3, body: THREE.Vector3): THREE.Box3 {
  void axis;
  return boxOf(v3(...LM.min), v3(...LM.max), orient(body, upFor(body)), hub);
}

/** A medium motor with its output at `at` (robot frame), the output pointing along `dir`, its top toward `up`. */
export function mediumMotor(
  kit: Kit,
  port: string,
  at: THREE.Vector3,
  dir: THREE.Vector3,
  up: THREE.Vector3,
  fit: Fit | null = null,
): MotorPart {
  const { mats } = kit;
  const q = orient(dir, up);
  const g = kit.live(new THREE.Group());
  g.position.copy(P(at.x, at.y, at.z));
  g.quaternion.copy(q);
  kit.group.add(g);
  const [x0, y0, z0] = MM.min,
    [, y1, z1] = MM.max;
  const w = y1 - y0,
    h = z1 - z0,
    l = -x0;
  // the body behind the output: light grey below, white above, the front face a little proud
  kit.box(l - 0.3, w, h * 0.52, x0 + (l - 0.3) / 2, 0, z0 + h * 0.26, mats.light, 0.35, g);
  kit.box(l - 0.3, w, h * 0.48, x0 + (l - 0.3) / 2, 0, z1 - h * 0.24, mats.white, 0.4, g);
  kit.box(0.3, w, h, -0.15, 0, (z0 + z1) / 2, mats.light, 0.3, g);
  const [sx, , sz] = MM.at.socket!;
  kit.box(0.3, 1.2, 0.9, sx + 0.1, 0, sz, mats.anthracite, 0.1, g);
  const hubBase = kit.live(new THREE.Group());
  hubBase.rotation.y = Math.PI / 2; // three.js Z along the output (+x)
  g.add(hubBase);
  const spin = hubOn(kit, hubBase, MM.hub.d / 2, 0.3);
  spin.position.z = 0.02;
  let grip: ((deg: number) => void) | null = null;
  let end: THREE.Object3D | null = null;
  if (fit) {
    // out of the hub is the hub base's +Z
    const front = kit.live(new THREE.Group());
    front.rotation.y = -Math.PI / 2;
    hubBase.add(front);
    ({ grip, end } = attach(kit, fit, spin, 1, front));
  }
  kit.real({ ldraw: MM.ldraw, holder: g, frame: "front", roles: { hub: { target: spin } } });
  return {
    port,
    group: g,
    end,
    box: boxOf(v3(...MM.min), v3(...MM.max), q, at),
    socket: { at: pointOf(v3(sx - 0.1, 0, sz), q, at), dir: dir.clone().normalize().negate() },
    turn(deg) {
      spin.rotation.z = (-deg * Math.PI) / 180;
      grip?.(deg);
    },
  };
}

/** The red output hub: a disc of radius `r`, `width` along its axle (three.js Z of `parent`), with a cross hole and
 *  four pin holes on each face. */
function hubOn(kit: Kit, parent: THREE.Object3D, r: number, width: number): THREE.Object3D {
  const { mats } = kit;
  const spin = kit.live(new THREE.Group());
  parent.add(spin);
  kit.axleCyl(r, width, 0, 0, 0, mats.red, spin, 24);
  for (const face of [1, -1]) {
    const y = face * (width / 2 + 0.01);
    kit.box(0.48, 0.03, 0.18, 0, y, 0, mats.black, 0, spin);
    kit.box(0.18, 0.03, 0.48, 0, y, 0, mats.black, 0, spin);
    for (let a = 0; a < 4; a++) {
      const ang = (a * Math.PI) / 2 + Math.PI / 4;
      if (r > 1) kit.axleCyl(0.24, 0.03, Math.cos(ang) * 0.8, y, Math.sin(ang) * 0.8, mats.black, spin, 10);
    }
  }
  return spin;
}

/** The large motor's case seen from its side (x along it, z up; its LDraw box), extruded across: round at the
 *  front about the output, tall at the back, with the round opening the hub turns in. */
function largeCase(): THREE.BufferGeometry {
  const [x0, y0, z0] = LM.min,
    [x1, y1, z1] = LM.max;
  const r = -z0; // the case is round about the output at its front and bottom
  const s = new THREE.Shape();
  s.moveTo(x0, 0);
  s.absarc(0, 0, r, Math.PI, Math.PI * 1.5, false);
  s.lineTo(x1 - 0.5, z0);
  s.quadraticCurveTo(x1, z0, x1, z0 + 0.5);
  s.lineTo(x1, z1 - 0.6);
  s.quadraticCurveTo(x1, z1, x1 - 0.6, z1);
  s.lineTo(2.6, z1);
  s.bezierCurveTo(1.4, z1, 1.0, r + 0.4, 0, r);
  s.absarc(0, 0, r, Math.PI / 2, Math.PI, false);
  const opening = new THREE.Path();
  opening.absarc(0, 0, LM.hub.d / 2 + 0.06, 0, Math.PI * 2, true);
  s.holes.push(opening);
  const w = y1 - y0,
    bevel = 0.15;
  const g = new THREE.ExtrudeGeometry(s, {
    depth: w - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: 0,
    bevelSegments: 2,
    curveSegments: 18,
  });
  g.translate(0, 0, -(w - 2 * bevel) / 2);
  return g;
}
