// A QR code encoder (ISO/IEC 18004) for the join link of a page: byte mode, error correction level M, versions
// 1 to 10 (up to 213 bytes), the mask of lowest penalty. No dependency. `qrText` draws it for a terminal and
// `qrSvg` for the pairing console (attributes only: the console's CSP allows no inline style).

/** Data and error correction per version at level M (index = version): [ecc codewords per block, blocks]. */
const M_BLOCKS: readonly (readonly [number, number])[] = [
  [0, 0],
  [10, 1],
  [16, 1],
  [26, 1],
  [18, 2],
  [24, 2],
  [16, 4],
  [18, 4],
  [22, 4],
  [22, 5],
  [26, 5],
];
export const QR_MAX_VERSION = 10;
const FORMAT_M = 0b00; // level M in the format bits

/** Positions of the alignment patterns' centres on each axis. */
function alignment(version: number): number[] {
  if (version === 1) return [];
  const n = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = Math.ceil((version * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

/** Modules left for data and error correction codewords (bits). */
function rawModules(version: number): number {
  let r = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const n = Math.floor(version / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (version >= 7) r -= 36;
  }
  return r;
}

/** Codewords of data at level M for a version. */
export function dataCodewords(version: number): number {
  const [ecc, blocks] = M_BLOCKS[version]!;
  return Math.floor(rawModules(version) / 8) - ecc * blocks;
}

// GF(256) with the polynomial x^8 + x^4 + x^3 + x^2 + 1
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function rsDivisor(degree: number): number[] {
  const out = new Array<number>(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j]!, root);
      if (j + 1 < degree) out[j] ^= out[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return out;
}
function rsRemainder(data: number[], divisor: number[]): number[] {
  const out = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ out.shift()!;
    out.push(0);
    divisor.forEach((coef, i) => (out[i] ^= gfMul(coef, factor)));
  }
  return out;
}

/** The data codewords, then error correction, split in blocks and interleaved. */
function codewords(bytes: Uint8Array, version: number): number[] {
  const capacity = dataCodewords(version);
  const bits: number[] = [];
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  const [ecc, blocks] = M_BLOCKS[version]!;
  const raw = Math.floor(rawModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(ecc);
  const split: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - ecc + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const block = [...dat, ...rsRemainder(dat, divisor)];
    if (i < shortBlocks) block.splice(shortLen - ecc, 0, -1); // a hole: short blocks have one data codeword less
    split.push(block);
  }
  const out: number[] = [];
  for (let i = 0; i < split[0]!.length; i++)
    for (let j = 0; j < split.length; j++) if (i !== shortLen - ecc || j >= shortBlocks) out.push(split[j]![i]!);
  return out;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The 15 format bits of level M and a mask, BCH-coded and masked. */
export function formatBits(mask: number): number {
  const data = (FORMAT_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
/** The 18 version bits (version 7 and above). */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

class Grid {
  readonly size: number;
  readonly dark: boolean[][];
  readonly fixed: boolean[][];
  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  set(x: number, y: number, dark: boolean) {
    this.dark[y]![x] = dark;
    this.fixed[y]![x] = true;
  }
  functionPatterns() {
    const { size, version } = this;
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [
      [3, 3],
      [size - 4, 3],
      [3, size - 4],
    ] as const)
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          if (x >= 0 && x < size && y >= 0 && y < size) this.set(x, y, d !== 2 && d !== 4);
        }
    const align = alignment(version);
    for (const ay of align)
      for (const ax of align) {
        if ((ax === 6 && ay === 6) || (ax === 6 && ay === size - 7) || (ax === size - 7 && ay === 6)) continue;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) this.set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    this.format(0); // reserves the format areas; drawn again with the chosen mask
    if (version >= 7) {
      const bits = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, bit);
        this.set(b, a, bit);
      }
    }
  }
  format(mask: number) {
    const { size } = this;
    const bits = formatBits(mask);
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(i));
    this.set(8, size - 8, true); // the dark module
  }
  place(words: number[]) {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++)
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (this.fixed[y]![x] || i >= words.length * 8) continue;
          this.dark[y]![x] = ((words[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
    }
  }
  applyMask(mask: number) {
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++)
        if (!this.fixed[y]![x] && MASKS[mask]!(x, y)) this.dark[y]![x] = !this.dark[y]![x];
  }
  penalty(): number {
    const { size, dark } = this;
    let p = 0;
    const line = (get: (i: number) => boolean) => {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && get(i) === get(i - 1)) run++;
        else {
          if (run >= 5) p += run - 2;
          run = 1;
        }
      }
      // 1:1:3:1:1 finder-like runs with four light modules on one side
      const s = Array.from({ length: size }, (_, i) => (get(i) ? "1" : "0")).join("");
      const padded = `0000${s}0000`;
      for (const pat of ["00001011101", "10111010000"])
        for (let k = padded.indexOf(pat); k !== -1; k = padded.indexOf(pat, k + 1)) p += 40;
    };
    for (let y = 0; y < size; y++) line((x) => dark[y]![x]!);
    for (let x = 0; x < size; x++) line((y) => dark[y]![x]!);
    for (let y = 0; y < size - 1; y++)
      for (let x = 0; x < size - 1; x++) {
        const c = dark[y]![x];
        if (c === dark[y]![x + 1] && c === dark[y + 1]![x] && c === dark[y + 1]![x + 1]) p += 3;
      }
    const darkCount = dark.reduce((n, row) => n + row.filter(Boolean).length, 0);
    const total = size * size;
    p += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
    return p;
  }
}

/** The modules of the QR code of `text` (true = dark), without the quiet zone. Throws above 213 bytes. */
export function qrEncode(text: string, forceMask?: number): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  const fits = (v: number) => 4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(v) * 8;
  while (version <= QR_MAX_VERSION && !fits(version)) version++;
  if (version > QR_MAX_VERSION)
    throw new Error(
      `qr: ${bytes.length} bytes do not fit a version ${QR_MAX_VERSION} code at level M (at most ${dataCodewords(QR_MAX_VERSION) - 3})`,
    );
  const words = codewords(bytes, version);
  let best: Grid | null = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask !== undefined && mask !== forceMask) continue;
    const g = new Grid(version);
    g.functionPatterns();
    g.place(words);
    g.applyMask(mask);
    g.format(mask);
    const p = g.penalty();
    if (p < bestPenalty) {
      best = g;
      bestPenalty = p;
    }
  }
  return best!.dark;
}

const QUIET = 2; // modules of light border; 4 by the standard, 2 scans from a screen and keeps the text small

/**
 * The code as text for a terminal: two rows of modules per line with half blocks, dark modules drawn as the
 * terminal's background and light ones as blocks, so it reads on a dark terminal (most of them) as dark on light.
 */
export function qrText(modules: boolean[][]): string {
  const size = modules.length;
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < size && y < size && modules[y]![x]!;
  const lines: string[] = [];
  for (let y = -QUIET; y < size + QUIET; y += 2) {
    let s = "";
    for (let x = -QUIET; x < size + QUIET; x++) {
      const top = !at(x, y);
      const bottom = y + 1 < size + QUIET && !at(x, y + 1);
      s += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(s);
  }
  return lines.join("\n");
}

/** The code as an SVG element, one path of dark modules, sized `px` with a quiet zone of 4 modules. */
export function qrSvg(modules: boolean[][], px = 256): string {
  const size = modules.length;
  const box = size + 8;
  let d = "";
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y]![x]) d += `M${x + 4},${y + 4}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${box} ${box}" shape-rendering="crispEdges" role="img"><rect width="${box}" height="${box}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
