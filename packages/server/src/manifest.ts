// Shape checks for what runtimes and organs announce (CONTRACT §0.2: a command without a bound is rejected).
// Shape only: the relay knows nothing about what a kind, channel or command means.

import type { DeviceSpec, RobotProfile } from "../../protocol/types.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const BOUNDS = ["degrees", "ms", "instant"];
const LIMITS = ["max_speed_pct", "max_command_ms", "max_drive_cm", "max_turn_deg", "max_program_ms"] as const;

/** Returns null when the manifest is acceptable, else what is wrong. `provider` set → every device must belong to it. */
export function checkDevices(devices: unknown, provider?: string): string | null {
  if (!Array.isArray(devices)) return "devices must be an array of DeviceSpec";
  const seen = new Set<string>();
  for (const [i, d] of devices.entries()) {
    if (!isObj(d) || typeof d.id !== "string" || d.id === "") return `devices[${i}]: id is required`;
    const at = `device ${d.id}`;
    if (seen.has(d.id)) return `${at}: duplicate id`;
    seen.add(d.id);
    if (typeof d.provider !== "string" || typeof d.kind !== "string")
      return `${at}: provider and kind are required strings`;
    if (provider !== undefined && (d.provider !== provider || !d.id.startsWith(`${provider}.`)))
      return `${at}: an organ's devices must have provider "${provider}" and an id starting with "${provider}."`;
    if (!Array.isArray(d.roles) || !Array.isArray(d.channels) || !Array.isArray(d.commands))
      return `${at}: roles, channels and commands must be arrays`;
    for (const c of d.channels)
      if (!isObj(c) || typeof c.name !== "string" || typeof c.type !== "string")
        return `${at}: every channel needs name and type`;
    for (const c of d.commands) {
      if (!isObj(c) || typeof c.name !== "string") return `${at}: every command needs a name`;
      const b = c.bound;
      if (!isObj(b) || !BOUNDS.includes(b.kind as string) || typeof b.max !== "number" || !Number.isFinite(b.max))
        return `${at} command ${c.name}: bound {kind: degrees|ms|instant, max: number} is required; unbounded commands are rejected`;
      if (typeof c.moves !== "boolean") return `${at} command ${c.name}: moves must be a boolean`;
      if (c.params !== undefined && !isObj(c.params))
        return `${at} command ${c.name}: params must be a JSON Schema object`;
    }
  }
  return null;
}

export function checkProfile(p: unknown): string | null {
  if (!isObj(p) || typeof p.id !== "string") return "profile.id is required";
  if (!isObj(p.roles) || Object.values(p.roles).some((v) => typeof v !== "string"))
    return "profile.roles must map role → device id";
  if (!isObj(p.limits)) return "profile.limits is required";
  for (const k of LIMITS) {
    const v = (p.limits as Record<string, unknown>)[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return `profile.limits.${k} must be a positive number`;
  }
  if (!Array.isArray(p.notes)) return "profile.notes must be an array";
  return null;
}

/** Finds a device by id or role (profile role first, then the device's own roles). */
export function resolveDevice(
  ref: string,
  devices: DeviceSpec[],
  profile: RobotProfile | null,
): DeviceSpec | undefined {
  const byId = devices.find((d) => d.id === ref);
  if (byId) return byId;
  const target = profile?.roles[ref];
  return (target ? devices.find((d) => d.id === target) : undefined) ?? devices.find((d) => d.roles.includes(ref));
}
