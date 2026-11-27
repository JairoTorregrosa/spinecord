// A draft twin (CONTRACT §3 `twin.unconfirmed`, reaching the page as `world.look.unconfirmed`): what of its build
// nobody confirmed, in plain Spanish, one line per entry. The page shows a "borrador" chip only when there is one.
import type { RobotMeta } from "./messages";

const MOTOR: Record<string, string> = { large: "motor grande", medium: "motor mediano" };
const SENSOR: Record<string, string> = {
  touch: "táctil",
  color: "color",
  ultrasonic: "ultrasónico",
  gyro: "giroscopio",
  ir: "infrarrojo",
};
const WHAT: Record<string, string> = {
  left_right: "Qué motor mueve el lado izquierdo",
  front: "Cuál es el frente del robot",
  drive: "Si avanza con ruedas, con orugas o no avanza",
  wheel_diameter: "El diámetro de las ruedas",
  axle_track: "La distancia entre las ruedas",
  footprint: "El tamaño del robot en el suelo",
  places: "Dónde van el ladrillo, los sensores y el teléfono",
};

/** The entries of `look.unconfirmed` (a list of strings), or [] when absent or not a list. */
export function unconfirmedOf(m: RobotMeta): string[] {
  const u = m.world.look?.unconfirmed;
  return Array.isArray(u) ? u.filter((e): e is string => typeof e === "string") : [];
}

/** One plain line per unconfirmed entry: the port with what the file says is there, or the measure. */
export function draftLines(m: RobotMeta): string[] {
  return unconfirmedOf(m).map((e) => {
    if (/^[A-D]$/.test(e)) {
      const k = m.ports.motors[e as "A"];
      return `Puerto ${e}: ${k ? MOTOR[k] : "vacío"}`;
    }
    const s = /^S([1-4])$/.exec(e);
    if (s) {
      const k = m.ports.sensors[s[1] as "1"];
      return `Puerto ${s[1]}: ${k ? `sensor ${SENSOR[k]}` : "vacío"}`;
    }
    return WHAT[e] ?? e;
  });
}
