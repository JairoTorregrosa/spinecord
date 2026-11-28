// When the page cannot show the scene, it says so where the scene would be, with what to do, and keeps the rest
// working: the connection, the brick panel, the widgets and the calls need no WebGL. Two things decide it, each
// with its own states: the browser's 3D (WebGL ok, never started, or taken back and not returned) and the robot
// in focus (drawn, none, or one the page could not draw). The panel shows the first that fails, the browser's
// before the robot's; every event moves one of the two, so a reason clears exactly when its cause does.

/** Why the scene is not shown: nothing, or the reason the panel gives. */
export type No3dWhy = "none" | "no_context" | "lost" | "build";

export interface No3dState {
  /** The browser's 3D. "no_context" never comes back: the page has no renderer. */
  webgl: "ok" | "no_context" | "lost";
  /** The robot in focus: drawn (or none), or the reason (English, for the console and the panel's title) it was not. */
  build: { ok: true } | { ok: false; detail: string };
  /** Why the browser's 3D failed, for the console and the panel's title. */
  webglDetail: string;
}

export type No3dEvent =
  | { t: "no_context"; detail: string }
  | { t: "lost"; detail: string }
  | { t: "restored" }
  | { t: "build_failed"; detail: string }
  /** A robot was drawn, or there is no robot to draw: nothing about the build stands in the way. */
  | { t: "built" };

export const NO3D_START: No3dState = { webgl: "ok", build: { ok: true }, webglDetail: "" };

/** The next state after `e`. */
export function no3dNext(s: No3dState, e: No3dEvent): No3dState {
  switch (e.t) {
    case "no_context":
      return { ...s, webgl: "no_context", webglDetail: e.detail };
    case "lost":
      return s.webgl === "no_context" ? s : { ...s, webgl: "lost", webglDetail: e.detail };
    case "restored":
      return s.webgl === "lost" ? { ...s, webgl: "ok", webglDetail: "" } : s;
    case "build_failed":
      return { ...s, build: { ok: false, detail: e.detail } };
    case "built":
      return { ...s, build: { ok: true } };
  }
}

/** What the panel shows for a state: the browser's failure first, then the robot's. */
export function no3dShown(s: No3dState): { why: No3dWhy; detail: string } {
  if (s.webgl !== "ok") return { why: s.webgl, detail: s.webglDetail };
  if (!s.build.ok) return { why: "build", detail: s.build.detail };
  return { why: "none", detail: "" };
}

/** How long a lost context may take to come back before the page says the 3D view is gone (ms). */
export const LOST_GRACE_MS = 3000;

/** The person's words for why there is no 3D view, and what to do. */
export function no3dText(why: Exclude<No3dWhy, "none">): string {
  if (why === "build")
    return "Esta página no pudo dibujar este robot. Avísale a quien te pasó esta página: el resto de la página sigue funcionando.";
  const fix =
    "Abre la página en Chrome o Edge y activa la aceleración por hardware (chrome://settings/system), luego recarga.";
  return why === "lost"
    ? `El navegador cerró los gráficos 3D (WebGL) y no los devolvió. ${fix}`
    : `Este navegador no pudo iniciar los gráficos 3D (WebGL). ${fix}`;
}

let state = NO3D_START;
let shown = "none\n";

/** Moves the page's state by `e` and shows or hides the panel to match; the reason's detail goes to the console. */
export function no3d(e: No3dEvent): void {
  state = no3dNext(state, e);
  const { why, detail } = no3dShown(state);
  if (`${why}\n${detail}` === shown) return;
  shown = `${why}\n${detail}`;
  const off = why === "none";
  document.body.classList.toggle("no3d", !off);
  const box = document.getElementById("no3d");
  const chip = document.getElementById("chip-3d");
  if (box) {
    box.hidden = off;
    box.querySelector("p")!.textContent = off ? "" : no3dText(why);
    box.title = detail;
  }
  if (chip) chip.hidden = off;
  if (!off) console.error(`twin view: no 3D (${why}): ${detail}`);
}
