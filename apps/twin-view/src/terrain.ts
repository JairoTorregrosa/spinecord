// The terrain of a world in 3D (WorldShape.terrain): platforms as blocks of painted plywood, ramps as wedges, each
// edge you can fall off or be stopped by drawn as a dark line, and a label on every piece with its height (a ramp:
// both ends and its slope) that stays legible from the top camera. A piece is shaded warmer the higher it stands, and
// a ramp's top carries a contour line every CONTOUR_CM, so the top view reads heights at a glance.
//
// World (x right, y up, cm) to three.js: X = x, Z = -y, Y up.
import * as THREE from "three";
import type { RobotState, TerrainPiece } from "./messages";

const CONTOUR_CM = 2;

/** The surface height of a piece at its four corners: [x0y0, x1y0, x1y1, x0y1] (world x, y). */
export function cornerHeights(p: TerrainPiece): [number, number, number, number] {
  const lo = p.low_cm,
    hi = p.high_cm;
  switch (p.rises) {
    case "east":
      return [lo, hi, hi, lo];
    case "west":
      return [hi, lo, lo, hi];
    case "north":
      return [lo, lo, hi, hi];
    case "south":
      return [hi, hi, lo, lo];
    default:
      return [hi, hi, hi, hi];
  }
}
/** The surface height (cm) at (x, y): the piece there (where two touch, the higher), else the floor (0). */
export function heightAt(pieces: readonly TerrainPiece[], x: number, y: number): number {
  let z = 0;
  for (const p of pieces) {
    if (x < p.x || x > p.x + p.w || y < p.y || y > p.y + p.h) continue;
    const f =
      p.rises === "east"
        ? (x - p.x) / p.w
        : p.rises === "west"
          ? (p.x + p.w - x) / p.w
          : p.rises === "north"
            ? (y - p.y) / p.h
            : p.rises === "south"
              ? (p.y + p.h - y) / p.h
              : 1;
    z = Math.max(z, p.low_cm + (p.high_cm - p.low_cm) * f);
  }
  return z;
}
/** A ramp's slope in degrees (0 for a platform). */
export function slopeDeg(p: TerrainPiece): number {
  if (!p.rises) return 0;
  const run = p.rises === "east" || p.rises === "west" ? p.w : p.h;
  return (Math.atan2(p.high_cm - p.low_cm, run) * 180) / Math.PI;
}
/** What the label of a piece says, in the person's words: its height, or a ramp's ends and slope. */
export function pieceLabel(p: TerrainPiece): string {
  if (p.kind === "platform") return `${pieceName(p.id)} · ${cm(p.high_cm)}`;
  return `${pieceName(p.id)} · ${cm(p.low_cm)} → ${cm(p.high_cm)} · ${Math.round(slopeDeg(p))}°`;
}
/** A piece's id as a person reads it: "orilla_b" is "orilla b". */
export function pieceName(id: string): string {
  return id.replace(/[_-]+/g, " ").trim();
}
/** The words of the terrain chip, or null when there is nothing to say. */
export function terrainWords(st: Pick<RobotState, "fallen" | "block">): string | null {
  if (st.fallen)
    return st.fallen.from === "floor"
      ? "Se cayó: ponlo de pie o restaura el mundo"
      : `Se cayó de ${pieceName(st.fallen.from)}: ponlo de pie o restaura el mundo`;
  if (st.block?.by === "step")
    return `Escalón muy alto en ${pieceName(st.block.with)} (${cm(st.block.rise_cm)}): rodéalo`;
  if (st.block?.by === "steep") return `Muy empinado (${Math.round(st.block.slope_deg)}°): patina`;
  return null;
}
/** A height in Spanish, to the tenth: "2,5 cm". */
export function cm(v: number): string {
  return `${(Math.round(v * 10) / 10).toLocaleString("es")} cm`;
}

/** Colour of a surface `z` cm high: a sand tone that warms and darkens with height. */
function tone(z: number, top: number): THREE.Color {
  const t = top > 0 ? Math.min(1, z / top) : 0;
  return new THREE.Color().setHSL(0.09 - 0.04 * t, 0.45 + 0.2 * t, 0.72 - 0.25 * t);
}

/** A text label on a canvas sprite, the same size on screen from any camera (`tall`: its height, share of the view). */
function label(text: string, tall = 0.026): THREE.Sprite {
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  const px = 44;
  g.font = `700 ${px}px system-ui, sans-serif`;
  c.width = Math.ceil(g.measureText(text).width) + 28;
  c.height = px + 22;
  g.font = `700 ${px}px system-ui, sans-serif`;
  g.fillStyle = "rgba(25,20,15,0.78)";
  g.beginPath();
  g.roundRect(0, 0, c.width, c.height, 14);
  g.fill();
  g.fillStyle = "#fff6e6";
  g.textBaseline = "middle";
  g.fillText(text, 14, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, transparent: true }));
  s.scale.set((tall * c.width) / c.height, tall, 1);
  s.renderOrder = 10;
  return s;
}

