// EV3 direct commands: pure encoders and decoders (no I/O, no Node/Bun APIs).
//
// Frame (direct command):  [u16 LE len][u16 LE counter][type][u16 LE header][bytecodes]
//   type   0x00 = reply wanted, 0x80 = no reply
//   header low 10 bits = bytes of global memory (the reply), high 6 bits = locals
// Reply:                   [u16 LE len][u16 LE counter][0x02 ok | 0x04 error][globals]
//
// Sources: LEGO "EV3 Communication Developer Kit", lms2012 bytecodes.h / c_output.c,
// and BrandonVP/OpenMindstorms python/openev3/protocol.py (MIT, (c) 2026 Brandon Van Pelt),
// whose parameter encoders this file follows byte for byte (see fixtures/).
//
// There is deliberately NO system-command encoder here (types 0x01/0x81): system
// command 0xA0 puts the brick in firmware-update mode. As a direct opcode 0xA0 is
// OUTPUT_GET_TYPE, which this library never emits either.

export const USB_VID = 0x0694;
export const USB_PID = 0x0005;

export const TYPE_DIRECT_REPLY = 0x00;
export const TYPE_DIRECT_NO_REPLY = 0x80;
export const TYPE_SYSTEM_REPLY = 0x01;
export const TYPE_SYSTEM_NO_REPLY = 0x81;
export const REPLY_OK = 0x02;
export const REPLY_ERROR = 0x04;

export const MAX_GLOBALS = 1019;
export const MAX_LOCALS = 63;
export const MAX_MESSAGE = 1024;

export const OP = {
  UI_READ: 0x81,
  UI_WRITE: 0x82,
  UI_BUTTON: 0x83,
  UI_DRAW: 0x84,
  SOUND: 0x94,
  INPUT_DEVICE: 0x99,
  OUTPUT_STOP: 0xa3,
  OUTPUT_POWER: 0xa4,
  OUTPUT_SPEED: 0xa5,
  OUTPUT_START: 0xa6,
  OUTPUT_READ: 0xa8,
  OUTPUT_TEST: 0xa9,
  // 0xAA OUTPUT_READY is never used: it blocks the brick until the motor is done.
  OUTPUT_STEP_POWER: 0xac,
  OUTPUT_TIME_POWER: 0xad,
  OUTPUT_STEP_SPEED: 0xae,
  OUTPUT_TIME_SPEED: 0xaf,
  OUTPUT_STEP_SYNC: 0xb0,
  OUTPUT_TIME_SYNC: 0xb1,
  OUTPUT_CLR_COUNT: 0xb2,
  OUTPUT_GET_COUNT: 0xb3,
} as const;

export const SUB = {
  UI_READ_GET_VBATT: 0x01,
  UI_READ_GET_LBATT: 0x12,
  UI_WRITE_LED: 0x1b,
  UI_BUTTON_PRESSED: 0x09,
  UI_DRAW_UPDATE: 0x00,
  UI_DRAW_TEXT: 0x05,
  UI_DRAW_SELECT_FONT: 0x11,
  UI_DRAW_FILLWINDOW: 0x13,
  SOUND_BREAK: 0x00,
  SOUND_TONE: 0x01,
  INPUT_GET_TYPEMODE: 0x05,
  INPUT_STOP_ALL: 0x0d,
  INPUT_READY_RAW: 0x1c,
  INPUT_READY_SI: 0x1d,
} as const;

export const SENSOR_TYPE = { touch: 16, color: 29, ultrasonic: 30, gyro: 32, ir: 33 } as const;
export const TYPE_NONE = 126;
export const DEVICE_NAMES: Record<number, string> = {
  7: "large-motor",
  8: "medium-motor",
  16: "touch",
  29: "color",
  30: "ultrasonic",
  32: "gyro",
  33: "ir",
  125: "unknown",
  126: "none",
  127: "error",
};

export const OUTPUT_MASK = { A: 1, B: 2, C: 4, D: 8 } as const;
export const ALL_OUTPUTS = 0x0f;
export type OutputPort = keyof typeof OUTPUT_MASK;
export const outputIndex = (p: OutputPort): number => "ABCD".indexOf(p);

// ---------------------------------------------------------------- parameters

