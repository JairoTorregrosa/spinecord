// Pictures of the world. One renderer: a plain RGBA buffer (usable in tests and on a server); the canvas path
// only does putImageData and writes the labels. `snapshotPNG` gives a PNG with no dependencies.
import {
  World,
  COLOR_RGB,
  ULTRASONIC_MAX_CM,
  CONE_HALF_DEG,
  ULTRASONIC_RAYS,
  ULTRASONIC_ECHO_DEG,
  type Vec,
} from "./world";

export interface Image {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
export interface RenderOptions {
  /** Pixels per cm (default 4). */
  scale?: number;
  /** Draw the distance-sensor rays and the colour-sensor spot (default true). */
  rays?: boolean;
  /** Trail of positions [x, y] in cm. */
  trail?: Vec[];
}
type RGB = readonly [number, number, number];
const WALL: RGB = [60, 60, 70],
  BOX: RGB = [110, 110, 125],
  BODY: RGB = [235, 140, 40],
  NOSE: RGB = [120, 60, 10];
const RAY: RGB = [230, 40, 60],
  /** A ray of the cone whose surface sends no echo back (met too far off square). */
  SILENT_RAY: RGB = [235, 175, 180],
  SPOT: RGB = [20, 160, 230],
  POINT: RGB = [40, 40, 40],
  TRAIL: RGB = [150, 90, 200];

/** Floor and boxes per world and scale, kept while the obstacles stay the same list (a moved box is a new list). */
const floorCache = new WeakMap<object, Map<number, { boxes: object; buf: Uint8ClampedArray }>>();

function floorLayer(world: World, scale: number, W: number, H: number): Uint8ClampedArray {
  let per = floorCache.get(world.cfg);
  if (!per) floorCache.set(world.cfg, (per = new Map()));
  const kept = per.get(scale);
  if (kept && kept.boxes === world.cfg.boxes) return kept.buf;
  const buf = new Uint8ClampedArray(W * H * 4);
  const c = world.cfg;
  for (let py = 0; py < H; py++) {
    const y = c.height - (py + 0.5) / scale;
    for (let px = 0; px < W; px++) {
      const x = (px + 0.5) / scale;
      let rgb: RGB = COLOR_RGB[world.floorColorAt(x, y)]!;
      for (const b of c.boxes)
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
          rgb = BOX;
          break;
        }
      if (px < 2 || py < 2 || px >= W - 2 || py >= H - 2) rgb = WALL;
      const i = (py * W + px) * 4;
      buf[i] = rgb[0];
      buf[i + 1] = rgb[1];
      buf[i + 2] = rgb[2];
      buf[i + 3] = 255;
    }
  }
  per.set(scale, { boxes: c.boxes, buf });
  return buf;
}

