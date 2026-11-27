// Converts the EV3's electronic parts from the LDraw parts library into the compact meshes the 3D view
// (apps/twin-view) lazy-loads, and writes their attribution. Cross-platform:
//
//   bun scripts/ldraw-meshes.ts                       downloads complete.zip into a temporary folder
//   bun scripts/ldraw-meshes.ts --zip <complete.zip>  uses a library zip already downloaded
//
// The library is read from the zip in memory (no unzip tool), never written into the repo. What it writes:
// apps/twin-view/meshes/<part>.bin.gz (one per part below, gzipped) and apps/twin-view/meshes/ATTRIBUTION.md.
//
// What a file holds: the part's triangles in its own LDraw frame (LDU, -Y up), quantized to 1/16 LDU, wound
// counter-clockwise as LDraw's BFC says (a sub-file without BFC is written double-sided), grouped by colour and
// by role. Edge and conditional lines (types 2 and 5) are dropped; no primitive is swapped for a coarser one; the
// printed sub-parts are kept, so the port letters and the logo read. A role is a sub-part the page moves or draws
// itself: a motor's hub, the touch sensor's button, the brick's buttons, its LED's light guide; the brick's LCD
// is left out, the page draws the screen there from the state. Normals are left to the page (creased at 30°).
//
// Layout of a .bin, little-endian: "SCM1", u32 n = length of the JSON header, the header (UTF-8), zero padding to
// 4 bytes, then the groups' data at the offsets the header gives (relative to the end of the padding):
//   header = {part, title, quantum, bbox_ldu, groups: [{role, colour, rgb, alpha, double, bbox_ldu, vertices, triangles,
//             positions: offset, indices: offset, wide}]}
// positions: int16, planar (every x, then every y, then every z), each the step from the vertex before, in quanta;
// indices: 3 per triangle, each the step from the index before, int16 (int32 when `wide`).
import { inflateRawSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIBRARY_URL = "https://library.ldraw.org/library/updates/complete.zip";
const OUT = join(import.meta.dir, "..", "apps", "twin-view", "meshes");
/** 1/16 LDU: 0.025 mm, and ±2047 LDU (±82 cm) fits an int16. */
const QUANTUM = 1 / 16;

type Role = string | null;
interface PartSpec {
  /** What LDraw colour 16 (the main colour) is on this part as sold. */
  main: number;
  /** The role of a sub-file reference, from its name and where its origin lands in the part's frame. */
  role?: (name: string, at: number[]) => Role | "drop";
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.6;
const brickRoles = (name: string, at: number[]): Role | "drop" => {
  if (name === "11036.dat") return "drop"; // the LCD: the page draws the screen
  if (name === "11026.dat") return "led"; // the buttons' frame: the status light shines through it
  // the six buttons, as the brick numbers them: 1 up, 2 enter, 3 down, 4 right, 5 left, 6 back
  if (name === "99146.dat") return "button2";
  if (name === "11030.dat") return "button6";
  if (name === "99147.dat") return near(at[2]!, -26.8) ? "button1" : "button3";
  if (name === "99145.dat") return at[0]! < 0 ? "button5" : "button4";
  return null;
};
export const PARTS: Record<string, PartSpec> = {
  "95646": { main: 15, role: brickRoles },
  "95646c01": { main: 15, role: brickRoles },
  "95658": { main: 15, role: (n) => (n === "99617c01.dat" ? "hub" : null) },
  "99455": { main: 15, role: (n) => (n === "99543.dat" ? "hub" : null) },
  "95648": { main: 15, role: (n) => (n === "99386.dat" ? "plunger" : null) },
  "95650": { main: 15, role: (n) => (n === "11013.dat" || n === "64897.dat" ? "lens" : null) },
  "99380": { main: 15 },
  "95652": { main: 15, role: (n) => (n === "99957.dat" ? "eye" : null) },
  "95654": { main: 15 },
};

// ---------------------------------------------------------------- the zip, read in memory
export function zipEntries(buf: Buffer): Map<string, () => Buffer> {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file: no end of central directory");
  let count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff) {
    // zip64: the locator sits just before the end record
    const loc = eocd - 20;
    if (buf.readUInt32LE(loc) !== 0x07064b50) throw new Error("zip64 without its locator");
    const z = Number(buf.readBigUInt64LE(loc + 8));
    count = Number(buf.readBigUInt64LE(z + 32));
    at = Number(buf.readBigUInt64LE(z + 48));
  }
  const out = new Map<string, () => Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`zip central directory broken at entry ${i}`);
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28),
      extraLen = buf.readUInt16LE(at + 30),
      commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    out.set(name.toLowerCase(), () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + size);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`${name}: zip method ${method} is not supported`);
    });
  }
  return out;
}

