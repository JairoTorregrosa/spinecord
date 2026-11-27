// Small widgets for the readouts of the brick panel: a gauge for a motor's speed, a bar for a distance, a swatch
// for a colour, a compass for a heading, a dot for a touch, a bar for the battery. Each one is drawn from a value
// the process sent, never from one it did not: an empty port gets no widget, a mode without values says so. Every
// number stays reachable in the widget's title. Pure functions returning HTML, so they are tested without a page.
import type { SensorState } from "./messages";
import { COLOR_RGB } from "./arena";

export const COLOR_NAMES = ["ninguno", "negro", "azul", "verde", "amarillo", "rojo", "blanco", "marrón"];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** A half-circle gauge of a signed percentage (-100 left .. 100 right), the number beside it. */
export function gauge(pct: number, title: string): string {
  const p = clamp(pct, -100, 100);
  const a = (p / 100) * (Math.PI / 2); // 0 points up
  const x = 18 + 14 * Math.sin(a),
    y = 18 - 14 * Math.cos(a);
  const fill = p >= 0 ? "var(--blue)" : "var(--warn)";
  return `<span class="w-gauge" title="${attr(title)}"><svg viewBox="0 0 36 20" width="36" height="20" aria-hidden="true"><path d="M4 18 A14 14 0 0 1 32 18" fill="none" stroke="#ffffff22" stroke-width="3"/><line x1="18" y1="18" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${fill}" stroke-width="2.5" stroke-linecap="round"/></svg><span>${Math.round(p)} %</span></span>`;
}

/** A bar filled `frac` (0..1) with its words beside it. */
export function bar(frac: number, words: string, title: string, kind = ""): string {
  return `<span class="w-bar ${kind}" title="${attr(title)}"><i><b style="width:${(clamp(frac, 0, 1) * 100).toFixed(0)}%"></b></i><span>${words}</span></span>`;
}

/** A compass needle at `deg` (counter-clockwise positive, 0 = where it started). */
export function compass(deg: number, title: string): string {
  return `<span class="w-compass" title="${attr(title)}"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="#ffffff33" stroke-width="1.5"/><g transform="rotate(${(-deg).toFixed(0)} 12 12)"><path d="M12 3 L15 13 L12 11.5 L9 13 Z" fill="var(--bad)"/></g></svg><span>${Math.round(deg)}°</span></span>`;
}

/** A dot, lit when `on`. */
export function dot(on: boolean, words: string, title: string): string {
  return `<span class="w-dot${on ? " on" : ""}" title="${attr(title)}"><i></i><span>${words}</span></span>`;
}

/** A colour swatch with its name. */
export function swatch(css: string, name: string, title: string): string {
  return `<span class="w-swatch" title="${attr(title)}"><i style="background:${css}"></i><span>${name}</span></span>`;
}

/** The widget of one sensor's reading; "" for an empty port. `mode`: the mode's words, for the title. */
export function sensorWidget(s: SensorState, mode: string): string {
  if (!s.kind) return "";
  const v = s.values;
  const all = `${mode}: ${v.length ? v.join(", ") : "sin dato"}`;
  if (!v.length) return `<span class="dim" title="${attr(all)}">sin dato</span>`;
  switch (s.kind) {
    case "touch":
      return s.mode === 0
        ? dot(v[0]! >= 0.5, v[0]! >= 0.5 ? "presionado" : "libre", all)
        : `<span title="${attr(all)}">${v[0]} golpes</span>`;
    case "color": {
      if (s.mode === 2) {
        const c = v[0] ?? 0;
        const rgb = COLOR_RGB[c];
        return swatch(rgb ?? "transparent", COLOR_NAMES[c] ?? String(c), all);
      }
      if (s.mode === 4) {
        const [r, g, b] = v.map((x) => Math.round(clamp(x / 400, 0, 1) * 255));
        return swatch(`rgb(${r},${g},${b})`, v.map((x) => Math.round(x)).join(" · "), all);
      }
      // reflected or ambient light: how bright, not which colour (the sensor does not know it in this mode)
      const g = Math.round(clamp(v[0]! / 100, 0, 1) * 255);
      return swatch(`rgb(${g},${g},${g})`, `${Math.round(v[0]!)} %`, all);
    }
    case "ultrasonic": {
      if (s.mode === 2) return `<span title="${attr(all)}">escuchando</span>`;
      const cm = s.mode === 1 ? v[0]! * 2.54 : v[0]!;
      if (s.mode === 0 && v[0] === 255) return bar(0, "sin eco", `${all} (255: no vuelve eco)`, "none");
      const unit = s.mode === 1 ? "in" : "cm";
      return bar(1 - clamp(cm / 250, 0, 1), `${v[0]!.toFixed(1)} ${unit}`, all, "near");
    }
    case "gyro":
      if (s.mode === 1) return `<span title="${attr(all)}">${Math.round(v[0]!)}°/s</span>`;
      return compass(v[0]!, s.mode === 3 ? `${all} (ángulo°, °/s)` : all);
    case "ir":
      return bar(1 - clamp(v[0]! / 100, 0, 1), `${Math.round(v[0]!)} %`, `${all} (0 = tocando, 100 = lejos)`, "near");
  }
}
