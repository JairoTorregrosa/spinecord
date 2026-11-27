// The EV3 Intelligent Brick (45500): 11.9 × 7.6 × 4.8 cm, a white top over a light bluish grey body, pin holes
// along its long sides, ports A-D at the screen end and 1-4 at the other. On top: the 178 × 128 screen in its dark
// window, the six buttons on a pad whose light guide is the status LED.
//
// Inside the brick's group: x toward the screen end, y to the left, z up, the bottom at z = 0.
import * as THREE from "three";
import { DIMS } from "./dims";
import { COL, P, type Kit } from "./parts";
import type { RobotState } from "./messages";

export const BRICK = { L: DIMS.brick.l, W: DIMS.brick.w, H: DIMS.brick.h };
const LCD_W = 178,
  LCD_H = 128;
const LED_RGB = [0x000000, 0x1fe05a, 0xff2a1f, 0xff9a1a];

export interface Brick {
  group: THREE.Group;
  /** Where port `p` (1..4 of the sensors, A..D of the motors) is, inside the brick's group. */
  portAt(p: string): THREE.Vector3;
  update(s: RobotState, timeS: number): void;
}

export function buildBrick(kit: Kit): Brick {
  const { mats, keep } = kit;
  const { L, W, H } = BRICK;
  const g = new THREE.Group();
  // the body: light grey below, the white top cap over it, the port ends in anthracite
  kit.box(L - 0.3, W, H * 0.55, 0, 0, H * 0.275, mats.light, 0.45, g);
  kit.box(L, W - 0.02, H * 0.52, 0, 0, H * 0.74, mats.white, 0.6, g);
  for (const end of [1, -1]) kit.box(0.5, W - 0.9, H * 0.5, end * (L / 2 - 0.3), 0, H * 0.3, mats.anthracite, 0.15, g);
  // pin holes along both long sides, where beams are pinned to the brick
  for (const x of [-4.0, -2.4, 2.4, 4.0]) kit.axleCyl(0.25, W + 0.04, x, 0, H * 0.3, mats.black, g, 14);
  // the ports: four sockets at each end
  const portY = (i: number) => (1.5 - i) * 1.55;
  for (let i = 0; i < 4; i++)
    for (const end of [1, -1]) kit.box(0.2, 1.1, 0.75, end * (L / 2 - 0.02), portY(i), H * 0.3, mats.black, 0.08, g);
  // the print on the top: logo and name, at the end away from the screen
  const top = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(4.2, W - 1.4)),
    keep(new THREE.MeshStandardMaterial({ map: keep(brickTopTexture()), roughness: 0.35, transparent: true })),
  );
  top.rotation.x = -Math.PI / 2;
  top.position.copy(P(-L / 2 + 2.6, 0, H + 0.005));
  g.add(top);
  // the screen in its window
  const sx = L / 2 - 2.75;
  kit.box(4.1, 5.6, 0.12, sx, 0, H - 0.02, mats.anthracite, 0.3, g);
  const lcdCanvas = document.createElement("canvas");
  lcdCanvas.width = LCD_W * 2;
  lcdCanvas.height = LCD_H * 2;
  const lcdTex = keep(new THREE.CanvasTexture(lcdCanvas));
  lcdTex.colorSpace = THREE.SRGBColorSpace;
  lcdTex.anisotropy = 4;
  const lcd = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(4.27, 3.07)),
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
  );
  lcd.rotation.x = -Math.PI / 2;
  lcd.rotation.z = -Math.PI / 2; // its width runs across the brick
  lcd.position.copy(P(sx, 0, H + 0.05));
  g.add(lcd);
  // the button pad: its rim is the LED's light guide
  const cx = -0.95;
  const ledMat = kit.live(
    keep(new THREE.MeshStandardMaterial({ color: 0x3a3f44, emissive: 0x000000, roughness: 0.3 })),
  );
  kit.box(3.7, 4.3, 0.1, cx, 0, H + 0.02, ledMat, 0.9, g);
  kit.box(3.3, 3.9, 0.12, cx, 0, H + 0.04, mats.anthracite, 0.8, g);
  const btnMats = new Map<number, THREE.MeshStandardMaterial>();
  const button = (id: number, lx: number, ly: number, x: number, y: number, color: number) => {
    const m = kit.live(keep(new THREE.MeshStandardMaterial({ color, roughness: 0.35, emissive: 0x000000 })));
    btnMats.set(id, m);
    kit.box(lx, ly, 0.28, x, y, H + 0.18, m, 0.12, g);
  };
  button(2, 1.05, 1.05, cx, 0, COL.dark); // enter
  button(1, 0.75, 1.5, cx + 1.15, 0, COL.light); // up
  button(3, 0.75, 1.5, cx - 1.15, 0, COL.light); // down
  button(5, 1.5, 0.75, cx, 1.25, COL.light); // left
  button(4, 1.5, 0.75, cx, -1.25, COL.light); // right
  button(6, 0.9, 1.0, sx - 2.55, 2.65, COL.dark); // back, under the screen at the left
  // the speaker grille on the right of the print
  for (let i = 0; i < 5; i++)
    kit.box(0.14, 1.6, 0.04, -L / 2 + 1.0 + i * 0.32, -W / 2 + 1.5, H + 0.01, mats.light, 0, g);

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
    portAt(p) {
      const i = "1234".includes(p) ? Number(p) - 1 : "ABCD".indexOf(p);
      if (i < 0) throw new Error(`the brick has no port ${p}`);
      const end = "1234".includes(p) ? -1 : 1;
      return new THREE.Vector3(end * (L / 2 + 0.1), portY(i), H * 0.3);
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
      drawLcd(s);
    },
  };
}

function brickTopTexture(): THREE.CanvasTexture {
  // seen from above with the screen end on the right: 4.2 cm along x is 420 px, the brick's width 620 px
  const c = document.createElement("canvas");
  c.width = 420;
  c.height = 620;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = "#d01012";
  g.fillRect(40, 30, 64, 64);
  g.fillStyle = "#fff";
  g.font = "bold 22px Arial, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.save();
  g.translate(72, 62);
  g.rotate(-Math.PI / 2);
  g.fillText("LEGO", 0, 1);
  g.restore();
  g.fillStyle = "#8a8f94";
  g.save();
  g.translate(150, 310);
  g.rotate(-Math.PI / 2);
  g.font = "600 30px Arial, sans-serif";
  g.fillText("MINDSTORMS", 0, 0);
  g.font = "bold 64px Arial, sans-serif";
  g.fillText("EV3", 0, 62);
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  // drawn with the screen end on the right; the plane lies the other way round, so the print reads as the LCD does
  t.center.set(0.5, 0.5);
  t.rotation = Math.PI;
  return t;
}
