// Whether a frame would show anything the last one drawn did not. A frame of the scene costs as much when the robot
// stands still as when it moves; on an integrated GPU that is most of a core and a warm laptop for hours of
// watching a robot that waits for its next call. The page draws a frame only when something it would draw changed:
// any visible object's place, material, geometry or texture, the cameras, the canvas, or what the caller adds
// (the robot's camera's rectangle, a shadow to redraw).
import type * as THREE from "three";

type Colour = { r: number; g: number; b: number };
type Drawn = THREE.Object3D & {
  material?: THREE.Material | THREE.Material[];
  geometry?: THREE.BufferGeometry;
  isLight?: boolean;
  intensity?: number;
  color?: Colour;
  instanceMatrix?: THREE.BufferAttribute;
  instanceColor?: THREE.BufferAttribute | null;
  count?: number;
};
type Mat = THREE.Material & {
  color?: Colour;
  emissive?: Colour;
  emissiveIntensity?: number;
  map?: THREE.Texture | null;
  emissiveMap?: THREE.Texture | null;
};

export class Stillness {
  private readonly v: number[] = [];
  private n = 0;
  private diff = false;

  private put(x: number): void {
    if (this.n >= this.v.length || this.v[this.n] !== x) {
      this.v[this.n] = x;
      this.diff = true;
    }
    this.n++;
  }
  private colour(c: Colour | undefined): void {
    if (!c) return;
    this.put(c.r);
    this.put(c.g);
    this.put(c.b);
  }
  private texture(t: THREE.Texture | null | undefined): void {
    this.put(t ? t.id : -1);
    if (t) this.put(t.version);
  }
  private material(m: Mat): void {
    this.put(m.id);
    this.put(m.version);
    this.put(m.opacity);
    this.put(m.visible ? 1 : 0);
    this.put(m.transparent ? 1 : 0);
    this.colour(m.color);
    this.colour(m.emissive);
    if (m.emissiveIntensity !== undefined) this.put(m.emissiveIntensity);
    this.texture(m.map);
    this.texture(m.emissiveMap);
  }
  private geometry(g: THREE.BufferGeometry): void {
    this.put(g.id);
    this.put(g.drawRange.start);
    this.put(g.drawRange.count);
    for (const name in g.attributes) {
      const a = g.attributes[name] as THREE.BufferAttribute & { data?: { version: number } };
      this.put(a.version ?? a.data?.version ?? -1);
    }
    this.put(g.index ? g.index.version : -1);
  }
  private matrix(m: THREE.Matrix4): void {
    for (let i = 0; i < 16; i++) this.put(m.elements[i]!);
  }

  /**
   * True when the scene, seen by `cameras`, with `extra` (anything else the picture depends on), differs from the
   * last call; the first call is always true. Call it after the world matrices are up to date.
   */
  changed(scene: THREE.Scene, cameras: readonly THREE.Camera[], extra: readonly number[]): boolean {
    this.n = 0;
    this.diff = false;
    scene.traverseVisible((o: Drawn) => {
      this.put(o.id);
      this.put(o.layers.mask);
      this.put(o.renderOrder);
      this.matrix(o.matrixWorld);
      if (o.material) {
        if (Array.isArray(o.material)) for (const m of o.material) this.material(m as Mat);
        else this.material(o.material as Mat);
      }
      if (o.geometry) this.geometry(o.geometry);
      if (o.instanceMatrix) {
        this.put(o.instanceMatrix.version);
        this.put(o.count ?? 0);
        this.put(o.instanceColor ? o.instanceColor.version : -1);
      }
      if (o.isLight) {
        this.put(o.intensity ?? 0);
        this.colour(o.color);
      }
    });
    const bg = scene.background as Colour | null;
    if (bg && "r" in bg) this.colour(bg);
    const fog = scene.fog as (THREE.Fog & { color: Colour }) | null;
    if (fog) {
      this.put(fog.near);
      this.put(fog.far);
      this.colour(fog.color);
    }
    this.put(scene.environmentIntensity);
    for (const c of cameras) {
      this.matrix(c.matrixWorld);
      this.matrix(c.projectionMatrix);
      this.put(c.layers.mask);
    }
    for (const x of extra) this.put(x);
    if (this.n !== this.v.length) {
      this.v.length = this.n;
      this.diff = true;
    }
    return this.diff;
  }

  /** The next call answers true: after the canvas was lost and restored, or anything else outside the scene. */
  reset(): void {
    this.v.length = 0;
  }
}
