// What happened in a twin's world (sim.world `events`, CONTRACT §4), as one compact row of the activity list: an
// icon, a few words, and the whole event in the row's title. Events that only end something already shown (a
// contact or a stall ending) or that the page already shows another way (the echo) give no row.
import type { WorldEventMsg } from "./messages";

const WALL: Record<string, string> = {
  wall_west: "pared oeste",
  wall_east: "pared este",
  wall_south: "pared sur",
  wall_north: "pared norte",
};
const touched = (w: string | undefined) => (w === undefined ? "?" : (WALL[w] ?? `caja ${w}`));

/** The row of one event, or null for an event the list does not show. */
export function eventRow(e: WorldEventMsg): { icon: string; text: string } | null {
  switch (e.kind) {
    case "push_began":
      return { icon: "📦", text: `empuja ${e.box}` };
    case "push_ended":
      return { icon: "📦", text: `${e.box} se movió ${fmt(e.moved_cm)} cm` };
    case "contact_began":
      return { icon: "💥", text: `toca ${touched(e.with)}` };
    case "obstacle_changed":
      return {
        icon: e.change === "added" ? "➕" : e.change === "removed" ? "➖" : "✋",
        text: `${e.box} ${e.change === "added" ? "puesta" : e.change === "removed" ? "quitada" : "movida"}`,
      };
    case "stall_began":
      return { icon: "⛔", text: "atascado" };
    case "slip_began":
      return { icon: "〰", text: "patina" };
    case "placed":
      return { icon: "🖐", text: e.how === "carried" ? "llevado a mano" : "vuelve al inicio" };
    default:
      return null;
  }
}
const fmt = (v: number | undefined) => (v === undefined ? "?" : (Math.round(v * 10) / 10).toLocaleString("es"));