export interface TerrainView {
  group: THREE.Group;
  /** The solid meshes (for the hand's ray: the robot is set down on top of them). */
  solids: THREE.Mesh[];
  dispose(): void;
}

/** The terrain's meshes, edges and labels. */
export function buildTerrain(pieces: readonly TerrainPiece[]): TerrainView {
  const group = new THREE.Group();
  group.name = "terrain";
  const owned: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => (owned.push(x), x);
  const solids: THREE.Mesh[] = [];
  const top = Math.max(1, ...pieces.map((p) => p.high_cm));
  const edgeMat = keep(new THREE.LineBasicMaterial({ color: 0x1d140c }));
  const lineMat = keep(new THREE.LineBasicMaterial({ color: 0x5a3c1e, transparent: true, opacity: 0.55 }));
  for (const p of pieces) {
    const [h00, h10, h11, h01] = cornerHeights(p);
    const x0 = p.x,
      x1 = p.x + p.w,
      y0 = p.y,
      y1 = p.y + p.h;
    // eight corners: the four on the floor, the four on the surface (scene coordinates)
    const v = (x: number, y: number, z: number) => [x, z, -y];
    const B = [v(x0, y0, 0), v(x1, y0, 0), v(x1, y1, 0), v(x0, y1, 0)];
    const T = [v(x0, y0, h00), v(x1, y0, h10), v(x1, y1, h11), v(x0, y1, h01)];
    const pos: number[] = [],
      col: number[] = [];
    const quad = (
      a: number[],
      b: number[],
      c: number[],
      d: number[],
      za: number,
      zb: number,
      zc: number,
      zd: number,
      dark = 1,
    ) => {
      for (const [q, z] of [
        [a, za],
        [b, zb],
        [c, zc],
        [a, za],
        [c, zc],
        [d, zd],
      ] as [number[], number][]) {
        pos.push(...q);
        const k = tone(z, top).multiplyScalar(dark);
        col.push(k.r, k.g, k.b);
      }
    };
    // the top, then each side (a side of zero height is nothing); sides are shaded darker so edges read in 3D
    quad(T[0]!, T[1]!, T[2]!, T[3]!, h00, h10, h11, h01);
    quad(B[0]!, B[1]!, T[1]!, T[0]!, 0, 0, h10, h00, 0.62); // south
    quad(B[1]!, B[2]!, T[2]!, T[1]!, 0, 0, h11, h10, 0.72); // east
    quad(B[2]!, B[3]!, T[3]!, T[2]!, 0, 0, h01, h11, 0.62); // north
    quad(B[3]!, B[0]!, T[0]!, T[3]!, 0, 0, h00, h01, 0.72); // west
    const geo = keep(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geo,
      keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide })),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.terrain = p.id;
    group.add(mesh);
    solids.push(mesh);
    // the edges of the top: where a body can be stopped or fall
    const lift = 0.05;
    const edge: number[] = [];
    for (let i = 0; i < 4; i++) {
      const a = T[i]!,
        b = T[(i + 1) % 4]!;
      edge.push(a[0]!, a[1]! + lift, a[2]!, b[0]!, b[1]! + lift, b[2]!);
    }
    for (let i = 0; i < 4; i++) edge.push(...B[i]!, ...T[i]!);
    const eg = keep(new THREE.BufferGeometry());
    eg.setAttribute("position", new THREE.Float32BufferAttribute(edge, 3));
    group.add(new THREE.LineSegments(eg, edgeMat));
    // a ramp's contours: a line across it every CONTOUR_CM of height
    if (p.rises) {
      const cl: number[] = [];
      const along = p.rises === "east" || p.rises === "west";
      for (let z = Math.ceil(p.low_cm / CONTOUR_CM) * CONTOUR_CM; z < p.high_cm; z += CONTOUR_CM) {
        if (z <= p.low_cm) continue;
        const f = (z - p.low_cm) / (p.high_cm - p.low_cm);
        if (along) {
          const x = p.rises === "east" ? x0 + f * p.w : x1 - f * p.w;
          cl.push(...v(x, y0, z + lift), ...v(x, y1, z + lift));
        } else {
          const y = p.rises === "north" ? y0 + f * p.h : y1 - f * p.h;
          cl.push(...v(x0, y, z + lift), ...v(x1, y, z + lift));
        }
      }
      if (cl.length) {
        const cg = keep(new THREE.BufferGeometry());
        cg.setAttribute("position", new THREE.Float32BufferAttribute(cl, 3));
        group.add(new THREE.LineSegments(cg, lineMat));
      }
    }
    // its label, just above the middle of its top
    const s = label(pieceLabel(p));
    keep(s.material.map!);
    keep(s.material);
    s.position.set(x0 + p.w / 2, (h00 + h10 + h11 + h01) / 4 + 3, -(y0 + p.h / 2));
    group.add(s);
  }
  return {
    group,
    solids,
    dispose() {
      for (const o of owned) o.dispose();
    },
  };
}
