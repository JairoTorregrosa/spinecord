// What sits on the robot besides its drive and brick: the sensors (IR 45509, ultrasonic 45504, colour 45506,
// touch 45507, gyro 45505) with their flat cables to the brick's ports, motors on the other ports, and what the
// look adds (a phone in a holder of beams, a bumper of beams and bricks, a paper label).
import * as THREE from "three";
import type { Look } from "./look";
import type { RobotMeta, RobotState } from "./messages";
import { P, type Kit } from "./parts";

export interface Extras {
  height: number;
  eye: { pos: THREE.Vector3; look: THREE.Vector3 };
  rayOrigin: THREE.Vector3 | null;
  update(s: RobotState, timeS: number, tachos: Record<string, number>): void;
}

export interface Mount {
  /** Robot-frame point of a brick port and the way out of the brick there (+1 ahead, -1 behind). */
  port(p: string): { at: THREE.Vector3; out: number };
  brickTop: number;
  brickHalfW: number;
  brickX: number;
  brickZ: number;
}

/** A cable from `from` (leaving it along `dir`) to one of the brick's ports, as a person routes one: a short hop
 *  when the port is near, else down beside the brick and along its side, then straight into the port. */
function cableTo(kit: Kit, m: Mount, from: THREE.Vector3, dir: THREE.Vector3, p: string): void {
  const { at, out } = m.port(p);
  const a = from.clone().addScaledVector(dir, 1.0);
  const into = at.clone().add(new THREE.Vector3(out * 0.8, 0, 0));
  if (Math.abs(at.x - from.x) < 7) {
    const mid = new THREE.Vector3((a.x + into.x) / 2 + out * 0.8, (a.y + at.y) / 2, Math.max(a.z, at.z) + 0.6);
    kit.cable([from, a, mid, into, at]);
    return;
  }
  const side = from.y >= 0 ? 1 : -1;
  const ys = side * (m.brickHalfW + 0.7);
  const high = a.z > m.brickTop ? Math.max(m.brickTop + 1.2, a.z - 1.2) : a.z;
  kit.cable([
    from,
    a,
    new THREE.Vector3(a.x + dir.x * 0.6, (a.y + ys) / 2, high),
    new THREE.Vector3((a.x + at.x) / 2, ys, Math.min(high, m.brickTop - 0.6)),
    new THREE.Vector3(at.x + out * 1.4, (ys + at.y) / 2, at.z + 0.5),
    into,
    at,
  ]);
}

