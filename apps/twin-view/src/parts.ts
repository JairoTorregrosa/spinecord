// The kit the robot is built from: LEGO colours and plastics, and the shapes every part repeats (rounded boxes,
// cylinders, Technic beams with their holes, studs, flat cables). Static meshes are merged per material at the
// end (`mergeStatic`), so a robot of a few hundred parts costs a few dozen draw calls.
//
// Robot frame: x ahead, y to the left, z up, cm. three.js inside the robot group: X ahead, Y up, Z to the right.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** A point of the robot frame (x ahead, y left, z up) in the group's three.js frame. */
export const P = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, z, -y);

/** The robot-frame direction of a facing, turned by `yawDeg` about the vertical. */
export function facingDir(f: "forward" | "back" | "left" | "right" | "up" | "down", yawDeg = 0): THREE.Vector3 {
  const v = {
    forward: [1, 0, 0],
    back: [-1, 0, 0],
    left: [0, 1, 0],
    right: [0, -1, 0],
    up: [0, 0, 1],
    down: [0, 0, -1],
  }[f];
  return new THREE.Vector3(v[0], v[1], v[2]).applyAxisAngle(new THREE.Vector3(0, 0, 1), (yawDeg * Math.PI) / 180);
}

/** The "up" of a part that faces `dir`: the sky, or for a part that faces up or down, its back or its front. */
export function upFor(dir: THREE.Vector3, yawDeg = 0): THREE.Vector3 {
  if (Math.abs(dir.z) < 0.9) return new THREE.Vector3(0, 0, 1);
  return new THREE.Vector3(dir.z > 0 ? -1 : 1, 0, 0).applyAxisAngle(
    new THREE.Vector3(0, 0, 1),
    (yawDeg * Math.PI) / 180,
  );
}

/** The rotation (three.js frame) that turns a part built along +x with its top at +z (robot frame) to point along
 *  `dir` with its top toward `up`. */
export function orient(dir: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion {
  const ex = dir.clone().normalize();
  const ez = up.clone().addScaledVector(ex, -up.dot(ex)).normalize();
  const ey = new THREE.Vector3().crossVectors(ez, ex);
  const m = new THREE.Matrix4().makeBasis(P(ex.x, ex.y, ex.z), P(ez.x, ez.y, ez.z), P(ey.x, ey.y, ey.z).negate());
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

/** The robot-frame box of a part whose own box (robot-style axes) is `min`..`max`, turned by `q` and moved to `at`. */
export function boxOf(min: THREE.Vector3, max: THREE.Vector3, q: THREE.Quaternion, at: THREE.Vector3): THREE.Box3 {
  const b = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z);
    const t = P(v.x, v.y, v.z).applyQuaternion(q);
    b.expandByPoint(v.set(t.x + at.x, -t.z + at.y, t.y + at.z));
  }
  return b;
}

/** A robot-frame point of a part turned by `q` at `at`. */
export function pointOf(local: THREE.Vector3, q: THREE.Quaternion, at: THREE.Vector3): THREE.Vector3 {
  const t = P(local.x, local.y, local.z).applyQuaternion(q);
  return new THREE.Vector3(t.x + at.x, -t.z + at.y, t.y + at.z);
}

/** LEGO's own colours (sRGB): white, light and dark bluish grey, black, red, and the rubber of a tread. */
export const COL = {
  white: 0xf2f3f2,
  light: 0xa0a5a9,
  dark: 0x6c6e68,
  black: 0x1b2a34,
  red: 0xc91a09,
  rubber: 0x202224,
  anthracite: 0x34393e,
};
/** One LEGO stud: 0.8 cm between studs, a stud 0.48 across and 0.17 high. */
export const STUD = 0.8;

