// What the look adds to a robot besides its devices: a phone standing across the body in a holder of beams (its
// screen shows a face), a bumper of beams and red bricks, a paper label on the brick.
import * as THREE from "three";
import type { BrickMount } from "./devices";
import type { Look } from "./look";
import type { RobotMeta, RobotState } from "./messages";
import { P, type Kit } from "./parts";

export interface Accessories {
  height: number;
  /** The robot's own camera, robot frame (three.js axes inside the group): where, and a point it looks at. */
  eye: { pos: THREE.Vector3; look: THREE.Vector3 };
  /** What they take up, robot frame. */
  boxes: THREE.Box3[];
  update(s: RobotState, timeS: number): void;
}

export function buildAccessories(kit: Kit, meta: RobotMeta, look: Look, m: BrickMount): Accessories {
  const { mats, keep, group } = kit;
  const body = meta.world.body;
  const boxes: THREE.Box3[] = [];
  let height = m.box.max.z + 1;
  let eye = { pos: P(body.front_cm + 0.5, 0, Math.max(6, m.box.max.z)), look: P(body.front_cm + 40, 0, 2) };
  let drawFace: ((timeS: number, busy: boolean) => void) | null = null;
  if (look.phone) {
    // a phone 14.7 × 7.15 × 0.95 cm in a case, built with its screen looking along +x, then turned to its yaw
    const ph = look.phone;
    const T = 0.95;
    const [W, H] = ph.portrait ? [7.15, 14.7] : [14.7, 7.15];
    const bb = m.box;
    const px = ph.x ?? Math.min(body.front_cm - 1.5, bb.max.x - 1);
    const bottom = ph.bottom ?? bb.max.z + 1.2;
    const zc = bottom + H / 2;
    const yaw = (ph.yaw * Math.PI) / 180;
    const pg = new THREE.Group();
    pg.position.copy(P(px, ph.y, 0));
    pg.rotation.y = yaw;
    group.add(pg);
    const caseMat = keep(new THREE.MeshStandardMaterial({ color: 0x223a63, roughness: 0.7 }));
    kit.box(T + 0.2, W + 0.3, H + 0.3, -0.1, 0, zc, caseMat, 0.55, pg);
    kit.box(
      0.04,
      W - 0.2,
      H - 0.2,
      T / 2 + 0.01,
      0,
      zc,
      keep(new THREE.MeshStandardMaterial({ color: 0x050607, roughness: 0.1 })),
      0,
      pg,
    );
    // the screen: glass over the face the page draws
    const [cw, ch] = ph.portrait ? [250, 512] : [512, 250];
    const faceCanvas = document.createElement("canvas");
    faceCanvas.width = cw;
    faceCanvas.height = ch;
    const faceTex = keep(new THREE.CanvasTexture(faceCanvas));
    faceTex.colorSpace = THREE.SRGBColorSpace;
    faceTex.anisotropy = 4;
    const screen = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(W - 0.7, H - 0.7)),
      kit.live(
        keep(
          new THREE.MeshPhysicalMaterial({
            color: 0x000000,
            emissive: 0xffffff,
            emissiveMap: faceTex,
            emissiveIntensity: 1,
            roughness: 0.08,
            clearcoat: 1,
            clearcoatRoughness: 0.04,
          }),
        ),
      ),
    );
    screen.position.copy(P(T / 2 + 0.04, 0, zc));
    screen.rotation.y = Math.PI / 2;
    pg.add(screen);
    const ctx = faceCanvas.getContext("2d")!;
    let faceKey = 0;
    drawFace = (timeS, busy) => {
      const blink = timeS % 4.2 > 4.05;
      const key = blink ? 1 : busy ? 2 : 3;
      if (key === faceKey) return;
      faceKey = key;
      // two big eyes, wide apart, so the face reads from across the room
      ctx.fillStyle = "#0a0f16";
      ctx.fillRect(0, 0, cw, ch);
      ctx.fillStyle = busy ? "#7ee0ff" : "#c9f1ff";
      const s = Math.min(cw, ch) / 250;
      for (const x of [cw / 2 - 80 * s, cw / 2 + 80 * s]) {
        ctx.beginPath();
        if (blink) ctx.roundRect(x - 36 * s, ch / 2 - 6 * s, 72 * s, 12 * s, 6 * s);
        else ctx.roundRect(x - 34 * s, ch / 2 - (busy ? 44 : 56) * s, 68 * s, (busy ? 88 : 112) * s, 34 * s);
        ctx.fill();
      }
      faceTex.needsUpdate = true;
    };
    // the case's back, printed with stamps
    const back = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(W - 0.5, H - 0.5)),
      keep(new THREE.MeshStandardMaterial({ map: keep(phoneCaseTexture(ph.portrait)), roughness: 0.55 })),
    );
    back.position.copy(P(-(T / 2 + 0.21), 0, zc));
    back.rotation.y = -Math.PI / 2;
    pg.add(back);
    // the camera island at the top corner of the back
    const cy = -W / 2 + 2.2,
      cz = zc + H / 2 - 2.0;
    kit.box(
      0.24,
      3.2,
      3.2,
      -(T / 2 + 0.3),
      cy,
      cz,
      keep(new THREE.MeshStandardMaterial({ color: 0x9fb4c9, roughness: 0.25, metalness: 0.3 })),
      0.6,
      pg,
    );
    for (const [ly, lz] of [
      [cy - 0.7, cz + 0.7],
      [cy + 0.7, cz - 0.7],
    ] as const)
      kit.axleCyl(0.55, 0.3, -(T / 2 + 0.45), ly, lz, mats.black, pg, 20).rotation.set(0, Math.PI / 2, 0);
    // the holder: two upright beams from what is under the phone up its back, a cross beam behind it, and a beam
    // under its lower edge
    const fx = -(T / 2 + 0.75);
    const under = Math.abs(px - (bb.min.x + bb.max.x) / 2) < (bb.max.x - bb.min.x) / 2 + 1 ? bb.max.z : m.driveTop;
    const rise = zc + 1.5 - (under - 0.4);
    const holes = Math.max(3, Math.round(rise / 0.8) + 1);
    const postY = Math.min(3.6, W / 2 - 0.8);
    for (const y of [postY, -postY])
      kit.beam(holes, fx, y, under - 0.4 + ((holes - 1) * 0.8) / 2, mats.dark, "y", pg).rotation.z = Math.PI / 2;
    const crossN = Math.max(3, Math.round((2 * postY) / 0.8) + 2);
    kit.beam(crossN, fx, 0, zc + 0.6, mats.dark, "y", pg).rotation.y = Math.PI / 2;
    const ledgeN = Math.max(3, Math.round(W / 0.8));
    kit.beam(ledgeN, -0.1, 0, bottom - 0.5, mats.black, "y", pg).rotation.y = Math.PI / 2;
    for (const y of [postY, -postY])
      kit.axleCyl(0.26, 1.0, fx, y, zc + 0.6, mats.red, pg, 12).rotation.set(0, Math.PI / 2, 0);
    height = Math.max(height, bottom + H + 0.2);
    // what it takes up: its box turned by its yaw
    const c = Math.abs(Math.cos(yaw)),
      sn = Math.abs(Math.sin(yaw));
    const hx = (c * (T + 1.6)) / 2 + (sn * W) / 2,
      hy = (sn * (T + 1.6)) / 2 + (c * W) / 2;
    boxes.push(
      new THREE.Box3(
        new THREE.Vector3(px - hx, ph.y - hy, bottom - 1),
        new THREE.Vector3(px + hx, ph.y + hy, bottom + H + 0.2),
      ),
    );
    // the robot's camera is the phone's: at the top of its screen side, looking where the screen looks, down a little
    const dx = Math.cos(yaw),
      dy = Math.sin(yaw);
    eye = {
      pos: P(px + dx * (T / 2 + 0.6), ph.y + dy * (T / 2 + 0.6), zc + H / 2 - 0.9),
      look: P(px + dx * 60, ph.y + dy * 60, zc - 10),
    };
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
    boxes.push(
      new THREE.Box3(
        new THREE.Vector3(Math.min(bx, bx + out * 3) - 0.6, -span / 2 - 1.8, 2.5),
        new THREE.Vector3(Math.max(bx, bx + out * 3) + 0.6, span / 2 + 1.8, 6),
      ),
    );
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
    const b = m.box;
    // between the pin holes of the brick's side
    lab.position.copy(P((b.min.x + b.max.x) / 2, b.max.y + 0.03, b.min.z + 1.4));
    lab.rotation.set(0, Math.PI, 0.06); // it faces out of the brick's left side
    group.add(lab);
  }

  return {
    height,
    eye,
    boxes,
    update(s, timeS) {
      drawFace?.(timeS, s.activity !== "idle");
    },
  };
}

function phoneCaseTexture(portrait: boolean): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = portrait ? 250 : 512;
  c.height = portrait ? 512 : 250;
  const g = c.getContext("2d")!;
  g.fillStyle = "#26467a";
  g.fillRect(0, 0, c.width, c.height);
  // postage stamps printed on the case, muted as a print on silicone is
  const colours = ["#e6d8c0", "#e9cbbf", "#dde3ea", "#ebe1c8", "#d6dfcf"];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 22; i++) {
    const x = rnd() * (c.width - 12) - 10,
      y = rnd() * (c.height - 10) - 10,
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
