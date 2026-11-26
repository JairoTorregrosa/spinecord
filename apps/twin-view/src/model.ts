// The 3D body of a twin: an EV3 brick on two large motors, tracks or wheels, its sensors where the look puts them,
// and what the look adds (a phone, a bumper, a label). Built from cm; every moving part follows the twin's state:
// tread links and sprockets from the drive motors' tachos, motor hubs from every tacho, the touch plunger, the
// colour sensor's light, the ultrasonic eye, the brick's LED and screen.
//
// Robot frame: x ahead, y to the left, z up. three.js inside the robot group: X ahead, Y up, Z to the right.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Look } from "./look";
import type { RobotMeta, RobotState } from "./messages";

/** A point of the robot frame (x ahead, y left, z up) in the group's three.js frame. */
export const P = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, z, -y);

const COL = {
  white: 0xf4f4f1,
  light: 0xc7c9cb,
  mid: 0x8c9196,
  dark: 0x3a3e43,
  black: 0x1a1b1d,
  red: 0xd3201a,
  rubber: 0x151515,
  glass: 0x07090c,
};
const LED_RGB = [0x000000, 0x1fe05a, 0xff2a1f, 0xff9a1a];
const LCD_W = 178,
  LCD_H = 128;

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

function plastic(color: number, rough = 0.55): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.02 });
}

