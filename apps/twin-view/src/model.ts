// The 3D body of a twin, composed from a catalogue of parts placed by data: the drive from the profile's
// drivetrain (drive.ts), the brick (brick.ts) on a frame of beams, every other motor and every sensor on its own
// port (devices.ts) with its cable to that port, what the look adds (accessories.ts). Where each goes comes from
// the world's `extensions.view` (look.ts) or a default mount that keeps clear of what is placed (layout.ts).
// Every moving part follows the twin's state: tread links and sprockets or wheels from the drive motors' tachos,
// every motor's hub from its tacho, the touch plunger, the colour sensor's light, the ultrasonic eye, the
// brick's LED, buttons and screen.
//
// Robot frame: x ahead, y to the left, z up. three.js inside the robot group: X ahead, Y up, Z to the right.
import * as THREE from "three";
import { buildAccessories } from "./accessories";
import { brickDims, buildBrick } from "./brick";
import { BEAM, MODULE } from "./dims";
import { buildDevices, cableTo, type BrickMount } from "./devices";
import { buildDrive } from "./drive";
import { Occupancy } from "./layout";
import type { Look } from "./look";
import type { RobotMeta, RobotState } from "./messages";
import { boxOf, disposeKit, makeKit, mergeKit, orient, P, pointOf } from "./parts";

export { P };

export interface RobotModel {
  group: THREE.Group;
  /** The robot's own camera (the phone when there is one, else the front), robot frame: where, and a point it looks at. */
  eye: { pos: THREE.Vector3; look: THREE.Vector3 };
  /** Origin of the distance sensor's rays in the group frame, or null without a distance sensor. */
  rayOrigin: THREE.Vector3 | null;
  /** Height of the tallest part, cm. */
  height: number;
  update(s: RobotState, tachos: Record<string, number>, timeS: number): void;
  dispose(): void;
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export function buildRobot(meta: RobotMeta, look: Look): RobotModel {
  const group = new THREE.Group();
  group.name = `robot ${meta.id}`;
  const kit = makeKit(group);
  const { mats } = kit;
  const body = meta.world.body;
  const occ = new Occupancy();

  const drive = buildDrive(kit, meta, look);
  for (const b of drive.boxes) occ.add(b);

  // ---------------------------------------------------------------- the brick, on a frame of beams
  // flat: its screen up, the screen's top edge (ports A-D) to the front or the back; standing: upright, ports
  // A-D on top, the screen facing the front or the back
  const lb = look.brick;
  const towards = lb.screen === "front" ? 1 : -1;
  const q = lb.pose === "flat" ? orient(v3(towards, 0, 0), v3(0, 0, 1)) : orient(v3(0, 0, 1), v3(towards, 0, 0));
  const bd = brickDims(lb.battery);
  const lmin = v3(...bd.min),
    lmax = v3(...bd.max);
  const at0 = boxOf(lmin, lmax, q, v3(0, 0, 0));
  const bx = lb.x ?? (body.front_cm - body.back_cm) / 2 - 1;
  // lying flat, it sits on two beams across its bottom pinned into its bottom holes (one module thick)
  const bz = lb.z ?? drive.top + (lb.pose === "flat" ? BEAM.along : 0);
  const origin = v3(bx - (at0.min.x + at0.max.x) / 2, lb.y - (at0.min.y + at0.max.y) / 2, bz - at0.min.z);
  const brick = buildBrick(kit, lb.battery);
  brick.group.position.copy(P(origin.x, origin.y, origin.z));
  brick.group.quaternion.copy(q);
  group.add(brick.group);
  const box = boxOf(lmin, lmax, q, origin);
  const frameZ = box.min.z;
  // the frame under it: across the robot, wide enough to rest on the drive's motors, at the brick's bottom holes
  // (the map's holes with a vertical axis, a module either side of the middle), holes up
  const reach = Math.max(box.max.y - lb.y, ...drive.motors.map((mo) => Math.max(mo.box.max.y, -mo.box.min.y)));
  const across = Math.max(3, 2 * Math.round(reach / MODULE) + 1);
  const bottomHoles =
    lb.pose === "flat" ? [...new Set(bd.holes.filter((h) => h.axis[2] > 0.9).map((h) => h.at[0]))] : [];
  for (const hx of bottomHoles.length ? bottomHoles : [lmin.x + MODULE, lmax.x - MODULE]) {
    const c = pointOf(v3(hx, 0, 0), q, origin);
    const beam = kit.beam(across, c.x, lb.y, frameZ - BEAM.along / 2, mats.dark);
    // its length across the robot (three.js Z), its holes up (three.js Y)
    beam.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(v3(0, 0, 1), v3(1, 0, 0), v3(0, 1, 0)));
  }
  occ.add(box.clone().expandByPoint(v3(box.min.x, box.min.y, frameZ - BEAM.along)));
  // nothing is mounted over the screen and the buttons (in front of them when the brick stands): a person needs them
  occ.add(boxOf(v3(bd.at.buttons![0] - 2, lmin.y, lmax.z), v3(lmax.x, lmax.y, lmax.z + 3), q, origin));