export interface Kit {
  group: THREE.Group;
  mats: Record<"white" | "light" | "dark" | "black" | "red" | "rubber" | "anthracite" | "metal", THREE.Material>;
  keep<T extends { dispose(): void }>(x: T): T;
  /** One geometry per key for the whole robot, made on first use and disposed with the robot. */
  cached(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry;
  /** Marks an object that moves or a material that changes: never merged. */
  live<T extends THREE.Object3D | THREE.Material>(x: T): T;
  add(geo: THREE.BufferGeometry, mat: THREE.Material, at: THREE.Vector3, parent?: THREE.Object3D): THREE.Mesh;
  /** A box lx (ahead) × ly (across) × lz (up) centred at (x, y, z), its edges rounded by `radius`. */
  box(
    lx: number,
    ly: number,
    lz: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
    radius?: number,
    parent?: THREE.Object3D,
  ): THREE.Mesh;
  /** A cylinder whose axis runs across the robot (y), centred at (x, y, z). */
  axleCyl(
    r: number,
    width: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
    parent?: THREE.Object3D,
    segments?: number,
  ): THREE.Mesh;
  /** A Technic beam of `holes` holes centred at (x, y, z), lying along x, its holes along `axis`. */
  beam(
    holes: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
    axis?: "y" | "z",
    parent?: THREE.Object3D,
  ): THREE.Mesh;
  /** The studs of a plate or brick nx × ny whose top is at z, centred at (x, y). */
  studs(nx: number, ny: number, x: number, y: number, z: number, mat: THREE.Material, parent?: THREE.Object3D): void;
  /** A flat EV3 cable along the points (robot frame), with a plug at each end. */
  cable(points: THREE.Vector3[]): void;
}

export function makeKit(group: THREE.Group): Kit {
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => (disposables.push(x), x);
  const liveSet = new Set<THREE.Object3D | THREE.Material>();
  const plastic = (color: number, roughness: number) =>
    keep(new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 }));
  // ABS is a glossy plastic: low roughness, a clear highlight from the room light
  const mats = {
    white: plastic(COL.white, 0.32),
    light: plastic(COL.light, 0.38),
    dark: plastic(COL.dark, 0.4),
    black: plastic(COL.black, 0.38),
    red: plastic(COL.red, 0.33),
    rubber: plastic(COL.rubber, 0.82),
    anthracite: plastic(COL.anthracite, 0.45),
    metal: keep(new THREE.MeshStandardMaterial({ color: 0xc4c8cc, roughness: 0.25, metalness: 0.9 })),
  };
  const geoCache = new Map<string, THREE.BufferGeometry>();
  const cached = (key: string, make: () => THREE.BufferGeometry) => {
    let g = geoCache.get(key);
    if (!g) geoCache.set(key, (g = keep(make())));
    return g;
  };
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, at: THREE.Vector3, parent: THREE.Object3D = group) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(at);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const kit: Kit = {
    group,
    mats,
    keep,
    cached,
    live(x) {
      liveSet.add(x);
      return x;
    },
    add,
    box(lx, ly, lz, x, y, z, mat, radius = 0, parent = group) {
      const rr = Math.min(radius, lx / 2, ly / 2, lz / 2);
      const geo = cached(`box ${r2(lx)} ${r2(ly)} ${r2(lz)} ${r2(rr)}`, () =>
        // a small radius reads the same with one bevel segment as with two, at a third of the triangles
        rr > 0 ? new RoundedBoxGeometry(lx, lz, ly, rr >= 0.4 ? 2 : 1, rr) : new THREE.BoxGeometry(lx, lz, ly),
      );
      return add(geo, mat, P(x, y, z), parent);
    },
    axleCyl(r, width, x, y, z, mat, parent = group, segments = 24) {
      const geo = cached(`cyl ${r2(r)} ${r2(width)} ${segments}`, () =>
        new THREE.CylinderGeometry(r, r, width, segments).rotateX(Math.PI / 2),
      );
      return add(geo, mat, P(x, y, z), parent);
    },
    beam(holes, x, y, z, mat, axis = "y", parent = group) {
      const geo = cached(`beam ${holes}`, () => beamGeometry(holes));
      const m = add(geo, mat, P(x, y, z), parent);
      if (axis === "z") m.rotation.x = Math.PI / 2;
      return m;
    },
    studs(nx, ny, x, y, z, mat, parent = group) {
      const geo = cached("stud", () => new THREE.CylinderGeometry(0.24, 0.24, 0.17, 12).translate(0, 0.085, 0));
      for (let i = 0; i < nx; i++)
        for (let j = 0; j < ny; j++)
          add(geo, mat, P(x + (i - (nx - 1) / 2) * STUD, y + (j - (ny - 1) / 2) * STUD, z), parent);
    },
    cable(points) {
      const curve = new THREE.CatmullRomCurve3(
        points.map((p) => P(p.x, p.y, p.z)),
        false,
        "centripetal",
      );
      // a flat ribbon 0.42 × 0.16 cm, as the EV3's RJ12 cables are
      const shape = new THREE.Shape();
      shape.moveTo(-0.08, -0.21);
      shape.lineTo(0.08, -0.21);
      shape.lineTo(0.08, 0.21);
      shape.lineTo(-0.08, 0.21);
      shape.closePath();
      const geo = keep(new THREE.ExtrudeGeometry(shape, { steps: 64, bevelEnabled: false, extrudePath: curve }));
      add(geo, mats.black, new THREE.Vector3());
      for (const [t, dir] of [
        [0, 1],
        [1, -1],
      ] as const) {
        const at = curve.getPointAt(t);
        const tan = curve.getTangentAt(t).multiplyScalar(dir);
        const plug = add(
          cached("plug", () => new RoundedBoxGeometry(1.1, 0.55, 0.9, 2, 0.12)),
          mats.anthracite,
          at,
        );
        plug.position.addScaledVector(tan, 0.5);
        plug.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), tan);
      }
    },
  };
  (kit as Kit & { _dispose: () => void; _merge: () => void })._dispose = () => {
    for (const d of disposables) d.dispose();
  };
  (kit as Kit & { _merge: () => void })._merge = () => mergeStatic(group, liveSet, keep);
  return kit;
}

