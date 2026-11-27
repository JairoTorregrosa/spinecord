// The EV3 motors. The large motor (45502): a round head Ø 4.2 around its output, a body 11.2 cm long that
// narrows to the cable socket at its back, the output axle across the body. The medium motor (45503): a compact
// block 4.8 × 2.4 × 3.2 with its output axle along its length. Both have the red output hub that turns with
// the motor's tacho.
import * as THREE from "three";
import { attach, type Fit } from "./attachments";
import { DIMS } from "./dims";
import { boxOf, orient, P, pointOf, upFor, type Kit } from "./parts";

export interface MotorPart {
  port: string;
  /** The part's box in the robot frame. */
  box: THREE.Box3;
  /** Where its cable leaves it, robot frame, and the way it leaves. */
  socket: { at: THREE.Vector3; dir: THREE.Vector3 };
  /** Turns the hub to the tacho. */
  turn(tachoDeg: number): void;
}

/** A large motor with its hub at `hub` (robot frame), its output axle pointing along `axis` and its body running
 *  along `body` (perpendicular to the axle). The hub turns clockwise about `ref` as the tacho grows (a drive
 *  passes the robot's right, -y, so both sides turn as their wheels do); by default about its own axle. */
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
  // local frame: the body along +x, the top up; the axle is then along local y, the hub on the side it points to
  const up = upFor(body);
  const q = orient(body, up);
  const ey = new THREE.Vector3().crossVectors(up, body).normalize();
  const side = axis.dot(ey) >= 0 ? 1 : -1;
  const g = new THREE.Group();
  g.position.copy(P(hub.x, hub.y, hub.z));
  g.quaternion.copy(q);
  kit.group.add(g);
  kit.add(
    kit.cached("large motor top", () => largeShell(true)),
    mats.white,
    new THREE.Vector3(),
    g,
  );
  kit.add(
    kit.cached("large motor bottom", () => largeShell(false)),
    mats.light,
    new THREE.Vector3(),
    g,
  );
  // the grey ring round the output, and the socket at the back
  kit.axleCyl(1.45, 2.6, 0, 0, 0, mats.light, g, 28);
  kit.box(0.9, 1.3, 1.0, 9.0, 0, -0.3, mats.anthracite, 0.12, g);
  const spin = hubOn(kit, g, P(0, side * 1.36, 0));
  // the spin turns about the group's three.js Z, which is the robot's -ey
  const k = -ey.dot(ref.clone().normalize()) >= 0 ? 1 : -1;
  let grip: ((deg: number) => void) | null = null;
  if (fit) {
    // out of the hub is local +y on side 1, three.js -Z
    const front = new THREE.Group();
    front.position.copy(spin.position);
    front.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    g.add(front);
    grip = attach(kit, fit, spin, -side, front);
  }
  return {
    port,
    box: largeMotorBox(hub, axis, body),
    socket: { at: pointOf(new THREE.Vector3(9.5, 0, -0.3), q, hub), dir: body.clone().normalize() },
    turn(deg) {
      spin.rotation.z = (-k * deg * Math.PI) / 180;
      grip?.(deg);
    },
  };
}

/** The box a large motor would take with its hub at `hub`, without building it. */
export function largeMotorBox(hub: THREE.Vector3, axis: THREE.Vector3, body: THREE.Vector3): THREE.Box3 {
  return boxOf(new THREE.Vector3(-2.1, -1.5, -2.1), new THREE.Vector3(9.5, 1.5, 2.1), orient(body, upFor(body)), hub);
}

