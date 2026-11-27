// The world of a twin in 3D: the floor with its zones, lines and named points, the walls around the arena and
// the obstacles. The 2D world has no heights: walls and boxes are drawn higher than the distance sensor, because
// for the physics they are as tall as they need to be.
//
// World (x right, y up, cm) to three.js: X = x, Z = -y, Y up.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { Box, WorldShape } from "./messages";

/** Floor colours of the colour ids of contract §2.2, as sim-world draws them. */
export const COLOR_RGB = ["#282828", "#141414", "#3478dc", "#3caa5a", "#f5cd3c", "#dc463c", "#f5f3ec", "#8c5f3c"];

export const toScene = (x: number, y: number, h = 0): THREE.Vector3 => new THREE.Vector3(x, h, -y);

export interface Arena {
  group: THREE.Group;
  /** The obstacle meshes, in the order of the world's boxes. */
  boxes: THREE.Mesh[];
  setBoxes(boxes: Box[]): void;
  /** Highlights obstacle `i` (or none) as the one a click would take away. */
  highlight(i: number | null): void;
  dispose(): void;
}

export function buildArena(w: WorldShape, tallest: number): Arena {
  const group = new THREE.Group();
  group.name = `world ${w.name}`;
  const owned: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => (owned.push(x), x);

  // ---------------------------------------------------------------- floor
  const scale = Math.max(2, Math.min(6, 2048 / Math.max(w.width, w.height)));
  const c = document.createElement("canvas");
  c.width = Math.round(w.width * scale);
  c.height = Math.round(w.height * scale);
  const g = c.getContext("2d")!;
  const X = (x: number) => x * scale,
    Y = (y: number) => (w.height - y) * scale;
  g.fillStyle = "#efeee8";
  g.fillRect(0, 0, c.width, c.height);
  for (let x = 0; x <= w.width; x += 10) {
    g.fillStyle = x % 50 === 0 ? "#d3d0c6" : "#e2e0d8";
    g.fillRect(X(x) - (x % 50 === 0 ? 1 : 0.5), 0, x % 50 === 0 ? 2 : 1, c.height);
  }
  for (let y = 0; y <= w.height; y += 10) {
    g.fillStyle = y % 50 === 0 ? "#d3d0c6" : "#e2e0d8";
    g.fillRect(0, Y(y) - (y % 50 === 0 ? 1 : 0.5), c.width, y % 50 === 0 ? 2 : 1);
  }
  for (const z of w.zones) {
    g.fillStyle = COLOR_RGB[z.color] ?? "#888";
    g.fillRect(X(z.x), Y(z.y + z.h), z.w * scale, z.h * scale);
    if (z.label) {
      g.fillStyle = z.color === 1 || z.color === 2 || z.color === 7 ? "#ffffffcc" : "#00000099";
      g.font = `bold ${Math.round(4 * scale)}px system-ui, sans-serif`;
      g.fillText(z.label, X(z.x) + 2 * scale, Y(z.y + z.h) + 5 * scale);
    }
  }
  g.strokeStyle = "#141414";
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const l of w.lines) {
    g.lineWidth = l.width * scale;
    g.beginPath();
    l.points.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
    if (l.closed) g.closePath();
    g.stroke();
  }
  for (const p of w.points) {
    g.setLineDash([2 * scale, 1.5 * scale]);
    g.strokeStyle = "#6b5bd6";
    g.lineWidth = 0.6 * scale;
    g.beginPath();
    g.arc(X(p.x), Y(p.y), p.radius * scale, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = "#6b5bd6";
    g.font = `600 ${Math.round(3.6 * scale)}px system-ui, sans-serif`;
    g.textAlign = "center";
    g.fillText(p.label, X(p.x), Y(p.y) + 1.2 * scale);
    g.textAlign = "start";
  }
  // where the robot starts
  {
    const sx = X(w.start.x),
      sy = Y(w.start.y),
      a = (-w.start.heading_deg * Math.PI) / 180;
    g.save();
    g.translate(sx, sy);
    g.rotate(a);
    g.strokeStyle = "#9a978c";
    g.lineWidth = 0.5 * scale;
    g.setLineDash([1.5 * scale, 1.5 * scale]);
    g.strokeRect(
      -w.body.back_cm * scale,
      -w.body.half_width_cm * scale,
      (w.body.front_cm + w.body.back_cm) * scale,
      2 * w.body.half_width_cm * scale,
    );
    g.setLineDash([]);
    g.beginPath();
    g.moveTo(w.body.front_cm * scale + 3 * scale, 0);
    g.lineTo(w.body.front_cm * scale, -2 * scale);
    g.lineTo(w.body.front_cm * scale, 2 * scale);
    g.closePath();
    g.fillStyle = "#9a978c";
    g.fill();
    g.restore();
  }
  const floorTex = keep(new THREE.CanvasTexture(c));
  floorTex.colorSpace = THREE.SRGBColorSpace;
  floorTex.anisotropy = 8;
  const floor = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(w.width, w.height)),
    keep(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.92 })),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(w.width / 2, 0, -w.height / 2);
  floor.receiveShadow = true;
  floor.name = "floor";
  group.add(floor);

  // the table or floor around the arena
  const around = Math.max(w.width, w.height) * 6;
  const ground = new THREE.Mesh(
    keep(new THREE.CircleGeometry(around / 2, 64)),
    keep(new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 1 })),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(w.width / 2, -0.05, -w.height / 2);
  ground.receiveShadow = true;
  group.add(ground);

  // ---------------------------------------------------------------- walls
  const wallH = Math.max(12, Math.min(40, tallest + 4));
  const T = 2.5;
  const wallMat = keep(new THREE.MeshStandardMaterial({ color: 0xd9c3a2, roughness: 0.75 }));
  const wall = (x: number, y: number, lx: number, ly: number) => {
    const m = new THREE.Mesh(keep(new RoundedBoxGeometry(lx, wallH, ly, 2, 0.5)), wallMat);
    m.position.copy(toScene(x, y, wallH / 2));
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  };
  wall(w.width / 2, -T / 2, w.width + 2 * T, T);
  wall(w.width / 2, w.height + T / 2, w.width + 2 * T, T);
  wall(-T / 2, w.height / 2, T, w.height);
  wall(w.width + T / 2, w.height / 2, T, w.height);

  // ---------------------------------------------------------------- obstacles
  const boxH = Math.max(15, Math.min(45, tallest + 6));
  const boxMat = keep(new THREE.MeshStandardMaterial({ color: 0xc89c6b, roughness: 0.85 }));
  const hotMat = keep(new THREE.MeshStandardMaterial({ color: 0xe0574e, roughness: 0.7, emissive: 0x401010 }));
  const tapeMat = keep(new THREE.MeshStandardMaterial({ color: 0xd8c08f, roughness: 0.5 }));
  const boxGroup = new THREE.Group();
  group.add(boxGroup);
  const meshes: THREE.Mesh[] = [];
  const temp: { dispose(): void }[] = [];
  const setBoxes = (boxes: Box[]) => {
    for (const m of meshes) boxGroup.remove(m);
    for (const t of temp.splice(0)) t.dispose();
    meshes.length = 0;
    boxes.forEach((b, i) => {
      const geo = new RoundedBoxGeometry(b.w, boxH, b.h, 2, Math.min(0.8, b.w / 4, b.h / 4));
      temp.push(geo);
      const m = new THREE.Mesh(geo, boxMat);
      m.position.copy(toScene(b.x + b.w / 2, b.y + b.h / 2, boxH / 2));
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.index = i;
      const tapeGeo = new THREE.BoxGeometry(Math.min(4, b.w * 0.3), 0.08, b.h + 0.04);
      temp.push(tapeGeo);
      const tape = new THREE.Mesh(tapeGeo, tapeMat);
      tape.position.set(0, boxH / 2 + 0.02, 0);
      m.add(tape);
      boxGroup.add(m);
      meshes.push(m);
    });
  };
  setBoxes(w.boxes);

  return {
    group,
    boxes: meshes,
    setBoxes,
    highlight(i) {
      meshes.forEach((m, j) => (m.material = j === i ? hotMat : boxMat));
    },
    dispose() {
      for (const t of temp) t.dispose();
      for (const o of owned) o.dispose();
    },
  };
}