export function buildExtras(kit: Kit, meta: RobotMeta, look: Look, mount: Mount): Extras {
  const { mats, keep, group } = kit;
  const body = meta.world.body;
  let height = mount.brickTop + 1;
  let eye = { pos: P(body.front_cm + 0.5, 0, Math.max(6, mount.brickTop)), look: P(body.front_cm + 40, 0, 2) };

  // ---------------------------------------------------------------- other motors (not the drive's)
  const hubs: { port: string; obj: THREE.Object3D }[] = [];
  const drivePorts = new Set([meta.drivetrain?.left ?? "B", meta.drivetrain?.right ?? "C"]);
  for (const [port, type] of Object.entries(meta.ports.motors)) {
    if (drivePorts.has(port)) continue;
    const x = Math.min(body.front_cm - 3, mount.brickX + 6.5);
    const z = mount.brickTop + 1.8;
    if (type === "medium") {
      // the medium motor (45503): a compact block with its output facing ahead
      kit.box(4.0, 4.6, 2.2, x - 1.2, 0, z - 0.5, mats.light, 0.5);
      kit.box(3.8, 4.4, 1.3, x - 1.2, 0, z + 1.1, mats.white, 0.5);
    } else kit.box(6, 2.4, 3.6, x - 2.6, 0, z, mats.white, 0.8);
    const g = kit.live(new THREE.Group());
    g.position.copy(P(x + 1.0, 0, z));
    g.rotation.y = Math.PI / 2; // the hub faces ahead
    group.add(g);
    kit.axleCyl(1.0, 0.3, 0, 0, 0, mats.red, g);
    kit.box(0.95, 0.06, 0.22, 0, 0.17, 0, mats.black, 0, g);
    kit.box(0.22, 0.06, 0.95, 0, 0.17, 0, mats.black, 0, g);
    hubs.push({ port, obj: g });
    cableTo(kit, mount, new THREE.Vector3(x - 3.4, 0, z + 0.4), new THREE.Vector3(-1, 0, 0), port);
  }

  // ---------------------------------------------------------------- phone
  let drawFace: ((timeS: number, busy: boolean) => void) | null = null;
  if (look.phone) {
    const ph = look.phone;
    const T = 0.95,
      W = 14.7,
      H = 7.15;
    const zc = ph.bottom + H / 2;
    const face = ph.screen === "front" ? 1 : -1;
    // the case, soft-touch silicone; the screen is glass in a thin black border
    const caseMat = keep(new THREE.MeshStandardMaterial({ color: 0x223a63, roughness: 0.7 }));
    kit.box(T + 0.2, W + 0.3, H + 0.3, ph.x - face * 0.1, 0, zc, caseMat, 0.55);
    kit.box(
      0.04,
      W - 0.2,
      H - 0.2,
      ph.x + face * (T / 2 + 0.01),
      0,
      zc,
      keep(new THREE.MeshStandardMaterial({ color: 0x050607, roughness: 0.1 })),
      0,
    );
    const faceCanvas = document.createElement("canvas");
    faceCanvas.width = 512;
    faceCanvas.height = 250;
    const faceTex = keep(new THREE.CanvasTexture(faceCanvas));
    faceTex.colorSpace = THREE.SRGBColorSpace;
    faceTex.anisotropy = 4;
    const screen = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(W - 0.9, H - 0.7)),
      kit.live(
        keep(
          new THREE.MeshPhysicalMaterial({
            color: 0x000000,
            emissive: 0xffffff,
            emissiveMap: faceTex,
            emissiveIntensity: 0.9,
            roughness: 0.08,
            clearcoat: 1,
            clearcoatRoughness: 0.04,
          }),
        ),
      ),
    );
    screen.position.copy(P(ph.x + face * (T / 2 + 0.04), 0, zc));
    screen.rotation.y = face > 0 ? Math.PI / 2 : -Math.PI / 2;
    group.add(screen);
    const ctx = faceCanvas.getContext("2d")!;
    let faceKey = 0;
    drawFace = (timeS, busy) => {
      const blink = timeS % 4.2 > 4.05;
      const key = blink ? 1 : busy ? 2 : 3;
      if (key === faceKey) return;
      faceKey = key;
      ctx.fillStyle = "#0a0f16";
      ctx.fillRect(0, 0, 512, 250);
      ctx.fillStyle = busy ? "#7ee0ff" : "#c9f1ff";
      for (const x of [175, 337]) {
        ctx.beginPath();
        if (blink) ctx.roundRect(x - 34, 118, 68, 10, 5);
        else ctx.roundRect(x - 30, busy ? 78 : 72, 60, busy ? 84 : 100, 30);
        ctx.fill();
      }
      faceTex.needsUpdate = true;
    };
    // the case's back, printed with stamps
    const back = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(W - 0.5, H - 0.5)),
      keep(new THREE.MeshStandardMaterial({ map: keep(phoneCaseTexture()), roughness: 0.55 })),
    );
    back.position.copy(P(ph.x - face * (T / 2 + 0.21), 0, zc));
    back.rotation.y = face > 0 ? -Math.PI / 2 : Math.PI / 2;
    group.add(back);
    // the camera island at the top corner of the back
    const bx = ph.x - face * (T / 2 + 0.3);
    kit.box(
      0.24,
      3.2,
      3.2,
      bx,
      -W / 2 + 2.2,
      zc + H / 2 - 2.0,
      keep(new THREE.MeshStandardMaterial({ color: 0x9fb4c9, roughness: 0.25, metalness: 0.3 })),
      0.6,
    );
    for (const [ly, lz] of [
      [-W / 2 + 1.5, zc + H / 2 - 1.3],
      [-W / 2 + 2.9, zc + H / 2 - 2.7],
    ] as const) {
      const lens = kit.axleCyl(0.55, 0.3, bx - face * 0.15, ly, lz, mats.black, group, 20);
      lens.rotation.set(0, Math.PI / 2, 0); // its axis runs ahead
    }
    // the holder: two upright beams from the brick up the back of the phone, a cross beam behind it, and a
    // beam across under its lower edge
    const fx = ph.x - face * (T / 2 + 0.75);
    const rise = zc + 1.5 - (mount.brickTop - 0.4);
    const holes = Math.max(3, Math.round(rise / 0.8) + 1);
    for (const y of [3.6, -3.6]) {
      const b = kit.beam(holes, fx, y, mount.brickTop - 0.4 + ((holes - 1) * 0.8) / 2, mats.dark);
      b.rotation.z = Math.PI / 2;
    }
    const cross = kit.beam(11, fx, 0, zc + 0.6, mats.dark);
    cross.rotation.y = Math.PI / 2;
    const ledge = kit.beam(15, ph.x - face * 0.1, 0, ph.bottom - 0.5, mats.black);
    ledge.rotation.y = Math.PI / 2;
    for (const y of [3.6, -3.6])
      kit.axleCyl(0.26, 1.0, fx, y, zc + 0.6, mats.red, group, 12).rotation.set(0, Math.PI / 2, 0);
    height = Math.max(height, ph.bottom + H + 0.2);
    eye = {
      pos: P(ph.x + face * (T / 2 + 0.6), 0, zc + H / 2 - 0.9),
      look: P(ph.x + face * 60, 0, zc - 10),
    };
  }

  // ---------------------------------------------------------------- sensors
  const touchPlungers: { port: string; obj: THREE.Object3D; base: THREE.Vector3 }[] = [];
  const colorLights: { port: string; lens: THREE.MeshStandardMaterial; spotMat: THREE.MeshBasicMaterial }[] = [];
  const usEyes: { port: string; mat: THREE.MeshStandardMaterial }[] = [];
  let rayOrigin: THREE.Vector3 | null = null;
  const back = new THREE.Vector3(-1, 0, 0);
  for (const s of look.sensors) {
    if (s.kind === "ultrasonic" || s.kind === "ir") {
      const g = new THREE.Group();
      g.position.copy(P(s.x, s.y, s.z));
      group.add(g);
      // the body: grey below, a white cap, the front in anthracite
      kit.box(2.4, 4.6, 1.5, -0.4, 0, -0.55, mats.light, 0.5, g);
      kit.box(2.4, 4.6, 1.3, -0.4, 0, 0.75, mats.white, 0.5, g);
      kit.box(0.5, 4.8, 2.7, 0.95, 0, 0, mats.anthracite, 0.4, g);
      kit.studs(1, 2, -0.8, 0, 1.4, mats.white, g);
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
          const eyeG = new THREE.Group();
          eyeG.position.copy(P(1.2, y, 0));
          eyeG.rotation.y = Math.PI / 2; // the eyes look ahead
          g.add(eyeG);
          kit.axleCyl(1.0, 0.3, 0, 0, 0, mats.red, eyeG, 28);
          kit.axleCyl(0.75, 0.34, 0, 0, 0, mats.black, eyeG, 24);
          kit.axleCyl(0.5, 0.36, 0, 0, 0, i === 0 ? glow : mats.anthracite, eyeG, 20);
        }
      } else {
        // the IR's dark red window, glossy
        const win = keep(new THREE.MeshStandardMaterial({ color: 0x3c0508, roughness: 0.06, metalness: 0.1 }));
        kit.box(0.2, 3.7, 1.5, 1.25, 0, 0.05, win, 0.5, g);
      }
      rayOrigin = P(s.x + 1.5, s.y, s.z);
      cableTo(kit, mount, new THREE.Vector3(s.x - 1.6, s.y, s.z), back, s.port);
      height = Math.max(height, s.z + 1.6);
    } else if (s.kind === "color") {
      kit.box(2.2, 1.9, 2.2, s.x, s.y, s.z + 1.1, mats.light, 0.4);
      kit.box(2.0, 1.8, 0.7, s.x, s.y, s.z + 2.4, mats.white, 0.3);
      kit.box(1.6, 1.6, 0.2, s.x, s.y, s.z, mats.black, 0.3);
      const lens = kit.live(
        keep(
          new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xff2010, emissiveIntensity: 1, roughness: 0.1 }),
        ),
      );
      const l = kit.add(keep(new THREE.CylinderGeometry(0.4, 0.4, 0.12, 20)), lens, P(s.x, s.y, s.z - 0.12));
      l.castShadow = false;
      const spotMat = kit.live(
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
      // the light on the floor, as wide as what the sensor reads
      const spot = new THREE.Mesh(
        keep(new THREE.CircleGeometry(Math.max(0.6, body.color_spot_radius_cm * 1.2), 28)),
        spotMat,
      );
      spot.rotation.x = -Math.PI / 2;
      spot.position.copy(P(body.color_sensor_x_cm, s.y, 0.05));
      spot.raycast = () => {};
      group.add(spot);
      colorLights.push({ port: s.port, lens, spotMat });
      cableTo(kit, mount, new THREE.Vector3(s.x - 1.1, s.y, s.z + 1.6), back, s.port);
    } else if (s.kind === "touch") {
      kit.box(2.8, 1.9, 2.3, s.x - 1.2, s.y, s.z - 0.1, mats.light, 0.4);
      kit.box(2.8, 1.9, 0.7, s.x - 1.2, s.y, s.z + 1.35, mats.white, 0.3);
      kit.box(0.4, 1.4, 1.4, s.x + 0.2, s.y, s.z, mats.anthracite, 0.2);
      const pl = kit.live(new THREE.Group());
      pl.position.copy(P(s.x + 0.4, s.y, s.z));
      group.add(pl);
      kit.box(0.9, 0.42, 1.3, 0.45, 0, 0, mats.red, 0.1, pl);
      kit.box(0.9, 1.3, 0.42, 0.45, 0, 0, mats.red, 0.1, pl);
      touchPlungers.push({ port: s.port, obj: pl, base: pl.position.clone() });
      cableTo(kit, mount, new THREE.Vector3(s.x - 2.6, s.y, s.z), back, s.port);
    } else {
      kit.box(2.4, 2.4, 1.8, s.x, s.y, s.z, mats.white, 0.4);
      kit.box(2.3, 2.3, 0.6, s.x, s.y, s.z - 0.75, mats.light, 0.3);
      kit.box(1.6, 0.25, 0.05, s.x, s.y, s.z + 0.92, mats.red, 0);
      kit.box(0.25, 1.6, 0.05, s.x, s.y, s.z + 0.92, mats.red, 0);
      cableTo(kit, mount, new THREE.Vector3(s.x - 1.2, s.y, s.z), back, s.port);
    }
  }

  // ---------------------------------------------------------------- bumper and label
  if (look.bumper) {
    const bx = look.bumper.x,
      out = bx < 0 ? -1 : 1,
      span = 2 * body.half_width_cm - 2.5;
    const holes = Math.max(3, Math.round(span / 0.8) + 1);
    kit.beam(holes, bx, 0, 4.2, mats.black).rotation.y = Math.PI / 2;
    // red 2 × 2 bricks, two high, on the bar
    for (const y of [span / 2 - 1.6, span / 4, -span / 4, -span / 2 + 1.6]) {
      for (const z of [4.2, 5.16]) kit.box(1.58, 1.58, 0.94, bx + out * 1.2, y, z, mats.red, 0.06);
      kit.studs(2, 2, bx + out * 1.2, y, 5.63, mats.red);
    }
    kit.axleCyl(0.24, span + 1.2, bx + out * 2.3, 0, 3.0, mats.white, group, 12);
    for (const y of [span / 2 + 0.4, -span / 2 - 0.4]) {
      const cone = kit.add(keep(new THREE.ConeGeometry(0.45, 1.4, 16)), mats.white, P(bx + out * 2.3, y, 3.0));
      cone.rotation.z = out > 0 ? -Math.PI / 2 : Math.PI / 2;
    }
    // two beams from the bar forward to the body
    for (const y of [span / 2 - 0.6, -span / 2 + 0.6]) {
      const n = Math.max(3, Math.round((Math.abs(bx) - 5) / 0.8) + 1);
      kit.beam(n, bx - out * (((n - 1) * 0.8) / 2), y, 4.2, mats.black);
    }
  }
  if (look.label) {
    const lab = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(2.0, 2.0)),
      keep(new THREE.MeshStandardMaterial({ map: keep(labelTexture(look.label)), roughness: 0.9 })),
    );
    const end = look.brick.screen === "front" ? -1 : 1;
    lab.position.copy(P(mount.brickX + end * 3.4, 3.8 + 0.03, mount.brickZ + 1.4));
    lab.rotation.set(0, Math.PI, 0.06); // it faces out of the brick's left side
    group.add(lab);
  }

  return {
    height,
    eye,
    rayOrigin,
    update(s, timeS, tachos) {
      drawFace?.(timeS, s.activity !== "idle");
      for (const h of hubs) h.obj.rotation.z = -((tachos[h.port] ?? 0) * Math.PI) / 180;
      for (const sensor of s.sensors) {
        const tp = touchPlungers.find((x) => x.port === sensor.port);
        if (tp) tp.obj.position.copy(tp.base).add(P(sensor.mode === 0 && sensor.values[0] === 1 ? -0.5 : 0, 0, 0));
        const cl = colorLights.find((x) => x.port === sensor.port);
        if (cl) {
          // reflected light: the red LED; colour: white light; ambient: the LED nearly off (a dim blue)
          const hex = sensor.mode === 0 ? 0xff2010 : sensor.mode === 1 ? 0x2a5cff : 0xf4f6ff;
          cl.lens.emissive.setHex(hex);
          cl.lens.emissiveIntensity = sensor.mode === 1 ? 0.5 : 2;
          cl.spotMat.color.setHex(hex);
          cl.spotMat.opacity = sensor.mode === 1 ? 0.12 : 0.45;
        }
        const us = usEyes.find((x) => x.port === sensor.port);
        if (us) us.mat.emissiveIntensity = sensor.values.length ? 0.9 + 0.3 * Math.sin(timeS * 9) : 0;
      }
    },
  };
}

function phoneCaseTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 250;
  const g = c.getContext("2d")!;
  g.fillStyle = "#26467a";
  g.fillRect(0, 0, 512, 250);
  // postage stamps printed on the case, muted as a print on silicone is
  const colours = ["#e6d8c0", "#e9cbbf", "#dde3ea", "#ebe1c8", "#d6dfcf"];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 22; i++) {
    const x = rnd() * 500 - 10,
      y = rnd() * 240 - 10,
      w = 34 + rnd() * 18,
      h = 42 + rnd() * 16;
    g.save();
    g.translate(x + w / 2, y + h / 2);
    g.rotate((rnd() - 0.5) * 0.7);
    g.fillStyle = colours[i % colours.length]!;
    g.fillRect(-w / 2, -h / 2, w, h);
    // the perforated edge
    g.fillStyle = "#26467a";
    for (let k = -w / 2; k < w / 2; k += 5) {
      g.beginPath();
      g.arc(k + 2.5, -h / 2, 1.4, 0, Math.PI * 2);
      g.arc(k + 2.5, h / 2, 1.4, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = ["#b9534f", "#5b7bb9", "#c0963a", "#6a936f"][i % 4]!;
    g.fillRect(-w / 2 + 5, -h / 2 + 5, w - 10, h - 18);
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function labelTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f6f1dc";
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = "#d9d2b8";
  g.lineWidth = 3;
  g.strokeRect(2, 2, 124, 124);
  g.fillStyle = "#1f2a6b";
  g.font = "bold 88px 'Comic Sans MS', 'Segoe Print', 'Marker Felt', cursive";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
