// The person's camera. Four modes, one at a time: free (orbit, pan, zoom), follow (the same, carried along with
// the robot), eye (what the robot's own camera sees; the controls rest) and top (straight down, north up, the
// mouse pans: for measuring). Leaving eye or top brings back the view the person had before. Orbit never goes
// under the floor, and top never rotates, so nothing flips.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { toScene } from "./arena";
import type { WorldShape } from "./messages";

export type Cam = "free" | "follow" | "eye" | "top";
export const CAMS: readonly Cam[] = ["free", "follow", "eye", "top"];
type Pose = { x: number; y: number; th: number };
/** A rectangle of the canvas, in CSS pixels from its top-left corner. */
export interface Area {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
/** The robot's bounding box, from the centre of its wheel axle (cm): what framing must show whole. */
export interface Extent {
  front_cm: number;
  back_cm: number;
  half_width_cm: number;
  height_cm: number;
}

/**
 * The view offset (THREE.PerspectiveCamera.setViewOffset) that puts the optical centre at the centre of `free`, a
 * part of a `W` x `H` canvas: the canvas becomes a window of a larger image centred there.
 */
export function viewOffset(W: number, H: number, free: Area): { fullW: number; fullH: number; x: number; y: number } {
  const cx = (free.left + free.right) / 2,
    cy = (free.top + free.bottom) / 2;
  const fullW = 2 * Math.max(cx, W - cx),
    fullH = 2 * Math.max(cy, H - cy);
  return { fullW, fullH, x: fullW / 2 - cx, y: fullH / 2 - cy };
}

/** How far (cm) a camera of vertical field `fovDeg` stands for a sphere of `radius` to fit in `free`, with a margin. */
export function fitDistance(radius: number, fovDeg: number, W: number, H: number, free: Area, margin = 1.12): number {
  const { fullH } = viewOffset(W, H, free);
  const fpx = fullH / (2 * Math.tan((fovDeg * Math.PI) / 360)); // pixels per unit at unit distance
  const half = Math.min(
    Math.atan(Math.max(20, free.bottom - free.top) / 2 / fpx),
    Math.atan(Math.max(20, free.right - free.left) / 2 / fpx),
  );
  return (radius * margin) / Math.sin(half);
}

/** The centre of the robot's bounding box (scene units) and the radius of the sphere around it. */
export function robotSphere(p: Pose, e: Extent): { x: number; y: number; z: number; r: number } {
  const ahead = (e.front_cm - e.back_cm) / 2;
  const s = toScene(p.x + Math.cos(p.th) * ahead, p.y + Math.sin(p.th) * ahead, e.height_cm / 2);
  return { x: s.x, y: s.y, z: s.z, r: Math.hypot(e.front_cm + e.back_cm, 2 * e.half_width_cm, e.height_cm) / 2 };
}

/** Free (follow) cameras ease to a new framing in this long (ms). */
export const EASE_MS = 600;

export class Cameras {
  mode: Cam = "follow";
  readonly controls: OrbitControls;
  private world: WorldShape | null = null;
  private saved: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private busy = false;
  private readonly tmp = new THREE.Vector3();
  /** The robot's extent, once a robot is shown: what framing fits. */
  extent: Extent | null = null;
  /** Where the camera looks at the robot from when it frames it: degrees around it from behind, and above the floor. */
  aim = { az: -32, el: 38 };
  /** A framing to do at the next frame that knows the robot's pose: snap (first paint), ease (a press), fit (resize). */
  private pending: "snap" | "ease" | "fit" | null = null;
  private tween: {
    t0: number;
    target0: THREE.Vector3;
    off0: THREE.Vector3;
    off1: THREE.Vector3;
  } | null = null;
  /** Called after a framing snaps, with the target and the robot's heading (a deep link's angle). */
  onSnap: ((target: THREE.Vector3, heading: number) => void) | null = null;
  private offsetKey = "";
  /** The robot's centre when the camera last followed it: following moves the view by the robot's movement only. */
  private lastCentre: THREE.Vector3 | null = null;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
    private readonly onChange: (mode: Cam) => void,
    /** The part of the canvas no panel covers (canvas pixels): the top view fits the arena in there. */
    private readonly free: () => { left: number; top: number; right: number; bottom: number },
  ) {
    const c = new OrbitControls(camera, canvas);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.maxPolarAngle = Math.PI / 2 - 0.04;
    c.minDistance = 12;
    c.screenSpacePanning = true;
    c.target.set(60, 0, -60);
    camera.position.set(-20, 90, 40);
    this.controls = c;
  }

