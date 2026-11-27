// The devices on the brick's ports that are not the drive: the sensors (infrared 45509, ultrasonic 45504, colour
// 45506, touch 45507, gyro 45505) and the motors that move something else (an arm, a head), each where the look
// puts it or at a default mount (layout.ts), with its flat cable to its own port on the brick.
//
// Each sensor is built facing +x with its top at +z, its centre at the origin, then turned to its facing.
import * as THREE from "three";
import type { Fit } from "./attachments";
import { placePart, type Mount, type Occupancy } from "./layout";
import type { Look, MotorPlace, SensorPlace } from "./look";
import type { RobotMeta, RobotState } from "./messages";
import { DIMS, type Dim } from "./dims";
import { largeMotor, largeMotorBox, mediumMotor, type MotorPart } from "./motors";
import { facingDir, P, pointOf, type Kit } from "./parts";

/** The brick as the cables see it: where each port is, the way out of it, and the brick's box. */
export interface BrickMount {
  port(p: string): { at: THREE.Vector3; out: THREE.Vector3 };
  box: THREE.Box3;
  /** Top of the drive (0 without one): where low mounts start. */
  driveTop: number;
  /** The brick's face at the end away from its screen, robot frame: where parts can sit on the brick. */
  printTop: THREE.Vector3;
}

/** A flat cable from `from` (leaving it along `dir`) to port `p`: a short hop when the port is near, else beside
 *  the brick, along its side, and straight into the port, as a person routes one. */
export function cableTo(kit: Kit, m: BrickMount, from: THREE.Vector3, dir: THREE.Vector3, p: string): void {
  const { at, out } = m.port(p);
  const a = from.clone().addScaledVector(dir, 1.0);
  const into = at.clone().addScaledVector(out, 0.9);
  if (a.distanceTo(into) < 7) {
    const mid = a.clone().add(into).multiplyScalar(0.5).addScaledVector(out, 0.6);
    mid.z = Math.max(mid.z, Math.min(a.z, into.z) + 0.6);
    kit.cable([from, a, mid, into, at]);
    return;
  }
  const b = m.box;
  const ys = from.y >= (b.min.y + b.max.y) / 2 ? b.max.y + 0.7 : b.min.y - 0.7;
  const high = a.z > b.max.z ? Math.max(b.max.z + 1.2, a.z - 1.2) : a.z;
  kit.cable([
    from,
    a,
    new THREE.Vector3(a.x + dir.x * 0.6, (a.y + ys) / 2, high),
    new THREE.Vector3((a.x + at.x) / 2, ys, Math.min(high, b.max.z - 0.6)),
    into
      .clone()
      .addScaledVector(out, 1.0)
      .add(new THREE.Vector3(0, (ys - into.y) / 2, 0.3)),
    into,
    at,
  ]);
}

