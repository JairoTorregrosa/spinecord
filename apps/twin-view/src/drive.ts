// What drives the robot: two EV3 large motors (45502) and, on their hubs, tracks or wheels, every size from the LEGO
// parts map (dims.ts).
//
// Tracks, the two kinds the EV3 sets have:
//   rubber  the home set's (31313): a rubber band 53992, 2.0 wide and 3.2 mm thick, round two rims 56145 (Ø 3.04)
//           a fixed 9.6 cm apart, the rear one on the motor's hub (TRACK3R). 3.68 cm tall over the rims.
//   links   the Education set's (45544): wide links 88323 (3.84 across, a pitch of 1.36) round ten-tooth sprockets
//           57519; one link per tooth, so the links travel exactly as the teeth do; 5.52 cm rolling Ø. As many
//           links as the body is long.
// Wheels: the real tyre on its rim nearest the profile's diameter, a steel ball 99948 (Ø 1.8) in its receptacle
// at the back.
// Either way the drive is centred on the drive axle (x = 0), where the twin turns.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Look } from "./look";
import type { RobotMeta } from "./messages";
import { CASTER, MOTOR, MODULE, TRACKS, wheelFor } from "./dims";
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

const LK = TRACKS.links,
  RB = TRACKS.rubber;
/** Between a wheel or a track and the motor beside it: a bush on the axle (half a module). */
const GAP = MODULE / 2;
/** Half the large motor's width. */
const MOTOR_HALF = (MOTOR.large.max[1] - MOTOR.large.min[1]) / 2;

