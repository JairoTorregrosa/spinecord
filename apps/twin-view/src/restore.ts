// What the page says after "Restaurar mundo": plain words for the person at the page, naming only what this
// robot has (a gyro is set to zero only on a robot with one), and a fault that a restore does not clear.
import type { RobotMeta } from "./messages";

/** The toast after a restore of `robot`'s room; `activity`: what the robot is left in. */
export function restoredText(robot: Pick<RobotMeta, "ports">, activity?: string): string {
  if (activity === "fault")
    return "La sala quedó como al principio, pero el robot sigue en falla: pídele a Claude que le quite la falla (reset_fault).";
  const gyro = Object.values(robot.ports.sensors).includes("gyro");
  return `Listo: la sala quedó como al principio y el robot volvió a la salida${gyro ? ", con el giroscopio en cero" : ""}.`;
}
