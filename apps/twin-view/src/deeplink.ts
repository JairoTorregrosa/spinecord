// A view of the page chosen by its address, read once at load, so a link (or a screenshot tool) opens the scene
// from a given angle:  ?cam=free|follow|robot|top&az=<deg>&el=<deg>&dist=<cm>&hud=0&stats=1
//   cam    the camera mode (robot: the robot's own camera; top: follow, seen from straight above)
//   az     around the robot, from behind it: 0 behind, 90 its left side, 180 in front, 270 its right side
//   el     degrees above the floor; dist: cm from the robot to the camera
//   hud=0  hides the panels, so only the scene shows; stats=1 shows draw calls, triangles and frame time
import type * as THREE from "three";

const DEG = Math.PI / 180;

export interface DeepLink {
  cam: "free" | "follow" | "eye" | null;
  az: number | null;
  el: number | null;
  dist: number | null;
  hud: boolean;
  stats: boolean;
}

const num = (q: URLSearchParams, k: string): number | null => {
  const v = q.get(k);
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`the page address has ${k}=${v}: a number is expected`);
  return n;
};

export function readDeepLink(search: string): DeepLink {
  const q = new URLSearchParams(search);
  const c = q.get("cam");
  const cams: Record<string, DeepLink["cam"]> = { free: "free", follow: "follow", robot: "eye", top: "follow" };
  if (c !== null && !(c in cams)) throw new Error(`the page address has cam=${c}: free, follow, robot or top`);
  return {
    cam: c === null ? null : cams[c]!,
    az: num(q, "az"),
    el: num(q, "el") ?? (c === "top" ? 89.5 : null),
    dist: num(q, "dist"),
    hud: q.get("hud") !== "0",
    stats: q.get("stats") === "1",
  };
}

export const link = readDeepLink(location.search);

/** Puts the camera around `target` (the robot, heading `heading` rad) as the link asks; keeps what it leaves out. */
export function placeCamera(camera: THREE.PerspectiveCamera, target: THREE.Vector3, heading: number): void {
  if (link.az === null && link.el === null && link.dist === null) return;
  const off = camera.position.clone().sub(target);
  const dist = link.dist ?? off.length();
  const el = (link.el ?? Math.asin(off.y / off.length()) / DEG) * DEG;
  // three.js: the robot looks along (cos h, 0, -sin h); behind it is the opposite way
  const a = heading + Math.PI + (link.az ?? 0) * DEG;
  camera.position.set(
    target.x + Math.cos(a) * Math.cos(el) * dist,
    target.y + Math.sin(el) * dist,
    target.z - Math.sin(a) * Math.cos(el) * dist,
  );
}

/** Applies the camera mode and the panels once the page is up. */
export function applyLink(): void {
  if (link.cam) document.querySelector<HTMLButtonElement>(`#cams button[data-cam="${link.cam}"]`)?.click();
  if (link.hud) return;
  const style = document.createElement("style");
  style.textContent = ".panel, #pip, #hint, #bubble, #toast { display: none !important; }";
  document.head.append(style);
  const pip = document.getElementById("opt-pip") as HTMLInputElement | null;
  if (pip?.checked) pip.click();
}

let statsEl: HTMLElement | null = null;
let last = 0;
const deltas: number[] = [];
/** Once per frame, after every render of it: shows what the frame cost when the link asks for it. */
export function frameStats(renderer: THREE.WebGLRenderer, now: number): void {
  if (!link.stats) return;
  if (!statsEl) {
    renderer.info.autoReset = false;
    statsEl = document.createElement("div");
    statsEl.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:99;font:12px monospace;color:#fff;background:#000a;padding:4px 6px";
    document.body.append(statsEl);
  }
  if (last) deltas.push(now - last);
  if (deltas.length > 120) deltas.shift();
  last = now;
  const ms = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
  const r = renderer.info.render;
  statsEl.textContent = `${r.calls} calls · ${r.triangles} tris · ${ms.toFixed(1)} ms over ${deltas.length} frames · geo ${renderer.info.memory.geometries} tex ${renderer.info.memory.textures}`;
  renderer.info.reset();
}