export function buildDrive(kit: Kit, meta: RobotMeta, look: Look): Drive {
  const { mats, keep, group } = kit;
  const body = meta.world.body;
  const d = meta.drivetrain;
  if (look.drive === "none" || !d) return { top: 0, motors: [], boxes: [], update() {} };
  const D = d.wheel_diameter_cm;
  const sign = d.forward_sign;
  const sides = [
    { port: d.left, y: d.axle_track_cm / 2, out: 1 },
    { port: d.right, y: -d.axle_track_cm / 2, out: -1 },
  ];
  const spinners: { port: string; obj: THREE.Object3D }[] = [];
  const treads: { port: string; place: (travel: number) => void }[] = [];
  const boxes: THREE.Box3[] = [];
  // the twin moves by the profile's diameter: the drawn parts follow the distance it travels
  const cmPerDeg = (sign * Math.PI * D) / 360;
  let wheelR = D / 2;
  const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  let hubX: number, hubZ: number, bodyDir: number, motorY: number;
  let caster: { x: number; top: number } | null = null;
  if (look.drive === "tracks") {
    // the loop the tread runs on: two circles of radius `r` (its pitch line) `span` apart, centred on x = 0
    let r: number, span: number, zc: number, width: number;
    let unit: THREE.BufferGeometry, count: number, pitch: number;
    let wheelGeo: THREE.BufferGeometry, wheelMat: THREE.Material;
    if (look.track === "rubber") {
      r = RB.rim / 2 + RB.thick / 2;
      span = RB.rimsApart;
      zc = RB.d / 2;
      width = RB.w;
      wheelR = RB.d / 2;
      // the band, and its ridges as the moving units
      count = RB.ridges;
      pitch = (2 * span + 2 * Math.PI * r) / count;
      unit = keep(ridgeGeometry(pitch));
      wheelGeo = kit.cached("rim 56145", () => rimGeometry(RB.rim / 2, RB.rimW, 6));
      wheelMat = mats.black;
      for (const dr of sides)
        kit.add(
          kit.cached("band", () => bandGeometry(RB.rim / 2, RB.d / 2, span, RB.w)),
          mats.rubber,
          P(0, dr.y, zc),
        );
    } else {
      pitch = LK.pitch;
      r = (LK.teeth * pitch) / (2 * Math.PI);
      zc = LK.d / 2;
      width = LK.w;
      wheelR = LK.d / 2;
      // as many links as fit the shorter end of the body from the axle, at least two sprockets' worth
      const half = Math.max(r + 1, Math.min(body.front_cm, body.back_cm) - LK.d / 2 - 0.3);
      count = Math.max(14, Math.round((2 * (2 * half) + 2 * Math.PI * r) / pitch / 2) * 2);
      span = (count * pitch - 2 * Math.PI * r) / 2;
      unit = keep(treadLinkGeometry(pitch, r));
      wheelGeo = kit.cached("sprocket 57519", () => sprocketGeometry(r));
      wheelMat = mats.light;
    }
    const xf = span / 2,
      xr = -span / 2;
    const per = 2 * span + 2 * Math.PI * r;
    const q = new THREE.Quaternion(),
      zAxis = v3(0, 0, 1),
      one = v3(1, 1, 1),
      v = v3(0, 0, 0),
      m4 = new THREE.Matrix4();
    for (const dr of sides) {
      const mesh = kit.live(new THREE.InstancedMesh(unit, mats.rubber, count));
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false; // the instances move; the geometry's own bounds are one unit's
      group.add(mesh);
      const lateral = -dr.y;
      const at = (s: number): THREE.Matrix4 => {
        s = ((s % per) + per) % per;
        let x: number, z: number, phi: number;
        if (s < span) [x, z, phi] = [xr + s, zc - r, 0];
        else if ((s -= span) < Math.PI * r) {
          const a = -Math.PI / 2 + s / r;
          [x, z, phi] = [xf + r * Math.cos(a), zc + r * Math.sin(a), a + Math.PI / 2];
        } else if ((s -= Math.PI * r) < span) [x, z, phi] = [xf - s, zc + r, Math.PI];
        else {
          const a = Math.PI / 2 + (s - span) / r;
          [x, z, phi] = [xr + r * Math.cos(a), zc + r * Math.sin(a), a + Math.PI / 2];
        }
        q.setFromAxisAngle(zAxis, phi);
        return m4.compose(v.set(x, z, lateral), q, one);
      };
      const place = (travel: number) => {
        for (let i = 0; i < count; i++) mesh.setMatrixAt(i, at(i * pitch - travel));
        mesh.instanceMatrix.needsUpdate = true;
      };
      place(0);
      treads.push({ port: dr.port, place });
      for (const sx of [xr, xf]) {
        const wheel = kit.live(new THREE.Group());
        wheel.position.copy(P(sx, dr.y, zc));
        group.add(wheel);
        kit.add(wheelGeo, wheelMat, v3(0, 0, 0), wheel);
        spinners.push({ port: dr.port, obj: wheel });
        // the axle through it, and a red bush holding it on the outside
        kit.axleCyl(0.24, width + 2 * MODULE, sx, dr.y - (dr.out * MODULE) / 2, zc, mats.dark, group, 12);
        kit.axleCyl(0.42, GAP, sx, dr.y + dr.out * (width / 2 + GAP / 2), zc, mats.red, group, 16);
      }
      // the beam inside the track that holds both axles, a module in from the track
      const holes = Math.round(span / MODULE) + 3;
      kit.beam(holes, 0, dr.y - dr.out * (width / 2 + GAP + MODULE / 2), zc, mats.dark);
      const yIn = dr.y - dr.out * (width / 2 + GAP + MODULE),
        yOut = dr.y + dr.out * (width / 2 + GAP);
      boxes.push(new THREE.Box3(v3(xr - zc, Math.min(yIn, yOut), 0), v3(xf + zc, Math.max(yIn, yOut), 2 * zc)));
    }
    // the motor drives the rear wheel; its body runs ahead along the inside of the track
    hubX = xr;
    hubZ = zc;
    bodyDir = 1;
    motorY = d.axle_track_cm / 2 - width / 2 - GAP - MODULE - MOTOR_HALF;
  } else {
    // the real wheel nearest the profile's diameter; it turns so its tread keeps pace with the floor
    const real = wheelFor(D);
    const tyreR = real.d / 2;
    wheelR = tyreR;
    const tyre = kit.cached(`tyre ${real.part}`, () => tyreGeometry(tyreR, real.w, real.rim / 2));
    const rim = kit.cached(`rim ${real.rimPart}`, () => rimGeometry(real.rim / 2, real.w - 0.2, 6));
    for (const dr of sides) {
      const wheel = kit.live(new THREE.Group());
      wheel.position.copy(P(0, dr.y, tyreR));
      group.add(wheel);
      kit.add(tyre, mats.rubber, v3(0, 0, 0), wheel);
      kit.add(rim, mats.light, v3(0, 0, 0), wheel);
      spinners.push({ port: dr.port, obj: wheel });
      boxes.push(new THREE.Box3(v3(-tyreR, dr.y - real.w / 2 - 0.3, 0), v3(tyreR, dr.y + real.w / 2 + 0.3, 2 * tyreR)));
    }
    hubX = 0;
    hubZ = tyreR;
    bodyDir = -1;
    motorY = d.axle_track_cm / 2 - real.w / 2 - GAP - MOTOR_HALF;
    if (look.caster) {
      // the ball caster at the back: the steel ball in its receptacle, a beam up to the frame
      const bx = -body.back_cm + CASTER.socket.d / 2 + 0.6;
      const rb = CASTER.ball / 2;
      kit.add(
        kit.cached("ball", () => new THREE.SphereGeometry(rb, 24, 16)),
        mats.metal,
        P(bx, 0, rb),
      );
      const top = rb + CASTER.socket.w * 0.75;
      kit.add(
        kit.cached(
          "ball socket",
          () => new THREE.CylinderGeometry(CASTER.socket.d / 2, CASTER.socket.d / 2, top - rb * 0.9, 20),
        ),
        mats.dark,
        P(bx, 0, (top + rb * 0.9) / 2),
      );
      boxes.push(new THREE.Box3(v3(bx - 1.3, -1.3, 0), v3(bx + 1.3, 1.3, top)));
      caster = { x: bx, top };
    }
  }

  // the large motors (drive motors are large whatever the ports say: a medium one could not carry the robot),
  // their hubs on the drive's axles, their bodies along the robot
  const motors = sides.map((dr) =>
    largeMotor(
      kit,
      dr.port,
      v3(hubX, dr.out * Math.max(MOTOR_HALF, motorY), hubZ),
      v3(0, dr.out, 0),
      v3(bodyDir, 0, 0),
      v3(0, -1, 0),
    ),
  );
  for (const m of motors) boxes.push(m.box);
  const top = Math.max(look.drive === "tracks" ? 2 * hubZ : 2 * hubZ + 0.2, ...motors.map((m) => m.box.max.z));
  // the caster's post: a beam from its receptacle up to the frame under the brick
  if (caster) {
    const n = Math.max(2, Math.round((top - caster.top) / MODULE) + 1);
    kit.beam(n, caster.x, 0, caster.top + ((n - 1) * MODULE) / 2, mats.dark, "y").rotation.z = Math.PI / 2;
  }

  return {
    top,
    motors,
    boxes,
    update(tachos) {
      for (const t of treads) t.place((tachos[t.port] ?? 0) * cmPerDeg);
      for (const sp of spinners) sp.obj.rotation.z = -((tachos[sp.port] ?? 0) * cmPerDeg) / wheelR;
      for (const m of motors) m.turn((tachos[m.port] ?? 0) * sign);
    },
  };
}
/** One wide tread link (88323) in its own frame: x along the travel, y toward the sprocket (in), z across. A plate
 *  with a bar across its outer face and two guide lugs on its inner face, the sprocket's teeth between; the plate
 *  sits outside the pitch line, its outer face at the rolling radius. */
