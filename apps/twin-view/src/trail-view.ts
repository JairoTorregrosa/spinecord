// The robot's trail drawn on the floor (the points: src/trail.ts): a flat band just above the mat, under the robot,
// orange where it drove forward and violet in reverse, its edges darker so it reads on white mat, coloured paper and
// black tape alike, light chevrons every few cm pointing the way it went, and fading (not vanishing) the farther
// back it lies. The band is HALF_CM each side, and never under MIN_PX on screen, so it stays readable from the top
// camera on a phone. Each pixel is drawn once (a stencil): where the path crosses itself the newest part shows, and
// a turn in place does not darken where its wedges overlap.
import * as THREE from "three";
import { AUX, TrailFeed, TrailPath } from "./trail";

/** Half the band's width on the floor, cm. */
export const HALF_CM = 1.4;
/** Half the band's width at the least, in pixels of the canvas. */
const MIN_PX = 2.5;
/** Height over the mat, cm: above it for the depth buffer, under the robot's tracks. */
const HEIGHT = 0.15;
/** Progress (cm) over which an older part fades to OLD_ALPHA. */
const FADE_CM = 600;
const OLD_ALPHA = 0.4;
// sRGB, as three keeps them (linear in the shader, converted back on output like every material's)
const FORWARD = new THREE.Color(0xff6a13);
const REVERSE = new THREE.Color(0xb04dff);
/** Points kept: about 60 m of path at STEP_CM. */
export const TRAIL_MAX = 6000;

const vertexShader = /* glsl */ `
attribute vec2 nrm;
attribute vec4 aux;
uniform float uHalf;
uniform float uMinPx;
uniform float uViewH;
varying float vSide;
varying float vDist;
varying float vKind;
varying float vProg;
varying float vHalf;
#include <fog_pars_vertex>
void main() {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // cm per pixel at this point: the band never gets thinner than uMinPx on screen
  float perPx = 2.0 * clip.w / (projectionMatrix[1][1] * uViewH);
  float hw = max(uHalf, uMinPx * perPx);
  vec3 p = position + vec3(nrm.x, 0.0, nrm.y) * aux.x * hw;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
  vSide = aux.x;
  vDist = aux.y;
  vKind = aux.z;
  vProg = aux.w;
  vHalf = hw;
}`;

const fragmentShader = /* glsl */ `
uniform vec3 uForward;
uniform vec3 uReverse;
uniform float uHead;
uniform float uFade;
uniform float uOld;
varying float vSide;
varying float vDist;
varying float vKind;
varying float vProg;
varying float vHalf;
#include <fog_pars_fragment>
void main() {
  float across = abs(vSide);
  vec3 base = mix(uForward, uReverse, clamp(-vKind, 0.0, 1.0));
  float edge = smoothstep(0.58, 0.72, across);
  vec3 col = mix(base, base * 0.15, edge);
  // chevrons: a V every few band-widths, its arms trailing back, so it points the way the robot went
  float period = max(10.0, vHalf * 7.0);
  float u = (vDist + across * vHalf * 1.4) / period;
  float f = fract(u);
  float aa = max(fwidth(u), 1e-4);
  float chev = smoothstep(0.0, aa, f) * (1.0 - smoothstep(0.2 - aa, 0.2, f));
  chev *= clamp(abs(vKind), 0.0, 1.0) * (1.0 - edge);
  col = mix(col, vec3(1.0), chev * 0.7);
  float alpha = mix(0.95, uOld, smoothstep(0.0, uFade, uHead - vProg));
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export class TrailView {
  readonly path = new TrailPath(TRAIL_MAX, HEIGHT, HALF_CM);
  /** Where the robot's states go (main.ts onState): they become the points. */
  readonly feed = new TrailFeed(this.path);
  readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.BufferGeometry();
  private readonly mat: THREE.ShaderMaterial;
  private readonly attrs: THREE.BufferAttribute[];
  private readonly index: THREE.BufferAttribute;

  constructor(layer: number) {
    const p = this.path;
    const pos = new THREE.BufferAttribute(p.pos, 3),
      nrm = new THREE.BufferAttribute(p.nrm, 2),
      aux = new THREE.BufferAttribute(p.aux, AUX);
    this.attrs = [pos, nrm, aux];
    for (const a of this.attrs) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("position", pos);
    this.geo.setAttribute("nrm", nrm);
    this.geo.setAttribute("aux", aux);
    this.index = new THREE.BufferAttribute(p.index, 1).setUsage(THREE.DynamicDrawUsage);
    this.geo.setIndex(this.index);
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      // the scene's fog melts the band into the far floor as it does the mat
      fog: true,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uHalf: { value: HALF_CM },
        uMinPx: { value: MIN_PX },
        uViewH: { value: 720 },
        uForward: { value: FORWARD },
        uReverse: { value: REVERSE },
        uHead: { value: 0 },
        uFade: { value: FADE_CM },
        uOld: { value: OLD_ALPHA },
      },
      transparent: true,
      depthWrite: false,
      // drawn as if a little nearer than the mat it lies on, from any height
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
      // each pixel once: the first quad drawn there (the newest) wins
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilZPass: THREE.ReplaceStencilOp,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.layers.set(layer);
  }

  /** The canvas's height in device pixels, for the band's least width on screen. */
  set viewHeight(px: number) {
    this.mat.uniforms.uViewH!.value = px;
  }
  /** What the picture depends on beyond the geometry (the fade's head), for the stillness check. */
  get head(): number {
    return this.path.head;
  }

  clear(): void {
    this.path.clear();
  }

  /** Sends what changed to the GPU: call once a frame while the trail is shown (a hidden trail keeps recording). */
  flush(): void {
    const p = this.path;
    this.geo.setDrawRange(p.drawStart, p.drawCount);
    this.mat.uniforms.uHead!.value = p.head;
    if (!p.takeDirty()) return;
    const lo = p.dirtyLo,
      hi = p.dirtyHi;
    // one range per buffer, the same objects every time (three empties the list once it has uploaded them)
    for (let i = 0; i < this.attrs.length; i++) {
      const a = this.attrs[i]!;
      this.range(a, this.ranges[i]!, 2 * lo * a.itemSize, 2 * (hi - lo) * a.itemSize);
    }
    // quads lo..hi-1 sit at slots max-hi .. max-1-lo
    this.range(this.index, this.ranges[3]!, (p.max - hi) * 6, (hi - lo) * 6);
  }
  private readonly ranges = [0, 1, 2, 3].map(() => ({ start: 0, count: 0 }));
  private range(a: THREE.BufferAttribute, r: { start: number; count: number }, start: number, count: number): void {
    r.start = start;
    r.count = count;
    a.clearUpdateRanges();
    a.updateRanges.push(r);
    a.needsUpdate = true;
  }
}
