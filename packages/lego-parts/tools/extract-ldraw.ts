// Reads the LDraw parts library and writes data/ldraw-geometry.json: for every part the catalogue names (the
// `ids.ldraw` of data/electronics.json, rolling.json and structural.json), its bounding box, triangle count,
// Technic holes and named sub-parts. With --model it also reads one LDraw model (an .mpd) and writes the world
// placement of every catalogue part in it to data/ldraw-models.json.
// The library is not in the repo: download https://library.ldraw.org/library/updates/complete.zip, unzip it
// anywhere, then (cross-platform):
//   bun packages/lego-parts/tools/extract-ldraw.ts --ldraw <dir with parts/ and p/>
//   bun packages/lego-parts/tools/extract-ldraw.ts --ldraw <dir> --model <file.mpd> --key <build key> --source <url>
//     [--section <name of the sub-model to read, default the first>]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GeometryFile, Hole, PartGeometry, SubPart, Vec3 } from "../types.ts";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const LIB = arg("--ldraw");
if (!LIB || !existsSync(join(LIB, "parts")) || !existsSync(join(LIB, "p")))
  throw new Error("--ldraw <dir> must name an unzipped LDraw library (a folder with parts/ and p/)");
const DATA = join(import.meta.dir, "..", "data");
const LDU_MM = 0.4;
const LDU_PER_MODULE = 20;
const PART_URL = "https://library.ldraw.org/library/official/parts/";

type M = number[]; // x y z a b c d e f g h i, as in an LDraw type 1 line
const IDENTITY: M = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
const norm = (n: string): string => n.trim().toLowerCase().split("\\").join("/");
const round = (x: number): number => Math.round(x * 100) / 100 + 0;

const files = new Map<string, string[] | null>();
function read(name: string, embedded?: Map<string, string[]>): string[] | null {
  const n = norm(name);
  const inModel = embedded?.get(n);
  if (inModel) return inModel;
  if (!files.has(n)) {
    const path = ["parts", "p"].map((d) => join(LIB!, d, ...n.split("/"))).find((p) => existsSync(p));
    files.set(n, path ? readFileSync(path, "utf8").split(/\r?\n/) : null);
  }
  return files.get(n)!;
}
const title = (lines: string[]): string => (lines[0] ?? "").replace(/^0\s+/, "").trim();

function mul(A: M, B: M): M {
  const [x, y, z, a, b, c, d, e, f, g, h, i] = A as [number, ...number[]] as number[];
  const [X, Y, Z, a2, b2, c2, d2, e2, f2, g2, h2, i2] = B as number[];
  return [
    x! + a! * X! + b! * Y! + c! * Z!,
    y! + d! * X! + e! * Y! + f! * Z!,
    z! + g! * X! + h! * Y! + i! * Z!,
    a! * a2! + b! * d2! + c! * g2!,
    a! * b2! + b! * e2! + c! * h2!,
    a! * c2! + b! * f2! + c! * i2!,
    d! * a2! + e! * d2! + f! * g2!,
    d! * b2! + e! * e2! + f! * h2!,
    d! * c2! + e! * f2! + f! * i2!,
    g! * a2! + h! * d2! + i! * g2!,
    g! * b2! + h! * e2! + i! * h2!,
    g! * c2! + h! * f2! + i! * i2!,
  ];
}
const apply = (m: M, v: number[]): number[] => [
  m[0]! + m[3]! * v[0]! + m[4]! * v[1]! + m[5]! * v[2]!,
  m[1]! + m[6]! * v[0]! + m[7]! * v[1]! + m[8]! * v[2]!,
  m[2]! + m[9]! * v[0]! + m[10]! * v[1]! + m[11]! * v[2]!,
];

type Ref = { name: string; m: M; depth: number };
type Walk = { tris: number; min: number[]; max: number[]; missing: Set<string> };
function walk(name: string, onRef: (r: Ref) => boolean, embedded?: Map<string, string[]>): Walk {
  const out: Walk = {
    tris: 0,
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    missing: new Set(),
  };
  const visit = (file: string, m: M, depth: number): void => {
    const lines = read(file, embedded);
    if (!lines) {
      out.missing.add(norm(file));
      return;
    }
    for (const raw of lines) {
      const t = raw.trim().split(/\s+/);
      if (t[0] === "1") {
        const sub = t.slice(14).join(" ");
        const mm = mul(m, t.slice(2, 14).map(Number));
        if (onRef({ name: norm(sub), m: mm, depth: depth + 1 })) visit(sub, mm, depth + 1);
      } else if (t[0] === "3" || t[0] === "4") {
        const n = t[0] === "3" ? 3 : 4;
        out.tris += n - 2;
        for (let j = 0; j < n; j++) {
          const v = apply(m, t.slice(2 + 3 * j, 5 + 3 * j).map(Number));
          for (let a = 0; a < 3; a++) {
            out.min[a] = Math.min(out.min[a]!, v[a]!);
            out.max[a] = Math.max(out.max[a]!, v[a]!);
          }
        }
      }
    }
  };
  visit(name, IDENTITY, 0);
  return out;
}

