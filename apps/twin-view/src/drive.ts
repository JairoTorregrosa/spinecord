// What drives the robot: two EV3 large motors (45502) and, on their hubs, either tracks or wheels.
//
// Tracks: wide tread links (57518, 3.84 cm across) around two ten-tooth sprockets (57519, Ø 4.04 cm). The links'
// pitch line has the drivetrain's effective diameter and ten links span one turn of a sprocket, so the links travel
// exactly as the teeth do, and the track as a whole is as long as the world's body allows.
// Wheels: the educator base's 56 mm tyres on rims, a steel ball at the back.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Look } from "./look";
import type { RobotMeta } from "./messages";
import { largeMotor, type MotorPart } from "./motors";
import { P, type Kit } from "./parts";

export interface Drive {
  /** Top of the drive and its motors, cm: where the brick's frame can rest. 0 without a drive. */
  top: number;
  /** The drive motors, their hubs on the drive's axles. */
  motors: MotorPart[];
  /** What the drive takes up, robot frame: parts placed later keep out of it. */
  boxes: THREE.Box3[];
  update(tachos: Record<string, number>): void;
}

const TRACK_W = 3.84;
const LINK_T = 0.32; // the link's plate
const GROUSER = 0.28; // the bar across its outer face

export function buildDrive(kit: Kit, meta: RobotMeta, look: Look): Drive {
  const { mats, keep, group } = kit;
  const body = meta.world.body;
  const d = meta.drivetrain;
  if (look.drive === "none" || !d) return { top: 0, motors: [], boxes: [], update() {} };
  const D = d.wheel_diameter_cm;
  const Rp = D / 2;
  const sign = d.forward_sign;
  const sides = [
    { port: d.left, y: d.axle_track_cm / 2, out: 1 },
    { port: d.right, y: -d.axle_track_cm / 2, out: -1 },
  ];
  const spinners: { port: string; obj: THREE.Object3D }[] = [];
  const treads: { port: string; place: (travel: number) => void }[] = [];
  const boxes: THREE.Box3[] = [];
  const cmPerDeg = (sign * Math.PI * D) / 360;
  const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  let hubX: number, hubZ: number, bodyDir: number, motorY: number;
  if (look.drive === "tracks") {
    // ten teeth per turn of the sprocket, so one link per tooth
    const pitch = (2 * Math.PI * Rp) / 10;
    const zc = Rp + LINK_T / 2 + 0.06 + GROUSER;
    // the front of the track reaches the front of the body; the rear stops short of what the body keeps behind
    const xf = body.front_cm - (Rp + 0.5);
    const want = Math.max(4, xf - (-body.back_cm + Rp + 3.5));
    const N = Math.max(14, Math.round((2 * want + 2 * Math.PI * Rp) / pitch));
    const Ls = (N * pitch - 2 * Math.PI * Rp) / 2;
    const xr = xf - Ls;
    const xc = (xf + xr) / 2;
    const per = N * pitch;
    const linkGeo = keep(treadLinkGeometry(pitch));
    const sprocketGeo = keep(sprocketGeometry(Rp));
    const q = new THREE.Quaternion(),
      zAxis = v3(0, 0, 1),
      one = v3(1, 1, 1),
      v = v3(0, 0, 0),
      m4 = new THREE.Matrix4();
    for (const dr of sides) {
      const mesh = kit.live(new THREE.InstancedMesh(linkGeo, mats.rubber, N));
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false; // the instances move; the geometry's own bounds are one link's
      group.add(mesh);
      const lateral = -dr.y;
      const at = (s: number): THREE.Matrix4 => {
        s = ((s % per) + per) % per;
        let x: number, z: number, phi: number;
        if (s < Ls) [x, z, phi] = [xc - Ls / 2 + s, zc - Rp, 0];
        else if ((s -= Ls) < Math.PI * Rp) {
          const a = -Math.PI / 2 + s / Rp;
          [x, z, phi] = [xc + Ls / 2 + Rp * Math.cos(a), zc + Rp * Math.sin(a), a + Math.PI / 2];
        } else if ((s -= Math.PI * Rp) < Ls) [x, z, phi] = [xc + Ls / 2 - s, zc + Rp, Math.PI];
        else {
          const a = Math.PI / 2 + (s - Ls) / Rp;
          [x, z, phi] = [xc - Ls / 2 + Rp * Math.cos(a), zc + Rp * Math.sin(a), a + Math.PI / 2];
        }
        q.setFromAxisAngle(zAxis, phi);
        return m4.compose(v.set(x, z, lateral), q, one);
      };
      const place = (travel: number) => {
        for (let i = 0; i < N; i++) mesh.setMatrixAt(i, at(i * pitch - travel));
        mesh.instanceMatrix.needsUpdate = true;
      };
      place(0);
      treads.push({ port: dr.port, place });
      for (const sx of [xr, xf]) {
        const wheel = kit.live(new THREE.Group());
        wheel.position.copy(P(sx, dr.y, zc));
        group.add(wheel);
        kit.add(sprocketGeo, mats.light, v3(0, 0, 0), wheel);
        spinners.push({ port: dr.port, obj: wheel });
        // the axle through it, and a red bush holding it on the outside
        kit.axleCyl(0.24, TRACK_W + 1.6, sx, dr.y - dr.out * 0.4, zc, mats.dark, group, 12);
        kit.axleCyl(0.42, 0.6, sx, dr.y + dr.out * (TRACK_W / 2 + 0.2), zc, mats.red, group, 16);
      }
      // the frame on the inside of the track: a beam that holds the front sprocket's axle
      const holes = Math.max(3, Math.round(Ls / 0.8) + 1);
      kit.beam(holes, xc, dr.y - dr.out * (TRACK_W / 2 + 0.55), zc, mats.dark);
      const yIn = dr.y - dr.out * (TRACK_W / 2 + 1),
        yOut = dr.y + dr.out * (TRACK_W / 2 + 0.6);
      boxes.push(new THREE.Box3(v3(xr - zc, Math.min(yIn, yOut), 0), v3(xf + zc, Math.max(yIn, yOut), 2 * zc)));
    }
    hubX = xr;
    hubZ = zc;
    bodyDir = 1;
    motorY = d.axle_track_cm / 2 - TRACK_W / 2 - 0.9 - 1.2;
  } else {
    const tyreW = 2.6;
    const tyre = kit.cached(`tyre ${Rp} ${tyreW}`, () => tyreGeometry(Rp, tyreW));
    const rim = kit.cached(`rim ${Rp} ${tyreW}`, () => rimGeometry(Rp * 0.62, tyreW - 0.2));
    for (const dr of sides) {
      const wheel = kit.live(new THREE.Group());
      wheel.position.copy(P(0, dr.y, Rp));
      group.add(wheel);
      kit.add(tyre, mats.rubber, v3(0, 0, 0), wheel);
      kit.add(rim, mats.light, v3(0, 0, 0), wheel);
      spinners.push({ port: dr.port, obj: wheel });
      boxes.push(new THREE.Box3(v3(-Rp, dr.y - tyreW / 2 - 0.3, 0), v3(Rp, dr.y + tyreW / 2 + 0.3, D)));
    }
    if (look.caster) {
      // the ball caster at the back: a steel ball in a dark grey cage, on a beam up to the frame
      const bx = -body.back_cm + 2.4;
      kit.add(
        kit.cached("ball", () => new THREE.SphereGeometry(1.1, 24, 16)),
        mats.metal,
        P(bx, 0, 1.1),
      );
      kit.box(2.9, 2.9, 1.6, bx, 0, 2.4, mats.dark, 0.5);
      kit.box(1.6, 1.6, 0.8, bx, 0, 3.6, mats.dark, 0.2);
      kit.beam(7, bx + 2.4, 0, 4.0, mats.dark, "z");
      boxes.push(new THREE.Box3(v3(bx - 1.5, -1.5, 0), v3(bx + 5, 1.5, 4.4)));
    }
    hubX = 0;
    hubZ = Rp;
    bodyDir = -1;
    motorY = d.axle_track_cm / 2 - tyreW / 2 - 0.5 - 1.2;
  }

  // the large motors (drive motors are large whatever the ports say: a medium one could not carry the robot),
  // their hubs on the drive's axles, their bodies along the robot
  const motors = sides.map((dr) =>
    largeMotor(
      kit,
      dr.port,
      v3(hubX, dr.out * Math.max(1.4, motorY), hubZ),
      v3(0, dr.out, 0),
      v3(bodyDir, 0, 0),
      v3(0, -1, 0),
    ),
  );
  for (const m of motors) boxes.push(m.box);
  const top = Math.max(look.drive === "tracks" ? hubZ + Rp + 0.5 : D + 0.2, ...motors.map((m) => m.box.max.z));

  return {
    top,
    motors,
    boxes,
    update(tachos) {
      for (const t of treads) t.place((tachos[t.port] ?? 0) * cmPerDeg);
      for (const sp of spinners) sp.obj.rotation.z = -((tachos[sp.port] ?? 0) * cmPerDeg) / Rp;
      for (const m of motors) m.turn((tachos[m.port] ?? 0) * sign);
    },
  };
}

