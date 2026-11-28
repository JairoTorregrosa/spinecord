// The panels around the 3D scene: the robot's problem chips, its ports and screen, Claude's MCP calls, and the notes
// the page gives the person (toasts, hints). All copy is the page's own, in Spanish.
import { Follow, ScrollOwner, isClaudeCall, keptScrollTop } from "./activity";
import type { Chip } from "./status";
import type { MotorState, RefusalCode, RobotState, ServerMessage } from "./messages";
import { glance } from "./toolwords";
import { bar, gauge, sensorWidget } from "./widgets";

const $ = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`the page has no #${id}`);
  return e as T;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Why the process refused an action of the hand, in the person's words. */
export const REFUSAL: Record<RefusalCode | "offline", string> = {
  does_not_fit: "No cabe ahí: chocaría con una pared o una caja",
  box_on_robot: "La caja caería sobre el robot: ponla en un sitio libre",
  outside: "La caja tiene que quedar dentro de la pista",
  no_such_box: "Esa caja ya no está: otra pestaña la quitó o la movió",
  too_fast: "Demasiadas acciones seguidas: espera un segundo",
  invalid: "La página envió una acción no válida (recárgala)",
  internal: "Error del visor (queda en el registro de spinecord)",
  offline: "Sin conexión con spinecord: no se hizo nada",
};
/** The distance sensors, by kind: what the cone of the 3D view is called. */
export const CONE: Record<string, string> = { ultrasonic: "Cono ultrasónico", ir: "Cono infrarrojo" };
const KIND: Record<string, string> = {
  touch: "Táctil",
  color: "Color",
  ultrasonic: "Ultrasónico",
  gyro: "Giroscopio",
  ir: "Infrarrojo",
};
const MODE: Record<string, Record<number, string>> = {
  touch: { 0: "presión", 1: "golpes" },
  color: { 0: "luz reflejada", 1: "luz ambiente", 2: "color", 4: "RGB" },
  ultrasonic: { 0: "distancia", 1: "distancia en pulgadas", 2: "escucha" },
  gyro: { 0: "ángulo", 1: "velocidad de giro", 3: "ángulo y velocidad" },
  ir: { 0: "proximidad" },
};
/** What a value means, for the tooltip of a sensor. */
const MEANING: Record<string, string> = {
  touch: "1 = presionado, 0 = libre",
  color: "luz en %, o el color que ve",
  ultrasonic: "distancia al obstáculo más cercano del cono",
  gyro: "grados desde el último reinicio; positivo = a la izquierda (antihorario)",
  ir: "0 = tocando, 100 = lejos (unos 70 cm); no son centímetros",
};
/** One chip of the top bar; null hides it. */
export function chip(id: string, c: Chip): void {
  const el = $(id);
  el.hidden = c === null;
  if (!c) return;
  const [text, kind] = c;
  if (el.textContent !== text) el.textContent = text;
  el.className = `chip ${kind}`;
}

function motorRow(m: MotorState, role: string): string {
  if (!m.type)
    return `<div class="port empty"><span class="id">${m.port}</span><span class="what">vacío</span><span></span></div>`;
  const pct = Math.max(-100, Math.min(100, m.speed_pct));
  const tags =
    (m.blocked ? '<span class="tag bad">bloqueado</span>' : "") +
    (m.coasting ? '<span class="tag warn">por inercia</span>' : "");
  const title = `velocidad ${m.speed_pct} % · giro acumulado (tacómetro) ${m.tacho_deg}°`;
  return `<div class="port${m.blocked ? " blocked" : ""}"><span class="id">${m.port}</span><span class="what"><b>${m.type === "large" ? "Grande" : "Mediano"}</b>${role ? ` · ${role}` : ""}${tags}</span><span class="val">${gauge(pct, title)}<span class="dim tacho" title="${title}">${Math.round(m.tacho_deg)}°</span></span></div>`;
}