function treadLinkGeometry(pitch: number, r: number): THREE.BufferGeometry {
  const outer = LK.d / 2 - r; // pitch line to the outer face
  const plate = outer * 0.55,
    bar = outer - plate;
  const parts = [
    new RoundedBoxGeometry(pitch * 0.92, plate, LK.w, 1, 0.06).translate(0, -plate / 2, 0),
    new THREE.BoxGeometry(pitch * 0.36, bar, LK.w * 0.94).translate(0, -plate - bar / 2, 0),
    new THREE.BoxGeometry(pitch * 0.5, 0.34, 0.45).translate(0, 0.15, 1.05),
    new THREE.BoxGeometry(pitch * 0.5, 0.34, 0.45).translate(0, 0.15, -1.05),
  ].map((g) => (g.index ? g.toNonIndexed() : g));
  return mergeClean(parts);
}

/** One ridge of the rubber track, on the band's outer face (the band's pitch line through its middle). */
function ridgeGeometry(pitch: number): THREE.BufferGeometry {
  return mergeClean([
    new THREE.BoxGeometry(pitch * 0.42, RB.thick * 0.8, RB.w * 0.92).translate(0, -RB.thick * 0.85, 0).toNonIndexed(),
  ]);
}

function mergeClean(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  for (const g of parts)
    for (const n of Object.keys(g.attributes)) if (n !== "position" && n !== "normal") g.deleteAttribute(n);
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  if (!merged) throw new Error("a tread unit did not merge");
  return merged;
}

