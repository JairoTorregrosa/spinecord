// What the page says after "Restaurar mundo": plain words for the person at the page, naming only what this
// robot has (a gyro is set to zero only on a robot with one).
import type { RobotMeta } from "./messages";

/** The toast after a restore of `robot`'s room. */
export function restoredText(robot: Pick<RobotMeta, "ports">): string {
  const gyro = Object.values(robot.ports.sensors).includes("gyro");
  return `Listo: la sala quedó como al principio y el robot volvió a la salida${gyro ? ", con el giroscopio en cero" : ""}.`;
}
