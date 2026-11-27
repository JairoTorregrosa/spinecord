// The world of a twin in 3D: a mat on a wooden floor with its zones (paper), lines (tape) and named points
// (marker), a faint 10 cm grid and cm rulers along its edges to measure by; plywood walls around it and
// cardboard boxes as obstacles. Walls, and boxes without a height, are drawn higher than the distance sensor,
// because for the physics they are as tall as they need to be; a box with a height stands as tall as it is, and
// one the robot can push (it has a mass) is tinted blue. Every texture is drawn here on a canvas.
//
// World (x right, y up, cm) to three.js: X = x, Z = -y, Y up.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Obstacle, WorldShape } from "./messages";

/** Floor colours of the colour ids of contract §2.2, as sim-world draws them. */
export const COLOR_RGB = ["#282828", "#141414", "#3478dc", "#3caa5a", "#f5cd3c", "#dc463c", "#f5f3ec", "#8c5f3c"];

export const toScene = (x: number, y: number, h = 0): THREE.Vector3 => new THREE.Vector3(x, h, -y);

export interface Arena {
  group: THREE.Group;
  /** The obstacle meshes; each one's `userData.id` is its box's id. */
  boxes: THREE.Mesh[];
  setBoxes(boxes: Obstacle[]): void;
  /** Highlights obstacle `i` (or none) as the one a click would take away. */
  /** Lights the box with this id (null: none). */
  highlight(id: string | null): void;
  dispose(): void;
}

/** What lies just under the mat (its own edge, the wooden floor) is drawn as if a little farther away: seen
 *  from the top camera, a few metres up, the depth buffer cannot tell a millimetre apart and the mat's grey edge
 *  would cover its print. The offset grows with distance, so the mat wins from any height. */
const BEHIND = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 } as const;

let seed = 1;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/** A tile of fine grain, laid over a surface so it does not read as flat colour. */
function grain(size: number, alpha: number, streak = 0): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const img = g.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const v = 128 + (rnd() - 0.5) * 90 + (streak ? Math.sin((x / size) * Math.PI * 2 * streak) * 30 : 0);
    img.data[4 * i] = img.data[4 * i + 1] = img.data[4 * i + 2] = v;
    img.data[4 * i + 3] = alpha * 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