export function buildRobot(meta: RobotMeta, look: Look): RobotModel {
  const group = new THREE.Group();
  group.name = `robot ${meta.id}`;
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => (disposables.push(x), x);
  const mats = {
    white: keep(plastic(COL.white)),
    light: keep(plastic(COL.light)),
    mid: keep(plastic(COL.mid)),
    dark: keep(plastic(COL.dark, 0.6)),
    black: keep(plastic(COL.black, 0.5)),
    red: keep(plastic(COL.red, 0.45)),
    rubber: keep(plastic(COL.rubber, 0.9)),
    metal: keep(new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.3, metalness: 0.8 })),
  };
  /** A box of size lx (ahead) × ly (across) × lz (up) centred at (x, y, z) of the robot frame. */
  const box = (
    lx: number,
    ly: number,
    lz: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
    radius = 0,
    parent: THREE.Object3D = group,
  ): THREE.Mesh => {
    const g = keep(
      radius > 0
        ? new RoundedBoxGeometry(lx, lz, ly, 3, Math.min(radius, lx / 2, ly / 2, lz / 2))
        : new THREE.BoxGeometry(lx, lz, ly),
    );
    const m = new THREE.Mesh(g, mat);
    m.position.copy(P(x, y, z));
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  /** A disc or cylinder whose axis runs across the robot (y), centred at (x, y, z). */
  const axleCyl = (
    r: number,
    width: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
    parent: THREE.Object3D = group,
    segments = 28,
  ): THREE.Mesh => {
    const g = keep(new THREE.CylinderGeometry(r, r, width, segments));
    g.rotateX(Math.PI / 2); // axis along three Z (across the robot)
    const m = new THREE.Mesh(g, mat);
    m.position.copy(P(x, y, z));
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  const body = meta.world.body;
  const d = meta.drivetrain;
  const D = d?.wheel_diameter_cm ?? 5.6;
  const r = D / 2;
  const track = d?.axle_track_cm ?? 2 * body.half_width_cm - 2;
  const side = track / 2;
  const sign = d?.forward_sign ?? 1;
  const leftPort = d?.left ?? "B",
    rightPort = d?.right ?? "C";

  // ---------------------------------------------------------------- drive: tracks or wheels
  interface Drive {
    port: string;
    y: number;
  }
  const drives: Drive[] = [
    { port: leftPort, y: side },
    { port: rightPort, y: -side },
  ];
  const spinners: { port: string; obj: THREE.Object3D; radius: number }[] = [];
  const treads: { port: string; mesh: THREE.InstancedMesh; place: (travel: number) => void }[] = [];
  let driveTop = 0,
    axleZ = r;
  const TREAD = 0.45,
    TRACK_W = 2.6;
  const Ls = Math.min(22, Math.max(8, (body.front_cm + body.back_cm) * 0.62));
  if (look.drive === "tracks") {
    const zc = r + TREAD,
      R = r + TREAD / 2;
    axleZ = zc;
    driveTop = zc + r + TREAD;
    const per = 2 * Ls + 2 * Math.PI * R;
    const N = Math.max(12, Math.round(per / 1.55));
    const step = per / N;
    const plate = new THREE.BoxGeometry(step * 0.84, TREAD, TRACK_W);
    const ridge = new THREE.BoxGeometry(step * 0.3, 0.32, TRACK_W * 0.92);
    ridge.translate(0, -TREAD / 2 - 0.14, 0);
    const linkGeo = keep(mergeGeometries([plate, ridge])!);
    plate.dispose();
    ridge.dispose();
    const q = new THREE.Quaternion(),
      zAxis = new THREE.Vector3(0, 0, 1),
      one = new THREE.Vector3(1, 1, 1);
    for (const dr of drives) {
      const lateral = -dr.y; // three Z
      const mesh = new THREE.InstancedMesh(linkGeo, mats.rubber, N);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      const m4 = new THREE.Matrix4();
      const at = (s: number): THREE.Matrix4 => {
        s = ((s % per) + per) % per;
        let x: number, z: number, phi: number;
        if (s < Ls) [x, z, phi] = [-Ls / 2 + s, zc - R, 0];
        else if ((s -= Ls) < Math.PI * R) {
          const a = -Math.PI / 2 + s / R;
          [x, z, phi] = [Ls / 2 + R * Math.cos(a), zc + R * Math.sin(a), a + Math.PI / 2];
        } else if ((s -= Math.PI * R) < Ls) [x, z, phi] = [Ls / 2 - s, zc + R, Math.PI];
        else {
          const a = Math.PI / 2 + (s - Ls) / R;
          [x, z, phi] = [-Ls / 2 + R * Math.cos(a), zc + R * Math.sin(a), a + Math.PI / 2];
        }
        q.setFromAxisAngle(zAxis, phi);
        return m4.compose(new THREE.Vector3(x, z, lateral), q, one);
      };
      const place = (travel: number) => {
        for (let i = 0; i < N; i++) mesh.setMatrixAt(i, at(i * step - travel));
        mesh.instanceMatrix.needsUpdate = true;
      };
      place(0);
      treads.push({ port: dr.port, mesh, place });
      // sprockets and the idler, with a cross so their turning shows
      for (const sx of [-Ls / 2, 0, Ls / 2]) {
        const wheel = new THREE.Group();
        wheel.position.copy(P(sx, dr.y, zc));
        group.add(wheel);
        axleCyl(sx === 0 ? r * 0.82 : r, TRACK_W - 0.5, 0, 0, 0, mats.dark, wheel);
        const out = dr.y > 0 ? 1 : -1;
        box(r * 1.6, 0.12, 0.38, 0, out * (TRACK_W / 2 - 0.2), 0, mats.mid, 0, wheel);
        box(0.38, 0.12, r * 1.6, 0, out * (TRACK_W / 2 - 0.2), 0, mats.mid, 0, wheel);
        spinners.push({ port: dr.port, obj: wheel, radius: R });
      }
      // the black frame that holds the wheels, outside the tread
      const out = dr.y > 0 ? 1 : -1;
      box(Ls + 1, 0.7, 1.1, 0, dr.y + out * (TRACK_W / 2 + 0.45), zc, mats.black, 0.2);
      for (const sx of [-Ls / 2, 0, Ls / 2]) axleCyl(0.32, 0.25, sx, dr.y + out * (TRACK_W / 2 + 0.85), zc, mats.red);
    }
  } else {
    axleZ = r;
    driveTop = D;
    for (const dr of drives) {
      const wheel = new THREE.Group();
      wheel.position.copy(P(0, dr.y, r));
      group.add(wheel);
      axleCyl(r, 2.3, 0, 0, 0, mats.rubber, wheel, 36);
      const out = dr.y > 0 ? 1 : -1;
      axleCyl(r * 0.62, 2.35, 0, 0, 0, mats.light, wheel);
      box(r * 1.15, 0.1, 0.5, 0, out * 1.2, 0, mats.mid, 0, wheel);
      box(0.5, 0.1, r * 1.15, 0, out * 1.2, 0, mats.mid, 0, wheel);
      spinners.push({ port: dr.port, obj: wheel, radius: r });
    }
    // a steel ball at the back
    const ball = new THREE.Mesh(keep(new THREE.SphereGeometry(1.1, 20, 14)), mats.metal);
    ball.position.copy(P(-body.back_cm + 2.4, 0, 1.1));
    ball.castShadow = true;
    group.add(ball);
    box(2.8, 2.8, 2.2, -body.back_cm + 2.4, 0, 2.6, mats.black, 0.3);
  }

  // ---------------------------------------------------------------- motors
  const hubs: { port: string; obj: THREE.Object3D }[] = [];
  const hub = (port: string, x: number, y: number, z: number, out: number) => {
    const g = new THREE.Group();
    g.position.copy(P(x, y, z));
    group.add(g);
    axleCyl(1.05, 0.3, 0, 0, 0, mats.red, g);
    box(1.2, 0.08, 0.28, 0, out * 0.17, 0, mats.black, 0, g);
    box(0.28, 0.08, 1.2, 0, out * 0.17, 0, mats.black, 0, g);
    hubs.push({ port, obj: g });
  };
  const motorZ = look.drive === "tracks" ? axleZ + 1.3 : r + 0.7;
  const motorX = look.drive === "tracks" ? -0.6 : -2.8;
  const motorY = side - (look.drive === "tracks" ? TRACK_W / 2 + 1.6 : 2.6);
  for (const dr of drives) {
    const out = dr.y > 0 ? 1 : -1;
    const y = out * Math.max(1.4, motorY);
    box(10.8, 2.5, 2.8, motorX, y, motorZ - 0.7, mats.light, 0.6);
    box(10.4, 2.4, 1.5, motorX, y, motorZ + 1.3, mats.white, 0.6);
    box(3.6, 2.6, 2.6, motorX + 4.4, y, motorZ - 1.5, mats.light, 0.9);
    const hx = look.drive === "tracks" ? -Ls / 2 : 0;
    hub(dr.port, hx, y + out * 1.4, axleZ, out);
  }
  const motorTop = motorZ + 2.05;

  // ---------------------------------------------------------------- brick
  const BL = 11.6,
    BW = 8.4,
    BH = 4.4;
  const brickZ = Math.max(motorTop + 0.35, driveTop * 0.6, 4);
  const brick = new THREE.Group();
  brick.position.copy(P(look.brick.x, 0, brickZ));
  if (look.brick.screen === "back") brick.rotation.y = Math.PI;
  group.add(brick);
  // inside `brick`: x toward the screen end (ports A-D), the bottom at z = 0
  box(BL, BW, BH * 0.56, 0, 0, BH * 0.28, mats.light, 0.5, brick);
  box(BL - 0.1, BW - 0.1, BH * 0.5, 0, 0, BH * 0.72, mats.white, 0.55, brick);
  box(BL + 0.06, BW + 0.06, 0.34, 0, 0, BH * 0.5, mats.dark, 0.1, brick);
  // top face: the print
  const topTex = keep(brickTopTexture());
  const top = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(BL - 0.6, BW - 0.6)),
    keep(new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.6, transparent: true })),
  );
  top.rotation.x = -Math.PI / 2;
  top.position.copy(P(0, 0, BH + 0.012));
  brick.add(top);
  // the screen
  box(3.7, 5.3, 0.1, BL / 2 - 3.0, 0, BH + 0.03, mats.dark, 0, brick);
  const lcdCanvas = document.createElement("canvas");
  lcdCanvas.width = LCD_W * 2;
  lcdCanvas.height = LCD_H * 2;
  const lcdTex = keep(new THREE.CanvasTexture(lcdCanvas));
  lcdTex.colorSpace = THREE.SRGBColorSpace;
  const lcd = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(4.5, 3.15)),
    keep(
      new THREE.MeshStandardMaterial({
        map: lcdTex,
        roughness: 0.35,
        emissive: 0x9aa68f,
        emissiveMap: lcdTex,
        emissiveIntensity: 0.35,
      }),
    ),
  );
  lcd.rotation.x = -Math.PI / 2;
  lcd.rotation.z = -Math.PI / 2; // its width runs across the brick
  lcd.position.copy(P(BL / 2 - 3.0, 0, BH + 0.09));
  brick.add(lcd);
  // buttons around the LED
  const cx = -1.15;
  const ledMat = keep(new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0x000000, roughness: 0.4 }));
  box(3.9, 4.4, 0.06, cx, 0, BH + 0.04, ledMat, 0.4, brick);
  const btnMats = new Map<number, THREE.MeshStandardMaterial>();
  const button = (id: number, lx: number, ly: number, x: number, y: number, color: number) => {
    const m = keep(new THREE.MeshStandardMaterial({ color, roughness: 0.45, emissive: 0x000000 }));
    btnMats.set(id, m);
    box(lx, ly, 0.3, x, y, BH + 0.2, m, 0.12, brick);
  };
  button(2, 1.15, 1.15, cx, 0, COL.dark); // enter
  button(1, 0.85, 1.6, cx + 1.25, 0, COL.light); // up
  button(3, 0.85, 1.6, cx - 1.25, 0, COL.light); // down
  button(5, 1.6, 0.85, cx, 1.35, COL.light); // left
  button(4, 1.6, 0.85, cx, -1.35, COL.light); // right
  button(6, 0.9, 1.1, cx + 1.3, 2.75, COL.mid); // back
  // ports: A-D at the screen end, 1-4 at the other
  const portY = (i: number) => BW / 2 - 1.35 - i * ((BW - 2.7) / 3);
  for (let i = 0; i < 4; i++) {
    box(0.12, 1.25, 0.85, BL / 2 + 0.03, portY(i), 1.45, mats.black, 0, brick);
    box(0.12, 1.25, 0.85, -BL / 2 - 0.03, portY(i), 1.45, mats.black, 0, brick);
  }
  const brickTop = brickZ + BH;
  // black beams under the brick, on the motors
  for (const y of [BW / 2 - 0.5, -BW / 2 + 0.5])
    box(BL + 2.4, 0.8, 0.8, look.brick.x, y, brickZ - 0.4, mats.black, 0.2);
  for (const x of [look.brick.x - 4.5, look.brick.x + 4.5])
    box(0.8, track - 1, 0.8, x, 0, brickZ - 0.4, mats.black, 0.2);
  /** Where sensor port `p` (1..4) is, robot frame. */
  const sensorPortAt = (p: number): THREE.Vector3 => {
    const flip = look.brick.screen === "back" ? -1 : 1;
    return new THREE.Vector3(look.brick.x - flip * (BL / 2 + 0.1), flip * portY(p - 1), brickZ + 1.45);
  };

  // ---------------------------------------------------------------- the medium motor and other motors
  for (const [port, type] of Object.entries(meta.ports.motors)) {
    if (port === leftPort || port === rightPort) continue;
    const x = Math.min(body.front_cm - 3, look.brick.x + BL / 2 + 1.5);
    const z = brickTop + 1.8;
    if (type === "medium") {
      box(4.2, 4.8, 3.2, x - 1, 0, z, mats.light, 0.6);
      box(3.6, 4.4, 0.9, x - 1, 0, z + 1.9, mats.white, 0.4);
    } else box(6, 2.5, 3.5, x - 2, 0, z, mats.light, 0.6);
    const g = new THREE.Group();
    g.position.copy(P(x + 1.25, 0, z));
    g.rotation.y = Math.PI / 2; // the hub faces ahead
    group.add(g);
    axleCyl(1.0, 0.3, 0, 0, 0, mats.red, g);
    box(1.15, 0.08, 0.26, 0, 0.17, 0, mats.black, 0, g);
    box(0.26, 0.08, 1.15, 0, 0.17, 0, mats.black, 0, g);
    hubs.push({ port, obj: g });
  }

  // ---------------------------------------------------------------- phone
  let height = brickTop + 1;
  let eye = { pos: P(body.front_cm + 0.5, 0, Math.max(6, brickTop)), look: P(body.front_cm + 40, 0, 2) };
  let phoneFace: { tex: THREE.CanvasTexture; ctx: CanvasRenderingContext2D; blink: number } | null = null;
  if (look.phone) {
    const ph = look.phone;
    const T = 0.95,
      W = 14.7,
      H = 7.15;
    const zc = ph.bottom + H / 2;
    const face = ph.screen === "front" ? 1 : -1;
    box(T, W, H, ph.x, 0, zc, keep(plastic(0x1c2127, 0.35)), 0.5);
    // the screen and the case
    const faceCanvas = document.createElement("canvas");
    faceCanvas.width = 512;
    faceCanvas.height = 250;
    const faceTex = keep(new THREE.CanvasTexture(faceCanvas));
    faceTex.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(W - 0.9, H - 0.7)),
      keep(
        new THREE.MeshStandardMaterial({
          map: faceTex,
          emissive: 0xffffff,
          emissiveMap: faceTex,
          emissiveIntensity: 0.8,
          roughness: 0.15,
        }),
      ),
    );
    screen.position.copy(P(ph.x + face * (T / 2 + 0.01), 0, zc));
    screen.rotation.y = face > 0 ? Math.PI / 2 : -Math.PI / 2;
    group.add(screen);
    phoneFace = { tex: faceTex, ctx: faceCanvas.getContext("2d")!, blink: 0 };
    const caseTex = keep(phoneCaseTexture());
    const back = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(W - 0.25, H - 0.25)),
      keep(new THREE.MeshStandardMaterial({ map: caseTex, roughness: 0.3 })),
    );
    back.position.copy(P(ph.x - face * (T / 2 + 0.01), 0, zc));
    back.rotation.y = face > 0 ? -Math.PI / 2 : Math.PI / 2;
    group.add(back);
    // the camera bump on the back, at the top corner on the right
    const bx = ph.x - face * (T / 2 + 0.15);
    box(0.3, 3.4, 3.4, bx, -W / 2 + 2.2, zc + H / 2 - 2.0, keep(plastic(0x9fb4c9, 0.3)), 0.6);
    for (const [ly, lz] of [
      [-W / 2 + 1.5, zc + H / 2 - 1.3],
      [-W / 2 + 2.9, zc + H / 2 - 2.7],
    ] as const) {
      const lens = axleCyl(0.62, 0.5, bx - face * 0.2, ly, lz, mats.black);
      lens.rotation.set(0, Math.PI / 2, 0); // its axis runs ahead
    }
    // the holder: an open frame on the back and two posts down to the brick
    const fx = ph.x - face * (T / 2 + 0.45);
    box(0.8, 5.8, 0.8, fx, 0, zc + 1.7, mats.light, 0.2);
    box(0.8, 5.8, 0.8, fx, 0, zc - 2.2, mats.light, 0.2);
    box(0.8, 0.8, 4.7, fx, 2.5, zc - 0.25, mats.light, 0.2);
    box(0.8, 0.8, 4.7, fx, -2.5, zc - 0.25, mats.light, 0.2);
    for (const y of [3.4, -3.4])
      box(0.8, 0.8, ph.bottom - brickTop + 1, fx, y, (ph.bottom + brickTop) / 2, mats.black, 0.2);
    box(0.8, W - 2, 0.8, ph.x, 0, ph.bottom - 0.4, mats.black, 0.2);
    height = Math.max(height, ph.bottom + H);
    eye = {
      pos: P(ph.x + face * (T / 2 + 0.6), 0, zc + H / 2 - 0.9),
      look: P(ph.x + face * 60, 0, zc - 10),
    };
  }

  // ---------------------------------------------------------------- sensors
  const touchPlungers: { port: string; obj: THREE.Object3D; base: THREE.Vector3 }[] = [];
  const colorLights: {
    port: string;
    lens: THREE.MeshStandardMaterial;
    spot: THREE.Mesh;
    spotMat: THREE.MeshBasicMaterial;
  }[] = [];
  const usEyes: { port: string; mat: THREE.MeshStandardMaterial }[] = [];
  let rayOrigin: THREE.Vector3 | null = null;
  const cable = (from: THREE.Vector3, port: number) => {
    const to = sensorPortAt(port);
    const up = Math.max(from.z, to.z) + 2.5;
    const curve = new THREE.CatmullRomCurve3([
      P(from.x, from.y, from.z),
      P(from.x - 1.5, from.y, up),
      P((from.x + to.x) / 2, (from.y + to.y) / 2, up + 1),
      P(to.x + (to.x > look.brick.x ? 2 : -2), to.y, to.z + 2),
      P(to.x, to.y, to.z),
    ]);
    const m = new THREE.Mesh(keep(new THREE.TubeGeometry(curve, 48, 0.22, 6, false)), mats.black);
    m.castShadow = true;
    group.add(m);
  };
  for (const s of look.sensors) {
    const pn = Number(s.port);
    if (s.kind === "ultrasonic" || s.kind === "ir") {
      const g = new THREE.Group();
      g.position.copy(P(s.x, s.y, s.z));
      group.add(g);
      box(2.4, 4.7, 2.7, -0.2, 0, 0, mats.light, 0.6, g);
      box(2.2, 4.4, 0.7, -0.3, 0, 1.25, mats.white, 0.3, g);
      if (s.kind === "ultrasonic") {
        const glow = keep(
          new THREE.MeshStandardMaterial({
            color: 0x400000,
            emissive: 0xff1a10,
            emissiveIntensity: 0.0,
            roughness: 0.4,
          }),
        );
        usEyes.push({ port: s.port, mat: glow });
        for (const [i, y] of [1.25, -1.25].entries()) {
          const eyeG = new THREE.Group();
          eyeG.position.copy(P(1.1, y, 0));
          g.add(eyeG);
          eyeG.rotation.y = Math.PI / 2; // the eyes look ahead
          axleCyl(0.95, 0.75, 0, 0, 0, mats.black, eyeG);
          axleCyl(0.6, 0.78, 0, 0, 0, i === 0 ? glow : mats.dark, eyeG);
        }
      } else
        box(
          0.4,
          3.8,
          1.6,
          1.05,
          0,
          0,
          keep(new THREE.MeshStandardMaterial({ color: 0x220405, roughness: 0.15 })),
          0.2,
          g,
        );
      rayOrigin = P(s.x + 1.5, s.y, s.z);
      cable(new THREE.Vector3(s.x - 1.4, s.y, s.z), pn);
      height = Math.max(height, s.z + 1.5);
    } else if (s.kind === "color") {
      box(2.2, 1.9, 2.6, s.x, s.y, s.z + 1.0, mats.light, 0.4);
      box(2.0, 1.8, 0.6, s.x, s.y, s.z + 2.3, mats.white, 0.2);
      const lens = keep(
        new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xff2010, emissiveIntensity: 1, roughness: 0.2 }),
      );
      const l = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.55, 0.55, 0.3, 20)), lens);
      l.position.copy(P(s.x, s.y, s.z - 0.35));
      group.add(l);
      const spotMat = keep(
        new THREE.MeshBasicMaterial({
          color: 0xff2010,
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      const spot = new THREE.Mesh(
        keep(new THREE.CircleGeometry(Math.max(0.8, body.color_spot_radius_cm * 1.5), 28)),
        spotMat,
      );
      spot.rotation.x = -Math.PI / 2;
      spot.position.copy(P(body.color_sensor_x_cm, s.y, 0.06));
      group.add(spot);
      colorLights.push({ port: s.port, lens, spot, spotMat });
      cable(new THREE.Vector3(s.x - 1.1, s.y, s.z + 1.6), pn);
    } else if (s.kind === "touch") {
      box(2.8, 1.9, 2.5, s.x - 1.2, s.y, s.z, mats.light, 0.4);
      box(2.6, 1.8, 0.6, s.x - 1.2, s.y, s.z + 1.3, mats.white, 0.2);
      const pl = new THREE.Group();
      pl.position.copy(P(s.x + 0.2, s.y, s.z));
      group.add(pl);
      box(0.9, 0.5, 1.5, 0.45, 0, 0, mats.red, 0.1, pl);
      box(0.9, 1.5, 0.5, 0.45, 0, 0, mats.red, 0.1, pl);
      touchPlungers.push({ port: s.port, obj: pl, base: pl.position.clone() });
      cable(new THREE.Vector3(s.x - 2.6, s.y, s.z), pn);
    } else {
      box(2.4, 2.4, 1.8, s.x, s.y, s.z, mats.light, 0.4);
      box(1.6, 0.3, 0.06, s.x, s.y, s.z + 0.93, mats.red, 0);
      cable(new THREE.Vector3(s.x - 1.2, s.y, s.z), pn);
    }
  }

  // ---------------------------------------------------------------- bumper and label
  if (look.bumper) {
    const bx = look.bumper.x,
      out = bx < 0 ? -1 : 1,
      span = 2 * body.half_width_cm - 2.5;
    box(1.0, span, 1.0, bx, 0, 4.2, mats.black, 0.2);
    for (const y of [span / 2 - 1.6, span / 4, -span / 4, -span / 2 + 1.6]) {
      box(1.6, 1.6, 1.6, bx + out * 1.2, y, 4.2, mats.red, 0.3);
      box(1.6, 1.6, 1.6, bx + out * 1.2, y, 5.8, mats.red, 0.3);
    }
    const ax = axleCyl(0.3, span + 1.2, bx + out * 2.3, 0, 3.0, mats.light);
    ax.castShadow = true;
    for (const y of [span / 2 + 0.4, -span / 2 - 0.4]) {
      const cone = new THREE.Mesh(keep(new THREE.ConeGeometry(0.55, 2.6, 16)), mats.white);
      cone.rotation.z = out > 0 ? -Math.PI / 2 : Math.PI / 2;
      cone.position.copy(P(bx + out * 2.8, y, 3.0));
      cone.castShadow = true;
      group.add(cone);
    }
    for (const y of [span / 2 - 0.6, -span / 2 + 0.6])
      box(Math.abs(bx) - 4, 0.8, 0.8, bx / 2 - out * 1.5, y, 4.2, mats.black, 0.2);
  }
  if (look.label) {
    const tex = keep(labelTexture(look.label));
    const lab = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(2.2, 2.2)),
      keep(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 })),
    );
    lab.position.copy(P(look.brick.x + (look.brick.screen === "front" ? -3.2 : 3.2), BW / 2 + 0.04, brickZ + 1.25));
    lab.rotation.z = 0.06;
    group.add(lab);
  }

  // ---------------------------------------------------------------- state
  let lcdKey = "";
  const drawLcd = (s: RobotState) => {
    const key = `${s.lcd.join("\n")}|${Math.round(s.battery_pct)}|${s.id}`;
    if (key === lcdKey) return;
    lcdKey = key;
    const c = lcdCanvas.getContext("2d")!;
    c.setTransform(2, 0, 0, 2, 0, 0);
    c.fillStyle = "#c3ccb6";
    c.fillRect(0, 0, LCD_W, LCD_H);
    c.fillStyle = "#151a12";
    c.font = "bold 10px ui-monospace, Menlo, Consolas, monospace";
    c.textBaseline = "top";
    c.fillText(s.id.slice(0, 18), 4, 3);
    // the battery at the top right
    c.strokeStyle = "#151a12";
    c.lineWidth = 1;
    c.strokeRect(LCD_W - 26, 3, 20, 9);
    c.fillRect(LCD_W - 6, 5.5, 2, 4);
    c.fillRect(LCD_W - 24, 5, (16 * Math.max(0, Math.min(100, s.battery_pct))) / 100, 5);
    c.fillRect(0, 15, LCD_W, 1);
    // the brick takes 10 lines of 22 characters; few lines are drawn larger so they read from afar
    const lines = s.lcd.length ? s.lcd.slice(0, 10) : ["spinecord", "", "listo"];
    const size = lines.length <= 4 ? 17 : lines.length <= 6 ? 14 : 10;
    c.font = `bold ${size}px ui-monospace, Menlo, Consolas, monospace`;
    lines.forEach((t, i) => c.fillText(t.slice(0, 22), 5, 21 + i * (size + 2)));
    lcdTex.needsUpdate = true;
  };
  const drawFace = (timeS: number, busy: boolean) => {
    if (!phoneFace) return;
    const { ctx } = phoneFace;
    const blink = timeS % 4.2 > 4.05;
    const key = blink ? 1 : busy ? 2 : 3;
    if (key === phoneFace.blink) return;
    phoneFace.blink = key;
    ctx.fillStyle = "#0a0f16";
    ctx.fillRect(0, 0, 512, 250);
    ctx.fillStyle = busy ? "#7ee0ff" : "#c9f1ff";
    for (const x of [175, 337]) {
      ctx.beginPath();
      if (blink) ctx.roundRect(x - 34, 118, 68, 10, 5);
      else ctx.roundRect(x - 30, busy ? 78 : 72, 60, busy ? 84 : 100, 30);
      ctx.fill();
    }
    phoneFace.tex.needsUpdate = true;
  };

  return {
    group,
    eye,
    rayOrigin,
    height,
    update(s, tachos, timeS) {
      const cmPerDeg = (sign * Math.PI * D) / 360;
      for (const t of treads) t.place((tachos[t.port] ?? 0) * cmPerDeg);
      for (const sp of spinners) sp.obj.rotation.z = -((tachos[sp.port] ?? 0) * cmPerDeg) / sp.radius;
      for (const h of hubs) h.obj.rotation.z = -((tachos[h.port] ?? 0) * sign * Math.PI) / 180;
      // brick LED: 0 off, 1-3 steady green/red/orange, 4-6 flashing, 7-9 pulsing
      const p = s.led;
      const colour = p === 0 ? 0 : ((p - 1) % 3) + 1;
      const level =
        p === 0
          ? 0
          : p <= 3
            ? 1
            : p <= 6
              ? (timeS * 2) % 1 < 0.5
                ? 1
                : 0.05
              : 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(timeS * Math.PI * 2));
      ledMat.emissive.setHex(LED_RGB[colour]!);
      ledMat.emissiveIntensity = 2.2 * level;
      for (const [id, m] of btnMats) m.emissive.setHex(s.buttons.includes(id) ? 0x553311 : 0x000000);
      drawLcd(s);
      drawFace(timeS, s.activity !== "idle");
      for (const sensor of s.sensors) {
        const tp = touchPlungers.find((x) => x.port === sensor.port);
        if (tp) tp.obj.position.copy(tp.base).add(P(sensor.mode === 0 && sensor.values[0] === 1 ? -0.55 : 0, 0, 0));
        const cl = colorLights.find((x) => x.port === sensor.port);
        if (cl) {
          // reflected light: red LED; colour: white; ambient: a dim blue
          const hex = sensor.mode === 0 ? 0xff2010 : sensor.mode === 1 ? 0x2a5cff : 0xf4f6ff;
          cl.lens.emissive.setHex(hex);
          cl.lens.emissiveIntensity = sensor.mode === 1 ? 0.5 : 1.6;
          cl.spotMat.color.setHex(hex);
          cl.spotMat.opacity = sensor.mode === 1 ? 0.12 : 0.5;
        }
        const us = usEyes.find((x) => x.port === sensor.port);
        if (us) us.mat.emissiveIntensity = sensor.values.length ? 0.9 + 0.3 * Math.sin(timeS * 9) : 0;
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
      for (const t of treads) t.mesh.dispose();
    },
  };
}

function brickTopTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 464;
  c.height = 336;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  // the canvas is the top face seen from above with the screen end on the right
  g.fillStyle = "#d3201a";
  g.fillRect(22, 262, 46, 46);
  g.fillStyle = "#fff";
  g.font = "bold 16px Arial, sans-serif";
  g.save();
  g.translate(45, 285);
  g.rotate(-Math.PI / 2);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("LEGO", 0, 1);
  g.restore();
  g.fillStyle = "#a9acb0";
  g.save();
  g.translate(60, 70);
  g.rotate(-Math.PI / 2);
  g.font = "bold 40px Arial, sans-serif";
  g.textAlign = "center";
  g.fillText("EV3", 0, 0);
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function phoneCaseTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 250;
  const g = c.getContext("2d")!;
  g.fillStyle = "#2f5b96";
  g.fillRect(0, 0, 512, 250);
  // stamps
  const colours = ["#f3e2c7", "#f6d0c4", "#e8eef7", "#f7ecd0", "#dfe9d6"];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 26; i++) {
    const x = rnd() * 500 - 10,
      y = rnd() * 240 - 10,
      w = 34 + rnd() * 18,
      h = 42 + rnd() * 16;
    g.save();
    g.translate(x + w / 2, y + h / 2);
    g.rotate((rnd() - 0.5) * 0.7);
    g.fillStyle = colours[i % colours.length]!;
    g.fillRect(-w / 2, -h / 2, w, h);
    g.fillStyle = ["#d9534f", "#5b8bd9", "#e0a63a", "#6aa36f"][i % 4]!;
    g.beginPath();
    g.arc(0, -2, w * 0.22, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function labelTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f3ecc6";
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = "#3a2a6a";
  g.font = "italic 84px 'Comic Sans MS', 'Segoe Print', cursive";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
