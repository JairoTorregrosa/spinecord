// Helpers shared by the tests (not exported from index.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { World, parseWorld, NO_NOISE, type WorldConfig, type DriveGeometry } from "./world";

export const example = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(import.meta.dir, "examples", name), "utf8")) as Record<string, unknown>;
export const EXAMPLES = { lineOval: example("line-oval.json"), wallsMaze: example("walls-maze.json") };
/** The drivetrain the tests give their robot (as a robot profile would): 12 cm between the wheels. */
export const DRIVE: DriveGeometry = { axle_track_cm: 12 };
export function config(json: unknown = EXAMPLES.lineOval, over: Partial<WorldConfig> = {}): WorldConfig {
  return { ...parseWorld(json), ...over };
}
/** An example world without noise (to compare against exact numbers), with a body that can roll. */
export function quietWorld(json: unknown = EXAMPLES.lineOval, over: Partial<WorldConfig> = {}): World {
  return new World(config(json, { noise: { ...NO_NOISE }, ...over }), 1, { ...DRIVE });
}