  /** The hand holds the pointer (a drag on the robot or the floor): the camera must not move with it. */
  handBusy(b: boolean): void {
    this.busy = b;
    this.apply();
  }

  set(next: Cam): void {
    if (next === this.mode) {
      // "Seguir" pressed again: the robot comes back into view behind it
      if (next === "follow") this.frame("ease");
      return;
    }
    const still = (m: Cam) => m === "eye" || m === "top";
    if (still(next) && !still(this.mode))
      this.saved = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
    else if (!still(next) && still(this.mode) && this.saved) {
      this.camera.position.copy(this.saved.pos);
      this.controls.target.copy(this.saved.target);
    }
    this.mode = next;
    // following starts by bringing the robot into view, behind it, within a second
    if (next === "follow") this.frame("ease");
    if (next === "top") this.topView();
    this.apply();
    this.onChange(next);
  }

  /** A world arrived: limits to its size, and (`first`) the robot framed at the first frame that shows it. */
  fitArena(w: WorldShape, first: boolean): void {
    this.world = w;
    this.controls.maxDistance = Math.max(w.width, w.height) * 3;
    if (!first) return;
    if (this.mode === "top") this.topView();
    else this.frame("snap");
  }

  /** Frames the robot at the next frame that knows where it is (see `pending`). */
  frame(how: "snap" | "ease" | "fit"): void {
    // a snap or an ease asked for wins over a fit
    if (how === "fit" && this.pending !== null) return;
    this.pending = how;
  }

  /** "Centrar vista": back to a view that shows the robot whole (behind and above it), or the arena from the top. */
  reset(): void {
    if (this.mode === "top") return this.topView();
    if (this.mode === "eye") return;
    this.frame("ease");
  }

  /** The canvas changed size or the panels moved: the free area's centre stays the optical centre. */
  resized(): void {
    this.offsetKey = ""; // the aspect changed: the offset is set again
    if (this.mode === "top") this.topView();
    else if (this.mode !== "eye") this.frame("fit");
  }

