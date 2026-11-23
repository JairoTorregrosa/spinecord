// The size of a frame a page sent, read from the file's own header (JPEG SOF, PNG IHDR), so the process holds
// the limit on the longest side whatever the page says. Pure; null when the bytes are not a frame it can read.

export function imageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  if (mime === "image/png") return pngSize(bytes);
  if (mime === "image/jpeg") return jpegSize(bytes);
  return null;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || PNG.some((x, i) => b[i] !== x)) return null;
  // the first chunk is IHDR: length (4), type (4), width (4), height (4)
  if (String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== "IHDR") return null;
  const u32 = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
  return { width: u32(16), height: u32(20) };
}

// Start-of-frame markers: baseline, extended, progressive, lossless and their arithmetic-coded forms.
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    // fill bytes, and markers without a length
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (len < 2) return null;
    if (SOF.has(marker)) {
      if (i + 9 > b.length) return null;
      return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
    }
    // the image data starts: no frame header came before it
    if (marker === 0xda || marker === 0xd9) return null;
    i += 2 + len;
  }
  return null;
}