/** The ports panel. `roles`: what each motor port does on this robot ("oruga izq."). */
export function ports(s: RobotState, roles: Record<string, string>): void {
  setHtml("motors", s.motors.map((m) => motorRow(m, roles[m.port] ?? "")).join(""));
  setHtml(
    "sensors",
    s.sensors
      .map((x) =>
        x.kind
          ? `<div class="port" title="${esc(MEANING[x.kind] ?? "")}"><span class="id">${x.port}</span><span class="what"><b>${KIND[x.kind]}</b></span><span class="val">${sensorWidget(x, MODE[x.kind]?.[x.mode] ?? `modo ${x.mode}`)}</span></div>`
          : `<div class="port empty"><span class="id">${x.port}</span><span class="what">vacío</span><span></span></div>`,
      )
      .join(""),
  );
  const low = s.battery_pct < 20;
  const bat = $("battery");
  setHtml(
    "battery",
    bar(
      s.battery_pct / 100,
      `${Math.round(s.battery_pct)} %`,
      `batería ${s.battery_v.toFixed(2)} V · ${s.battery_pct} %`,
      low ? "low" : "bat",
    ),
  );
  bat.classList.toggle("bad", low);
  const blank = s.lcd.every((l) => l.trim() === "");
  const lcd = blank ? "pantalla en blanco" : s.lcd.slice(0, 10).join("\n");
  const el = $("lcd");
  if (el.textContent !== lcd) el.textContent = lcd;
  el.classList.toggle("blank", blank);
  for (const b of document.querySelectorAll<HTMLButtonElement>("#pad button"))
    b.classList.toggle("down", s.buttons.includes(Number(b.dataset.btn)));
}
/** innerHTML only when it changed: a panel rebuilt ten times a second loses the hover and the text selection. */
function setHtml(id: string, html: string): void {
  const el = $(id);
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
}

const LED_CSS = ["#222", "#27e063", "#ff3b2f", "#ffa126"];
const LED_NAMES = ["apagado", "verde", "rojo", "naranja"];
/** The LED of the button pad, animated like the brick's (flashing 4-6, pulsing 7-9). */
const still = matchMedia("(prefers-reduced-motion: reduce)");
export function led(pattern: number, timeS: number): void {
  const el = $("led");
  const colour = pattern === 0 ? 0 : ((pattern - 1) % 3) + 1;
  // reduced motion: the colour, steady, with the pattern named in the title
  const level =
    pattern === 0
      ? 0
      : pattern <= 3 || still.matches
        ? 1
        : pattern <= 6
          ? (timeS * 2) % 1 < 0.5
            ? 1
            : 0
          : 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(timeS * Math.PI * 2));
  const c = level > 0.1 ? LED_CSS[colour]! : "#222";
  el.style.background = c;
  el.style.boxShadow = level > 0.1 && colour ? `0 0 ${6 + 8 * level}px ${LED_CSS[colour]}` : "none";
  el.style.opacity = String(0.4 + 0.6 * level);
  const title = `LED: ${LED_NAMES[colour]}${pattern > 3 ? (pattern <= 6 ? ", parpadea" : ", pulsa") : ""}`;
  if (el.title !== title) el.title = title;
}

// ---------------------------------------------------------------- calls
const MAX_CALLS = 80;
const rows = new Map<number, { li: HTMLLIElement; at: number; running: boolean }>();
/** Whether the list shows the newest call, and which scrolls are the page's own (src/activity.ts). */
const follow = new Follow();
const owner = new ScrollOwner();
let wasFolded = false;
const secs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const atNewest = (list: HTMLElement) => list.scrollTop <= 4;
/** The page scrolls the list, and notes the place it set so that scroll is not taken for the person's. */
function setTop(list: HTMLElement, top: number): void {
  list.scrollTop = top;
  owner.set(list.scrollTop);
}
/** The first row the person sees, and its top relative to the list's top edge. */
function visibleRow(list: HTMLElement): HTMLElement | null {
  const edge = list.getBoundingClientRect().top;
  for (const li of list.children) if (li.getBoundingClientRect().bottom > edge) return li as HTMLElement;
  return null;
}
const relTop = (li: HTMLElement, list: HTMLElement) =>
  li.getBoundingClientRect().top - list.getBoundingClientRect().top;