export function buildArena(w: WorldShape, tallest: number, maxAnisotropy = 8): Arena {
  const group = new THREE.Group();
  group.name = `world ${w.name}`;
  const owned: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => (owned.push(x), x);
  seed = 7;

  // ---------------------------------------------------------------- the mat
  // 10 px per cm keeps a 2 cm tape and 3 mm ruler ticks sharp up close; at most 4096 px on a side
  const scale = Math.max(2, Math.min(10, 4096 / Math.max(w.width, w.height)));
  const c = document.createElement("canvas");
  c.width = Math.round(w.width * scale);
  c.height = Math.round(w.height * scale);
  const g = c.getContext("2d")!;
  // the roughness of each place, at half the size: the mat is matte, tape and marker shine a little
  const rc = document.createElement("canvas");
  rc.width = Math.ceil(c.width / 2);
  rc.height = Math.ceil(c.height / 2);
  const rg = rc.getContext("2d")!;
  rg.scale(0.5, 0.5);
  rg.fillStyle = "rgb(0,215,0)";
  rg.fillRect(0, 0, c.width, c.height);
  const X = (x: number) => x * scale,
    Y = (y: number) => (w.height - y) * scale;
  g.fillStyle = "#e3e2de";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = g.createPattern(grain(128, 0.05), "repeat")!;
  g.globalCompositeOperation = "multiply";
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = "source-over";
  // the grid: every 10 cm, stronger every 50, lines at least two texels wide so they do not shimmer from afar
  for (const [step, colour, width] of [
    [10, "rgba(80,74,64,0.16)", 0.12],
    [50, "rgba(80,74,64,0.3)", 0.18],
  ] as const) {
    g.fillStyle = colour;
    const lw = Math.max(2, width * scale);
    for (let x = step; x < w.width; x += step) g.fillRect(X(x) - lw / 2, 0, lw, c.height);
    for (let y = step; y < w.height; y += step) g.fillRect(0, Y(y) - lw / 2, c.width, lw);
  }
  // zones: coloured paper laid on the mat, its edge a shade darker
  for (const z of w.zones) {
    const colour = COLOR_RGB[z.color] ?? "#888";
    g.fillStyle = colour;
    g.fillRect(X(z.x), Y(z.y + z.h), z.w * scale, z.h * scale);
    g.fillStyle = g.createPattern(grain(64, 0.07), "repeat")!;
    g.globalCompositeOperation = "multiply";
    g.fillRect(X(z.x), Y(z.y + z.h), z.w * scale, z.h * scale);
    g.globalCompositeOperation = "source-over";
    // printed paper is never as saturated as a screen's colour
    g.fillStyle = "rgba(150,146,138,0.14)";
    g.fillRect(X(z.x), Y(z.y + z.h), z.w * scale, z.h * scale);
    g.strokeStyle = "rgba(0,0,0,0.18)";
    g.lineWidth = Math.max(1, 0.15 * scale);
    g.strokeRect(X(z.x), Y(z.y + z.h), z.w * scale, z.h * scale);
    rg.fillStyle = "rgb(0,235,0)";
    rg.fillRect(X(z.x), Y(z.y + z.h), z.w * scale, z.h * scale);
    if (z.label) {
      g.fillStyle = z.color === 1 || z.color === 2 || z.color === 7 ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.6)";
      g.font = `800 ${Math.round(4.5 * scale)}px system-ui, sans-serif`;
      g.textBaseline = "top";
      g.fillText(z.label.toUpperCase(), X(z.x) + 2 * scale, Y(z.y + z.h) + 2 * scale);
    }
  }
  // lines: black electrical tape, its ends cut square
  g.lineCap = rg.lineCap = "butt";
  g.lineJoin = rg.lineJoin = "round";
  for (const l of w.lines) {
    const path = (ctx: CanvasRenderingContext2D) => {
      ctx.beginPath();
      l.points.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
      if (l.closed) ctx.closePath();
    };
    g.strokeStyle = "#161616";
    g.lineWidth = l.width * scale;
    path(g);
    g.stroke();
    g.strokeStyle = "rgba(255,255,255,0.06)";
    g.lineWidth = l.width * scale * 0.35;
    path(g);
    g.stroke();
    rg.strokeStyle = "rgb(0,90,0)";
    rg.lineWidth = l.width * scale;
    path(rg);
    rg.stroke();
  }
  // named points: a circle and a cross drawn with a marker, the name beside it
  for (const p of w.points) {
    g.strokeStyle = "#4b3cc4";
    g.fillStyle = "#4b3cc4";
    g.lineWidth = Math.max(2, 0.35 * scale);
    g.lineCap = "round";
    g.beginPath();
    g.arc(X(p.x), Y(p.y), p.radius * scale, 0, Math.PI * 2);
    g.stroke();
    const k = Math.min(1.5, p.radius / 3) * scale;
    g.beginPath();
    g.moveTo(X(p.x) - k, Y(p.y));
    g.lineTo(X(p.x) + k, Y(p.y));
    g.moveTo(X(p.x), Y(p.y) - k);
    g.lineTo(X(p.x), Y(p.y) + k);
    g.stroke();
    g.font = `700 ${Math.round(3.2 * scale)}px system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "top";
    g.fillText(p.label, X(p.x), Y(p.y) + (p.radius + 1) * scale);
    g.textAlign = "start";
  }
  // rulers along every edge: a tick each cm, longer each 5 and 10, the number each 10
  g.fillStyle = "rgba(40,36,30,0.75)";
  g.font = `600 ${Math.round(2.2 * scale)}px system-ui, sans-serif`;
  const tw = Math.max(1.5, 0.12 * scale);
  for (let x = 1; x < w.width; x++) {
    const len = (x % 10 === 0 ? 2.6 : x % 5 === 0 ? 1.6 : 0.9) * scale;
    g.fillRect(X(x) - tw / 2, Y(0) - len, tw, len);
    g.fillRect(X(x) - tw / 2, Y(w.height), tw, len);
    if (x % 10 === 0) {
      g.textAlign = "center";
      g.textBaseline = "bottom";
      g.fillText(String(x), X(x), Y(0) - 3 * scale);
      g.textBaseline = "top";
      g.fillText(String(x), X(x), Y(w.height) + 3 * scale);
    }
  }
  for (let y = 1; y < w.height; y++) {
    const len = (y % 10 === 0 ? 2.6 : y % 5 === 0 ? 1.6 : 0.9) * scale;
    g.fillRect(X(0), Y(y) - tw / 2, len, tw);
    g.fillRect(X(w.width) - len, Y(y) - tw / 2, len, tw);
    if (y % 10 === 0) {
      g.textBaseline = "middle";
      g.textAlign = "left";
      g.fillText(String(y), X(0) + 3.2 * scale, Y(y));
      g.textAlign = "right";
      g.fillText(String(y), X(w.width) - 3.2 * scale, Y(y));
    }
  }
  g.textAlign = "start";
  // where the robot starts: its footprint in pencil, an arrow for its heading
  {
    const sx = X(w.start.x),
      sy = Y(w.start.y),
      a = (-w.start.heading_deg * Math.PI) / 180;
    g.save();
    g.translate(sx, sy);
    g.rotate(a);
    g.strokeStyle = "rgba(70,66,58,0.55)";
    g.lineWidth = Math.max(1.5, 0.25 * scale);
    g.setLineDash([1.2 * scale, 1 * scale]);
    g.strokeRect(
      -w.body.back_cm * scale,
      -w.body.half_width_cm * scale,
      (w.body.front_cm + w.body.back_cm) * scale,
      2 * w.body.half_width_cm * scale,
    );
    g.setLineDash([]);
    g.beginPath();
    g.moveTo(w.body.front_cm * scale + 3 * scale, 0);
    g.lineTo(w.body.front_cm * scale + 0.6 * scale, -1.8 * scale);
    g.lineTo(w.body.front_cm * scale + 0.6 * scale, 1.8 * scale);
    g.closePath();
    g.fillStyle = "rgba(70,66,58,0.55)";
    g.fill();
    g.restore();
  }
  const floorTex = keep(new THREE.CanvasTexture(c));
  floorTex.colorSpace = THREE.SRGBColorSpace;
  floorTex.anisotropy = maxAnisotropy;
  const roughTex = keep(new THREE.CanvasTexture(rc));
  roughTex.anisotropy = maxAnisotropy;
  const floor = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(w.width, w.height)),
    keep(new THREE.MeshStandardMaterial({ map: floorTex, roughnessMap: roughTex, roughness: 1 })),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(w.width / 2, 0, -w.height / 2);
  floor.receiveShadow = true;
  floor.name = "floor";
  group.add(floor);

  // the wooden floor of the room around the arena
  const around = Math.max(w.width, w.height) * 8;
  const woodTex = keep(new THREE.CanvasTexture(parquet()));
  woodTex.colorSpace = THREE.SRGBColorSpace;
  woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping;
  woodTex.repeat.set(around / 120, around / 120);
  woodTex.anisotropy = maxAnisotropy;
  const ground = new THREE.Mesh(
    keep(new THREE.CircleGeometry(around / 2, 64)),
    // pushed back in depth: from far above, 3 mm under the mat is less than the depth buffer can tell apart
    keep(new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.6, ...BEHIND })),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(w.width / 2, -0.3, -w.height / 2);
  ground.receiveShadow = true;
  group.add(ground);
  // the mat's thickness, so it lies on the wood rather than being painted on it
  const matEdge = new THREE.Mesh(
    keep(new THREE.BoxGeometry(w.width + 1, 0.3, w.height + 1)),
    keep(new THREE.MeshStandardMaterial({ color: 0x8c877d, roughness: 0.9, ...BEHIND })),
  );
  matEdge.position.set(w.width / 2, -0.16, -w.height / 2);
  matEdge.receiveShadow = true;
  group.add(matEdge);

  // ---------------------------------------------------------------- walls: plywood boards
  const wallH = Math.max(12, Math.min(40, tallest + 4));
  const T = 1.8;
  const plyTex = keep(new THREE.CanvasTexture(plywood()));
  plyTex.colorSpace = THREE.SRGBColorSpace;
  plyTex.wrapS = plyTex.wrapT = THREE.RepeatWrapping;
  plyTex.anisotropy = maxAnisotropy;
  const wallMat = keep(new THREE.MeshStandardMaterial({ map: plyTex, roughness: 0.62 }));
  const boards: THREE.BufferGeometry[] = [];
  const wall = (x: number, y: number, lx: number, ly: number) => {
    const geo = new THREE.BoxGeometry(lx, wallH, ly);
    // the grain at its real size: the texture is 60 cm of board
    const uv = geo.attributes.uv!;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * Math.max(lx, ly)) / 60, (uv.getY(i) * wallH) / 60);
    geo.translate(x, wallH / 2, -y);
    boards.push(geo);
  };
  wall(w.width / 2, -T / 2, w.width + 2 * T, T);
  wall(w.width / 2, w.height + T / 2, w.width + 2 * T, T);
  wall(-T / 2, w.height / 2, T, w.height);
  wall(w.width + T / 2, w.height / 2, T, w.height);
  // one mesh for the four boards: one draw call
  const walls = new THREE.Mesh(keep(mergeGeometries(boards, false)!), wallMat);
  for (const b of boards) b.dispose();
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);

  // ---------------------------------------------------------------- obstacles: cardboard boxes
  const boxH = Math.max(15, Math.min(45, tallest + 6));
  // one texture for a box: its sides on the left half, its top on the right, so a box is one draw call
  const boxTex = keep(new THREE.CanvasTexture(cardboard()));
  boxTex.colorSpace = THREE.SRGBColorSpace;
  boxTex.anisotropy = maxAnisotropy;
  const boxMat = keep(new THREE.MeshStandardMaterial({ map: boxTex, roughness: 0.86 }));
  // a box the robot can push (it has a mass) is lighter cardboard with a blue tint: it moves, a fixed one does not
  const pushMat = keep(
    new THREE.MeshStandardMaterial({ map: boxTex, color: 0x6fa8ff, emissive: 0x0a2050, roughness: 0.8 }),
  );
  const hot = keep(
    new THREE.MeshStandardMaterial({ map: boxTex, color: 0xff9c8c, emissive: 0x501010, roughness: 0.8 }),
  );
  const boxGroup = new THREE.Group();
  group.add(boxGroup);
  const meshes: THREE.Mesh[] = [];
  const temp: { dispose(): void }[] = [];
  const setBoxes = (boxes: Obstacle[]) => {
    for (const m of meshes) boxGroup.remove(m);
    for (const t of temp.splice(0)) t.dispose();
    meshes.length = 0;
    for (const b of boxes) {
      // a box with a height stands as tall as it is; one without is taller than any sensor looks over
      const bh = b.height_cm ?? boxH;
      const geo = new THREE.BoxGeometry(b.w, bh, b.h);
      // faces in order +x, -x, +y, -y, +z, -z, four vertices each: the top (+y) takes the atlas's right half
      const uv = geo.attributes.uv!;
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) / 2 + (Math.floor(i / 4) === 2 ? 0.5 : 0));
      temp.push(geo);
      const own = b.mass_g === undefined ? boxMat : pushMat;
      const m = new THREE.Mesh(geo, own);
      m.position.copy(toScene(b.x + b.w / 2, b.y + b.h / 2, bh / 2));
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.id = b.id;
      m.userData.own = own;
      boxGroup.add(m);
      meshes.push(m);
    }
  };
  setBoxes(w.boxes);

  return {
    group,
    boxes: meshes,
    setBoxes,
    highlight(id) {
      for (const m of meshes) m.material = m.userData.id === id ? hot : (m.userData.own as THREE.Material);
    },
    dispose() {
      for (const t of temp) t.dispose();
      for (const o of owned) o.dispose();
    },
  };
}

/** Oak parquet: planks 10 × 60 cm in offset rows; the canvas is 120 × 120 cm. */
function parquet(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 1024;
  const g = c.getContext("2d")!;
  const px = 1024 / 120;
  for (let row = 0; row < 12; row++) {
    const off = (row % 2) * 30 + (row % 3) * 10;
    for (let k = -1; k < 3; k++) {
      const x0 = (k * 60 + off) * px;
      const tone = 0.85 + rnd() * 0.3;
      g.fillStyle = `rgb(${Math.round(168 * tone)},${Math.round(124 * tone)},${Math.round(84 * tone)})`;
      g.fillRect(x0, row * 10 * px, 60 * px, 10 * px);
      // the grain: long thin streaks along the plank
      for (let s = 0; s < 22; s++) {
        g.fillStyle = `rgba(${rnd() < 0.5 ? "70,45,25" : "235,205,160"},${0.05 + rnd() * 0.08})`;
        g.fillRect(
          x0 + rnd() * 10 * px,
          row * 10 * px + rnd() * 10 * px,
          (25 + rnd() * 35) * px,
          0.25 * px + rnd() * px,
        );
      }
      g.fillStyle = "rgba(40,25,15,0.55)";
      g.fillRect(x0, row * 10 * px, 0.18 * px, 10 * px);
    }
    g.fillStyle = "rgba(40,25,15,0.5)";
    g.fillRect(0, row * 10 * px, 1024, 0.18 * px);
  }
  return c;
}

/** Birch plywood, 60 × 60 cm: pale, with a soft long grain. */
function plywood(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = "#dcc7a3";
  g.fillRect(0, 0, 512, 512);
  for (let s = 0; s < 140; s++) {
    g.strokeStyle = `rgba(${rnd() < 0.6 ? "150,110,70" : "245,230,200"},${0.06 + rnd() * 0.1})`;
    g.lineWidth = 0.5 + rnd() * 2;
    const y = rnd() * 512;
    g.beginPath();
    g.moveTo(0, y);
    for (let x = 0; x <= 512; x += 64) g.lineTo(x, y + Math.sin(x / 90 + s) * 6);
    g.stroke();
  }
  return c;
}

/** Brown corrugated cardboard, 1024 × 512: on the left a side with its fluting faintly showing and a printed
 *  mark, on the right the top with the seam between its flaps under a strip of packing tape. */
function cardboard(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 512;
  const g = c.getContext("2d")!;
  for (const top of [false, true]) {
    g.save();
    g.translate(top ? 512 : 0, 0);
    g.beginPath();
    g.rect(0, 0, 512, 512);
    g.clip();
    g.fillStyle = "#b8895a";
    g.fillRect(0, 0, 512, 512);
    g.globalCompositeOperation = "multiply";
    g.fillStyle = g.createPattern(grain(128, 0.12, top ? 0 : 16), "repeat")!;
    g.fillRect(0, 0, 512, 512);
    g.globalCompositeOperation = "source-over";
    // the edges a little darker and worn
    for (const vertical of [false, true]) {
      const edge = vertical ? g.createLinearGradient(0, 0, 0, 512) : g.createLinearGradient(0, 0, 512, 0);
      edge.addColorStop(0, "rgba(80,50,25,0.28)");
      edge.addColorStop(0.03, "rgba(80,50,25,0)");
      edge.addColorStop(0.97, "rgba(80,50,25,0)");
      edge.addColorStop(1, "rgba(80,50,25,0.28)");
      g.fillStyle = edge;
      g.fillRect(0, 0, 512, 512);
    }
    if (top) {
      g.fillStyle = "rgba(60,35,15,0.6)";
      g.fillRect(254, 0, 3, 512);
      g.fillStyle = "rgba(225,200,150,0.75)";
      g.fillRect(214, 0, 84, 512);
      g.fillStyle = "rgba(255,255,255,0.18)";
      for (let y = 0; y < 512; y += 37) g.fillRect(214, y, 84, 9);
    } else {
      // "this side up" arrows printed in brown ink
      g.fillStyle = "rgba(70,40,20,0.7)";
      for (const x of [200, 280]) {
        g.beginPath();
        g.moveTo(x, 70);
        g.lineTo(x + 22, 100);
        g.lineTo(x + 8, 100);
        g.lineTo(x + 8, 135);
        g.lineTo(x - 8, 135);
        g.lineTo(x - 8, 100);
        g.lineTo(x - 22, 100);
        g.closePath();
        g.fill();
      }
      g.fillRect(170, 145, 140, 5);
    }
    g.restore();
  }
  return c;
}
