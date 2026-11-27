// The tools in the person's words, and the one value of a call worth a glance: shared by the activity list and the
// chat (--chat), so a call looks the same in both.
/** The tools in the person's words; the MCP name stays in the tooltip. */
export const TOOL: Record<string, [string, string]> = {
  drive: ["⬆", "avanzar"],
  turn: ["↻", "girar"],
  arc: ["⤴", "arco"],
  stop: ["■", "parar"],
  read_all: ["👁", "leer sensores"],
  read_device: ["👁", "leer"],
  sample_device: ["📈", "muestrear"],
  wait_until: ["⏳", "esperar"],
  describe_robot: ["🔎", "conocerse"],
  describe_device: ["🔎", "mirar"],
  list_robots: ["🔎", "robots"],
  command_device: ["⚡", "orden"],
  run_program: ["▶", "programa"],
  run_loop: ["🔁", "bucle"],
  supervise_loop: ["🔁", "vigilar"],
  reset_fault: ["↺", "reiniciar"],
};
/** The arguments of a call that matter at a glance (at most three values, units by their names). */
export function shortArgs(json: string): string {
  try {
    const a = JSON.parse(json) as Record<string, unknown>;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(a)) {
      if (k === "robot_id" || k === "request_id") continue;
      if (typeof v === "number")
        parts.push(
          `${v}${k.endsWith("_cm") ? " cm" : k.endsWith("_deg") ? "°" : k.endsWith("_pct") ? "%" : k.endsWith("_ms") ? " ms" : ""}`,
        );
      else if (typeof v === "string") parts.push(v);
      if (parts.length === 3) break;
    }
    return parts.join(" · ");
  } catch {
    return ""; // cut arguments are not JSON: the tooltip has them
  }
}
