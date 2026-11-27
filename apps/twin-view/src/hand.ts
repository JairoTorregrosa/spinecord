// The hand of the person at the page: what one does to a robot on the floor, plus a tape measure. Modes:
//   look     drag the robot to carry it (turn it on the way with Q / E or the wheel), drag elsewhere to orbit
//   carry    press where the robot goes, drag towards where it must face
//   box      drag a rectangle to set a box down (a click: 20 × 20 cm), drag a box to move it
//   remove   click a box to take it away
//   measure  drag on the floor: distance and angle, as the tools count them (cm, degrees counter-clockwise)
// What the hand holds is drawn as a ghost: blue where it can go, red where the process would refuse it, with the
// reason next to it. The process still decides; its refusal is shown where the hand let go.
import * as THREE from "three";
import { toScene, type Arena } from "./arena";
import type { Cameras } from "./camera";
import { boxOnRobot, fit, type Fit } from "./fit";
import * as hud from "./hud";
import type { Link, Reply } from "./link";
import type { Box, RobotMeta } from "./messages";

export type Mode = "look" | "carry" | "box" | "remove" | "measure";
export const MODES: readonly Mode[] = ["look", "carry", "box", "remove", "measure"];
type Pose = { x: number; y: number; th: number };
type Drag =
  | { kind: "robot"; dx: number; dy: number; x: number; y: number; th: number; from: Pose }
  | { kind: "place"; x: number; y: number; th: number; from: Pose }
  | { kind: "box"; x0: number; y0: number; x: number; y: number }
  | { kind: "move"; index: number; dx: number; dy: number; box: Box }
  | { kind: "measure"; x0: number; y0: number; x: number; y: number };

export interface HandContext {
  canvas: HTMLCanvasElement;
  camera: THREE.Camera;
  scene: THREE.Scene;
  cams: Cameras;
  link: Link;
  /** The robot shown, its world, and the boxes as the process last sent them. */
  focus(): RobotMeta | null;
  /** Where the robot is drawn now (null before its first state). */
  pose(): Pose | null;
  arena(): Arena | null;
  /** The robot's meshes, to tell a press on it from a press on the floor. */
  robot(): THREE.Object3D | null;
  /** Layer of what only the person sees. */
  helpers: number;
}

const DEG = Math.PI / 180;
const CLICK_BOX = 20;
const STEP_DEG = 15;
const HINTS: Record<Mode, string> = {
  look: "Arrastra el robot para levantarlo (Q / E o la rueda lo giran) · arrastra el suelo para mover la vista",
  carry: "Pulsa donde quieres el robot y arrastra hacia donde debe mirar · Esc cancela",
  box: "Arrastra un rectángulo para poner una caja (un clic: 20 × 20 cm) · arrastra una caja para moverla",
  remove: "Haz clic en una caja para quitarla · Esc vuelve a Mirar",
  measure: "Arrastra sobre el suelo para medir (desde el robot: desde el centro de su eje) · Esc borra",
};
const FIT_WORDS: Record<Exclude<Fit, "free">, string> = {
  wall: "No cabe: se saldría de la pista",
  box: "No cabe: chocaría con una caja",
};
/** Degrees in the tools' range, (-180, 180]. */
export const heading = (deg: number): number => {
  const h = ((((deg + 180) % 360) + 360) % 360) - 180;
  return h === -180 ? 180 : h;
};
const fmt = (v: number) => v.toFixed(1);

