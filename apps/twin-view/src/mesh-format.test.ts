// The real meshes committed in apps/twin-view/meshes are the LDraw parts the map names, whole: the same triangles
// as the map's geometry (less the brick's LCD, which the page draws itself), at the map's size, with the roles the
// page moves.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import geometry from "../../../packages/lego-parts/data/ldraw-geometry.json";
import { decode } from "./mesh-format";
import { REAL } from "./mesh-parts";

const dir = join(import.meta.dir, "..", "meshes");
const load = (part: string) => {
  const gz = readFileSync(join(dir, `${part}.bin.gz`));
  const raw = Bun.gunzipSync(new Uint8Array(gz));
  return decode(part, raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
};
/** The LCD sub-part 11036 is 12 triangles. */
const LCD = 12;

describe("the real meshes", () => {
  for (const part of REAL)
    test(`${part}: every triangle of the LDraw part, at its size`, () => {
      const d = load(part);
      const g = (
        geometry as { parts: Record<string, { triangles: number; bbox_ldu: { min: number[]; max: number[] } }> }
      ).parts[part]!;
      expect(d.triangles + (part.startsWith("95646") ? LCD : 0)).toBe(g.triangles);
      const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (const grp of d.groups) {
        grp.geometry.computeBoundingBox();
        const b = grp.geometry.boundingBox!;
        box.min = box.min.map((v, i) => Math.min(v, b.min.getComponent(i)));
        box.max = box.max.map((v, i) => Math.max(v, b.max.getComponent(i)));
      }
      for (let i = 0; i < 3; i++) {
        expect(box.min[i]!).toBeCloseTo(g.bbox_ldu.min[i]!, 1);
        expect(box.max[i]!).toBeCloseTo(g.bbox_ldu.max[i]!, 1);
      }
    });
  test("the parts that move are their own groups", () => {
    const roles = (p: string) => new Set(load(p).groups.map((g) => g.role));
    expect([...roles("95646")].sort()).toEqual(
      ["body", "button1", "button2", "button3", "button4", "button5", "button6", "led"].sort(),
    );
    expect(roles("95658").has("hub")).toBe(true);
    expect(roles("99455").has("hub")).toBe(true);
    expect(roles("95648").has("plunger")).toBe(true);
  });
});