// Hole primitives: a peg-hole face ring (peghole), a whole pin hole (connhole, beamhole), axle holes (axlehol*,
// axl<n>hol*). npeghol* are the surfaces between holes, not holes.
const HOLE = /^(peghole|connhole|beamhole|axlehol\d*|axlehole|axl\dhol\d*|axl\dho\d+|axl\dhole)\.dat$/;
const onGrid = (v: number[]): boolean => v.every((x) => Math.abs(x / 10 - Math.round(x / 10)) < 0.01);

function holes(prims: { name: string; m: M }[]): Hole[] {
  type Cluster = { axis: number[]; perp: number[]; along: number[]; axle: boolean };
  const clusters: Cluster[] = [];
  for (const p of prims) {
    let axis = [p.m[4]!, p.m[7]!, p.m[10]!];
    const len = Math.hypot(...axis);
    axis = axis.map((a) => a / len);
    const big = axis.reduce((bi, a, i) => (Math.abs(a) > Math.abs(axis[bi]!) ? i : bi), 0);
    if (axis[big]! < 0) axis = axis.map((a) => -a);
    const pos = p.m.slice(0, 3);
    const t = pos[0]! * axis[0]! + pos[1]! * axis[1]! + pos[2]! * axis[2]!;
    const perp = pos.map((x, i) => x - t * axis[i]!);
    const axle = p.name.startsWith("axl");
    const same = clusters.find(
      (c) =>
        Math.hypot(...c.axis.map((a, i) => a - axis[i]!)) < 0.02 &&
        Math.hypot(...c.perp.map((a, i) => a - perp[i]!)) < 1.5,
    );
    if (same) {
      same.along.push(t);
      same.axle ||= axle;
    } else clusters.push({ axis, perp, along: [t], axle });
  }
  return clusters
    .map((c): Hole => {
      const lo = Math.min(...c.along);
      const hi = Math.max(...c.along);
      const center = c.perp.map((x, i) => round(x + ((lo + hi) / 2) * c.axis[i]!)) as Vec3;
      return {
        kind: c.axle ? "axle" : "pin",
        axis: c.axis.map(round) as Vec3,
        center_ldu: center,
        center_modules: center.map((x) => round(x / LDU_PER_MODULE)) as Vec3,
        depth_ldu: round(hi - lo),
      };
    })
    .sort((a, b) => a.center_ldu.join().localeCompare(b.center_ldu.join()));
}

function partGeometry(id: string): PartGeometry {
  const file = `${id}.dat`;
  const lines = read(file);
  if (!lines) throw new Error(`LDraw has no parts/${file}`);
  const prims: { name: string; m: M }[] = [];
  const subparts: SubPart[] = [];
  const w = walk(file, (r) => {
    const base = r.name.split("/").pop()!;
    if (HOLE.test(base)) prims.push({ name: base, m: r.m });
    // named sub-parts: files in parts/ (not s/ sub-files, not primitives), down to three levels
    const sub = !r.name.includes("/") ? read(r.name) : null;
    if (sub && r.depth <= 3 && existsSync(join(LIB!, "parts", r.name)))
      subparts.push({
        ldraw: r.name.replace(/\.dat$/, ""),
        title: title(sub),
        position_ldu: r.m.slice(0, 3).map(round) as Vec3,
        rotation: r.m.slice(3).map(round),
      });
    return true;
  });
  if (w.missing.size) throw new Error(`${file}: missing sub-files ${[...w.missing].join(", ")}`);
  const license = lines
    .find((l) => l.startsWith("0 !LICENSE"))
    ?.replace("0 !LICENSE", "")
    .trim();
  if (!license) throw new Error(`${file} has no !LICENSE line`);
  const size = w.max.map((x, i) => round(x - w.min[i]!)) as Vec3;
  const all = holes(prims);
  return {
    ldraw: id,
    title: title(lines),
    source: PART_URL + file,
    license,
    bbox_ldu: { min: w.min.map(round) as Vec3, max: w.max.map(round) as Vec3 },
    size_ldu: size,
    size_mm: size.map((x) => round(x * LDU_MM)) as Vec3,
    size_modules: size.map((x) => round(x / LDU_PER_MODULE)) as Vec3,
    triangles: w.tris,
    holes: all.filter((h) => onGrid(h.center_ldu)),
    off_grid_holes: all.filter((h) => !onGrid(h.center_ldu)),
    subparts,
  };
}