/** Draws world + robot + rays into an RGBA buffer (origin top-left; the world's y axis is flipped). */
export function renderWorld(world: World, opts: RenderOptions = {}): Image {
  const scale = opts.scale ?? 4;
  if (!(scale > 0 && scale <= 32)) throw new Error(`renderWorld: scale must be in (0, 32], got ${scale}`);
  const c = world.cfg,
    W = Math.round(c.width * scale),
    H = Math.round(c.height * scale);
  const data = new Uint8ClampedArray(floorLayer(world, scale, W, H));
  const put = (px: number, py: number, rgb: RGB): void => {
    if (px < 0 || py < 0 || px >= W || py >= H) return;
    const i = (py * W + px) * 4;
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
  };
  const toPx = (x: number, y: number): [number, number] => [Math.floor(x * scale), Math.floor((c.height - y) * scale)];
  const disc = (x: number, y: number, r_cm: number, rgb: RGB): void => {
    const [cx, cy] = toPx(x, y),
      r = Math.max(1, Math.round(r_cm * scale));
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) put(cx + dx, cy + dy, rgb);
  };
  const line = (x0: number, y0: number, x1: number, y1: number, rgb: RGB): void => {
    const [ax, ay] = toPx(x0, y0),
      [bx, by] = toPx(x1, y1);
    const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay), 1);
    for (let i = 0; i <= n; i++) put(Math.round(ax + ((bx - ax) * i) / n), Math.round(ay + ((by - ay) * i) / n), rgb);
  };
  // Named points: a ring.
  for (const p of c.points) {
    for (let a = 0; a < 360; a += 3) {
      const r = (a * Math.PI) / 180;
      const [px, py] = toPx(p.x + p.radius * Math.cos(r), p.y + p.radius * Math.sin(r));
      put(px, py, POINT);
    }
  }
  for (const t of opts.trail ?? []) {
    const [px, py] = toPx(t[0], t[1]);
    put(px, py, TRAIL);
    put(px + 1, py, TRAIL);
  }
  // Robot: an oriented rectangle with a darker front end, to show where it faces.
  const p = world.pose,
    g = c.body,
    cs = Math.cos(p.th),
    sn = Math.sin(p.th);
  const reach = Math.hypot(Math.max(g.front_cm, g.back_cm), g.half_width_cm);
  const [x0, y0] = toPx(p.x - reach, p.y + reach),
    [x1, y1] = toPx(p.x + reach, p.y - reach);
  for (let py = y0; py <= y1; py++)
    for (let px = x0; px <= x1; px++) {
      const dx = (px + 0.5) / scale - p.x,
        dy = c.height - (py + 0.5) / scale - p.y;
      const u = dx * cs + dy * sn,
        v = -dx * sn + dy * cs;
      if (u >= -g.back_cm && u <= g.front_cm && Math.abs(v) <= g.half_width_cm)
        put(px, py, u > g.front_cm - 2.5 ? NOSE : BODY);
    }
  if (opts.rays ?? true) {
    const {
      o: [ox, oy],
      th,
    } = world.distanceSensorAxis(p);
    // Every ray of the ultrasonic cone, each up to what it hits: dark where that surface echoes, pale where it is
    // met too far off square to send the sound back (world.ts, ULTRASONIC_ECHO_DEG).
    const echo = Math.cos((ULTRASONIC_ECHO_DEG * Math.PI) / 180);
    for (let i = 0; i < ULTRASONIC_RAYS; i++) {
      const off = (((2 * i) / (ULTRASONIC_RAYS - 1) - 1) * CONE_HALF_DEG * Math.PI) / 180,
        h = world.rayHit(p, off),
        d = Math.min(h.d, ULTRASONIC_MAX_CM);
      line(ox, oy, ox + d * Math.cos(th + off), oy + d * Math.sin(th + off), h.cos >= echo - 1e-12 ? RAY : SILENT_RAY);
    }
    const [sx, sy] = world.pointAhead(g.color_sensor_x_cm);
    disc(sx, sy, g.color_spot_radius_cm, SPOT);
  }
  return { width: W, height: H, data };
}

export interface CameraOptions {
  width?: number;
  height?: number;
  fov_deg?: number;
  camera_height_cm?: number;
  wall_height_cm?: number;
}

/**
 * First-person view from the distance sensor's eye (World.distanceSensorAxis), looking where it looks.
 * Floor: every pixel under the horizon is projected onto the floor and takes its colour. Walls and obstacles: one ray per column.
 */
