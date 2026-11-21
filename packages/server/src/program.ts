// Programs (CONTRACT §5). Shape and caps are checked by the contract's validators (their single owner);
// the relay only adds `requires`: what the program touches, as written. It never evaluates or runs a node.

import { validateCondition, validateProgram } from "../../protocol/validate.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Collects every `device` named anywhere under a value (condition leaves and command_device args). */
function devicesIn(v: unknown, out: Set<string>): void {
  if (Array.isArray(v)) for (const x of v) devicesIn(x, out);
  else if (isObj(v)) {
    if (typeof v.device === "string") out.add(v.device);
    for (const [k, x] of Object.entries(v)) if (k !== "args" || !("command" in v)) devicesIn(x, out); // a command's own args are data, not references
  }
}

/** A drivetrain tool anywhere in the tree means the program needs the kind `motor_pair` (CONTRACT §2.2). */
function usesDrivetrain(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(usesDrivetrain);
  if (!isObj(v)) return false;
  if (isObj(v.call) && ["drive", "turn", "arc"].includes(v.call.tool as string)) return true;
  return Object.values(v).some(usesDrivetrain);
}

/**
 * Validates a program body (and optional success condition) and returns `requires`: device ids or roles as
 * written, plus the kind "motor_pair" when a drivetrain tool is used.
 */
export function checkProgram(
  body: unknown,
  success?: unknown,
): { ok: true; requires: string[] } | { ok: false; message: string } {
  const issues = [...validateProgram(body), ...(success === undefined ? [] : validateCondition(success, "success"))];
  if (issues.length > 0)
    return {
      ok: false,
      message:
        issues
          .slice(0, 5)
          .map((i) => `${i.path}: ${i.message}`)
          .join("; ") + (issues.length > 5 ? `; and ${issues.length - 5} more` : ""),
    };
  const requires = new Set<string>();
  devicesIn(body, requires);
  devicesIn(success, requires);
  if (usesDrivetrain(body)) requires.add("motor_pair");
  return { ok: true, requires: [...requires].sort() };
}