export class Hand {
  mode: Mode = "look";
  /** The floor point under the pointer (cm), or null off the floor. */
  pointer: { x: number; y: number } | null = null;
  private drag: Drag | null = null;
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly ghostRobot = new THREE.Group();
  private readonly ghostMat = new THREE.LineBasicMaterial({ color: 0x6fb3ff });
  private readonly ghostFillMat = new THREE.MeshBasicMaterial({
    color: 0x6fb3ff,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
  });
  private readonly ghostOutline = new THREE.LineLoop(new THREE.BufferGeometry(), this.ghostMat);
  private readonly ghostArrow = new THREE.Line(new THREE.BufferGeometry(), this.ghostMat);
  private readonly ghostFill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.ghostFillMat);
  private readonly ghostBoxMat = new THREE.MeshBasicMaterial({
    color: 0x3d8bff,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  private readonly ghostBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.ghostBoxMat);
  /** A tape on the floor, 1 cm wide (a line would be one pixel at any zoom), with a dot at each end. */
  private readonly tape = new THREE.Group();
  private readonly tapeStrip: THREE.Mesh;
  private readonly tapeEnds: THREE.Mesh[];
  /** The finished measure stays on the floor until the next one or Esc. */
  private measured: { x0: number; y0: number; x: number; y: number } | null = null;
  private readonly tag = document.getElementById("tag")!;
  private tagAt: THREE.Vector3 | null = null;

  constructor(private readonly c: HandContext) {
    const tapeMat = new THREE.MeshBasicMaterial({ color: 0xff8c1a, depthTest: false, transparent: true });
    const flat = (g: THREE.BufferGeometry) => {
      const m = new THREE.Mesh(g, tapeMat);
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 10;
      return m;
    };
    this.tapeStrip = flat(new THREE.PlaneGeometry(1, 1));
    this.tapeEnds = [flat(new THREE.CircleGeometry(1.4, 20)), flat(new THREE.CircleGeometry(1.4, 20))];
    this.tape.add(this.tapeStrip, ...this.tapeEnds);
    this.ghostFill.rotation.x = -Math.PI / 2;
    this.ghostRobot.add(this.ghostOutline, this.ghostArrow, this.ghostFill);
    this.ghostRobot.visible = this.ghostBox.visible = this.tape.visible = false;
    c.scene.add(this.ghostRobot, this.ghostBox, this.tape);
    for (const o of [this.ghostRobot, this.ghostBox, this.tape]) o.traverse((x) => x.layers.set(c.helpers));
    const cv = c.canvas;
    // capture phase: the hand sees a press before OrbitControls and keeps it when it takes it
    cv.addEventListener("pointerdown", (e) => this.down(e), { capture: true });
    cv.addEventListener("pointermove", (e) => this.move(e));
    cv.addEventListener("pointerup", (e) => this.up(e));
    cv.addEventListener("pointercancel", () => this.cancel());
    cv.addEventListener("pointerleave", () => (this.pointer = null));
    cv.addEventListener(
      "wheel",
      (e) => {
        // turning what the hand holds, not zooming, while it holds the robot
        if (this.drag?.kind !== "robot" && this.drag?.kind !== "place") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.turnHeld((e.deltaY > 0 ? -1 : 1) * (e.shiftKey ? 1 : 5));
      },
      { capture: true, passive: false },
    );
    cv.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (this.drag) this.cancel(); // a right click lets go without setting down
    });
  }

  /** The robot shown changed (another twin, another world): what the hand held belongs to the old one. */
  reset(m: RobotMeta | null): void {
    this.cancel();
    this.measured = null;
    this.tape.visible = false;
    if (m) this.shapeGhost(m);
  }

  setMode(m: Mode): void {
    this.cancel();
    this.mode = m;
    if (m !== "measure") {
      this.measured = null;
      this.tape.visible = false;
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>("#modes button")) {
      const on = b.dataset.mode === m;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
    this.c.canvas.dataset.mode = m;
    this.refreshHint();
  }

  refreshHint(): void {
    hud.hint(
      this.c.cams.mode === "eye" && this.mode !== "look"
        ? "La mano no alcanza desde la cámara del robot: elige Seguir, Libre o Arriba"
        : HINTS[this.mode],
    );
  }

  /** Esc: first lets go of what the hand holds, then clears the measure, then goes back to look. */
  escape(): void {
    if (this.drag) return this.cancel();
    if (this.measured) {
      this.measured = null;
      this.tape.visible = false;
      return;
    }
    this.setMode("look");
  }

  /** Q / E: turns what the hand holds, or else the robot where it stands, by STEP_DEG. */
  turnKey(sign: 1 | -1): void {
    if (this.drag?.kind === "robot" || this.drag?.kind === "place") return this.turnHeld(sign * STEP_DEG);
    const f = this.c.focus(),
      p = this.c.pose();
    if (!f || !p || this.drag) return;
    const th = p.th + sign * STEP_DEG * DEG;
    const why = fit(f.world, f.world.boxes, p.x, p.y, th);
    if (why !== "free") return hud.toast(FIT_WORDS[why]);
    void this.carry(f, p, { x: p.x, y: p.y, th }, null);
  }

  /** Every frame: the label next to what the hand holds or measured follows the camera. */
  frame(): void {
    if (!this.tagAt) return;
    const v = this.tagAt.clone().project(this.c.camera);
    const r = this.c.canvas.getBoundingClientRect();
    const behind = v.z > 1;
    this.tag.hidden = behind;
    this.tag.style.left = `${r.left + ((v.x + 1) / 2) * r.width}px`;
    this.tag.style.top = `${r.top + ((1 - v.y) / 2) * r.height}px`;
  }

  // ---------------------------------------------------------------- pointer
  private aim(e: { clientX: number; clientY: number }): void {
    const r = this.c.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.c.camera);
  }
  /** The floor point under the pointer (cm), kept inside the arena when `clamp`. */
  private floorAt(e: PointerEvent, clamp = true): { x: number; y: number } | null {
    this.aim(e);
    const p = this.ray.ray.intersectPlane(this.floor, new THREE.Vector3());
    const f = this.c.focus();
    if (!p || !f) return null;
    const { width, height } = f.world;
    const x = p.x,
      y = -p.z;
    if (!clamp) return x < 0 || y < 0 || x > width || y > height ? null : { x, y };
    return { x: Math.min(width, Math.max(0, x)), y: Math.min(height, Math.max(0, y)) };
  }
  private onRobot(e: PointerEvent): boolean {
    const g = this.c.robot();
    if (!g) return false;
    this.aim(e);
    return this.ray.intersectObject(g, true).length > 0;
  }
  private boxUnder(e: PointerEvent): number | null {
    const a = this.c.arena();
    if (!a) return null;
    this.aim(e);
    const hit = this.ray.intersectObjects(a.boxes, false)[0];
    return hit ? (hit.object.userData.index as number) : null;
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0 || this.drag) return;
    const f = this.c.focus(),
      pose = this.c.pose();
    if (!f || !pose || this.c.cams.mode === "eye") return;
    const m = this.mode;
    if (m === "remove") {
      const i = this.boxUnder(e);
      if (i === null) return;
      this.take(e);
      this.c.cams.handBusy(false);
      void this.c.link.request({ t: "box_remove", id: f.id, index: i }).then((r) => this.answer(r, e));
      return;
    }
    if (m === "look") {
      if (!this.onRobot(e)) return;
      const p = this.floorAt(e)!;
      this.drag = { kind: "robot", dx: pose.x - p.x, dy: pose.y - p.y, x: pose.x, y: pose.y, th: pose.th, from: pose };
    } else if (m === "box") {
      const i = this.boxUnder(e);
      const p = this.floorAt(e);
      if (!p) return;
      if (i !== null) {
        const b = f.world.boxes[i]!;
        this.drag = { kind: "move", index: i, dx: b.x - p.x, dy: b.y - p.y, box: { ...b } };
      } else this.drag = { kind: "box", x0: p.x, y0: p.y, x: p.x, y: p.y };
    } else {
      const p = this.floorAt(e, m !== "carry");
      if (!p) return;
      if (m === "carry") this.drag = { kind: "place", x: p.x, y: p.y, th: pose.th, from: pose };
      else {
        // a measure that starts on the robot starts at its axle centre: where the tools count from
        const o = this.onRobot(e) ? pose : p;
        this.drag = { kind: "measure", x0: o.x, y0: o.y, x: p.x, y: p.y };
      }
    }
    this.take(e);
    this.show();
  }

  /** The hand has this press: the camera must not move with it. */
  private take(e: PointerEvent): void {
    e.stopImmediatePropagation();
    this.c.cams.handBusy(true);
    try {
      this.c.canvas.setPointerCapture(e.pointerId);
    } catch {
      // a pointer the browser does not track (synthetic): the drag still ends on pointerup
    }
    this.c.canvas.classList.add("holding");
  }

  private move(e: PointerEvent): void {
    this.pointer = this.floorAt(e, false);
    const d = this.drag;
    const f = this.c.focus();
    if (!d || !f) {
      const hover =
        this.c.cams.mode === "eye"
          ? ""
          : this.mode === "remove" || this.mode === "box"
            ? this.boxUnder(e) !== null
              ? "box"
              : ""
            : this.mode === "look" && this.onRobot(e)
              ? "robot"
              : "";
      this.c.arena()?.highlight(this.mode === "remove" && hover === "box" ? this.boxUnder(e) : null);
      this.c.canvas.dataset.hover = hover;
      return;
    }
    const p = this.floorAt(e);
    if (!p) return;
    const { width, height } = f.world;
    if (d.kind === "robot") {
      d.x = Math.min(width, Math.max(0, p.x + d.dx));
      d.y = Math.min(height, Math.max(0, p.y + d.dy));
    } else if (d.kind === "place") {
      if (Math.hypot(p.x - d.x, p.y - d.y) > 3) d.th = Math.atan2(p.y - d.y, p.x - d.x);
    } else if (d.kind === "move") {
      d.box.x = Math.min(width - d.box.w, Math.max(0, p.x + d.dx));
      d.box.y = Math.min(height - d.box.h, Math.max(0, p.y + d.dy));
    } else {
      d.x = p.x;
      d.y = p.y;
    }
    this.show();
  }

  private up(e: PointerEvent): void {
    const d = this.drag;
    const f = this.c.focus();
    this.release(e);
    if (!d || !f) return;
    const pose = this.c.pose();
    if (d.kind === "robot" || d.kind === "place") {
      const why = fit(f.world, f.world.boxes, d.x, d.y, d.th);
      if (why !== "free") return hud.toastAt(`${FIT_WORDS[why]}. El robot se queda donde estaba.`, e);
      void this.carry(f, d.from, { x: d.x, y: d.y, th: d.th }, e);
    } else if (d.kind === "box" || d.kind === "move") {
      const b = d.kind === "box" ? this.boxRect(d, f) : d.box;
      if (pose && boxOnRobot(f.world, b, pose.x, pose.y, pose.th)) return hud.toastAt(hud.REFUSAL.box_on_robot, e);
      const sent =
        d.kind === "box"
          ? this.c.link.request({ t: "box_add", id: f.id, ...b })
          : this.c.link.request({ t: "box_move", id: f.id, index: d.index, ...b });
      void sent.then((r) => this.answer(r, e));
    } else {
      this.measured = Math.hypot(d.x - d.x0, d.y - d.y0) < 0.5 ? null : { x0: d.x0, y0: d.y0, x: d.x, y: d.y };
      this.show();
    }
  }

  private release(e: PointerEvent): void {
    this.drag = null;
    this.c.cams.handBusy(false);
    this.c.canvas.classList.remove("holding");
    if (this.c.canvas.hasPointerCapture(e.pointerId)) this.c.canvas.releasePointerCapture(e.pointerId);
    this.show();
  }

  private cancel(): void {
    if (!this.drag) return;
    this.drag = null;
    this.c.cams.handBusy(false);
    this.c.canvas.classList.remove("holding");
    this.show();
  }

  private turnHeld(deg: number): void {
    const d = this.drag;
    if (d?.kind !== "robot" && d?.kind !== "place") return;
    d.th += deg * DEG;
    this.show();
  }

  private async carry(f: RobotMeta, from: Pose, to: Pose, at: PointerEvent | null): Promise<void> {
    const r = await this.c.link.request({ t: "carry", id: f.id, x: to.x, y: to.y, heading_deg: to.th / DEG });
    if (!r.ok) return this.answer(r, at);
    const turned = Math.abs(heading((to.th - from.th) / DEG));
    const moved = Math.hypot(to.x - from.x, to.y - from.y);
    if (turned < 1 && moved < 1) return;
    const gyro = Object.values(f.ports.sensors).includes("gyro");
    hud.toast(
      gyro
        ? `Robot movido ${fmt(moved)} cm y girado ${Math.round(turned)}°: el giroscopio sintió el giro; los encoders no se enteran.`
        : `Robot movido ${fmt(moved)} cm y girado ${Math.round(turned)}°. Sin giroscopio, el robot no lo sabe: su rumbo y su distancia salen de los encoders.`,
      "info",
    );
  }

  /** A reply of the process: a refusal is shown where the hand let go. */
  private answer(r: Reply, at: PointerEvent | null): void {
    if (r.ok) return;
    const text = `${hud.REFUSAL[r.code]}${r.code === "internal" ? `: ${r.error}` : ""}`;
    if (at) hud.toastAt(text, at);
    else hud.toast(text);
  }

  private boxRect(d: { x0: number; y0: number; x: number; y: number }, f: RobotMeta): Box {
    const { width, height } = f.world;
    if (Math.hypot(d.x - d.x0, d.y - d.y0) < 3) {
      const s = Math.min(CLICK_BOX, width, height);
      return {
        x: Math.min(width - s, Math.max(0, d.x0 - s / 2)),
        y: Math.min(height - s, Math.max(0, d.y0 - s / 2)),
        w: s,
        h: s,
      };
    }
    const x = Math.min(d.x0, d.x),
      y = Math.min(d.y0, d.y);
    return { x, y, w: Math.max(2, Math.abs(d.x - d.x0)), h: Math.max(2, Math.abs(d.y - d.y0)) };
  }

  // ---------------------------------------------------------------- what is drawn
  private shapeGhost(m: RobotMeta): void {
    const b = m.world.body;
    const z = 0.25;
    const P = (x: number, y: number) => new THREE.Vector3(x, z, -y);
    this.ghostOutline.geometry.dispose();
    this.ghostOutline.geometry = new THREE.BufferGeometry().setFromPoints([
      P(b.front_cm, b.half_width_cm),
      P(b.front_cm, -b.half_width_cm),
      P(-b.back_cm, -b.half_width_cm),
      P(-b.back_cm, b.half_width_cm),
    ]);
    this.ghostArrow.geometry.dispose();
    this.ghostArrow.geometry = new THREE.BufferGeometry().setFromPoints([
      P(0, 0),
      P(b.front_cm + 8, 0),
      P(b.front_cm + 5, 2.5),
      P(b.front_cm + 8, 0),
      P(b.front_cm + 5, -2.5),
    ]);
    this.ghostFill.scale.set(b.front_cm + b.back_cm, 2 * b.half_width_cm, 1);
    this.ghostFill.position.set((b.front_cm - b.back_cm) / 2, 0.2, 0);
  }

  private label(text: string | null, at: THREE.Vector3 | null, bad = false): void {
    this.tagAt = text ? at : null;
    this.tag.hidden = !text;
    if (!text) return;
    this.tag.textContent = text;
    this.tag.classList.toggle("bad", bad);
    this.frame();
  }

  private show(): void {
    const d = this.drag;
    const f = this.c.focus();
    this.ghostRobot.visible = this.ghostBox.visible = false;
    this.tape.visible = false;
    if (!f) return this.label(null, null);
    if (d?.kind === "robot" || d?.kind === "place") {
      const why = fit(f.world, f.world.boxes, d.x, d.y, d.th);
      const colour = why === "free" ? 0x6fb3ff : 0xff5a4e;
      this.ghostMat.color.setHex(colour);
      this.ghostFillMat.color.setHex(colour);
      this.ghostRobot.visible = true;
      this.ghostRobot.position.copy(toScene(d.x, d.y));
      this.ghostRobot.rotation.y = d.th;
      const where = `x ${fmt(d.x)} · y ${fmt(d.y)} cm · θ ${Math.round(heading(d.th / DEG))}°`;
      return this.label(why === "free" ? where : `${where}\n${FIT_WORDS[why]}`, toScene(d.x, d.y, 2), why !== "free");
    }
    if (d?.kind === "box" || d?.kind === "move") {
      const b = d.kind === "box" ? this.boxRect(d, f) : d.box;
      const pose = this.c.pose();
      const bad = pose !== null && boxOnRobot(f.world, b, pose.x, pose.y, pose.th);
      this.ghostBoxMat.color.setHex(bad ? 0xff5a4e : 0x6fb3ff);
      this.ghostBox.visible = true;
      this.ghostBox.scale.set(b.w, 14, b.h);
      this.ghostBox.position.copy(toScene(b.x + b.w / 2, b.y + b.h / 2, 7));
      const size = `${fmt(b.w)} × ${fmt(b.h)} cm`;
      return this.label(
        bad ? `${size}\nNo: caería sobre el robot` : size,
        toScene(b.x + b.w / 2, b.y + b.h / 2, 15),
        bad,
      );
    }
    const m = d?.kind === "measure" ? d : this.measured;
    if (m) {
      const dx = m.x - m.x0,
        dy = m.y - m.y0;
      const len = Math.hypot(dx, dy);
      this.tapeStrip.position.copy(toScene((m.x + m.x0) / 2, (m.y + m.y0) / 2, 0.3));
      this.tapeStrip.scale.set(Math.max(0.01, len), 1, 1);
      this.tapeStrip.rotation.set(-Math.PI / 2, 0, Math.atan2(dy, dx));
      this.tapeEnds[0]!.position.copy(toScene(m.x0, m.y0, 0.3));
      this.tapeEnds[1]!.position.copy(toScene(m.x, m.y, 0.3));
      this.tape.visible = true;
      const ang = Math.round(heading(Math.atan2(dy, dx) / DEG));
      return this.label(
        `${fmt(Math.hypot(dx, dy))} cm · ${ang}°\nΔx ${fmt(dx)} · Δy ${fmt(dy)}`,
        toScene((m.x + m.x0) / 2, (m.y + m.y0) / 2, 1),
      );
    }
    this.label(null, null);
  }
}