/** The rubber band round two rims `span` apart: a stadium ring from the rims' radius out, `w` wide. */
function bandGeometry(rin: number, rout: number, span: number, w: number): THREE.BufferGeometry {
  const stadium = (r: number, path: THREE.Path) => {
    path.absarc(span / 2, 0, r, -Math.PI / 2, Math.PI / 2, false);
    path.absarc(-span / 2, 0, r, Math.PI / 2, (3 * Math.PI) / 2, false);
    return path;
  };
  const s = stadium(rout - 0.12, new THREE.Shape()) as THREE.Shape;
  s.holes.push(stadium(rin, new THREE.Path()));
  const g = new THREE.ExtrudeGeometry(s, {
    depth: w - 0.24,
    bevelEnabled: true,
    bevelThickness: 0.12,
    bevelSize: 0.12,
    bevelSegments: 1,
    curveSegments: 20,
  });
  g.translate(0, 0, -(w - 0.24) / 2);
  return g;
}

/** A ten-tooth sprocket (57519) whose teeth reach just past the links' pitch line, five round holes, the axle's
 *  cross. As wide as the map says. */
function sprocketGeometry(Rp: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const teeth = LK.teeth,
    ro = LK.sprocket / 2,
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
  s.holes.push(crossHole());
  const depth = LK.sprocketW;
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

function crossHole(): THREE.Path {
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
  return cross;
}

/** A tyre: a lathe of its section, with grooves round it, on a rim of radius `ri`. Axis across the robot. */
function tyreGeometry(R: number, w: number, ri: number): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const hw = w / 2;
  const k = Math.min(0.35, (R - ri) / 2);
  pts.push(new THREE.Vector2(ri, -hw));
  pts.push(new THREE.Vector2(R - k, -hw));
  for (let i = 0; i <= 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(R - k + k * Math.cos(a), -hw + k + k * Math.sin(a)));
  }
  for (const z of [-hw / 3, hw / 3]) {
    pts.push(new THREE.Vector2(R, z - 0.12));
    pts.push(new THREE.Vector2(R - 0.12, z - 0.08));
    pts.push(new THREE.Vector2(R - 0.12, z + 0.08));
    pts.push(new THREE.Vector2(R, z + 0.12));
  }
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(R - k + k * Math.cos(a), hw - k + k * Math.sin(a)));
  }
  pts.push(new THREE.Vector2(ri, hw));
  const g = new THREE.LatheGeometry(pts, 48);
  g.rotateX(Math.PI / 2);
  return g;
}

/** A rim with `n` round holes and an axle's cross at its centre. Axis across the robot (three Z). */
function rimGeometry(r: number, w: number, n: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.absarc(0, 0, r, 0, Math.PI * 2, false);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const h = new THREE.Path();
    h.absarc(Math.cos(a) * r * 0.62, Math.sin(a) * r * 0.62, r * 0.2, 0, Math.PI * 2, true);
    s.holes.push(h);
  }
  s.holes.push(crossHole());
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