export const disposeKit = (k: Kit): void => (k as Kit & { _dispose: () => void })._dispose();
export const mergeKit = (k: Kit): void => (k as Kit & { _merge: () => void })._merge();

/** A Technic beam: 0.72 cm thick and high, holes 0.8 apart, Ø 0.48, the ends round. Length along X, holes along Z. */
function beamGeometry(holes: number): THREE.BufferGeometry {
  const h = 0.36,
    len = (holes - 1) * STUD;
  const s = new THREE.Shape();
  s.moveTo(-len / 2, -h);
  s.lineTo(len / 2, -h);
  s.absarc(len / 2, 0, h, -Math.PI / 2, Math.PI / 2, false);
  s.lineTo(-len / 2, h);
  s.absarc(-len / 2, 0, h, Math.PI / 2, (3 * Math.PI) / 2, false);
  for (let i = 0; i < holes; i++) {
    const hole = new THREE.Path();
    hole.absarc(-len / 2 + i * STUD, 0, 0.24, 0, Math.PI * 2, true);
    s.holes.push(hole);
  }
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.72 - 0.08,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.04,
    bevelSegments: 1,
    curveSegments: 10,
  });
  g.translate(0, 0, -(0.72 - 0.08) / 2);
  return g;
}

/** Merges every mesh that neither moves nor changes into one mesh per material: draw calls fall from hundreds
 *  to a few dozen. The parts of each moving group are merged the same way inside that group. Transforms are baked
 *  relative to `group`, which is at the origin while the robot is built. */
function mergeStatic(
  group: THREE.Group,
  live: Set<THREE.Object3D | THREE.Material>,
  keep: <T extends { dispose(): void }>(x: T) => T,
): void {
  group.updateMatrixWorld(true);
  mergeUnder(group, group, live, keep);
  for (const o of live)
    if ((o as THREE.Object3D).isObject3D && !(o as THREE.Mesh).isMesh)
      mergeUnder(o as THREE.Object3D, group, live, keep);
}

function mergeUnder(
  root: THREE.Object3D,
  top: THREE.Group,
  live: Set<THREE.Object3D | THREE.Material>,
  keep: <T extends { dispose(): void }>(x: T) => T,
): void {
  const inv = root.matrixWorld.clone().invert();
  const byMat = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; meshes: THREE.Mesh[]; shadow: boolean }>();
  /** A mesh belongs to `root` when no other live object stands between them. */
  const ownedByRoot = (o: THREE.Object3D): boolean => {
    for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) {
      if (live.has(p) || p === top) return false;
    }
    return true;
  };
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh) return;
    const mat = m.material as THREE.Material;
    if (Array.isArray(m.material) || live.has(mat) || !ownedByRoot(m)) return;
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    for (const name of Object.keys(g.attributes))
      if (!["position", "normal", "uv"].includes(name)) g.deleteAttribute(name);
    if (!g.attributes.uv) {
      g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position!.count * 2), 2));
    }
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    let e = byMat.get(mat);
    if (!e) byMat.set(mat, (e = { geos: [], meshes: [], shadow: false }));
    e.geos.push(g);
    e.meshes.push(m);
    e.shadow ||= m.castShadow;
  });
  for (const [mat, e] of byMat) {
    if (e.meshes.length < 2) {
      for (const g of e.geos) g.dispose();
      continue;
    }
    const merged = mergeGeometries(e.geos, false);
    for (const g of e.geos) g.dispose();
    if (!merged) throw new Error(`the robot's ${mat.type} parts could not be merged`);
    for (const m of e.meshes) m.removeFromParent();
    const mesh = new THREE.Mesh(keep(merged), mat);
    mesh.castShadow = e.shadow;
    mesh.receiveShadow = true;
    mesh.name = "merged";
    root.add(mesh);
  }
}