  /** Every frame, after the robot is placed: `robot` its shown pose, `eye` its own camera, `now` in ms. */
  update(robot: Pose | null, eye: THREE.Camera | null, now = performance.now()): void {
    if (this.mode === "eye" && eye) {
      this.setOffset(null);
      this.camera.position.copy(eye.position);
      this.camera.quaternion.copy(eye.quaternion);
      return;
    }
    this.setOffset(this.area());
    const sphere = robot && this.extent ? robotSphere(robot, this.extent) : null;
    const centre = sphere ? this.tmp.set(sphere.x, sphere.y, sphere.z) : null;
    const c = this.controls;
    if (sphere && centre && this.pending && this.mode !== "top" && !this.busy) {
      const el = this.controls.domElement as HTMLElement;
      const d = fitDistance(sphere.r, this.camera.fov, el.clientWidth, el.clientHeight, this.area());
      let off: THREE.Vector3;
      if (this.pending === "fit") off = this.camera.position.clone().sub(c.target).setLength(d);
      else {
        const a = robot!.th + Math.PI - this.aim.az * (Math.PI / 180),
          e = this.aim.el * (Math.PI / 180);
        off = new THREE.Vector3(Math.cos(a) * Math.cos(e) * d, Math.sin(e) * d, -Math.sin(a) * Math.cos(e) * d);
      }
      if (this.pending === "ease")
        this.tween = {
          t0: now,
          target0: c.target.clone(),
          off0: this.camera.position.clone().sub(c.target),
          off1: off,
        };
      else {
        this.tween = null;
        c.target.copy(centre);
        this.camera.position.copy(centre).add(off);
        this.lastCentre = centre.clone();
        if (this.pending === "snap") this.onSnap?.(c.target, robot!.th);
      }
      this.pending = null;
    }
    if (this.tween && centre) {
      const k = Math.min(1, (now - this.tween.t0) / EASE_MS),
        e = k * k * (3 - 2 * k); // smoothstep
      c.target.lerpVectors(this.tween.target0, centre, e);
      this.camera.position.copy(c.target).add(this.tween.off0.clone().lerp(this.tween.off1, e));
      if (k >= 1) {
        this.tween = null;
        this.lastCentre = centre.clone();
      }
    } else if (this.mode === "follow" && centre && !this.busy) {
      // carried by the robot: its movement moves the view, so the person's orbit, zoom and pan are kept
      if (this.lastCentre) {
        const delta = centre.clone().sub(this.lastCentre);
        c.target.add(delta);
        this.camera.position.add(delta);
      }
      this.lastCentre = centre.clone();
    }
    c.update();
  }

  /** The free area, or the whole canvas when the panels are hidden or not laid out. */
  private area(): Area {
    const el = this.controls.domElement as HTMLElement;
    const W = el.clientWidth,
      H = el.clientHeight;
    const f = this.free();
    // a free area that collapsed (panels hidden, a window narrower than the panels) is no area: the whole canvas
    if (!(f.right - f.left >= 80 && f.bottom - f.top >= 80)) return { left: 0, top: 0, right: W, bottom: H };
    return f;
  }

  private setOffset(f: Area | null): void {
    const el = this.controls.domElement as HTMLElement;
    const W = el.clientWidth,
      H = el.clientHeight;
    const key = f ? `${W} ${H} ${f.left} ${f.top} ${f.right} ${f.bottom}` : "";
    if (key === this.offsetKey) return;
    this.offsetKey = key;
    if (!f || W === 0 || H === 0) {
      if (W > 0 && H > 0) this.camera.aspect = W / H;
      this.camera.clearViewOffset();
    } else {
      const o = viewOffset(W, H, f);
      // the frustum is the larger image's: its aspect, or the canvas would stretch
      this.camera.aspect = o.fullW / o.fullH;
      this.camera.setViewOffset(o.fullW, o.fullH, o.x, o.y, W, H);
    }
  }

  private topView(): void {
    const w = this.world;
    const el = this.controls.domElement as HTMLElement | null;
    if (!w || !el) return;
    const W = el.clientWidth,
      H = el.clientHeight;
    const f = this.area();
    this.setOffset(f);
    const fw = f.right - f.left,
      fh = f.bottom - f.top;
    // pixels per cm so that the whole arena, with a margin, fits where no panel covers it; the view offset puts
    // the optical centre at the centre of that free part, so the arena's centre goes on the axis
    const ppc = Math.min(fw / (w.width * 1.06), fh / (w.height * 1.06));
    const d = viewOffset(W, H, f).fullH / (ppc * 2 * Math.tan((this.camera.fov * Math.PI) / 360));
    const centre = toScene(w.width / 2, w.height / 2);
    this.controls.target.set(centre.x, 0, centre.z);
    // a hair south of straight down: OrbitControls has no "up" when looking along it, and north stays up
    this.camera.position.set(this.controls.target.x, d, this.controls.target.z + 0.01);
    this.controls.update();
  }

  private apply(): void {
    const c = this.controls;
    c.enabled = this.mode !== "eye" && !this.busy;
    c.enableRotate = this.mode !== "top";
    c.mouseButtons.LEFT = this.mode === "top" ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    c.touches.ONE = this.mode === "top" ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
  }
}
