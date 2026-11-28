// When the browser cannot draw in 3D (WebGL off: hardware acceleration disabled, a blocked GPU, a context the
// browser took back and did not return), the page says so where the scene would be, with the fix, and keeps the
// rest working: the connection, the brick panel, the widgets and the calls need no WebGL. A robot the page cannot
// draw as the twin reads it (its build contradicts itself) is said the same way, in place of a scene that lies.

export type No3dWhy = "no_context" | "lost" | "build";

/** How long a lost context may take to come back before the page says the 3D view is gone (ms). */
export const LOST_GRACE_MS = 3000;

/** The person's words for why there is no 3D view, and what to do. */
export function no3dText(why: No3dWhy, detail = ""): string {
  if (why === "build")
    return `El robot no se pudo dibujar como lo lee el gemelo: ${detail}. Corrige su archivo de robot y vuelve a abrir la página.`;
  const fix =
    "Abre la página en Chrome o Edge y activa la aceleración por hardware (chrome://settings/system), luego recarga.";
  return why === "lost"
    ? `El navegador cerró los gráficos 3D (WebGL) y no los devolvió. ${fix}`
    : `Este navegador no pudo iniciar los gráficos 3D (WebGL). ${fix}`;
}

/** Shows the message in place of the scene; the panels, the widgets and the calls stay. */
export function showNo3d(why: No3dWhy, detail: string): void {
  document.body.classList.add("no3d");
  const box = document.getElementById("no3d");
  const chip = document.getElementById("chip-3d");
  if (box) {
    box.hidden = false;
    box.querySelector("p")!.textContent = no3dText(why, detail);
    box.title = detail;
  }
  if (chip) chip.hidden = false;
  console.error(`twin view: no 3D (${why}): ${detail}`);
}

/** The context came back: the scene again. */
export function hideNo3d(): void {
  document.body.classList.remove("no3d");
  const box = document.getElementById("no3d");
  const chip = document.getElementById("chip-3d");
  if (box) box.hidden = true;
  if (chip) chip.hidden = true;
}