export interface Devices {
  height: number;
  /** Origin of the distance sensor's rays (its face), robot frame, or null. */
  rayOrigin: THREE.Vector3 | null;
  update(s: RobotState, timeS: number, tachos: Record<string, number>): void;
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** Each sensor kind's box around its centre, facing +x. */
const around = (d: Dim): [THREE.Vector3, THREE.Vector3] => [
  v3(-d.l / 2, -d.w / 2, -d.h / 2),
  v3(d.l / 2, d.w / 2, d.h / 2),
];
const SIZE: Record<SensorPlace["kind"], [THREE.Vector3, THREE.Vector3]> = {
  ultrasonic: around(DIMS.ultrasonicSensor),
  ir: around(DIMS.infraredSensor),
  color: around(DIMS.colorSensor),
  touch: around(DIMS.touchSensor),
  gyro: around(DIMS.gyroSensor),
};

export function buildDevices(kit: Kit, meta: RobotMeta, look: Look, m: BrickMount, occ: Occupancy): Devices {
  const { mats, keep, group } = kit;
  const body = meta.world.body;
  const F = body.front_cm,
    Bk = body.back_cm,
    HW = body.half_width_cm;
  const bb = m.box,
    dt = m.driveTop;
  const cx = (bb.min.x + bb.max.x) / 2,
    cz = (bb.min.z + bb.max.z) / 2;
  let height = 0;
  let rayOrigin: THREE.Vector3 | null = null;

  // ---------------------------------------------------------------- motors that drive something else
  const motors: MotorPart[] = [];
  // the parts the look places in full go first, so the defaults keep clear of them
  const byGiven = <T extends { x: number | null; y: number | null; z: number | null }>(a: T, b: T) =>
    Number(b.x !== null && b.y !== null && b.z !== null) - Number(a.x !== null && a.y !== null && a.z !== null);
  for (const mp of [...look.motors].sort(byGiven)) motors.push(placeMotor(kit, mp, m, occ, { F, cx, cz, bb }));
  for (const mo of motors) {
    cableTo(kit, m, mo.socket.at, mo.socket.dir, mo.port);
    height = Math.max(height, mo.box.max.z);
  }

  // ---------------------------------------------------------------- sensors
  const touchPlungers: { port: string; obj: THREE.Object3D }[] = [];
  const colorLights: { port: string; lens: THREE.MeshStandardMaterial; spotMat: THREE.MeshBasicMaterial | null }[] = [];
  const usEyes: { port: string; mat: THREE.MeshStandardMaterial }[] = [];
  for (const s of [...look.sensors].sort(byGiven)) {
    const dx = body.distance_sensor_x_cm - 1.4;
    const mounts: Record<SensorPlace["kind"], Mount[]> = {
      // its lens about 6 mm over the floor; side by side they sit a module apart
      color: [0, 2.8, -2.8].map((y) => ({
        x: body.color_sensor_x_cm,
        y,
        z: 0.6 + DIMS.colorSensor.l / 2,
        facing: "down" as const,
      })),
      touch: [
        { x: F - 2, y: 0, z: 3.2, facing: "forward" },
        { x: F - 2, y: 2.8, z: 3.2, facing: "forward" },
        { x: F - 2, y: -2.8, z: 3.2, facing: "forward" },
      ],
      ultrasonic: [
        { x: dx, y: 0, z: Math.max(6.5, dt + 1.6), facing: "forward" },
        { x: dx, y: 0, z: bb.max.z + 1.6, facing: "forward" },
      ],
      ir: [],
      gyro: [
        { x: -Bk + 2, y: HW - 2, z: dt + 1.3, facing: "up" },
        { x: -Bk + 2, y: -(HW - 2), z: dt + 1.3, facing: "up" },
        { x: m.printTop.x, y: m.printTop.y, z: m.printTop.z + 1.0, facing: "up" },
      ],
    };
    mounts.ir = mounts.ultrasonic;
    const [min, max] = SIZE[s.kind];
    const pl = placePart(s, min, max, mounts[s.kind], occ);
    const g = new THREE.Group();
    g.position.copy(P(pl.at.x, pl.at.y, pl.at.z));
    g.quaternion.copy(pl.q);
    group.add(g);
    const at = (x: number, y: number, z: number) => pointOf(v3(x, y, z), pl.q, pl.at);
    height = Math.max(height, pl.box.max.z);
    if (s.kind === "ultrasonic" || s.kind === "ir") {
      // the body: grey below, a white cap, the front in anthracite
      kit.box(2.0, 4.6, 1.4, -0.3, 0, -0.65, mats.light, 0.45, g);
      kit.box(2.0, 4.6, 1.35, -0.3, 0, 0.7, mats.white, 0.5, g);
      kit.box(0.6, 4.8, 2.8, 1.0, 0, 0, mats.anthracite, 0.35, g);
      kit.studs(1, 2, -0.6, 0, 1.38, mats.white, g);
      if (s.kind === "ultrasonic") {
        const glow = kit.live(
          keep(
            new THREE.MeshStandardMaterial({
              color: 0x220000,
              emissive: 0xff1a10,
              emissiveIntensity: 0,
              roughness: 0.4,
            }),
          ),
        );
        usEyes.push({ port: s.port, mat: glow });
        for (const [i, y] of [1.25, -1.25].entries()) {
          const eye = new THREE.Group();
          eye.position.copy(P(1.3, y, 0));
          eye.rotation.y = Math.PI / 2; // the eyes look along +x
          g.add(eye);
          kit.axleCyl(1.0, 0.3, 0, 0, 0, mats.red, eye, 28);
          kit.axleCyl(0.75, 0.34, 0, 0, 0, mats.black, eye, 24);
          kit.axleCyl(0.5, 0.36, 0, 0, 0, i === 0 ? glow : mats.anthracite, eye, 20);
        }
      } else {
        // the infrared's dark red window, glossy
        const win = keep(new THREE.MeshStandardMaterial({ color: 0x3c0508, roughness: 0.06, metalness: 0.1 }));
        kit.box(0.2, 3.7, 1.5, 1.32, 0, 0.05, win, 0.5, g);
      }
      rayOrigin ??= at(1.4, 0, 0);
    } else if (s.kind === "color") {
      kit.box(3.3, 2.3, 1.5, -0.25, 0, -0.75, mats.light, 0.35, g);
      kit.box(3.3, 2.3, 1.5, -0.25, 0, 0.75, mats.white, 0.4, g);
      const face = new THREE.Group();
      face.position.copy(P(1.6, 0, 0));
      face.rotation.y = Math.PI / 2;
      g.add(face);
      kit.axleCyl(0.92, 0.6, 0, 0, 0, mats.black, face, 24);
      const lens = kit.live(
        keep(
          new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xff2010, emissiveIntensity: 1, roughness: 0.1 }),
        ),
      );
      const l = kit.add(
        kit.cached("lens", () => new THREE.CylinderGeometry(0.42, 0.42, 0.1, 20).rotateX(Math.PI / 2)),
        lens,
        P(0, 0, -0.32),
        face,
      );
      l.castShadow = false;
      // its light on the floor when it looks down, as wide as what it reads
      let spotMat: THREE.MeshBasicMaterial | null = null;
      if (pl.dir.z < -0.7) {
        spotMat = kit.live(
          keep(
            new THREE.MeshBasicMaterial({
              color: 0xff2010,
              transparent: true,
              opacity: 0.55,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
              polygonOffset: true,
              polygonOffsetFactor: -2,
            }),
          ),
        );
        const spot = new THREE.Mesh(
          kit.cached("spot", () => new THREE.CircleGeometry(Math.max(0.6, body.color_spot_radius_cm * 1.2), 28)),
          spotMat,
        );
        const lensAt = at(1.9, 0, 0);
        spot.rotation.x = -Math.PI / 2;
        spot.position.copy(P(lensAt.x, lensAt.y, 0.05));
        spot.raycast = () => {};
        group.add(spot);
      }
      colorLights.push({ port: s.port, lens, spotMat });
    } else if (s.kind === "touch") {
      kit.box(2.8, 1.9, 1.2, -0.5, 0, -0.6, mats.light, 0.35, g);
      kit.box(2.8, 1.9, 1.2, -0.5, 0, 0.6, mats.white, 0.4, g);
      kit.box(0.5, 1.5, 1.5, 1.1, 0, 0, mats.anthracite, 0.2, g);
      const plunger = kit.live(new THREE.Group());
      plunger.position.copy(P(1.35, 0, 0));
      g.add(plunger);
      kit.box(0.9, 0.42, 1.3, 0.2, 0, 0, mats.red, 0.1, plunger);
      kit.box(0.9, 1.3, 0.42, 0.2, 0, 0, mats.red, 0.1, plunger);
      touchPlungers.push({ port: s.port, obj: plunger });
    } else {
      kit.box(1.2, 2.4, 2.4, -0.3, 0, 0, mats.light, 0.35, g);
      kit.box(0.6, 2.4, 2.4, 0.6, 0, 0, mats.white, 0.35, g);
      // the two red arrows of the axis it measures, printed on its face
      kit.box(0.04, 1.7, 0.22, 0.92, 0, 0, mats.red, 0, g);
      kit.box(0.04, 0.22, 1.0, 0.92, 0, 0.45, mats.red, 0, g);
    }
    cableTo(kit, m, at(SIZE[s.kind][0].x, 0, 0), pl.dir.clone().negate(), s.port);
  }

  return {
    height,
    rayOrigin,
    update(s, timeS, tachos) {
      for (const mo of motors) mo.turn(tachos[mo.port] ?? 0);
      for (const sensor of s.sensors) {
        const tp = touchPlungers.find((x) => x.port === sensor.port);
        if (tp) tp.obj.position.x = 1.35 - (sensor.mode === 0 && sensor.values[0] === 1 ? 0.5 : 0);
        const cl = colorLights.find((x) => x.port === sensor.port);
        if (cl) {
          // reflected light: the red LED; colour: white light; ambient: the LED nearly off (a dim blue)
          const hex = sensor.mode === 0 ? 0xff2010 : sensor.mode === 1 ? 0x2a5cff : 0xf4f6ff;
          cl.lens.emissive.setHex(hex);
          cl.lens.emissiveIntensity = sensor.mode === 1 ? 0.5 : 2;
          if (cl.spotMat) {
            cl.spotMat.color.setHex(hex);
            cl.spotMat.opacity = sensor.mode === 1 ? 0.12 : 0.45;
          }
        }
        const us = usEyes.find((x) => x.port === sensor.port);
        if (us) us.mat.emissiveIntensity = sensor.values.length ? 0.9 + 0.3 * Math.sin(timeS * 9) : 0;
      }
    },
  };
}