/** One wide tread link in its own frame: x along the travel, y toward the sprocket (in), z across the track.
 *  A plate with a bar across its outer face and two guide lugs on its inner face, the sprocket's teeth between. */
function treadLinkGeometry(pitch: number): THREE.BufferGeometry {
  const parts = [
    new RoundedBoxGeometry(pitch * 0.9, LINK_T, TRACK_W, 1, 0.08),
    new THREE.BoxGeometry(pitch * 0.36, GROUSER, TRACK_W * 0.94).translate(0, -LINK_T / 2 - GROUSER / 2 + 0.02, 0),
    new THREE.BoxGeometry(pitch * 0.5, 0.34, 0.45).translate(0, LINK_T / 2 + 0.15, 1.05),
    new THREE.BoxGeometry(pitch * 0.5, 0.34, 0.45).translate(0, LINK_T / 2 + 0.15, -1.05),
  ].map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of parts)
    for (const n of Object.keys(g.attributes)) if (n !== "position" && n !== "normal") g.deleteAttribute(n);
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  if (!merged) throw new Error("the tread link did not merge");
  // the plate's centre is the pitch line; it sits just outside it, so the teeth bite between the lugs
  merged.translate(0, -LINK_T / 2 - 0.06, 0);
  return merged;
}

/** A ten-tooth sprocket whose teeth reach just past the links' pitch line, five round holes, the axle's cross. */
function sprocketGeometry(Rp: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const teeth = 10,
    ro = Rp + 0.12,
    rr = Rp - 0.3;
  for (let i = 0; i <= teeth * 4; i++) {
    const a = (i / (teeth * 4)) * Math.PI * 2;
    const r = i % 4 === 1 || i % 4 === 2 ? ro : rr;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const h = new THREE.Path();
    h.absarc(Math.cos(a) * Rp * 0.55, Math.sin(a) * Rp * 0.55, Math.min(0.3, Rp * 0.17), 0, Math.PI * 2, true);
    s.holes.push(h);
  }
  const cross = new THREE.Path();
  const c = 0.24,
    w = 0.09;
  cross.moveTo(w, c);
  for (const [x, y] of [
    [-w, c],
    [-w, w],
    [-c, w],
    [-c, -w],
    [-w, -w],
    [-w, -c],
    [w, -c],
    [w, -w],
    [c, -w],
    [c, w],
    [w, w],
  ] as const)
    cross.lineTo(x, y);
  s.holes.push(cross);
  const depth = TRACK_W - 1.5;
  const g = new THREE.ExtrudeGeometry(s, {
    depth: depth - 0.1,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 1,
    curveSegments: 12,
  });
  g.translate(0, 0, -(depth - 0.1) / 2);
  return g;
}