// ---------------------------------------------------------------- LDraw
type M = number[]; // x y z a b c d e f g h i
const IDENTITY: M = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
const mul = (A: M, B: M): M => {
  const [x, y, z, a, b, c, d, e, f, g, h, i] = A.map(Number) as [number, ...number[]] as number[] as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const [X, Y, Z, a2, b2, c2, d2, e2, f2, g2, h2, i2] = B as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return [
    x + a * X + b * Y + c * Z,
    y + d * X + e * Y + f * Z,
    z + g * X + h * Y + i * Z,
    a * a2 + b * d2 + c * g2,
    a * b2 + b * e2 + c * h2,
    a * c2 + b * f2 + c * i2,
    d * a2 + e * d2 + f * g2,
    d * b2 + e * e2 + f * h2,
    d * c2 + e * f2 + f * i2,
    g * a2 + h * d2 + i * g2,
    g * b2 + h * e2 + i * h2,
    g * c2 + h * f2 + i * i2,
  ];
};
const apply = (m: M, x: number, y: number, z: number): [number, number, number] => [
  m[0]! + m[3]! * x + m[4]! * y + m[5]! * z,
  m[1]! + m[6]! * x + m[7]! * y + m[8]! * z,
  m[2]! + m[9]! * x + m[10]! * y + m[11]! * z,
];
const det = (m: M) =>
  m[3]! * (m[7]! * m[11]! - m[8]! * m[10]!) -
  m[4]! * (m[6]! * m[11]! - m[8]! * m[9]!) +
  m[5]! * (m[6]! * m[10]! - m[7]! * m[9]!);

interface Library {
  file(name: string): string[] | null;
}
export function library(zip: Map<string, () => Buffer>): Library {
  const cache = new Map<string, string[] | null>();
  return {
    file(name) {
      const n = name.trim().toLowerCase().split("\\").join("/");
      if (!cache.has(n)) {
        const keys = n.startsWith("../") ? [`ldraw/${n.slice(3)}`] : [`ldraw/parts/${n}`, `ldraw/p/${n}`];
        const hit = keys.map((k) => zip.get(k)).find(Boolean);
        cache.set(n, hit ? hit().toString("utf8").split(/\r?\n/) : null);
      }
      return cache.get(n)!;
    },
  };
}

