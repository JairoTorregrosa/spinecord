// The 3D body of a twin: an EV3 brick on a frame of beams over two large motors, tracks or wheels, its sensors
// where the look puts them, and what the look adds (a phone, a bumper, a label). Built in cm from the real parts'
// sizes; every moving part follows the twin's state: tread links and sprockets from the drive motors' tachos,
// motor hubs from every tacho, the touch plunger, the colour sensor's light, the ultrasonic eye, the brick's LED
// and screen. Parts are in drive.ts, brick.ts and sensors.ts; parts.ts holds the kit they share.
//
// Robot frame: x ahead, y to the left, z up. three.js inside the robot group: X ahead, Y up, Z to the right.
import * as THREE from "three";
import { BRICK, buildBrick } from "./brick";
import { buildDrive } from "./drive";
import type { Look } from "./look";
import type { RobotMeta, RobotState } from "./messages";
import { disposeKit, makeKit, mergeKit, P } from "./parts";
import { buildExtras } from "./sensors";

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

export function buildRobot(meta: RobotMeta, look: Look): RobotModel {
  const group = new THREE.Group();
  group.name = `robot ${meta.id}`;
  const kit = makeKit(group);
  const { mats } = kit;
  const body = meta.world.body;

  const drive = buildDrive(kit, meta, look);

  // the brick on a frame of beams that rests on the motors
  const brick = buildBrick(kit);
  const bx = look.brick.x;
  const brickZ = drive.top + 1.5;
  brick.group.position.copy(P(bx, 0, brickZ));
  const flip = look.brick.screen === "back" ? -1 : 1;
  if (flip < 0) brick.group.rotation.y = Math.PI;
  group.add(brick.group);
  const holes = Math.round((BRICK.L + 1.6) / 0.8) + 1;
  for (const y of [BRICK.W / 2 - 0.6, -BRICK.W / 2 + 0.6]) kit.beam(holes, bx, y, brickZ - 0.38, mats.dark);
  for (const x of [bx - 4.4, bx + 4.4]) {
    const n = Math.round((2 * drive.socket.y + 2.4) / 0.8) + 1;
    kit.beam(n, x, 0, drive.top + 0.37, mats.dark).rotation.y = Math.PI / 2;
  }
  // red pins where the beams meet the brick's pin holes
  for (const x of [-4.0, 4.0])
    for (const side of [1, -1])
      kit.axleCyl(0.3, 0.3, bx + x, side * (BRICK.W / 2 + 0.12), brickZ + BRICK.H * 0.3, mats.red, group, 14);
  const brickTop = brickZ + BRICK.H;
  const port = (p: string) => {
    const l = brick.portAt(p);
    return { at: new THREE.Vector3(bx + flip * l.x, flip * l.y, brickZ + l.z), out: Math.sign(flip * l.x) };
  };

  // the drive motors' cables to their ports
  const d = meta.drivetrain;
  for (const [p, side] of [
    [d?.left ?? "B", 1],
    [d?.right ?? "C", -1],
  ] as const) {
    const s = drive.socket;
    const from = new THREE.Vector3(s.x, side * s.y, s.z);
    const { at, out } = port(p);
    // out of the motor's socket, then up in one S-bend into the port
    const a = from.clone().add(new THREE.Vector3(s.dir * 0.8, 0, 0.4));
    const b = at.clone().add(new THREE.Vector3(out * 0.9, 0, 0));
    const c = new THREE.Vector3((a.x + b.x) / 2 + out * 1.2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    kit.cable([from, a, c, b, at]);
  }

  const extras = buildExtras(kit, meta, look, { port, brickTop, brickHalfW: BRICK.W / 2, brickX: bx, brickZ });

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

  return {
    group,
    eye: extras.eye,
    rayOrigin: extras.rayOrigin,
    height: Math.max(extras.height, brickTop + 1),
    update(s, tachos, timeS) {
      drive.update(tachos);
      brick.update(s, timeS);
      extras.update(s, timeS, tachos);
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