/** A 56 mm tyre: a lathe of its section, with grooves round it. Axis across the robot (three Z). */
function tyreGeometry(R: number, w: number): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const ri = R * 0.62,
    hw = w / 2;
  pts.push(new THREE.Vector2(ri, -hw));
  pts.push(new THREE.Vector2(R - 0.35, -hw));
  for (let i = 0; i <= 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(R - 0.35 + 0.35 * Math.cos(a), -hw + 0.35 + 0.35 * Math.sin(a)));
  }
  for (const z of [-0.45, 0.45]) {
    pts.push(new THREE.Vector2(R, z - 0.12));
    pts.push(new THREE.Vector2(R - 0.12, z - 0.08));
    pts.push(new THREE.Vector2(R - 0.12, z + 0.08));
    pts.push(new THREE.Vector2(R, z + 0.12));
  }
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(R - 0.35 + 0.35 * Math.cos(a), hw - 0.35 + 0.35 * Math.sin(a)));
  }
  pts.push(new THREE.Vector2(ri, hw));
  const g = new THREE.LatheGeometry(pts, 48);
  g.rotateX(Math.PI / 2);
  return g;
}

/** A rim with six round holes, its hub standing out. Axis across the robot (three Z). */
function rimGeometry(r: number, w: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.absarc(0, 0, r, 0, Math.PI * 2, false);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const h = new THREE.Path();
    h.absarc(Math.cos(a) * r * 0.62, Math.sin(a) * r * 0.62, r * 0.2, 0, Math.PI * 2, true);
    s.holes.push(h);
  }
  const g = new THREE.ExtrudeGeometry(s, {
    depth: w - 0.2,
    bevelEnabled: true,
    bevelThickness: 0.1,
    bevelSize: 0.08,
    bevelSegments: 2,
    curveSegments: 24,
  });
  g.translate(0, 0, -(w - 0.2) / 2);
  return g;
}
