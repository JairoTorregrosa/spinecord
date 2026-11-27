// The format of the real meshes scripts/ldraw-meshes.ts writes (its header describes the layout), read back into
// three.js geometries with normals creased at 30°: LDraw's round primitives are 16-sided, so faces 22.5° apart
// are smoothed and a box's edges stay sharp.
import * as THREE from "three";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";

export interface Group {
  role: string;
  colour: number;
  rgb: number;
  alpha: number;
  double: boolean;
  geometry: THREE.BufferGeometry;
}
export interface Decoded {
  part: string;
  triangles: number;
  groups: Group[];
}

/** Reads one converted part (the layout is in scripts/ldraw-meshes.ts). */
export function decode(part: string, buf: ArrayBuffer): Decoded {
  const bytes = new Uint8Array(buf);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "SCM1") throw new Error(`${part}: not a converted mesh`);
  const n = new DataView(buf).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n))) as {
    quantum: number;
    groups: {
      role: string;
      colour: number;
      rgb: number;
      alpha: number;
      double: boolean;
      vertices: number;
      triangles: number;
      positions: number;
      indices: number;
      wide: boolean;
    }[];
  };
  const base = 8 + n + ((4 - ((8 + n) % 4)) % 4);
  let triangles = 0;
  const groups = header.groups.map((g) => {
    const steps = new Int16Array(buf, base + g.positions, g.vertices * 3);
    const pos = new Float32Array(g.vertices * 3);
    for (let a = 0; a < 3; a++) {
      let v = 0;
      for (let i = 0; i < g.vertices; i++) {
        v += steps[a * g.vertices + i]!;
        pos[i * 3 + a] = v * header.quantum;
      }
    }
    const count = g.triangles * 3;
    const di = g.wide ? new Int32Array(buf, base + g.indices, count) : new Int16Array(buf, base + g.indices, count);
    const idx = new Uint32Array(count);
    let last = 0;
    for (let i = 0; i < count; i++) idx[i] = last += di[i]!;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const creased = toCreasedNormals(geo, (30 * Math.PI) / 180);
    geo.dispose();
    creased.computeBoundingSphere();
    triangles += g.triangles;
    return { role: g.role, colour: g.colour, rgb: g.rgb, alpha: g.alpha, double: g.double, geometry: creased };
  });
  return { part, triangles, groups };
}