function int(v: number, name: string): number {
  if (!Number.isInteger(v)) throw new RangeError(`${name}: ${v} is not an integer`);
  return v;
}
function range(v: number, lo: number, hi: number, name: string): number {
  int(v, name);
  if (v < lo || v > hi) throw new RangeError(`${name}: ${v} outside ${lo}..${hi}`);
  return v;
}

/** Short constant, -32..31, one byte. */
export function lc0(v: number): number[] {
  return [range(v, -32, 31, "LC0") & 0x3f];
}
export function lc1(v: number): number[] {
  return [0x81, range(v, -128, 255, "LC1") & 0xff];
}
export function lc2(v: number): number[] {
  range(v, -32768, 65535, "LC2");
  return [0x82, v & 0xff, (v >> 8) & 0xff];
}
export function lc4(v: number): number[] {
  range(v, -2147483648, 2147483647, "LC4");
  return [0x83, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
}
/** Smallest signed constant encoding. */
export function lc(v: number): number[] {
  int(v, "LC");
  if (v >= -32 && v <= 31) return lc0(v);
  if (v >= -128 && v <= 127) return lc1(v);
  if (v >= -32768 && v <= 32767) return lc2(v);
  return lc4(v);
}
/** Zero-terminated string. Only printable ASCII goes to the brick; anything else is an error. */
export function lcs(s: string): number[] {
  const out = [0x84];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) throw new RangeError(`LCS: character ${JSON.stringify(s[i])} is not printable ASCII`);
    out.push(c);
  }
  out.push(0);
  return out;
}
/** Global variable reference (byte offset into the reply). */
export function gv(i: number): number[] {
  range(i, 0, MAX_GLOBALS - 1, "GV");
  return i < 32 ? [0x60 | i] : i < 256 ? [0xe1, i] : [0xe2, i & 0xff, i >> 8];
}

// ---------------------------------------------------------------- framing

export interface FrameOptions {
  counter: number;
  globals?: number;
  locals?: number;
  reply?: boolean;
}

export function frame(bytecodes: ArrayLike<number>, o: FrameOptions): Uint8Array {
  const globals = range(o.globals ?? 0, 0, MAX_GLOBALS, "globals");
  const locals = range(o.locals ?? 0, 0, MAX_LOCALS, "locals");
  const counter = range(o.counter, 0, 0xffff, "counter");
  const total = 7 + bytecodes.length;
  if (total > MAX_MESSAGE) throw new RangeError(`direct command too long (${total} bytes, max ${MAX_MESSAGE})`);
  const out = new Uint8Array(total);
  const header = globals | (locals << 10);
  out[0] = (total - 2) & 0xff;
  out[1] = (total - 2) >> 8;
  out[2] = counter & 0xff;
  out[3] = counter >> 8;
  out[4] = o.reply === false ? TYPE_DIRECT_NO_REPLY : TYPE_DIRECT_REPLY;
  out[5] = header & 0xff;
  out[6] = header >> 8;
  out.set(bytecodes, 7);
  return out;
}

export interface DecodedCommand {
  counter: number;
  type: number;
  globals: number;
  locals: number;
  bytecodes: Uint8Array;
}

/** Decode an outgoing packet (used by the fake brick and by tests). Trailing padding is ignored. */
export function decodeCommand(packet: Uint8Array): DecodedCommand {
  if (packet.length < 5) throw new RangeError("packet too short");
  const len = packet[0] | (packet[1] << 8);
  if (len + 2 > packet.length)
    throw new RangeError(`packet length field ${len} exceeds ${packet.length - 2} bytes present`);
  const counter = packet[2] | (packet[3] << 8);
  const type = packet[4];
  if (type !== TYPE_DIRECT_REPLY && type !== TYPE_DIRECT_NO_REPLY) {
    return { counter, type, globals: 0, locals: 0, bytecodes: packet.slice(5, len + 2) };
  }
  if (len < 5) throw new RangeError("direct command without header");
  const header = packet[5] | (packet[6] << 8);
  return { counter, type, globals: header & 0x3ff, locals: header >> 10, bytecodes: packet.slice(7, len + 2) };
}

export interface DecodedReply {
  counter: number;
  ok: boolean;
  status: number;
  globals: Uint8Array;
}

