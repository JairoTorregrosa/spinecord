// The devices on the brick's ports that are not the drive: the sensors (infrared 45509, ultrasonic 45504, colour
// 45506, touch 45507, gyro 45505) and the motors that move something else (an arm, a head), each where the look
// puts it or at a default mount (layout.ts), with its flat cable to its own port on the brick.
//
// Each sensor is built facing +x with its top at +z, its centre at the origin, then turned to its facing.
import * as THREE from "three";
import type { Fit } from "./attachments";
import { hold, onGrid, placePart, type Mount, type Occupancy } from "./layout";
import type { Look, MotorPlace, SensorPlace } from "./look";
import type { RobotMeta, RobotState } from "./messages";
import { MOTOR, SENSOR, type PartDims } from "./dims";
import { largeMotor, largeMotorBox, mediumMotor, type MotorPart } from "./motors";
import { facingDir, P, pointOf, type Kit, type RealPart } from "./parts";
import { centreForPose, distancePort, eyeOffset, poseOfBody } from "./sensor-pose";

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
  update(s: RobotState, timeS: number, tachos: Record<string, number>): void;
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** A part's box around its centre (facing +x), and where its own origin (a sensor's axle hole, a motor's output)
 *  lies from that centre: the look places a part by the centre of its box. */
const around = (d: PartDims): { min: THREE.Vector3; max: THREE.Vector3; origin: THREE.Vector3 } => {
  const c = v3((d.min[0] + d.max[0]) / 2, (d.min[1] + d.max[1]) / 2, (d.min[2] + d.max[2]) / 2);
  return {
    min: v3(...d.min).sub(c),
    max: v3(...d.max).sub(c),
    origin: c.negate(),
  };
};
const SIZE: Record<SensorPlace["kind"], ReturnType<typeof around>> = {
  ultrasonic: around(SENSOR.ultrasonic),
  ir: around(SENSOR.ir),
  color: around(SENSOR.color),
  touch: around(SENSOR.touch),
  gyro: around(SENSOR.gyro),
};
const LDRAW: Record<SensorPlace["kind"], string> = {
  ultrasonic: SENSOR.ultrasonic.ldraw,
  ir: SENSOR.ir.ldraw,
  color: SENSOR.color.ldraw,
  touch: SENSOR.touch.ldraw,
  gyro: SENSOR.gyro.ldraw,
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
  /** The drawn eye, checked against the pose the physics reads from: a layout that moved it fails loud. */
  const eyeAt = (e: THREE.Vector3): void => {
    const p = poseOfBody(body);
    if (Math.hypot(e.x - p.x_cm, e.y - p.y_cm, e.z - p.z_cm) > 0.01)
      throw new Error(
        `the distance sensor is drawn with its eye at (${e.x.toFixed(2)}, ${e.y.toFixed(2)}, ${e.z.toFixed(2)}) cm, and the twin reads from (${p.x_cm}, ${p.y_cm}, ${p.z_cm})`,
      );
  };

  // ---------------------------------------------------------------- motors that drive something else
  const motors: MotorPart[] = [];
  // the parts the look places in full go first, so the defaults keep clear of them
  const byGiven = <T extends { x: number | null; y: number | null; z: number | null }>(a: T, b: T) =>
    Number(b.x !== null && b.y !== null && b.z !== null) - Number(a.x !== null && a.y !== null && a.z !== null);
  // a motor that rides on another's arm or lift comes after the one that carries it
  const order = [...look.motors].sort(byGiven).sort((a, b) => Number(a.on !== null) - Number(b.on !== null));
  for (const mp of order) {
    const carrier = mp.on ? motors.find((x) => x.port === mp.on) : undefined;
    if (carrier?.end) {
      // at the end of the carrier's arm or lift, hanging under it, facing ahead; it rides along from then on
      group.updateMatrixWorld(true);
      const e = carrier.end.getWorldPosition(new THREE.Vector3());
      const tip = v3(e.x, -e.z, e.y);
      const rider = placeMotor(
        kit,
        { ...mp, x: tip.x + 2, y: tip.y, z: tip.z - 1.5, facing: mp.facing ?? "forward" },
        m,
        occ,
        {
          F,
          cx,
          cz,
          bb,
        },
      );
      carrier.end.attach(rider.group);
      motors.push(rider);
      continue;
    }
    const part = placeMotor(kit, mp, m, occ, { F, cx, cz, bb });
    const c = part.box.getCenter(new THREE.Vector3());
    hold(
      kit,
      occ,
      part.box,
      v3(c.x, c.y, part.box.min.z + 0.4),
      v3(0, 1, 0),
      (part.box.max.y - part.box.min.y) / 2,
      bb,
    );
    motors.push(part);
  }
  for (const mo of motors) {
    cableTo(kit, m, mo.socket.at, mo.socket.dir, mo.port);
    height = Math.max(height, mo.box.max.z);
  }

  // ---------------------------------------------------------------- sensors
  const touchPlungers: { port: string; obj: THREE.Object3D }[] = [];
  const colorLights: { port: string; lens: THREE.MeshStandardMaterial; spotMat: THREE.MeshBasicMaterial | null }[] = [];
  const usEyes: { port: string; mat: THREE.MeshStandardMaterial }[] = [];
  // the distance sensor the physics reads (the lowest port with one) sits where its eye is the body's pose, facing
  // its heading: the one pose its reading, its rays and its drawing share (sensor-pose.ts); apps/local resolved the
  // look's place for it into that pose
  const pose = poseOfBody(body);
  const pinned = distancePort(meta.ports.sensors);
  const sensors = look.sensors.map((s): SensorPlace => {
    if (s.port !== pinned?.port) return s;
    const c = centreForPose(eyeOffset(pinned.kind, SENSOR[pinned.kind]), pose);
    return { ...s, x: c.x, y: c.y, z: c.z, facing: "forward", yaw: pose.yaw_deg };
  });
  for (const s of sensors.sort(byGiven)) {
    const dx = body.distance_sensor_x_cm - 1.4;
    const mounts: Record<SensorPlace["kind"], Mount[]> = {
      // its lens about 6 mm over the floor; side by side they sit a module apart
      color: [0, 2.8, -2.8].map((y) => ({
        x: body.color_sensor_x_cm,
        y,
        z: 0.6 + (SENSOR.color.max[0] - SENSOR.color.min[0]) / 2,
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
        // pinned flat against either side of the brick, so a taken top never leaves it floating
        { x: cx - 2, y: bb.max.y + 1.25, z: cz, facing: "up" },
        { x: cx - 2, y: bb.min.y - 1.25, z: cz, facing: "up" },
      ],
    };
    mounts.ir = mounts.ultrasonic;
    const size = SIZE[s.kind];
    const pl = placePart(s, size.min, size.max, mounts[s.kind], occ, s.kind === "gyro");
    // a default mount puts the sensor's axle hole on the half-module grid (over the drive's top)
    const hole0 = pointOf(size.origin, pl.q, pl.at);
    if (s.x === null && s.y === null && s.z === null) {
      const shift = v3(onGrid(hole0.x), onGrid(hole0.y), dt + onGrid(hole0.z - dt)).sub(hole0);
      pl.at.add(shift);
      pl.box.translate(shift);
    }
    const g = new THREE.Group();
    g.position.copy(P(pl.at.x, pl.at.y, pl.at.z));
    g.quaternion.copy(pl.q);
    group.add(g);
    // the part's own frame: its axle hole at the origin, the eye or face along +x (dims.ts SENSOR)
    const o = kit.live(new THREE.Group());
    o.position.copy(P(size.origin.x, size.origin.y, size.origin.z));
    g.add(o);
    const d = SENSOR[s.kind];
    const roles: NonNullable<RealPart["roles"]> = {};
    const f = (k: string) => {
      const v = d.at[k];
      if (!v) throw new Error(`the parts map gives the ${s.kind} sensor no ${k}`);
      return v;
    };
    /** a point of the part's frame in the robot frame */
    const at = (x: number, y: number, z: number) => pointOf(v3(x, y, z).add(size.origin), pl.q, pl.at);
    height = Math.max(height, pl.box.max.z);
    const [x0, y0, z0] = d.min,
      [x1, y1, z1] = d.max;
    const W = y1 - y0,
      H = z1 - z0;
    const zc = (z0 + z1) / 2;
    // the shell all EV3 sensors share: white above, light grey below, the socket at the back
    const shell = (xf: number, w: number) => {
      kit.box(xf - x0, w, H * 0.5, (x0 + xf) / 2, 0, z0 + H * 0.25, mats.light, 0.3, o);
      kit.box(xf - x0, w, H * 0.5, (x0 + xf) / 2, 0, z1 - H * 0.25, mats.white, 0.35, o);
      const [sx, , sz] = f("socket");
      kit.box(0.2, 1.1, 0.8, sx + 0.08, 0, sz, mats.anthracite, 0.08, o);
      // the axle hole through it, and the pin holes a module either side
      for (const h of d.holes)
        for (const side of [1, -1]) kit.axleCyl(0.24, 0.05, h.at[0], side * (w / 2 + 0.01), h.at[2], mats.black, o, 12);
    };
    if (s.kind === "ultrasonic" || s.kind === "ir") {
      // a narrow body behind the wide front that holds the eyes or the windows
      const xf = 1.2;
      shell(xf, 2.4);
      kit.box(x1 - xf, W, H, (xf + x1) / 2, 0, zc, s.kind === "ultrasonic" ? mats.black : mats.white, 0.35, o);
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
        // on the real mesh both transducers glow
        const eyes = kit.live(new THREE.Group());
        o.add(eyes);
        roles.eye = { target: eyes, material: glow };
        for (const [i, k] of ["transducer_left", "transducer_right"].entries()) {
          const [ex, ey, ez] = f(k);
          const eye = new THREE.Group();
          eye.position.copy(P(x1, ey, ez));
          eye.rotation.y = Math.PI / 2; // the eyes look along +x
          o.add(eye);
          const r = x1 - ex > 0 ? Math.min(1.25, W / 4 - 0.1) : 1;
          kit.axleCyl(r, 0.3, 0, 0, 0, mats.red, eye, 28);
          kit.axleCyl(r * 0.78, 0.34, 0, 0, 0, mats.black, eye, 24);
          kit.axleCyl(r * 0.5, 0.36, 0, 0, 0, i === 0 ? glow : mats.anthracite, eye, 20);
        }
        if (s.port === pinned?.port) eyeAt(at(...f("beam_centre")));
      } else {
        // the infrared's two dark red windows, glossy
        const win = keep(new THREE.MeshStandardMaterial({ color: 0x3c0508, roughness: 0.06, metalness: 0.1 }));
        for (const y of [W / 4, -W / 4]) kit.box(0.2, W / 2 - 0.5, H - 0.8, x1 - 0.05, y, zc, win, 0.4, o);
        if (s.port === pinned?.port) eyeAt(at(...f("front_face")));
      }
    } else if (s.kind === "color") {
      shell(x1 - 0.3, W);
      const [lx, ly, lz] = f("lens");
      const face = new THREE.Group();
      face.position.copy(P(lx - 0.15, ly, lz));
      face.rotation.y = Math.PI / 2;
      o.add(face);
      kit.axleCyl(0.6, 0.3, 0, 0, 0, mats.black, face, 24);
      const lens = kit.live(
        keep(
          new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xff2010, emissiveIntensity: 1, roughness: 0.1 }),
        ),
      );
      // the lens lights up on the real mesh too: its LED and phototransistor take this material there
      const lensHolder = kit.live(new THREE.Group());
      lensHolder.position.copy(face.position);
      lensHolder.rotation.copy(face.rotation);
      o.add(lensHolder);
      const l = kit.add(
        kit.cached("lens", () => new THREE.CylinderGeometry(0.3, 0.3, 0.1, 20).rotateX(Math.PI / 2)),
        lens,
        P(0, 0, -0.17),
        lensHolder,
      );
      roles.lens = { target: lensHolder, material: lens };
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
        const lensAt = at(lx, ly, lz);
        spot.rotation.x = -Math.PI / 2;
        spot.position.copy(P(lensAt.x, lensAt.y, 0.05));
        spot.raycast = () => {};
        group.add(spot);
      }
      colorLights.push({ port: s.port, lens, spotMat });
    } else if (s.kind === "touch") {
      const [bx, , bz] = f("button");
      // the red button (99386) stands 1.48 cm out of the body's front
      const front = bx - 1.48;
      shell(front, W);
      const plunger = kit.live(new THREE.Group());
      o.add(plunger);
      kit.box(1.48, 0.42, 1.5, front + 0.74, 0, bz, mats.red, 0.08, plunger);
      kit.box(1.48, 1.5, 0.42, front + 0.74, 0, bz, mats.red, 0.08, plunger);
      touchPlungers.push({ port: s.port, obj: plunger });
      kit.real({ ldraw: LDRAW[s.kind], holder: o, frame: "front", roles: { plunger: { target: plunger } } });
    } else {
      shell(x1, W);
      // the two red arrows of the axis it measures, printed on its top
      const [, , az] = f("measured_axis");
      kit.box(1.7, 0.22, 0.04, (x0 + x1) / 2, 0, Math.max(az, z1) + 0.01, mats.red, 0, o);
      kit.box(0.22, 1.0, 0.04, (x0 + x1) / 2 + 0.6, 0, Math.max(az, z1) + 0.01, mats.red, 0, o);
    }
    if (s.kind !== "touch") kit.real({ ldraw: LDRAW[s.kind], holder: o, frame: "front", roles });
    // held by what it touches, or by a beam through its axle hole
    const holeAxis = pointOf(v3(0, 1, 0), pl.q, v3(0, 0, 0));
    hold(kit, occ, pl.box, pointOf(size.origin, pl.q, pl.at), holeAxis, W / 2, bb);
    cableTo(kit, m, at(...f("socket")), pl.dir.clone().negate(), s.port);
  }

  return {
    height,
    update(s, timeS, tachos) {
      for (const mo of motors) mo.turn(tachos[mo.port] ?? 0);
      for (const sensor of s.sensors) {
        const tp = touchPlungers.find((x) => x.port === sensor.port);
        if (tp) tp.obj.position.x = sensor.mode === 0 && sensor.values[0] === 1 ? -0.4 : 0;
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
    const size = around(MOTOR.medium);
    const pl = placePart(
      mp,
      size.min,
      size.max,
      mounts.map((mo) => ({ ...mo, facing })),
      occ,
    );
    return mediumMotor(kit, mp.port, pointOf(size.origin, pl.q, pl.at), pl.dir, pl.up, fitOf(mp));
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
  // the motor's box from its hub (dims.ts MOTOR.large): its middle is this far along the body and up
  const LM = MOTOR.large;
  const upOf = new THREE.Vector3(0, 0, 1).addScaledVector(body, -body.z).normalize();
  const centreToHub = body
    .clone()
    .multiplyScalar(-(LM.min[0] + LM.max[0]) / 2)
    .addScaledVector(upOf.lengthSq() > 0.5 ? upOf : v3(-1, 0, 0), -(LM.min[2] + LM.max[2]) / 2);
  const lift = -LM.min[2]; // the hub stands this far over what the case rests on
  const halfW = (LM.max[1] - LM.min[1]) / 2;
  const hubs = [
    v3(onGrid(bb.max.x - 2.2), 0, bb.max.z + lift),
    v3(onGrid(cx + 3.7), bb.max.y + halfW, cz),
    v3(onGrid(cx + 3.7), bb.min.y - halfW, cz),
    v3(onGrid(bb.min.x - 2.2), 0, bb.max.z + lift),
  ];
  let hub: THREE.Vector3 | null = null;
  if (mp.x !== null || mp.y !== null || mp.z !== null) {
    const c = v3(mp.x ?? cx, mp.y ?? 0, mp.z ?? bb.max.z - centreToHub.z);
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
