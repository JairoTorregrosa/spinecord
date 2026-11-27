// The LEGO parts map: units, EV3 electronics, what rolls, structural parts, the three sets' inventories, the
// official builds, and the LDraw geometry they all point into. The data is JSON in data/ (readable by people,
// skills and a browser bundle as is); this loader is for bun.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Build,
  ElectronicPart,
  GeometryFile,
  LegoSet,
  PartGeometry,
  RollingPart,
  StructuralPart,
} from "./types.ts";

export * from "./types.ts";

const read = <T>(file: string): T => JSON.parse(readFileSync(join(import.meta.dir, "data", file), "utf8")) as T;

export type LegoParts = {
  units: Record<string, unknown>;
  electronics: ElectronicPart[];
  rolling: RollingPart[];
  structural: StructuralPart[];
  sets: LegoSet[];
  setPartNames: Record<string, string>;
  builds: Build[];
  geometry: GeometryFile;
  models: Record<string, unknown>;
};

export function loadLegoParts(): LegoParts {
  const sets = read<{ sets: LegoSet[]; part_names: Record<string, string> }>("sets.json");
  return {
    units: read("units.json"),
    electronics: read<{ parts: ElectronicPart[] }>("electronics.json").parts,
    rolling: read<{ parts: RollingPart[] }>("rolling.json").parts,
    structural: read<{ parts: StructuralPart[] }>("structural.json").parts,
    sets: sets.sets,
    setPartNames: sets.part_names,
    builds: read<{ builds: Build[] }>("builds.json").builds,
    geometry: read("ldraw-geometry.json"),
    models: read("ldraw-models.json"),
  };
}

/** The LDraw geometry of a catalogue part, or a thrown error naming the part (no part is drawn from a guess). */
export function geometryOf(parts: LegoParts, ldraw: string): PartGeometry {
  const g = parts.geometry.parts[ldraw];
  if (!g)
    throw new Error(`no LDraw geometry for ${ldraw}: add it to a catalogue file and rerun tools/extract-ldraw.ts`);
  return g;
}

/** Which sets, and how many of each, hold a part (by Rebrickable part number), spares excluded. */
export function setsWith(parts: LegoParts, part: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of parts.sets)
    for (const l of s.lines) if (l.part === part && !l.spare) out[s.set] = (out[s.set] ?? 0) + l.quantity;
  return out;
}
