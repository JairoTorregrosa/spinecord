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

export class Cameras {
  mode: Cam = "follow";
  readonly controls: OrbitControls;
  private world: WorldShape | null = null;
  private saved: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private lastFollow: THREE.Vector3 | null = null;
  private busy = false;
  private readonly tmp = new THREE.Vector3();

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
    if (next === this.mode) return;
    const still = (m: Cam) => m === "eye" || m === "top";
    if (still(next) && !still(this.mode))
      this.saved = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
    else if (!still(next) && still(this.mode) && this.saved) {
      this.camera.position.copy(this.saved.pos);
      this.controls.target.copy(this.saved.target);
    }
    this.mode = next;
    this.lastFollow = null;
    if (next === "top") this.topView();
    this.apply();
    this.onChange(next);
  }

  /** A world arrived: limits to its size, and (`first`) a view of the robot at its start. */
  fitArena(w: WorldShape, first: boolean): void {
    this.world = w;
    this.controls.maxDistance = Math.max(w.width, w.height) * 3;
    if (first) this.reset({ x: w.start.x, y: w.start.y, th: w.start.heading_deg * (Math.PI / 180) });
  }

  /** Back to a view that shows the robot (from behind and above), or the whole arena from the top. */
  reset(robot: Pose | null): void {
    this.lastFollow = null;
    if (this.mode === "top") return this.topView();
    if (this.mode === "eye") return;
    const w = this.world;
    const p = robot ?? (w ? { x: w.width / 2, y: w.height / 2, th: 0 } : null);
    if (!p) return;
    const s = toScene(p.x, p.y);
    this.controls.target.copy(s);
    const h = p.th;
    this.camera.position.set(s.x - Math.cos(h) * 70 + Math.sin(h) * 45, 62, s.z + Math.sin(h) * 70 + Math.cos(h) * 45);
    this.controls.update();
  }

  /** Every frame, after the robot is placed: `robot` its shown pose, `eye` its own camera. */
  update(robot: Pose | null, eye: THREE.Camera | null): void {
    if (this.mode === "eye" && eye) {
      this.camera.position.copy(eye.position);
      this.camera.quaternion.copy(eye.quaternion);
      return;
    }
    if (this.mode === "follow" && robot && !this.busy) {
      const p = toScene(robot.x, robot.y, 4);
      if (this.lastFollow) {
        this.tmp.subVectors(p, this.lastFollow);
        this.camera.position.add(this.tmp);
        this.controls.target.add(this.tmp);
      }
      this.lastFollow = p;
    } else this.lastFollow = null;
    this.controls.update();
  }

  private topView(): void {
    const w = this.world;
    const el = this.controls.domElement as HTMLElement | null;
    if (!w || !el) return;
    const W = el.clientWidth,
      H = el.clientHeight;
    const f = this.free();
    const fw = Math.max(80, f.right - f.left),
      fh = Math.max(80, f.bottom - f.top);
    // pixels per cm so that the whole arena, with a margin, fits where no panel covers it
    const ppc = Math.min(fw / (w.width * 1.06), fh / (w.height * 1.06));
    const d = H / (ppc * 2 * Math.tan((this.camera.fov * Math.PI) / 360));
    // the arena's centre drawn at the centre of that free part, not of the canvas
    const ox = (f.left + f.right) / 2 - W / 2,
      oy = (f.top + f.bottom) / 2 - H / 2;
    const centre = toScene(w.width / 2, w.height / 2);
    this.controls.target.set(centre.x - ox / ppc, 0, centre.z - oy / ppc);
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