/** A motor that does not drive: where the look says, else on the front or the top of the brick or beside it. */
function placeMotor(
  kit: Kit,
  mp: MotorPlace,
  m: BrickMount,
  occ: Occupancy,
  at: { F: number; cx: number; cz: number; bb: THREE.Box3 },
): MotorPart {
  const { F, cx, cz, bb } = at;
  if (mp.size === "medium") {
    const mounts: Mount[] = [
      { x: Math.min(F - 2.4, bb.max.x + 2.9), y: 0, z: Math.max(bb.max.z - 1.65, m.driveTop + 1.8), facing: "forward" },
      { x: m.printTop.x, y: m.printTop.y, z: m.printTop.z + 1.7, facing: "forward" },
      { x: cx, y: bb.max.y + 1.3, z: cz, facing: "forward" },
      { x: cx, y: bb.min.y - 1.3, z: cz, facing: "forward" },
    ];
    // an arm or a lift swings ahead from an axle across the robot; a turntable turns about an axle pointing up
    const facing =
      mp.attachment === "arm" || mp.attachment === "lift" ? "left" : mp.attachment === "turntable" ? "up" : "forward";
    const pl = placePart(
      mp,
      ...around(DIMS.mediumMotor),
      mounts.map((mo) => ({ ...mo, facing })),
      occ,
    );
    return mediumMotor(kit, mp.port, pl.at, pl.dir, pl.up, fitOf(mp));
  }
  // a large motor: its output axle along `facing` (default to the left; up for a turntable, ahead for a gripper),
  // its body running back from the hub, or
  // upright when the axle itself points ahead or back
  const axis = facingDir(
    mp.facing ?? (mp.attachment === "turntable" ? "up" : mp.attachment === "gripper" ? "forward" : "left"),
    mp.yaw,
  );
  const back = v3(-1, 0, 0);
  const body = back.addScaledVector(axis, -back.dot(axis));
  if (body.length() < 0.3) body.set(0, 0, 1);
  body.normalize();
  const centreToHub = body.clone().multiplyScalar(-3.7);
  const hubs = [
    v3(bb.max.x - 2.2, 0, bb.max.z + 2.15),
    v3(cx + 3.7, bb.max.y + 1.6, cz),
    v3(cx + 3.7, bb.min.y - 1.6, cz),
    v3(bb.min.x - 2.2, 0, bb.max.z + 2.15),
  ];
  let hub: THREE.Vector3 | null = null;
  if (mp.x !== null || mp.y !== null || mp.z !== null) {
    const c = v3(mp.x ?? cx, mp.y ?? 0, mp.z ?? bb.max.z + 2.15);
    hub = c.add(centreToHub);
  } else {
    for (const h of hubs) if (!occ.hits(largeMotorBox(h, axis, body))) hub ??= h;
    for (let dz = 0.5; !hub && dz <= 60; dz += 0.5) {
      const h = hubs[0]!.clone().add(v3(0, 0, dz));
      if (!occ.hits(largeMotorBox(h, axis, body))) hub = h;
    }
    hub ??= hubs[0]!;
  }
  const part = largeMotor(kit, mp.port, hub, axis, body, axis, fitOf(mp));
  occ.add(part.box);
  return part;
}

const fitOf = (mp: MotorPlace): Fit => ({ kind: mp.attachment, length: mp.length, openDeg: mp.openDeg });