/** Decode a reply. Accepts a padded HID report: only the first 2+len bytes are read. */
export function decodeReply(data: Uint8Array): DecodedReply {
  if (data.length < 5) throw new RangeError(`reply too short (${data.length} bytes)`);
  const len = data[0] | (data[1] << 8);
  if (len < 3 || len + 2 > data.length)
    throw new RangeError(`reply length field ${len} does not fit ${data.length} bytes`);
  const status = data[4];
  if (status !== REPLY_OK && status !== REPLY_ERROR)
    throw new RangeError(`not a direct reply (type 0x${status.toString(16)})`);
  return { counter: data[2] | (data[3] << 8), ok: status === REPLY_OK, status, globals: data.slice(5, len + 2) };
}

export function encodeReply(counter: number, ok: boolean, globals: ArrayLike<number> = []): Uint8Array {
  const out = new Uint8Array(5 + globals.length);
  out[0] = (3 + globals.length) & 0xff;
  out[1] = (3 + globals.length) >> 8;
  out[2] = counter & 0xff;
  out[3] = counter >> 8;
  out[4] = ok ? REPLY_OK : REPLY_ERROR;
  out.set(globals, 5);
  return out;
}

export type Param =
  | { kind: "const"; value: number }
  | { kind: "string"; value: string }
  | { kind: "global"; value: number };

/** Read one bytecode parameter at `at`. Returns the parameter and the next offset. */
export function readParam(b: Uint8Array, at: number): { param: Param; next: number } {
  if (at >= b.length) throw new RangeError("parameter past end of bytecodes");
  const h = b[at];
  const need = (n: number) => {
    if (at + n >= b.length) throw new RangeError("truncated parameter");
  };
  if ((h & 0x80) === 0) {
    if ((h & 0x40) === 0)
      return { param: { kind: "const", value: h & 0x20 ? (h & 0x3f) - 64 : h & 0x3f }, next: at + 1 };
    if ((h & 0x20) !== 0) return { param: { kind: "global", value: h & 0x1f }, next: at + 1 };
    throw new RangeError(`local variable parameter 0x${h.toString(16)} not supported`);
  }
  switch (h) {
    case 0x81:
      need(1);
      return { param: { kind: "const", value: (b[at + 1] << 24) >> 24 }, next: at + 2 };
    case 0x82:
      need(2);
      return { param: { kind: "const", value: ((b[at + 1] | (b[at + 2] << 8)) << 16) >> 16 }, next: at + 3 };
    case 0x83:
      need(4);
      return {
        param: { kind: "const", value: b[at + 1] | (b[at + 2] << 8) | (b[at + 3] << 16) | (b[at + 4] << 24) },
        next: at + 5,
      };
    case 0x84: {
      let end = at + 1;
      while (end < b.length && b[end] !== 0) end++;
      if (end >= b.length) throw new RangeError("unterminated string");
      let s = "";
      for (let i = at + 1; i < end; i++) s += String.fromCharCode(b[i]);
      return { param: { kind: "string", value: s }, next: end + 1 };
    }
    case 0xe1:
      need(1);
      return { param: { kind: "global", value: b[at + 1] }, next: at + 2 };
    case 0xe2:
      need(2);
      return { param: { kind: "global", value: b[at + 1] | (b[at + 2] << 8) }, next: at + 3 };
  }
  throw new RangeError(`unsupported parameter header 0x${h.toString(16)}`);
}

// ---------------------------------------------------------------- reply values

export function readF32(g: Uint8Array, at: number): number {
  if (at + 4 > g.length) throw new RangeError("reply too short for float");
  return new DataView(g.buffer, g.byteOffset + at, 4).getFloat32(0, true);
}
export function readI32(g: Uint8Array, at: number): number {
  if (at + 4 > g.length) throw new RangeError("reply too short for int32");
  return new DataView(g.buffer, g.byteOffset + at, 4).getInt32(0, true);
}
export function readI8(g: Uint8Array, at: number): number {
  if (at + 1 > g.length) throw new RangeError("reply too short for int8");
  return (g[at] << 24) >> 24;
}

// ---------------------------------------------------------------- commands (bytecode fragments)
// Port arguments: `mask` is a bit field (A=1,B=2,C=4,D=8); `index` is 0..3; sensor `port` is 0..3 on the wire.

