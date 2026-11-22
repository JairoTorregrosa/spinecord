// The robot file of a deployment (deployments/<name>/robots/<robot>.json): what an EV3 provider needs beyond
// the contract's profile. One shape and one validator for everything that builds an Ev3Provider from data
// (a twin, a stock EV3 behind the bridge page). Pure: no I/O.
import type { Limits, RobotProfile } from "../protocol/types";
import type { OutputPort } from "./encode";
import type { Ev3Hardware } from "./provider";

export interface RobotFile {
  /** Ports of the synced motor pair `<id>.pair`. */
  pair: { left: OutputPort; right: OutputPort };
  hardware: Ev3Hardware;
  profile: RobotProfile;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates a robot file. `where` prefixes every message (the path it was read from). */
export function parseRobotFile(json: unknown, where: string): RobotFile {
  const fail = (field: string, why: string): never => {
    throw new Error(`${where}: ${field} ${why}`);
  };
  const obj = (v: unknown, field: string): Record<string, unknown> => (isObj(v) ? v : fail(field, "must be an object"));
  const positive = (v: unknown, field: string): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0
      ? v
      : fail(field, `must be a number > 0, got ${JSON.stringify(v)}`);
  const text = (v: unknown, field: string): string =>
    typeof v === "string" && v !== "" ? v : fail(field, `must be a non-empty string, got ${JSON.stringify(v)}`);
  const port = (v: unknown, field: string): OutputPort =>
    v === "A" || v === "B" || v === "C" || v === "D"
      ? v
      : fail(field, `must be a motor port A, B, C or D, got ${JSON.stringify(v)}`);

  const root = obj(json, "the file");
  const pairIn = obj(root.pair, "pair");
  const pair = { left: port(pairIn.left, "pair.left"), right: port(pairIn.right, "pair.right") };
  if (pair.left === pair.right) fail("pair", `needs two different ports, got ${pair.left} twice`);

  const hw = obj(root.hardware, "hardware");
  const hardware: Ev3Hardware = {
    low_battery_v: positive(hw.low_battery_v, "hardware.low_battery_v"),
    max_tone_ms: positive(hw.max_tone_ms, "hardware.max_tone_ms"),
    tone_volume_pct: positive(hw.tone_volume_pct, "hardware.tone_volume_pct"),
  };

  const p = obj(root.profile, "profile");
  const roles = obj(p.roles, "profile.roles");
  for (const [role, device] of Object.entries(roles)) text(device, `profile.roles.${role}`);
  const lim = obj(p.limits, "profile.limits");
  const limits: Limits = {
    max_speed_pct: positive(lim.max_speed_pct, "profile.limits.max_speed_pct"),
    max_command_ms: positive(lim.max_command_ms, "profile.limits.max_command_ms"),
    max_drive_cm: positive(lim.max_drive_cm, "profile.limits.max_drive_cm"),
    max_turn_deg: positive(lim.max_turn_deg, "profile.limits.max_turn_deg"),
    max_program_ms: positive(lim.max_program_ms, "profile.limits.max_program_ms"),
  };
  if (!Array.isArray(p.notes) || p.notes.some((n) => typeof n !== "string"))
    fail("profile.notes", "must be an array of strings");
  const profile: RobotProfile = {
    id: text(p.id, "profile.id"),
    roles: roles as Record<string, string>,
    limits,
    notes: p.notes as string[],
  };
  if (p.drivetrain !== undefined) {
    const d = obj(p.drivetrain, "profile.drivetrain");
    if (d.type !== "differential")
      fail("profile.drivetrain.type", `must be "differential", got ${JSON.stringify(d.type)}`);
    if (d.forward_sign !== 1 && d.forward_sign !== -1)
      fail("profile.drivetrain.forward_sign", `must be 1 or -1, got ${JSON.stringify(d.forward_sign)}`);
    profile.drivetrain = {
      type: "differential",
      pair_device: text(d.pair_device, "profile.drivetrain.pair_device"),
      wheel_diameter_cm: positive(d.wheel_diameter_cm, "profile.drivetrain.wheel_diameter_cm"),
      axle_track_cm: positive(d.axle_track_cm, "profile.drivetrain.axle_track_cm"),
      forward_sign: d.forward_sign as 1 | -1,
    };
  }
  return { pair, hardware, profile };
}