function catalogueIds(): string[] {
  const ids = new Set<string>();
  for (const f of ["electronics.json", "rolling.json", "structural.json"]) {
    const parts = (JSON.parse(readFileSync(join(DATA, f), "utf8")) as { parts: { ids: { ldraw: string | null } }[] })
      .parts;
    for (const p of parts) if (p.ids.ldraw) ids.add(p.ids.ldraw);
  }
  return [...ids].sort();
}

function libraryRelease(): string {
  const notes = ["models"].flatMap((d) => {
    const dir = join(LIB!, d);
    return existsSync(dir) ? [...new Bun.Glob("Note*CA.txt").scanSync({ cwd: dir })].map((f) => join(dir, f)) : [];
  });
  const newest = notes.sort().pop();
  return newest ? (readFileSync(newest, "utf8").split(/\r?\n/)[0] ?? "").trim() : "unknown release";
}

function model(path: string, key: string, source: string, section?: string): void {
  // an .mpd: "0 FILE <name>" sections; the first is the main model
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  let main = "";
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^0\s+FILE\s+(.+)$/);
    if (m) {
      current = [];
      const name = norm(m[1]!);
      sections.set(name, current);
      main ||= name;
    } else current?.push(line);
  }
  if (section) {
    if (!sections.has(norm(section))) throw new Error(`${path} has no section "${section}"`);
    main = norm(section);
  }
  const catalogue = new Set(catalogueIds());
  // the box: every triangle of every part
  const w = walk(main, () => true, sections);
  // the parts: library parts are leaves; the model's own sections are followed, and each leaf remembers the
  // section path it came from (a cable is one section holding its two plugs)
  const placements: { part: string; position_ldu: Vec3; rotation: number[]; path: string }[] = [];
  const plugs: { position_ldu: Vec3; path: string }[] = [];
  const other = new Map<string, number>();
  const follow = (name: string, m: M, path: string): void => {
    for (const raw of sections.get(name) ?? []) {
      const t = raw.trim().split(/\s+/);
      if (t[0] !== "1") continue;
      const sub = norm(t.slice(14).join(" "));
      const mm = mul(m, t.slice(2, 14).map(Number));
      if (sections.has(sub)) {
        follow(sub, mm, path ? `${path} > ${sub}` : sub);
        continue;
      }
      const id = sub.replace(/\.dat$/, "");
      const at = mm.slice(0, 3).map(round) as Vec3;
      if (catalogue.has(id)) placements.push({ part: id, position_ldu: at, rotation: mm.slice(3).map(round), path });
      else if (id === "933c01" || id === "933") plugs.push({ position_ldu: at, path });
      else other.set(id, (other.get(id) ?? 0) + 1);
    }
  };
  follow(main, IDENTITY, "");
  const outFile = join(DATA, "ldraw-models.json");
  const out = existsSync(outFile) ? (JSON.parse(readFileSync(outFile, "utf8")) as Record<string, unknown>) : {};
  const license = (sections.get(main) ?? [])
    .find((l) => l.startsWith("0 !LICENSE"))
    ?.replace("0 !LICENSE", "")
    .trim();
  out[key] = {
    source,
    license: license ?? "none stated",
    section: main,
    frame: `the LDraw frame of the section "${main}": LDU, -Y up`,
    bbox_ldu: { min: w.min.map(round), max: w.max.map(round) },
    size_mm: w.max.map((x, i) => round((x - w.min[i]!) * LDU_MM)),
    placements: placements.sort((a, b) => a.part.localeCompare(b.part) || a.path.localeCompare(b.path)),
    cable_plugs: plugs,
    other_parts: Object.fromEntries([...other].sort()),
  };
  writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`${key}: ${placements.length} catalogue placements → ${outFile}`);
}

const modelPath = arg("--model");
if (modelPath) {
  const key = arg("--key");
  const source = arg("--source");
  if (!key || !source) throw new Error("--model needs --key <build key> and --source <url of the model file>");
  model(modelPath, key, source, arg("--section"));
} else {
  const parts: Record<string, PartGeometry> = {};
  for (const id of catalogueIds()) parts[id] = partGeometry(id);
  const out: GeometryFile = {
    note: "Generated by tools/extract-ldraw.ts from the LDraw parts library; do not edit. LDraw frame: LDU, -Y up, each part's own origin. 1 LDU = 0.4 mm, 20 LDU = 1 module.",
    library: libraryRelease(),
    library_source: "https://library.ldraw.org/library/updates/complete.zip",
    parts,
  };
  writeFileSync(join(DATA, "ldraw-geometry.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`${Object.keys(parts).length} parts → ${join(DATA, "ldraw-geometry.json")}`);
}