const mask = (m: number) => lc0(range(m, 1, 15, "output mask"));
const index = (i: number) => lc0(range(i, 0, 3, "output index"));
const pct = (v: number, name: string) => lc(range(v, -100, 100, name));
const brakeFlag = (b: boolean) => lc0(b ? 1 : 0);
const positive = (v: number, name: string) => {
  // 0 means "run forever" in the firmware: every motion this library emits is bounded on the brick.
  if (range(v, 0, 2147483647, name) === 0) throw new RangeError(`${name}: 0 would run the motor without a bound`);
  return v;
};

/** A3: stop, brake or coast. */
export const outputStop = (m: number, brake = true) => [OP.OUTPUT_STOP, 0, ...mask(m), ...brakeFlag(brake)];
/** A4: set power (does not start). */
export const outputPower = (m: number, power: number) => [OP.OUTPUT_POWER, 0, ...mask(m), ...pct(power, "power")];
/** A5: set regulated speed (does not start). */
export const outputSpeed = (m: number, speed: number) => [OP.OUTPUT_SPEED, 0, ...mask(m), ...pct(speed, "speed")];
/** A6: start. UNBOUNDED on the brick; exported for completeness, not used by the backend. */
export const outputStart = (m: number) => [OP.OUTPUT_START, 0, ...mask(m)];
/** AE: regulated speed for ramp-up + constant + ramp-down degrees. */
export function outputStepSpeed(
  m: number,
  speed: number,
  step1: number,
  step2: number,
  step3: number,
  brake = true,
): number[] {
  range(step1, 0, 2147483647, "step1");
  range(step2, 0, 2147483647, "step2");
  range(step3, 0, 2147483647, "step3");
  positive(step1 + step2 + step3, "step1+step2+step3");
  return [
    OP.OUTPUT_STEP_SPEED,
    0,
    ...mask(m),
    ...pct(speed, "speed"),
    ...lc(step1),
    ...lc(step2),
    ...lc(step3),
    ...brakeFlag(brake),
  ];
}
/** AF: regulated speed for ramp-up + constant + ramp-down milliseconds. */
export function outputTimeSpeed(
  m: number,
  speed: number,
  ms1: number,
  ms2: number,
  ms3: number,
  brake = true,
): number[] {
  range(ms1, 0, 2147483647, "ms1");
  range(ms2, 0, 2147483647, "ms2");
  range(ms3, 0, 2147483647, "ms3");
  positive(ms1 + ms2 + ms3, "ms1+ms2+ms3");
  return [
    OP.OUTPUT_TIME_SPEED,
    0,
    ...mask(m),
    ...pct(speed, "speed"),
    ...lc(ms1),
    ...lc(ms2),
    ...lc(ms3),
    ...brakeFlag(brake),
  ];
}
/** B0: two motors in sync for `step` degrees. turn: 0 straight, +-100 one motor stopped, +-200 spin in place. */
export const outputStepSync = (m: number, speed: number, turn: number, step: number, brake = true) => [
  OP.OUTPUT_STEP_SYNC,
  0,
  ...mask(m),
  ...pct(speed, "speed"),
  ...lc2(range(turn, -200, 200, "turn")),
  ...lc4(positive(step, "step")),
  ...brakeFlag(brake),
];
/** B1: two motors in sync for `ms` milliseconds. */
export const outputTimeSync = (m: number, speed: number, turn: number, ms: number, brake = true) => [
  OP.OUTPUT_TIME_SYNC,
  0,
  ...mask(m),
  ...pct(speed, "speed"),
  ...lc2(range(turn, -200, 200, "turn")),
  ...lc4(positive(ms, "ms")),
  ...brakeFlag(brake),
];
/** A8: speed (1 byte at gSpeed) and tacho count (4 bytes at gTacho). */
export const outputRead = (i: number, gSpeed: number, gTacho: number) => [
  OP.OUTPUT_READ,
  0,
  ...index(i),
  ...gv(gSpeed),
  ...gv(gTacho),
];
/** B3: tacho count, 4 bytes. */
export const outputGetCount = (i: number, g: number) => [OP.OUTPUT_GET_COUNT, 0, ...index(i), ...gv(g)];
/** B2: clear tacho count. */
export const outputClearCount = (m: number) => [OP.OUTPUT_CLR_COUNT, 0, ...mask(m)];
/** A9: busy flag for any motor in the mask, 1 byte. */
export const outputTest = (m: number, g: number) => [OP.OUTPUT_TEST, 0, ...mask(m), ...gv(g)];