interface Colour {
  rgb: number;
  alpha: number;
}
function colours(lib: Library): Map<number, Colour> {
  const lines = lib.file("../LDConfig.ldr") ?? null;
  if (!lines) throw new Error("LDConfig.ldr is not in the library");
  const out = new Map<number, Colour>();
  for (const l of lines) {
    const m = l.match(/^0\s+!COLOUR\s+\S+\s+CODE\s+(\d+)\s+VALUE\s+#([0-9A-Fa-f]{6})(?:.*?ALPHA\s+(\d+))?/);
    if (m) out.set(Number(m[1]), { rgb: parseInt(m[2]!, 16), alpha: m[3] ? Number(m[3]) / 255 : 1 });
  }
  return out;
}

interface Tri {
  role: string;
  colour: number;
  double: boolean;
  v: number[]; // 9 numbers
}
interface Walk {
  tris: Tri[];
  /** "Author" and licence of every file the part is made of. */
  credits: Map<string, { author: string; licence: string }>;
}

export function walkPart(lib: Library, part: string, spec: PartSpec): Walk {
  const out: Walk = { tris: [], credits: new Map() };
  const visit = (
    name: string,
    m: M,
    colour: number,
    invert: boolean,
    certifiedParent: boolean,
    role: string,
    depth: number,
  ) => {
    if (depth > 30) throw new Error(`${part}: sub-files nest deeper than 30 (a loop at ${name})`);
    const lines = lib.file(name);
    if (!lines) throw new Error(`${part}: the library has no ${name}`);
    const key = name.toLowerCase();
    if (!out.credits.has(key)) {
      const author =
        lines
          .find((l) => /^0\s+Author:/.test(l))
          ?.replace(/^0\s+Author:\s*/, "")
          .trim() ?? "unknown";
      const licence =
        lines
          .find((l) => /^0\s+!LICENSE/.test(l))
          ?.replace(/^0\s+!LICENSE\s*/, "")
          .trim() ?? "none";
      out.credits.set(key, { author, licence });
    }
    let certified = false,
      ccw = true,
      invertNext = false;
    for (const raw of lines) {
      const t = raw.trim().split(/\s+/);
      if (t[0] === "0") {
        if (t[1] !== "BFC") continue;
        const words = t.slice(2);
        if (words.includes("CERTIFY")) certified = !words.includes("NOCERTIFY");
        if (words.includes("NOCERTIFY")) certified = false;
        if (words.includes("CW")) ccw = false;
        if (words.includes("CCW")) ccw = true;
        if (words.includes("INVERTNEXT")) invertNext = true;
        continue;
      }
      const c =
        t[1] === "16" ? colour : t[1]?.startsWith("0x") ? parseInt(t[1].slice(3), 16) | 0x1000000 : Number(t[1]);
      if (t[0] === "1") {
        const n = t.slice(2, 14).map(Number);
        const child = mul(m, n);
        const sub = t.slice(14).join(" ").toLowerCase().split("\\").join("/");
        const at = apply(m, n[0]!, n[1]!, n[2]!);
        const r = role === "body" ? (spec.role?.(sub.split("/").pop()!, at) ?? null) : null;
        // a sub-file is inverted by its parent, by INVERTNEXT and by a mirroring matrix, each flipping the last
        const mirrored = det(n) < 0;
        const inverted = invert !== invertNext;
        if (r !== "drop")
          visit(sub, child, c, inverted !== mirrored, certifiedParent && certified, r ?? role, depth + 1);
        invertNext = false;
      } else if (t[0] === "3" || t[0] === "4") {
        const p = t.slice(2).map(Number);
        const pts: [number, number, number][] = [];
        for (let k = 0; k < (t[0] === "3" ? 3 : 4); k++) pts.push(apply(m, p[3 * k]!, p[3 * k + 1]!, p[3 * k + 2]!));
        // the triangle's front is counter-clockwise when the file's winding and the accumulated inversions agree
        const flip = !ccw !== invert;
        const tri = (a: number[], b: number[], d: number[]) =>
          out.tris.push({
            role,
            colour: c,
            double: !(certifiedParent && certified),
            v: flip ? [...a, ...d, ...b] : [...a, ...b, ...d],
          });
        tri(pts[0]!, pts[1]!, pts[2]!);
        if (pts[3]) tri(pts[0]!, pts[2]!, pts[3]!);
        invertNext = false;
      }
    }
  };
  visit(`${part}.dat`, IDENTITY, spec.main, false, true, "body", 0);
  return out;
}

const r2 = (x: number) => Math.round(x * 100) / 100 + 0;

function encode(part: string, title: string, w: Walk, palette: Map<number, Colour>): Uint8Array<ArrayBuffer> {
  // group by role, colour and sidedness; weld identical quantized vertices inside a group
  const groups = new Map<string, Tri[]>();
  for (const t of w.tris) {
    const k = `${t.role}|${t.colour}|${t.double}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(t);
  }
  const blobs: Uint8Array[] = [];
  let offset = 0;
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  const header = {
    part,
    title,
    quantum: QUANTUM,
    bbox_ldu: { min, max } as { min: number[]; max: number[] },
    groups: [] as Record<string, unknown>[],
  };
  for (const [k, tris] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [role, colourS, doubleS] = k.split("|") as [string, string, string];
    const colour = Number(colourS);
    const known = colour & 0x1000000 ? { rgb: colour & 0xffffff, alpha: 1 } : palette.get(colour);
    if (!known) throw new Error(`${part}: colour ${colour} is not in LDConfig.ldr`);
    const index = new Map<string, number>();
    const gmin = [Infinity, Infinity, Infinity],
      gmax = [-Infinity, -Infinity, -Infinity];
    const pos: number[] = [];
    const idx: number[] = [];
    for (const t of tris)
      for (let k3 = 0; k3 < 9; k3 += 3) {
        const q = [0, 1, 2].map((a) => Math.round(t.v[k3 + a]! / QUANTUM));
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a]!, t.v[k3 + a]!);
          max[a] = Math.max(max[a]!, t.v[k3 + a]!);
          gmin[a] = Math.min(gmin[a]!, t.v[k3 + a]!);
          gmax[a] = Math.max(gmax[a]!, t.v[k3 + a]!);
        }
        if (q.some((x) => Math.abs(x) > 32767)) throw new Error(`${part}: a vertex lies past ±2047 LDU`);
        const key = q.join(",");
        let i = index.get(key);
        if (i === undefined) {
          index.set(key, (i = pos.length / 3));
          pos.push(...q);
        }
        idx.push(i);
      }
    // planar and delta-coded: all x, then all y, then all z, each the step from the vertex before; each index the
    // step from the one before. The steps are small numbers, which is what gzip on the wire packs well (the
    // brick: 178 KB gzip as interleaved values, 50 KB so)
    const nv = pos.length / 3;
    const p16 = new Int16Array(pos.length);
    for (let a = 0; a < 3; a++) {
      let prev = 0;
      for (let i = 0; i < nv; i++) {
        const v = pos[i * 3 + a]!;
        p16[a * nv + i] = v - prev;
        prev = v;
      }
    }
    const wide = nv > 32767;
    const iArr = wide ? new Int32Array(idx.length) : new Int16Array(idx.length);
    let last = 0;
    for (let i = 0; i < idx.length; i++) {
      iArr[i] = idx[i]! - last;
      last = idx[i]!;
    }
    const pad = (n: number) => (4 - (n % 4)) % 4;
    const posAt = offset;
    blobs.push(new Uint8Array(p16.buffer));
    offset += p16.byteLength;
    blobs.push(new Uint8Array(pad(offset)));
    offset += pad(offset);
    const idxAt = offset;
    blobs.push(new Uint8Array(iArr.buffer));
    offset += iArr.byteLength;
    blobs.push(new Uint8Array(pad(offset)));
    offset += pad(offset);
    header.groups.push({
      role,
      colour,
      rgb: known.rgb,
      alpha: known.alpha,
      double: doubleS === "true",
      bbox_ldu: { min: gmin.map(r2), max: gmax.map(r2) },
      vertices: pos.length / 3,
      triangles: idx.length / 3,
      positions: posAt,
      indices: idxAt,
      wide,
    });
  }
  header.bbox_ldu = { min: min.map(r2), max: max.map(r2) };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const head = new Uint8Array(8 + json.length + ((4 - ((8 + json.length) % 4)) % 4));
  head.set(new TextEncoder().encode("SCM1"), 0);
  new DataView(head.buffer).setUint32(4, json.length, true);
  head.set(json, 8);
  const out = new Uint8Array(head.length + offset);
  out.set(head, 0);
  let at = head.length;
  for (const b of blobs) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

// ---------------------------------------------------------------- main
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const zipArg = argv.includes("--zip") ? argv[argv.indexOf("--zip") + 1] : undefined;
  let tmp: string | null = null;
  let zipPath = zipArg;
  if (!zipPath) {
    tmp = mkdtempSync(join(tmpdir(), "ldraw-"));
    zipPath = join(tmp, "complete.zip");
    console.log(`downloading ${LIBRARY_URL} into ${tmp}`);
    const res = await fetch(LIBRARY_URL);
    if (!res.ok) throw new Error(`${LIBRARY_URL}: HTTP ${res.status}`);
    writeFileSync(zipPath, new Uint8Array(await res.arrayBuffer()));
  }
  try {
    const zip = zipEntries(readFileSync(zipPath));
    const lib = library(zip);
    const palette = colours(lib);
    const version = (lib.file("../LDCfgalt.ldr") ?? [])
      .concat(lib.file("../LDConfig.ldr") ?? [])
      .find((l) => /^0\s+!LDRAW_ORG/.test(l));
    mkdirSync(OUT, { recursive: true });
    const credits = new Map<string, { author: string; licence: string; parts: Set<string> }>();
    const rows: string[] = [];
    for (const [part, spec] of Object.entries(PARTS)) {
      const w = walkPart(lib, part, spec);
      const title = (lib.file(`${part}.dat`)![0] ?? "").replace(/^0\s+/, "").trim();
      const bin = encode(part, title, w, palette);
      const gzBin = Bun.gzipSync(bin, { level: 9 });
      // stored gzipped: the page inflates it with the browser's DecompressionStream
      writeFileSync(join(OUT, `${part}.bin.gz`), gzBin);
      for (const [file, c] of w.credits) {
        const k = `${c.author}|${c.licence}`;
        let e = credits.get(k);
        if (!e) credits.set(k, (e = { ...c, parts: new Set() }));
        e.parts.add(file);
      }
      const gz = gzBin.length;
      rows.push(
        `| ${part} | ${title} | ${w.tris.length} | ${(bin.length / 1024).toFixed(1)} | ${(gz / 1024).toFixed(1)} |`,
      );
      console.log(`${part}: ${w.tris.length} triangles, ${bin.length} bytes, ${gz} gzip`);
    }
    const authors = [...credits.values()].sort((a, b) => (a.author < b.author ? -1 : 1));
    writeFileSync(
      join(OUT, "ATTRIBUTION.md"),
      [
        "# Attribution of the 3D parts",
        "",
        "The meshes in this folder are converted from the LDraw Parts Library, <https://library.ldraw.org>, © its",
        "authors listed below. The library is licensed under Creative Commons Attribution 4.0 International",
        "(CC BY 4.0, <https://creativecommons.org/licenses/by/4.0/>), and a few files under Creative Commons Attribution",
        "2.0 (CC BY 2.0, <https://creativecommons.org/licenses/by/2.0/>); each file's licence is listed with its author.",
        "",
        "**Modified.** These are not the library's files: each part was flattened with its sub-files into one mesh,",
        "its edge and conditional lines were removed, the EV3 brick's LCD sub-part was removed, its vertices were",
        "rounded to 1/16 LDU and stored in a binary format by `scripts/ldraw-meshes.ts`.",
        "",
        `Library: ${LIBRARY_URL}${version ? ` (${version.replace(/^0\s+/, "")})` : ""}.`,
        "",
        "| Part | Title | Triangles | KB | KB gzip |",
        "|---|---|---|---|---|",
        ...rows,
        "",
        "## Authors",
        "",
        "| Author | Licence | Files |",
        "|---|---|---|",
        ...authors.map((a) => `| ${a.author} | ${a.licence} | ${[...a.parts].sort().join(", ")} |`),
        "",
      ].join("\n"),
    );
    console.log(`wrote ${Object.keys(PARTS).length} meshes and ATTRIBUTION.md to ${OUT}`);
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}
