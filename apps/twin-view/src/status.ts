// What the top bar says about the page's connection and the robot: nothing while all is well, one chip per problem.
// A chip is [text, kind] (kind = the CSS class: bad, warn, busy) or null for no chip.
export type Chip = [string, string] | null;

/** The robot's link, only when it is not online. */
const LINK: Record<string, [string, string]> = {
  handshaking: ["conectando", "warn"],
  offline: ["desconectado", "bad"],
};
/** What the robot does, only when it is worth a look: a fault, or a program or loop moving it with no call running. */
const ACTIVITY: Record<string, [string, string]> = {
  running_program: ["corriendo un programa", "busy"],
  looping: ["en un bucle", "busy"],
  fault: ["en falla", "bad"],
};
const OK_LINK = new Set(["online"]);
const OK_ACTIVITY = new Set(["idle", "acting", "stopping"]);

/**
 * The chips of the top bar. `open`: the page's socket to spinecord is up. `robot`: the last state of the robot in
 * focus, or null when none is known (no socket, or no state yet).
 */
export function statusChips(
  open: boolean,
  robot: { link: string; activity: string } | null,
): { ws: Chip; link: Chip; activity: Chip } {
  if (!open) return { ws: ["Sin conexión · reintentando", "bad"], link: null, activity: null };
  if (!robot) return { ws: null, link: null, activity: null };
  return {
    ws: null,
    link: OK_LINK.has(robot.link) ? null : (LINK[robot.link] ?? [robot.link, "warn"]),
    activity: OK_ACTIVITY.has(robot.activity) ? null : (ACTIVITY[robot.activity] ?? [robot.activity, "warn"]),
  };
}