/**
 * One call of Claude's begins or ends; any other message is not the panel's (src/activity.ts). The list follows the
 * newest; while the person reads older calls it keeps their place.
 */
export function call(m: ServerMessage): void {
  if (!isClaudeCall(m)) return;
  const list = $<HTMLOListElement>("calls");
  $("calls-hint").hidden = true;
  // the row the person reads, measured before rows come, go (past MAX_CALLS) or grow, to hold it still after
  const anchor = follow.following ? null : visibleRow(list);
  const anchorBefore = anchor ? relTop(anchor, list) : 0;
  let row = rows.get(m.n);
  let added = false;
  if (!row) {
    const li = document.createElement("li");
    li.tabIndex = 0;
    li.innerHTML = `<span class="st" aria-hidden="true"></span><span class="tool"></span><span class="ms"></span><span class="args"></span><span class="sum" hidden></span>`;
    li.dataset.tool = m.tool;
    li.dataset.glance = glance(m.tool, m.t === "call_start" ? m.args : null);
    li.addEventListener("click", () => li.classList.toggle("open"));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        li.classList.toggle("open");
      }
    });
    row = { li, at: m.at, running: true };
    rows.set(m.n, row);
    list.prepend(li);
    added = true;
    while (list.children.length > MAX_CALLS) {
      const last = list.lastElementChild as HTMLLIElement;
      for (const [k, v] of rows) if (v.li === last) rows.delete(k);
      last.remove();
    }
  }
  const li = row.li;
  const q = (sel: string) => li.querySelector<HTMLElement>(sel)!;
  const time = new Date(m.at).toLocaleTimeString("es", { hour12: false });
  if (m.t === "call_start") {
    row.at = m.at;
    row.running = true;
    li.className = "run";
    q(".tool").innerHTML = `${li.dataset.glance}<span class="badge run">en curso</span>`;
    q(".args").textContent = m.args === "{}" ? "sin argumentos" : m.args;
    q(".ms").textContent = secs(Date.now() - m.at);
    li.title = `empezó a las ${time}`;
  } else {
    row.running = false;
    const reason = /\breason=(\w+)/.exec(m.summary)?.[1];
    const odd = m.ok && reason !== undefined && reason !== "completed" && reason !== "condition_met";
    li.className = `${m.ok ? (odd ? "warn" : "ok") : "err"}${li.classList.contains("open") ? " open" : ""}`;
    const badge = !m.ok
      ? `<span class="badge err">error · ${esc(m.code ?? "?")}</span>`
      : odd
        ? `<span class="badge warn">${esc(REASON[reason!] ?? reason!)}</span>`
        : "";
    q(".tool").innerHTML = `${li.dataset.glance ?? glance(m.tool, null)}${badge}`;
    q(".ms").textContent = secs(m.ms);
    const sum = q(".sum");
    sum.hidden = false;
    sum.textContent = m.summary;
    li.title = `terminó a las ${time} · clic para ver todo`;
  }
  if (added ? follow.added() : follow.following) setTop(list, 0);
  else if (anchor?.isConnected) setTop(list, keptScrollTop(list.scrollTop, anchorBefore, relTop(anchor, list)));
  showUnseen();
}

const REASON: Record<string, string> = {
  stalled: "se atascó",
  timeout: "se acabó el tiempo",
  clamped: "recortado",
  preempted: "interrumpido",
};

function showUnseen(): void {
  const b = $<HTMLButtonElement>("calls-new");
  const n = follow.unseen;
  b.hidden = n === 0;
  b.textContent = `↑ ${n} ${n === 1 ? "nueva" : "nuevas"}`;
}
/**
 * Wires the list: a scroll the page did not make is the person's and starts reading, or keeps it while they scroll
 * or drag on it; back at the top it follows again.
 */
