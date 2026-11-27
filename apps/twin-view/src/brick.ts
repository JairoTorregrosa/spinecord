// The EV3 Intelligent Brick (45500, LDraw 95646): 11.12 × 7.2 × 4.36 cm with the AA cover (5.08 with the
// rechargeable battery 95646c01), every size and position from the LEGO parts map (dims.ts). A white top shell over
// a light grey bottom shell, the through pin holes of its sides, motor ports A-D and the PC port at the screen end,
// sensor ports 1-4 at the other; on top the LCD (drawn from the state), the six buttons on the pad whose light
// guide is the status LED. Drawn from boxes first; the real LDraw mesh replaces the shells once it has loaded
// (meshes.ts), the screen, the buttons and the LED stay alive on it.
//
// Inside the brick's group: x toward the screen end, y to the left, z up, the bottom at z = 0.
import * as THREE from "three";
import { BEAM, BRICK as B, type PartDims } from "./dims";
import { COL, P, type Kit } from "./parts";
import type { RobotState } from "./messages";

export type Battery = "aa" | "rechargeable";
/** The brick's box in its group, for a battery. */
export const brickDims = (battery: Battery): PartDims => B[battery];
const LCD_W = 178,
  LCD_H = 128;
const LED_RGB = [0x000000, 0x1fe05a, 0xff2a1f, 0xff9a1a];

export interface Brick {
  group: THREE.Group;
  dims: PartDims;
  /** Where port `p` (1..4 of the sensors, A..D of the motors) is, inside the brick's group: its socket's face. */
  portAt(p: string): THREE.Vector3;
  update(s: RobotState, timeS: number): void;
}