  const mount: BrickMount = {
    port(p) {
      const local = brick.portAt(p);
      return {
        at: pointOf(local, q, origin),
        out: pointOf(v3(Math.sign(local.x), 0, 0), q, v3(0, 0, 0)),
      };
    },
    box,
    driveTop: drive.top,
    // the top of the end away from the screen, where the print is: free to mount on
    printTop: pointOf(v3(lmin.x + 2.2, 0, lmax.z), q, origin),
  };
  for (const mo of drive.motors) cableTo(kit, mount, mo.socket.at, mo.socket.dir, mo.port);

  const acc = buildAccessories(kit, meta, look, mount);
  for (const b of acc.boxes) occ.add(b);
  const devices = buildDevices(kit, meta, look, mount, occ);

  // a soft contact shadow under the body: the sun's shadow alone leaves the robot floating
  const shadowTex = kit.keep(contactShadowTexture());
  const len = body.front_cm + body.back_cm + 5,
    wid = 2 * body.half_width_cm + 5;
  const shadow = new THREE.Mesh(
    kit.keep(new THREE.PlaneGeometry(len, wid)),
    kit.live(
      kit.keep(
        new THREE.MeshBasicMaterial({
          color: 0x000000,
          alphaMap: shadowTex,
          transparent: true,
          opacity: 0.6,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
        }),
      ),
    ),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.copy(P((body.front_cm - body.back_cm) / 2, 0, 0.02));
  shadow.raycast = () => {}; // the floor under the robot stays the floor for the hand
  shadow.renderOrder = -1;
  group.add(shadow);

  mergeKit(kit);

  const ray = devices.rayOrigin;
  return {
    group,
    eye: acc.eye,
    rayOrigin: ray ? P(ray.x, ray.y, ray.z) : null,
    height: Math.max(acc.height, devices.height, box.max.z + 1),
    update(s, tachos, timeS) {
      drive.update(tachos);
      brick.update(s, timeS);
      acc.update(s, timeS);
      devices.update(s, timeS, tachos);
    },
    dispose() {
      group.traverse((o) => (o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).dispose());
      disposeKit(kit);
    },
  };
}

/** A soft dark rounded rectangle on a transparent field (as an alpha map: white is shadow). */
function contactShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 192;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, c.width, c.height);
  g.filter = "blur(14px)";
  g.fillStyle = "#fff";
  g.beginPath();
  g.roundRect(34, 30, 188, 132, 26);
  g.fill();
  g.filter = "blur(4px)";
  g.fillStyle = "#ddd";
  g.beginPath();
  g.roundRect(52, 44, 152, 104, 16);
  g.fill();
  return new THREE.CanvasTexture(c);
}
