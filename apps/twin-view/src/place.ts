// A look's place as the robot file writes it (look.ts header): x, y, z in modules (halves allowed) or in cm, a
// facing and a yaw. Pure and free of the parts map, so apps/local reads places with the same rule as the page; the
// size of a module comes from the caller (dims.ts MODULE on the page, the parts map at run time on the server).
import type { Facing, Place } from "./look";

const FACINGS: readonly Facing[] = ["forward", "back", "left", "right", "up", "down"];
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A length given in modules (rounded to a half module) or in cm, in cm; null when neither is given. */
export function lenIn(at: Record<string, unknown>, k: string, moduleCm: number): number | null {
  const cm = num(at[`${k}_cm`]);
  if (cm !== null) return cm;
  const m = num(at[k]);
  return m === null ? null : (Math.round(m * 2) / 2) * moduleCm;
}

/** A look's place: x, y, z in modules or cm (null where not given), its facing and yaw_deg. */
export function placeIn(v: unknown, moduleCm: number): Place {
  const at = obj(v) ?? {};
  return {
    x: lenIn(at, "x", moduleCm),
    y: lenIn(at, "y", moduleCm),
    z: lenIn(at, "z", moduleCm),
    facing: FACINGS.includes(at.facing as Facing) ? (at.facing as Facing) : null,
    yaw: num(at.yaw_deg) ?? 0,
  };
}