export function buildBrick(kit: Kit, battery: Battery): Brick {
  const { mats, keep } = kit;
  const d = B[battery];
  const [x0, y0] = d.min,
    [x1, y1, H] = d.max;
  const L = x1 - x0,
    W = y1 - y0;
  const v = (k: string) => {
    const a = d.at[k];
    if (!a) throw new Error(`the parts map gives the brick no ${k}`);
    return a;
  };
  const g = kit.live(new THREE.Group());
  // the shells: light grey bottom, white top (from the top down as far as the map says)
  const split = H - B.topShell;
  kit.box(L - 0.2, W - 0.1, split, (x0 + x1) / 2, 0, split / 2, mats.light, 0.35, g);
  kit.box(L, W, B.topShell, (x0 + x1) / 2, 0, split + B.topShell / 2, mats.white, 0.6, g);
  // the port ends in anthracite, as deep as the sockets
  for (const end of [x0, x1])
    kit.box(0.4, W - 1.0, 1.4, end - Math.sign(end) * 0.15, 0, v("port_1")[2], mats.anthracite, 0.12, g);
  // the side and bottom pin holes the map lists
  for (const h of d.holes) {
    if (h.axis[1] > 0.9) {
      // through the brick across: a dark ring on either side
      for (const side of [1, -1])
        kit.axleCyl(BEAM.hole / 2, 0.06, h.at[0], side * (W / 2 + 0.01), h.at[2], mats.black, g, 12);
    } else if (h.axis[2] > 0.9) {
      const down = kit.cached("hole down", () => new THREE.CylinderGeometry(BEAM.hole / 2, BEAM.hole / 2, 0.06, 12));
      kit.add(down, mats.black, P(h.at[0], h.at[1], -0.02), g);
    }
  }
  // the sockets: motor ports and PC at the screen end, sensor ports at the other
  for (const k of ["port_A", "port_B", "port_C", "port_D", "port_1", "port_2", "port_3", "port_4"]) {
    const [px, py, pz] = v(k);
    kit.box(0.2, 0.9, 0.7, px - Math.sign(px) * 0.08, py, pz, mats.black, 0.08, g);
  }
  {
    const [px, py, pz] = v("pc_usb");
    kit.box(0.2, 0.7, 0.3, px - Math.sign(px) * 0.08, py, pz, mats.black, 0.05, g);
  }
  // the print on the top: logo and name, at the end away from the screen
  const top = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(3.8, W - 1.4)),
    keep(new THREE.MeshStandardMaterial({ map: keep(brickTopTexture()), roughness: 0.35, transparent: true })),
  );
  top.rotation.x = -Math.PI / 2;
  top.position.copy(P(x0 + 2.3, 0, H + 0.005));
  g.add(top);
  // the screen in its window: the LCD where the map puts it, drawn from the state (it stays on the real mesh)
  const [sx, sy, sz] = v("screen");
  kit.box(B.screen.along + 0.4, B.screen.across + 0.5, 0.12, sx, sy, H - 0.04, mats.anthracite, 0.2, g);
  const lcdCanvas = document.createElement("canvas");
  lcdCanvas.width = LCD_W * 2;
  lcdCanvas.height = LCD_H * 2;
  const lcdTex = keep(new THREE.CanvasTexture(lcdCanvas));
  lcdTex.colorSpace = THREE.SRGBColorSpace;
  lcdTex.anisotropy = 4;
  const lcd = kit.live(
    new THREE.Mesh(
      keep(new THREE.PlaneGeometry(B.screen.across, B.screen.along)),
      kit.live(
        keep(
          new THREE.MeshStandardMaterial({
            map: lcdTex,
            roughness: 0.18,
            emissive: 0xa4ad98,
            emissiveMap: lcdTex,
            emissiveIntensity: 0.25,
          }),
        ),
      ),
    ),
  );
  lcd.rotation.x = -Math.PI / 2;
  lcd.rotation.z = -Math.PI / 2; // its width runs across the brick
  // just over the LCD's own face, under the shield's window
  lcd.position.copy(P(sx, sy, Math.max(sz, H - 0.1) + 0.02));
  g.add(lcd);
  // the button pad: the map gives its centre and the buttons' places; its rim is the LED's light guide
  const [cx, cy] = v("buttons");
  // the arrows sit 13.2 LDU either side of the centre, the D-shaped buttons 40 LDU (brick.features.buttons)
  const ledMat = kit.live(
    keep(new THREE.MeshStandardMaterial({ color: 0x3a3f44, emissive: 0x000000, roughness: 0.3 })),
  );
  const led = kit.live(new THREE.Group());
  g.add(led);
  kit.box(3.5, 4.3, 0.1, cx, cy, H + 0.02, ledMat, 0.9, led);
  kit.box(3.1, 3.9, 0.12, cx, cy, H + 0.04, mats.anthracite, 0.8, g);
  const btnMats = new Map<number, THREE.MeshStandardMaterial>();
  const buttons = new Map<number, THREE.Object3D>();
  const button = (id: number, lx: number, ly: number, x: number, y: number, color: number) => {
    const m = kit.live(keep(new THREE.MeshStandardMaterial({ color, roughness: 0.35, emissive: 0x000000 })));
    btnMats.set(id, m);
    const holder = kit.live(new THREE.Group());
    g.add(holder);
    buttons.set(id, holder);
    kit.box(lx, ly, 0.24, x, y, H + 0.16, m, 0.12, holder);
  };
  button(2, 0.8, 0.8, cx, cy, COL.dark); // enter
  button(1, 0.6, 1.9, cx + 0.53, cy, COL.light); // up, toward the screen
  button(3, 0.6, 1.9, cx - 0.53, cy, COL.light); // down
  button(5, 0.8, 0.6, cx, cy + 1.6, COL.light); // left
  button(4, 0.8, 0.6, cx, cy - 1.6, COL.light); // right
  button(6, 0.8, 1.5, cx + 1.6, cy + 2.0, COL.light); // back, at the pad's top left (11030 at x -50 LDU)
  kit.real({
    ldraw: d.ldraw,
    holder: g,
    frame: "brick",
    bottomLdu: B.bottomLdu[battery],
    roles: {
      led: { target: led, material: ledMat },
      ...Object.fromEntries([...buttons].map(([id, h]) => [`button${id}`, { target: h, material: btnMats.get(id)! }])),
    },
  });

  let lcdKey = "";
  const drawLcd = (s: RobotState) => {
    const key = `${s.lcd.join("\n")}|${Math.round(s.battery_pct)}|${s.id}`;
    if (key === lcdKey) return;
    lcdKey = key;
    const c = lcdCanvas.getContext("2d")!;
    c.setTransform(2, 0, 0, 2, 0, 0);
    c.fillStyle = "#b9c3ab";
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

  return {
    group: g,
    dims: d,
    portAt(p) {
      const k = "1234".includes(p) ? `port_${p}` : "ABCD".includes(p) ? `port_${p}` : null;
      if (!k || !d.at[k]) throw new Error(`the brick has no port ${p}`);
      const [px, py, pz] = d.at[k]!;
      return new THREE.Vector3(px + Math.sign(px) * 0.05, py, pz);
    },
    update(s, timeS) {
      // the LED: 0 off, 1-3 steady green/red/orange, 4-6 flashing, 7-9 pulsing
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
      ledMat.emissiveIntensity = 3 * level;
      for (const [id, m] of btnMats) m.emissive.setHex(s.buttons.includes(id) ? 0x553311 : 0x000000);
      // a pressed button sinks a little, as the real one does
      for (const [id, b] of buttons) b.position.y = s.buttons.includes(id) ? -0.08 : 0;
      drawLcd(s);
    },
  };
}

function brickTopTexture(): THREE.CanvasTexture {
  // seen from above with the screen end on the right: 3.8 cm along x is 380 px, the brick's width 580 px
  const c = document.createElement("canvas");
  c.width = 380;
  c.height = 580;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = "#d01012";
  g.fillRect(30, 26, 60, 60);
  g.fillStyle = "#fff";
  g.font = "bold 20px Arial, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.save();
  g.translate(60, 56);
  g.rotate(-Math.PI / 2);
  g.fillText("LEGO", 0, 1);
  g.restore();
  g.fillStyle = "#8a8f94";
  g.save();
  g.translate(140, 290);
  g.rotate(-Math.PI / 2);
  g.font = "600 28px Arial, sans-serif";
  g.fillText("MINDSTORMS", 0, 0);
  g.font = "bold 60px Arial, sans-serif";
  g.fillText("EV3", 0, 58);
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  // drawn with the screen end on the right; the plane lies the other way round, so the print reads as the LCD does
  t.center.set(0.5, 0.5);
  t.rotation = Math.PI;
  return t;
}
