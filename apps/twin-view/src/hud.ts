// The panels around the 3D scene: the robot's state chips, its ports and screen, and the MCP calls.
import type { CallEnd, CallStart, MotorState, RobotState, SensorState } from "./messages";
import { COLOR_RGB } from "./arena";

const $ = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`the page has no #${id}`);
  return e as T;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const ACTIVITY: Record<string, [string, string]> = {
  idle: ["en reposo", "ok"],
  acting: ["en movimiento", "busy"],
  running_program: ["programa", "busy"],
  looping: ["bucle", "busy"],
  stopping: ["frenando", "warn"],
  fault: ["falla", "bad"],
};
export const LINK: Record<string, [string, string]> = {
  online: ["en línea", "ok"],
  handshaking: ["conectando", "warn"],
  offline: ["desconectado", "bad"],
};
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
  ultrasonic: { 0: "distancia", 1: "distancia (in)", 2: "escucha" },
  gyro: { 0: "ángulo", 1: "velocidad", 3: "ángulo y velocidad" },
  ir: { 0: "proximidad" },
};
export const COLOR_NAMES = ["ninguno", "negro", "azul", "verde", "amarillo", "rojo", "blanco", "marrón"];

export function chip(id: string, [text, kind]: [string, string]): void {
  const el = $(id);
  el.textContent = text;
  el.className = `chip ${kind}`;
}

function sensorValue(s: SensorState): string {
  const v = s.values;
  if (!s.kind) return "—";
  if (!v.length) return '<span class="dim">sin dato</span>';
  switch (s.kind) {
    case "touch":
      return s.mode === 0 ? (v[0] ? "<b>presionado</b>" : "libre") : `${v[0]} golpes`;
    case "color":
      if (s.mode === 2) {
        const c = v[0] ?? 0;
        return `<span class="swatch" style="background:${COLOR_RGB[c] ?? "#888"}"></span>${COLOR_NAMES[c] ?? c}`;
      }
      if (s.mode === 4) return v.join(" · ");
      return `${v[0]} %`;
    case "ultrasonic":
      return s.mode === 0 ? `${v[0]!.toFixed(1)} cm` : s.mode === 1 ? `${v[0]!.toFixed(1)} in` : "escuchando";
    case "gyro":
      return s.mode === 0 ? `${v[0]}°` : s.mode === 1 ? `${v[0]}°/s` : `${v[0]}° · ${v[1]}°/s`;
    case "ir":
      return `${v[0]} %`;
  }
}

function motorRow(m: MotorState, role: string): string {
  if (!m.type)
    return `<div class="port empty"><span class="id">${m.port}</span><span class="what">vacío</span><span></span></div>`;
  const pct = Math.max(-100, Math.min(100, m.speed_pct));
  const tags =
    (m.blocked ? '<span class="tag bad">bloqueado</span>' : "") +
    (m.coasting ? '<span class="tag warn">inercia</span>' : "");
  const bar = `<div class="bar-mini"><i style="${pct >= 0 ? `left:50%;width:${pct / 2}%` : `left:${50 + pct / 2}%;width:${-pct / 2}%`}"></i></div>`;
  return `<div class="port"><span class="id">${m.port}</span><span class="what"><b>Motor ${m.type === "large" ? "grande" : "mediano"}</b>${role ? ` · ${role}` : ""}${tags}${bar}</span><span class="val">${Math.round(m.tacho_deg)}°<br><span class="dim">${Math.round(pct)} %</span></span></div>`;
}

/** The ports panel. `roles`: what each motor port does on this robot ("oruga izq."). */
export function ports(s: RobotState, roles: Record<string, string>): void {
  $("motors").innerHTML = s.motors.map((m) => motorRow(m, roles[m.port] ?? "")).join("");
  $("sensors").innerHTML = s.sensors
    .map((x) =>
      x.kind
        ? `<div class="port"><span class="id">${x.port}</span><span class="what"><b>${KIND[x.kind]}</b> · ${MODE[x.kind]?.[x.mode] ?? `modo ${x.mode}`}</span><span class="val">${sensorValue(x)}</span></div>`
        : `<div class="port empty"><span class="id">${x.port}</span><span class="what">vacío</span><span></span></div>`,
    )
    .join("");
  $("battery").textContent = `${s.battery_v.toFixed(2)} V · ${Math.round(s.battery_pct)} %`;
  const lcd = s.lcd.length ? s.lcd.slice(0, 10).join("\n") : "spinecord\n\nlisto";
  const el = $("lcd");
  if (el.textContent !== lcd) el.textContent = lcd;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#pad button"))
    b.classList.toggle("down", s.buttons.includes(Number(b.dataset.btn)));
}

const LED_CSS = ["#222", "#27e063", "#ff3b2f", "#ffa126"];
/** The LED of the button pad, animated like the brick's (flashing 4-6, pulsing 7-9). */
export function led(pattern: number, timeS: number): void {
  const el = $("led");
  const colour = pattern === 0 ? 0 : ((pattern - 1) % 3) + 1;
  const level =
    pattern === 0
      ? 0
      : pattern <= 3
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
}

// ---------------------------------------------------------------- calls
const MAX_CALLS = 60;
const rows = new Map<number, HTMLLIElement>();
export function call(m: CallStart | CallEnd): void {
  const list = $<HTMLOListElement>("calls");
  $("calls-hint").hidden = true;
  let li = rows.get(m.n);
  if (!li) {
    li = document.createElement("li");
    li.innerHTML = `<span class="st"></span><span class="tool"></span><span class="ms"></span><span class="args"></span><span class="sum" hidden></span>`;
    rows.set(m.n, li);
    list.prepend(li);
    while (list.children.length > MAX_CALLS) {
      const last = list.lastElementChild as HTMLLIElement;
      for (const [k, v] of rows) if (v === last) rows.delete(k);
      last.remove();
    }
  }
  const q = <T extends Element>(sel: string) => li!.querySelector<T & HTMLElement>(sel)!;
  q(".tool").innerHTML = `${esc(m.tool)}${m.robot_id ? `<span class="dim">${esc(m.robot_id)}</span>` : ""}`;
  if (m.t === "call_start") {
    li.className = "run";
    q(".args").textContent = m.args === "{}" ? "" : m.args;
    q(".ms").textContent = "…";
  } else {
    li.className = m.ok ? "ok" : "err";
    q(".ms").textContent = `${m.ms} ms`;
    const sum = q(".sum");
    sum.hidden = false;
    sum.textContent = m.summary;
    sum.title = m.summary;
  }
}

export function callsReset(): void {
  rows.clear();
  $("calls").innerHTML = "";
  $("calls-hint").hidden = false;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(text: string, info = false): void {
  const el = $("toast");
  el.textContent = text;
  el.className = info ? "toast info" : "toast";
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), info ? 2600 : 4200);
}

export function hint(text: string): void {
  const el = $("hint");
  el.textContent = text;
  el.hidden = text === "";
}