const sensorPort = (p: number) => lc0(range(p, 0, 19, "sensor port"));
/** 99 1D: `count` float32 SI values, 4 bytes each from `g`. type 0 = keep type, mode -1 = keep mode. */
export function inputReadySi(port: number, type: number, mode: number, count: number, g: number): number[] {
  range(count, 1, 8, "count");
  const out = [
    OP.INPUT_DEVICE,
    SUB.INPUT_READY_SI,
    0,
    ...sensorPort(port),
    ...lc(range(type, 0, 127, "type")),
    ...lc0(range(mode, -1, 7, "mode")),
    ...lc0(count),
  ];
  for (let i = 0; i < count; i++) out.push(...gv(g + 4 * i));
  return out;
}
/** 99 1C: `count` int32 raw values, 4 bytes each from `g`. */
export function inputReadyRaw(port: number, type: number, mode: number, count: number, g: number): number[] {
  const out = inputReadySi(port, type, mode, count, g);
  out[1] = SUB.INPUT_READY_RAW;
  return out;
}
/** 99 05: type and mode, 1 byte each. Ports 0..3 are inputs, 16..19 outputs A..D. */
export const inputGetTypeMode = (port: number, gType: number, gMode: number) => [
  OP.INPUT_DEVICE,
  SUB.INPUT_GET_TYPEMODE,
  0,
  ...sensorPort(port),
  ...gv(gType),
  ...gv(gMode),
];
/** 99 0D: stop all input devices. */
export const inputStopAll = () => [OP.INPUT_DEVICE, SUB.INPUT_STOP_ALL, 0];

/** 94 01: tone. */
export const soundTone = (volume: number, hz: number, ms: number) => [
  OP.SOUND,
  SUB.SOUND_TONE,
  ...lc1(range(volume, 0, 100, "volume")),
  ...lc2(range(hz, 250, 10000, "hz")),
  ...lc2(range(ms, 1, 32767, "ms")),
];

/** 84 05: text at pixel x,y (LCD is 178x128). color 1 = black. */
export const drawText = (color: 0 | 1, x: number, y: number, text: string) => [
  OP.UI_DRAW,
  SUB.UI_DRAW_TEXT,
  ...lc0(color),
  ...lc(range(x, 0, 177, "x")),
  ...lc(range(y, 0, 127, "y")),
  ...lcs(text),
];
/** 84 13: fill window; (0, 0, 0) clears the whole screen to white. */
export const drawFillWindow = (color: 0 | 1, y0: number, ySize: number) => [
  OP.UI_DRAW,
  SUB.UI_DRAW_FILLWINDOW,
  ...lc0(color),
  ...lc(range(y0, 0, 127, "y0")),
  ...lc(range(ySize, 0, 128, "ySize")),
];
/** 84 11: select font 0 (small), 1 (normal), 2 (large). */
export const drawSelectFont = (font: 0 | 1 | 2) => [OP.UI_DRAW, SUB.UI_DRAW_SELECT_FONT, ...lc0(font)];
/** 84 00: push the drawing to the LCD. */
export const drawUpdate = () => [OP.UI_DRAW, SUB.UI_DRAW_UPDATE];
/** 82 1B: brick LED pattern 0..9 (0 off, 1 green, 2 red, 3 orange, 4-6 flash, 7-9 pulse). */
export const uiLed = (pattern: number) => [OP.UI_WRITE, SUB.UI_WRITE_LED, ...lc0(range(pattern, 0, 9, "led pattern"))];
/** 83 09: is button pressed (1 up, 2 enter, 3 down, 4 right, 5 left, 6 back, 7 any), 1 byte. */
export const uiButtonPressed = (button: number, g: number) => [
  OP.UI_BUTTON,
  SUB.UI_BUTTON_PRESSED,
  ...lc0(range(button, 1, 7, "button")),
  ...gv(g),
];
/** 81 01: battery voltage, float32. */
export const uiBatteryVolts = (g: number) => [OP.UI_READ, SUB.UI_READ_GET_VBATT, ...gv(g)];
/** 81 12: battery level percent, 1 byte. */
export const uiBatteryPct = (g: number) => [OP.UI_READ, SUB.UI_READ_GET_LBATT, ...gv(g)];

export function toHex(b: ArrayLike<number>): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");
}
export function fromHex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new RangeError("bad hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