export function callsInit(): void {
  const list = $<HTMLOListElement>("calls");
  let down = false;
  const acts = () => {
    if (!atNewest(list)) follow.touched(false, performance.now());
  };
  for (const ev of ["wheel", "pointerdown", "touchstart", "keydown"])
    list.addEventListener(
      ev,
      () => {
        owner.personActs();
        if (ev === "pointerdown" || ev === "touchstart") down = true;
        acts();
      },
      { passive: true },
    );
  // a pointer or a finger held on the list and moving: the person is still at it, however long the drag
  for (const ev of ["pointermove", "touchmove"]) list.addEventListener(ev, () => down && acts(), { passive: true });
  for (const ev of ["pointerup", "pointercancel", "touchend", "touchcancel"])
    addEventListener(ev, () => (down = false), { passive: true });
  list.addEventListener("scroll", () => {
    const top = list.scrollTop;
    if (owner.byPage(top)) follow.scrolled(top <= 4);
    else follow.touched(top <= 4, performance.now());
    showUnseen();
  });
  $("calls-new").addEventListener("click", () => {
    follow.reset();
    showUnseen();
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (smooth) owner.glide(0);
    list.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
    if (!smooth) owner.set(list.scrollTop);
  });
}

/** Ten times a second: the time the running calls have taken so far, the call in the top bar, and the return to
 * the newest call once the person has left the list alone. */
export function callsTick(): void {
  // folded, nothing of the list is visible: it stops reading, and opens on the newest call (a hidden list keeps no
  // scroll the page sets, and the browser gives the old one back when it shows again: the top is set on opening)
  const folded = $("callpanel").classList.contains("folded");
  const opened = wasFolded && !folded;
  wasFolded = folded;
  if ((folded && follow.folded()) || follow.tick(performance.now()) || (opened && follow.following)) {
    setTop($("calls"), 0);
    showUnseen();
  }
  let newest: { tool: string; ms: number } | null = null;
  for (const [, r] of rows)
    if (r.running) {
      const ms = Date.now() - r.at;
      r.li.querySelector<HTMLElement>(".ms")!.textContent = secs(ms);
      const tool = r.li.dataset.tool ?? "";
      newest = { tool, ms };
    }
  const el = $("chip-call");
  el.hidden = newest === null;
  if (newest) el.textContent = `▶ ${newest.tool} · ${secs(newest.ms)}`;
}

export function callsReset(): void {
  rows.clear();
  follow.reset();
  $("calls").innerHTML = "";
  $("calls-hint").hidden = false;
  showUnseen();
}

// ---------------------------------------------------------------- notes to the person
let toastTimer: ReturnType<typeof setTimeout> | null = null;
/** A note at the bottom of the scene: an error (red) unless `kind` says it is information. */
export function toast(text: string, kind: "error" | "info" = "error"): void {
  place(text, kind, null);
}
/** A note where the hand let go: next to the pointer of `at`. */
export function toastAt(text: string, at: { clientX: number; clientY: number }): void {
  place(text, "error", at);
}
function place(text: string, kind: "error" | "info", at: { clientX: number; clientY: number } | null): void {
  const el = $("toast");
  el.textContent = text;
  el.className = `toast ${kind}${at ? " at" : ""}`;
  el.style.left = at ? `${Math.min(innerWidth - 160, Math.max(160, at.clientX))}px` : "";
  el.style.top = at ? `${Math.max(70, at.clientY - 18)}px` : "";
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), Math.max(kind === "info" ? 3500 : 5000, text.length * 60));
}

let hintFade: ReturnType<typeof setTimeout> | null = null;
/** A short hint at the top of the scene; it fades after the person's next touch of the page. */
export function hint(text: string): void {
  const el = $("hint");
  if (hintFade) clearTimeout(hintFade);
  el.textContent = text;
  el.classList.remove("fade");
  el.hidden = text === "";
  if (el.hidden) return;
  const fade = () => {
    removeEventListener("pointerdown", fade, true);
    removeEventListener("keydown", fade, true);
    hintFade = setTimeout(() => {
      el.classList.add("fade");
      hintFade = setTimeout(() => (el.hidden = true), 600);
    }, 1500);
  };
  // the hint that the press itself brought (a mode button) waits for the press after it
  setTimeout(() => {
    addEventListener("pointerdown", fade, { capture: true, once: true });
    addEventListener("keydown", fade, { capture: true, once: true });
  }, 0);
}