/** A medium motor centred at `at` (robot frame), its output pointing along `dir`, its top toward `up`. */
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
  const g = new THREE.Group();
  g.position.copy(P(at.x, at.y, at.z));
  g.quaternion.copy(q);
  kit.group.add(g);
  // centred on its box: the body behind, the collar and hub at the front (+x)
  const { l, w, h } = DIMS.mediumMotor;
  const hx = l / 2;
  kit.box(l - 1.3, w, h * 0.53, -0.65, 0, -h * 0.235, mats.light, 0.4, g);
  kit.box(l - 1.3, w, h * 0.47, -0.65, 0, h * 0.265, mats.white, 0.5, g);
  kit.box(0.4, 1.3, 1.0, -hx + 0.1, 0, 0.2, mats.anthracite, 0.12, g);
  const collar = kit.axleCyl(1.2, 0.8, hx - 0.9, 0, 0, mats.light, g, 24);
  collar.rotation.y = Math.PI / 2; // its axis along the output
  const hubBase = new THREE.Group();
  hubBase.position.copy(P(hx - 0.35, 0, 0));
  hubBase.rotation.y = Math.PI / 2;
  g.add(hubBase);
  const spin = hubOn(kit, hubBase, new THREE.Vector3());
  let grip: ((deg: number) => void) | null = null;
  if (fit) {
    // out of the hub is the hub base's +Z
    const front = new THREE.Group();
    front.rotation.y = -Math.PI / 2;
    hubBase.add(front);
    grip = attach(kit, fit, spin, 1, front);
  }
  return {
    port,
    box: boxOf(new THREE.Vector3(-hx, -w / 2, -h / 2), new THREE.Vector3(hx, w / 2, h / 2), q, at),
    socket: { at: pointOf(new THREE.Vector3(-hx - 0.1, 0, 0.2), q, at), dir: dir.clone().normalize().negate() },
    turn(deg) {
      spin.rotation.z = (-deg * Math.PI) / 180;
      grip?.(deg);
    },
  };
}

/** The red output hub: a disc with a cross hole and four pin holes, its axle along three.js Z of `parent`. */
function hubOn(kit: Kit, parent: THREE.Object3D, at: THREE.Vector3): THREE.Object3D {
  const { mats } = kit;
  const spin = kit.live(new THREE.Group());
  spin.position.copy(at);
  parent.add(spin);
  kit.axleCyl(1.0, 0.32, 0, 0, 0, mats.red, spin, 24);
  for (const side of [1, -1]) {
    kit.box(0.95, 0.06, 0.22, 0, side * 0.17, 0, mats.black, 0, spin);
    kit.box(0.22, 0.06, 0.95, 0, side * 0.17, 0, mats.black, 0, spin);
  }
  for (let a = 0; a < 4; a++) {
    const ang = (a * Math.PI) / 2 + Math.PI / 4;
    kit.axleCyl(0.2, 0.36, Math.cos(ang) * 0.68, 0, Math.sin(ang) * 0.68, mats.black, spin, 10);
  }
  return spin;
}

/** Half the large motor's shell, its hub at the origin and its body running along +X: the white top above the
 *  seam, or the grey bottom below it. */
function largeShell(top: boolean): THREE.BufferGeometry {
  // the silhouette seen from the side (x along the motor, y up), cut at the seam between the two shells
  const s = new THREE.Shape();
  const R = 2.1;
  if (top) {
    s.moveTo(-R, 0);
    s.absarc(0, 0, R, Math.PI, Math.PI / 2 - 0.2, true);
    s.bezierCurveTo(2.6, 1.9, 5.0, 1.55, 7.4, 1.25);
    s.quadraticCurveTo(9.1, 1.05, 9.1, 0);
  } else {
    s.moveTo(-R, 0);
    s.absarc(0, 0, R, Math.PI, Math.PI * 1.5, false);
    s.lineTo(5.5, -R);
    s.bezierCurveTo(7.8, -R, 9.1, -1.6, 9.1, -0.8);
    s.lineTo(9.1, 0);
  }
  s.closePath();
  const w = top ? 2.3 : 2.4;
  const g = new THREE.ExtrudeGeometry(s, {
    depth: w - 0.3,
    bevelEnabled: true,
    bevelThickness: 0.15,
    bevelSize: 0.15,
    bevelSegments: 2,
    curveSegments: 18,
  });
  g.translate(0, 0, -(w - 0.3) / 2);
  return g;
}