export function renderFirstPerson(world: World, opts: CameraOptions = {}): Image {
  const W = opts.width ?? 160,
    H = opts.height ?? 120;
  const fov = ((opts.fov_deg ?? 70) * Math.PI) / 180,
    camH = opts.camera_height_cm ?? 8,
    wallH = opts.wall_height_cm ?? 14;
  if (!(W > 0 && H > 0 && W <= 640 && H <= 480))
    throw new Error(`renderFirstPerson: size ${W}x${H} is outside 1..640 x 1..480`);
  const data = new Uint8ClampedArray(W * H * 4);
  // the camera is the distance sensor's eye: walls (rayHit) and floor from the same point, along the same heading
  const p = world.pose,
    {
      o: [ox, oy],
      th,
    } = world.distanceSensorAxis();
  const focal = W / 2 / Math.tan(fov / 2),
    horizon = H / 2;
  for (let px = 0; px < W; px++) {
    const off = Math.atan((W / 2 - px - 0.5) / focal); // + = left
    const dx = Math.cos(th + off),
      dy = Math.sin(th + off),
      cosOff = Math.cos(off);
    const hit = world.rayHit(p, off, Math.PI / 2),
      wall = hit.d * cosOff; // distance perpendicular to the image plane
    // a box as tall as it is; above a low one the camera sees the floor beyond it and sky, not what stands behind
    // it (one hit per column)
    const top = horizon - ((Math.min(wallH, hit.top_cm) - camH) * focal) / Math.max(wall, 0.01),
      bottom = horizon + (camH * focal) / Math.max(wall, 0.01);
    const shade = Math.max(0.35, 1 - wall / 220);
    for (let py = 0; py < H; py++) {
      let r: number, g: number, b: number;
      if (py + 0.5 > top && py + 0.5 < bottom) {
        r = 120 * shade;
        g = 122 * shade;
        b = 140 * shade;
      } else if (py + 0.5 > horizon) {
        // the floor: in front of what the column hit, or beyond a low box
        const d = (camH * focal) / (py + 0.5 - horizon) / cosOff;
        [r, g, b] = COLOR_RGB[world.floorColorAt(ox + dx * d, oy + dy * d)]!;
      } else {
        r = 196;
        g = 222;
        b = 240;
      }
      const i = (py * W + px) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

/** Standard base64 of some bytes (no Buffer, no btoa: works in a browser and in bun). */
export function toBase64(bytes: Uint8Array): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!,
      b = bytes[i + 1],
      c = bytes[i + 2];
    out +=
      A[a >> 2]! +
      A[((a & 3) << 4) | ((b ?? 0) >> 4)]! +
      (b === undefined ? "=" : A[((b & 15) << 2) | ((c ?? 0) >> 6)]!) +
      (c === undefined ? "=" : A[c & 63]!);
  }
  return out;
}

/** A short stable fingerprint of an image (32-bit FNV-1a, hex), for comparisons in tests. */
export function hashImage(img: Image): string {
  let h = 0x811c9dc5;
  h = Math.imul(h ^ img.width, 0x01000193);
  h = Math.imul(h ^ img.height, 0x01000193);
  for (let i = 0; i < img.data.length; i++) h = Math.imul(h ^ img.data[i]!, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Paints on a 2D canvas: the buffer image with the point labels on top. */
export function drawWorld(ctx: CanvasRenderingContext2D, world: World, opts: RenderOptions = {}): Image {
  const img = renderWorld(world, opts);
  const id = ctx.createImageData(img.width, img.height);
  id.data.set(img.data);
  ctx.putImageData(id, 0, 0);
  const scale = opts.scale ?? 4;
  ctx.font = `${Math.max(9, Math.round(scale * 2.6))}px sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = "#222";
  for (const p of world.cfg.points) ctx.fillText(p.label, p.x * scale, (world.cfg.height - p.y - p.radius) * scale - 3);
  return img;
}

// ---------- Dependency-free PNG (deflate "stored": uncompressed) ----------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePNG(img: Image): Uint8Array {
  const { width: W, height: H, data } = img;
  const raw = new Uint8Array(H * (1 + W * 4));
  for (let y = 0; y < H; y++) raw.set(data.subarray(y * W * 4, (y + 1) * W * 4), y * (1 + W * 4) + 1);
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  z[0] = 0x78;
  z[1] = 0x01;
  let o = 2,
    a = 1,
    b = 0;
  for (let i = 0; i < blocks; i++) {
    const chunk = raw.subarray(i * 65535, Math.min(raw.length, (i + 1) * 65535));
    z[o++] = i === blocks - 1 ? 1 : 0;
    z[o++] = chunk.length & 255;
    z[o++] = chunk.length >>> 8;
    z[o++] = ~chunk.length & 255;
    z[o++] = (~chunk.length >>> 8) & 255;
    z.set(chunk, o);
    o += chunk.length;
  }
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]!) % 65521;
    b = (b + a) % 65521;
  }
  z[o++] = b >>> 8;
  z[o++] = b & 255;
  z[o++] = a >>> 8;
  z[o++] = a & 255;
  const ihdr = new Uint8Array(13),
    dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W);
  dv.setUint32(4, H);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
  for (const [type, body] of [
    ["IHDR", ihdr],
    ["IDAT", z],
    ["IEND", new Uint8Array(0)],
  ] as [string, Uint8Array][]) {
    const chunk = new Uint8Array(12 + body.length),
      v = new DataView(chunk.buffer);
    v.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
    chunk.set(body, 8);
    v.setUint32(8 + body.length, crc32(chunk.subarray(4, 8 + body.length)));
    parts.push(chunk);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Overhead PNG of the world: what the twin's view from above returns. */
export function snapshotPNG(world: World, opts: RenderOptions = {}): Uint8Array {
  return encodePNG(renderWorld(world, opts));
}
