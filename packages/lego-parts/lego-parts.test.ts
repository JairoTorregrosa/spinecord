import { describe, expect, test } from "bun:test";
import { type Fact, geometryOf, isUnknown, loadLegoParts, type Maybe, setsWith, type Vec3 } from "./index.ts";

const parts = loadLegoParts();
const catalogue = [...parts.electronics, ...parts.rolling, ...parts.structural];
const URL = /^https?:\/\/\S+$|^[a-z-]+\.json#\S+$/;

/** every Fact or Unknown anywhere in a value, with its path */
function* facts(v: unknown, path: string): Generator<[string, Maybe<unknown>]> {
  if (!v || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  if ("value" in o && "source" in o) yield [path, o as Fact<unknown>];
  else if (o.unknown === true) yield [path, o as Maybe<unknown>];
  else for (const [k, x] of Object.entries(o)) yield* facts(x, `${path}.${k}`);
}
const near = (a: number[], b: number[], tol = 0.01) => a.every((x, i) => Math.abs(x - b[i]!) <= tol);

describe("catalogue", () => {
  test("keys are unique", () => {
    const keys = catalogue.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every part has ids, a name, a source, and LDraw geometry when it has an LDraw id", () => {
    for (const p of catalogue) {
      expect(p.name.length, p.key).toBeGreaterThan(0);
      expect(p.ids.design, p.key).toMatch(/\S/);
      expect(p.ids.bricklink, p.key).toMatch(/\S/);
      expect(p.ids.rebrickable, p.key).toMatch(/\S/);
      expect(p.ids.source, p.key).toMatch(URL);
      if (p.ids.ldraw) expect(geometryOf(parts, p.ids.ldraw).ldraw).toBe(p.ids.ldraw);
    }
  });

  test("every number carries a source URL or says why it is unknown", () => {
    const all = [...facts(parts.units, "units"), ...facts(catalogue, "parts"), ...facts(parts.builds, "builds")];
    expect(all.length).toBeGreaterThan(200);
    for (const [path, f] of all) {
      if (isUnknown(f)) expect(f.reason.length, path).toBeGreaterThan(10);
      else {
        expect(f.source, path).toMatch(URL);
        for (const a of f.alt ?? []) expect(a.source, `${path} alt`).toMatch(URL);
      }
    }
  });

  test("every electronic part has a mass or a reason, and every feature a source", () => {
    for (const p of parts.electronics) {
      expect(p.mass_g, p.key).toBeDefined();
      for (const [name, f] of Object.entries(p.features)) expect(f.source, `${p.key}.${name}`).toMatch(URL);
    }
  });
});

describe("geometry", () => {
  const units = parts.units as Record<string, Fact>;
  const ldu = units.ldu_mm!.value;
  const module = units.module_ldu!.value;

  test("the unit system agrees with itself", () => {
    expect(module * ldu).toBe(units.module_mm!.value);
    expect(units.plate_height_ldu!.value * ldu).toBeCloseTo(units.plate_height_mm!.value, 9);
    expect(units.brick_height_ldu!.value * ldu).toBeCloseTo(units.brick_height_mm!.value, 9);
    expect(units.brick_height_ldu!.value + 2 * units.plate_height_ldu!.value).toBe(2 * module);
  });

  test("mm and module sizes agree with the LDU box", () => {
    for (const g of Object.values(parts.geometry.parts)) {
      const size = g.bbox_ldu.max.map((x, i) => x - g.bbox_ldu.min[i]!);
      expect(near(size, g.size_ldu, 0.02), g.ldraw).toBe(true);
      expect(
        near(
          g.size_ldu.map((x) => x * ldu),
          g.size_mm,
          0.006,
        ),
        g.ldraw,
      ).toBe(true);
      expect(
        near(
          g.size_ldu.map((x) => x / module),
          g.size_modules,
          0.006,
        ),
        g.ldraw,
      ).toBe(true);
      expect(g.source, g.ldraw).toBe(`https://library.ldraw.org/library/official/parts/${g.ldraw}.dat`);
      for (const h of g.holes) {
        expect(
          near(
            h.center_ldu.map((x) => x / module),
            h.center_modules,
            0.006,
          ),
          g.ldraw,
        ).toBe(true);
        // on the half-module grid
        expect(
          h.center_ldu.every((x) => Math.abs(x / 10 - Math.round(x / 10)) < 0.01),
          g.ldraw,
        ).toBe(true);
      }
    }
  });

  test("no two parallel holes overlap (a pin hole is 12 LDU across)", () => {
    for (const g of Object.values(parts.geometry.parts))
      g.holes.forEach((a, i) =>
        g.holes.slice(i + 1).forEach((b) => {
          if (!near(a.axis, b.axis)) return;
          const d = a.center_ldu.map((x, k) => x - b.center_ldu[k]!);
          const t = d.reduce((s, x, k) => s + x * a.axis[k]!, 0);
          expect(
            Math.hypot(...d.map((x, k) => x - t * a.axis[k]!)),
            `${g.ldraw} ${a.center_ldu} ${b.center_ldu}`,
          ).toBeGreaterThanOrEqual(12);
        }),
      );
  });

  test("beams are 8 n - 0.8 mm long and their holes sit one module apart", () => {
    for (const p of parts.structural.filter((s) => s.kind === "beam" && !isUnknown(s.length_modules))) {
      const g = geometryOf(parts, p.ids.ldraw!);
      const n = (p.length_modules as Fact).value;
      expect(Math.max(...g.size_mm), p.key).toBeCloseTo(8 * n - 0.8, 6);
      expect(g.holes.length, p.key).toBe(n);
    }
  });

  test("a rim's or tyre's diameter is its LDraw size", () => {
    for (const p of parts.rolling.filter((r) => r.kind === "rim" || r.kind === "tyre")) {
      const g = geometryOf(parts, p.ids.ldraw!);
      const od = p.outer_diameter_mm as Fact;
      expect(
        g.size_mm.some((x) => Math.abs(x - od.value) < 0.06),
        p.key,
      ).toBe(true);
    }
  });

  test("every feature sits where its LDraw sub-part is", () => {
    for (const p of parts.electronics) {
      const g = geometryOf(parts, p.ids.ldraw!);
      for (const [name, f] of Object.entries(p.features)) {
        if (!f.ldraw_subpart) continue;
        const subs = g.subparts.filter((s) => s.ldraw === f.ldraw_subpart);
        expect(subs.length, `${p.key}.${name}: no sub-part ${f.ldraw_subpart}`).toBeGreaterThan(0);
        // the quad socket holds four ports: each sits ±14 or ±42 LDU along X from it
        const offsets = f.ldraw_subpart === "11035" ? [-42, -14, 14, 42] : [0];
        const hit = subs.some((s) =>
          offsets.some((dx) => near([s.position_ldu[0] + dx, s.position_ldu[1], s.position_ldu[2]], f.position_ldu)),
        );
        expect(hit, `${p.key}.${name}`).toBe(true);
      }
    }
  });

  test("the brick has motor ports A-D and sensor ports 1-4, PC port next to D", () => {
    const f = parts.electronics.find((p) => p.key === "brick")!.features;
    const x = (k: string) => f[k]!.position_ldu[0];
    expect(["port_A", "port_B", "port_C", "port_D", "pc_usb"].map(x)).toEqual([-57, -29, -1, 27, 58]);
    expect(["port_1", "port_2", "port_3", "port_4"].map(x)).toEqual([-57, -19, 19, 57]);
  });
});

describe("sets", () => {
  test("the three sets are there with their inventories", () => {
    expect(parts.sets.map((s) => s.set)).toEqual(["31313-1", "45544-1", "45560-1"]);
    for (const s of parts.sets) {
      expect(s.lines.length, s.set).toBeGreaterThan(100);
      for (const l of s.lines) expect(l.quantity, `${s.set} ${l.part}`).toBeGreaterThan(0);
    }
  });

  test("set inventories reference catalogue parts by their Rebrickable number", () => {
    const known = new Set(catalogue.map((p) => p.ids.rebrickable));
    const inSets = new Set(parts.sets.flatMap((s) => s.lines.map((l) => l.part)));
    // every catalogue part is in at least one of the three sets
    for (const p of catalogue) expect(inSets.has(p.ids.rebrickable), p.key).toBe(true);
    // every electronic part in a set is in the catalogue
    const electronic = parts.sets
      .flatMap((s) => s.lines)
      .filter((l) => /^(95646|95658|99455|9565|99380|72156|11145|5580)/.test(l.part));
    for (const l of electronic) expect(known.has(l.part), l.part).toBe(true);
    expect(parts.setPartNames["95658"]).toContain("Motor");
  });

  test("what the education set has that the home set lacks", () => {
    expect(setsWith(parts, "95652")).toEqual({ "45544-1": 1 }); // ultrasonic
    expect(setsWith(parts, "95654")).toEqual({ "31313-1": 1 }); // infrared
    expect(setsWith(parts, "95658")).toEqual({ "31313-1": 2, "45544-1": 2 }); // large motors
  });
});

describe("builds", () => {
  test("TRACK3R's placements are the model's, and its ports name catalogue parts", () => {
    const t = parts.builds.find((b) => b.key === "track3r")!;
    const model = parts.models.track3r as { placements: { part: string; position_ldu: Vec3 }[] };
    expect(Array.isArray(t.placements)).toBe(true);
    for (const p of t.placements as { part: string; position_ldu: Vec3 }[])
      expect(
        model.placements.some((m) => m.part === p.part && near(m.position_ldu, p.position_ldu)),
        `${p.part} ${p.position_ldu}`,
      ).toBe(true);
    expect(Object.keys(t.ports).sort()).toEqual(["4", "A", "B", "C"]);
  });
});
