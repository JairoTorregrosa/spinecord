// A fake EV3 brick behind the Transport interface. It decodes the real packets,
// simulates motors (tacho, busy), sensors and battery, and answers like the
// firmware (lms2012 c_output.c / c_input.c). Tests can make it drop or delay
// replies and stall a motor. Motor timing follows the injected clock.
import {
  OP,
  SUB,
  TYPE_DIRECT_NO_REPLY,
  TYPE_DIRECT_REPLY,
  TYPE_NONE,
  decodeCommand,
  encodeReply,
  readParam,
} from "./encode";
import type { Transport } from "./transport";

interface Motor {
  pos: number; // degrees, fractional
  speedPct: number; // signed speed while running, 0 when idle
  target: number | null; // stop when pos reaches this
  until: number | null; // stop at this clock time (ms)
  holdBrake: boolean;
  stalled: boolean;
  spinUntil: number; // the shaft still reads a speed until this clock time (brake lag)
  type: number; // 7 large, 8 medium, 126 none
}

/** `byMode[m]` holds the SI values the sensor returns in mode m. */
export interface FakeSensor {
  type: number;
  mode: number;
  byMode: Record<number, number[]>;
  /**
   * What the firmware's type table says of each mode (typedata.rcf): its name, unit symbol ("_" = none) and
   * decimals. Answers GET_FORMAT, GET_FIGURES, GET_SYMBOL and GET_MODENAME; absent = a type with one unnamed mode.
   */
  modes?: { name: string; symbol?: string; decimals?: number }[];
}

export interface FakeOptions {
  now?: () => number;
  /** Degrees per second at 100 % speed. A real large motor does about 1050. */
  degPerSecAt100?: number;
  batteryV?: number;
  batteryPct?: number;
}

export interface SentRecord {
  at: number;
  packet: Uint8Array;
  counter: number;
  type: number;
  opcodes: number[];
}

/**
 * Emulated time for a FakeEV3 and the provider that drives it: pass `now` to both and `sleep` to the provider.
 * Time moves only to the earliest pending wait, one macrotask at a time, so every promise chain settles first and
 * a loaded machine cannot stretch a wait into extra travel. A wait that lost a race still fires later and only
 * moves the clock.
 * It mirrors FakeClock of packages/runtime/clock.ts: the boundaries check forbids driver-ev3 to import runtime.
 */
export class EmulatedClock {
  private t = 0;
  private seq = 0;
  private timers: { at: number; seq: number; fire: () => void }[] = [];
  private pumping = false;
  readonly now = (): number => this.t;
  /** Time that passes while no one waits on this clock, ms (a reply the test holds back, say). */
  advance(ms: number): void {
    if (!(ms >= 0)) throw new Error(`EmulatedClock.advance: ms must be >= 0, got ${ms}`);
    this.t += ms;
  }
  readonly sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      this.timers.push({ at: this.t + Math.max(0, ms), seq: this.seq++, fire: resolve });
      this.pump();
    });
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    setImmediate(() => {
      this.pumping = false;
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers.shift();
      if (next) {
        this.t = Math.max(this.t, next.at);
        next.fire();
      }
      if (this.timers.length) this.pump();
    });
  }
}

export class FakeEV3 implements Transport {
  readonly motors: Motor[] = [0, 1, 2, 3].map((i) => ({
    pos: 0,
    speedPct: 0,
    target: null,
    until: null,
    holdBrake: false,
    stalled: false,
    spinUntil: 0,
    type: i === 1 || i === 2 ? 7 : TYPE_NONE,
  }));
  readonly sensors: (FakeSensor | null)[] = [null, null, null, null];
  batteryV: number;
  batteryPct: number;
  /** After a brake, A8 keeps reading a small speed for this long (a real shaft does not stop at once), ms. */
  brakeLagMs = 0;
  /** Extra delay before every reply, ms. */
  replyDelayMs = 0;
  /** Every packet received, in order. */
  readonly sent: SentRecord[] = [];
  /** Commands that arrived while another was in flight (a real brick ignores them). */
  overlaps = 0;
  /** Motions started without a bound on the brick (step or time 0, or A6 start). */
  unboundedMoves = 0;
  /** Commands answered with 0x04. */
  errors: string[] = [];
  lcd: string[] = [];
  led = 0;
  /** Brick buttons held down: 1 up, 2 enter, 3 down, 4 right, 5 left, 6 back. */
  readonly buttonsDown = new Set<number>();
  /** Times a sensor was asked for a mode other than its current one. */
  modeSwitches = 0;
  tones: { hz: number; ms: number; volume: number }[] = [];

  private readonly now: () => number;
  private readonly rate: number;
  private last: number;
  private inFlight = false;
  private dropCount = 0;
  private dropFilter: ((opcodes: number[]) => boolean) | null = null;

  constructor(opts: FakeOptions = {}) {
    this.now = opts.now ?? (() => performance.now());
    this.rate = opts.degPerSecAt100 ?? 1050;
    this.batteryV = opts.batteryV ?? 7.9;
    this.batteryPct = opts.batteryPct ?? 85;
    this.last = this.now();
  }

  // ------------------------------------------------------------- test controls

  /** Swallow the reply of the next `n` commands (they still execute, like a lost USB report). */
  dropNext(n = 1, filter?: (opcodes: number[]) => boolean): void {
    this.dropCount = n;
    this.dropFilter = filter ?? null;
  }
  /** Plug a sensor into input port 1..4, or update it: `values` are what it returns in `mode`. */
  setSensor(port: 1 | 2 | 3 | 4, type: number, values: number | number[], mode = 0): void {
    const old = this.sensors[port - 1];
    const s = old && old.type === type ? old : { type, mode: 0, byMode: {} as Record<number, number[]> };
    s.byMode[mode] = Array.isArray(values) ? values : [values];
    this.sensors[port - 1] = s;
  }
  /** Give the sensor on input port 1..4 its firmware type table rows (see FakeSensor.modes). */
  describeSensor(port: 1 | 2 | 3 | 4, modes: NonNullable<FakeSensor["modes"]>): void {
    const s = this.sensors[port - 1];
    if (!s) throw new Error(`no sensor on input port ${port}`);
    s.modes = modes;
  }
  unplugSensor(port: 1 | 2 | 3 | 4): void {
    this.sensors[port - 1] = null;
  }
  /** Block a wheel: the motor stays busy and its tacho does not advance. */
  stall(port: "A" | "B" | "C" | "D", stalled = true): void {
    this.advance();
    this.motors["ABCD".indexOf(port)].stalled = stalled;
  }
  tacho(port: "A" | "B" | "C" | "D"): number {
    this.advance();
    return Math.round(this.motors["ABCD".indexOf(port)].pos);
  }
  busy(mask = 0x0f): boolean {
    this.advance();
    return this.motors.some((m, i) => (mask & (1 << i)) !== 0 && this.isBusy(m));
  }

  // ------------------------------------------------------------- transport

  send(bytes: Uint8Array): Promise<Uint8Array> {
    const cmd = decodeCommand(bytes);
    const record: SentRecord = {
      at: this.now(),
      packet: bytes.slice(),
      counter: cmd.counter,
      type: cmd.type,
      opcodes: [],
    };
    this.sent.push(record);
    if (cmd.type !== TYPE_DIRECT_REPLY && cmd.type !== TYPE_DIRECT_NO_REPLY) {
      return Promise.reject(
        new Error(
          `FakeEV3: refusing system command type 0x${cmd.type.toString(16)} (0x${(cmd.bytecodes[0] ?? 0).toString(16)})`,
        ),
      );
    }
    if (cmd.type === TYPE_DIRECT_NO_REPLY) {
      return Promise.reject(
        new Error("FakeEV3: command sent without reply (type 0x80); every command must ask for a reply"),
      );
    }
    if (this.inFlight) {
      this.overlaps++;
      return new Promise(() => {}); // ignored by the brick: no reply, ever
    }
    this.advance();
    const globals = new Uint8Array(cmd.globals);
    let ok = true;
    try {
      this.execute(cmd.bytecodes, globals, record.opcodes);
    } catch (e) {
      ok = false;
      this.errors.push((e as Error).message);
    }
    if (this.dropCount > 0 && (!this.dropFilter || this.dropFilter(record.opcodes))) {
      this.dropCount--;
      return new Promise(() => {});
    }
    const reply = encodeReply(cmd.counter, ok, ok ? globals : []);
    this.inFlight = true;
    return new Promise((resolve) => {
      const done = () => {
        this.inFlight = false;
        resolve(reply);
      };
      if (this.replyDelayMs > 0) setTimeout(done, this.replyDelayMs);
      else queueMicrotask(done);
    });
  }

  // ------------------------------------------------------------- motors

  private isBusy(m: Motor): boolean {
    return m.speedPct !== 0;
  }

  private advance(): void {
    const t = this.now();
    const from = this.last;
    this.last = t;
    for (const m of this.motors) {
      if (m.speedPct === 0) continue;
      const end = m.until !== null ? Math.min(t, m.until) : t;
      if (!m.stalled && end > from) {
        const next = m.pos + (m.speedPct / 100) * this.rate * ((end - from) / 1000);
        if (m.target !== null && (m.speedPct > 0 ? next >= m.target : next <= m.target)) {
          m.pos = m.target;
          this.halt(m);
          continue;
        }
        m.pos = next;
      }
      if (m.until !== null && t >= m.until) this.halt(m);
    }
  }
  private halt(m: Motor): void {
    m.speedPct = 0;
    m.target = null;
    m.until = null;
  }

  private startStep(m: Motor, speed: number, degrees: number, brake: boolean): void {
    if (speed === 0) {
      this.halt(m);
      return;
    }
    m.speedPct = speed;
    m.holdBrake = brake;
    m.until = null;
    if (degrees === 0) {
      m.target = null;
      this.unboundedMoves++;
    } else m.target = m.pos + Math.sign(speed) * degrees;
  }
  private startTime(m: Motor, speed: number, ms: number, brake: boolean): void {
    if (speed === 0) {
      this.halt(m);
      return;
    }
    m.speedPct = speed;
    m.holdBrake = brake;
    m.target = null;
    if (ms === 0) {
      m.until = null;
      this.unboundedMoves++;
    } else m.until = this.now() + ms;
  }
  private masked(mask: number): Motor[] {
    if (mask < 0 || mask > 0x0f) throw new Error(`bad output mask ${mask}`);
    return this.motors.filter((_, i) => (mask & (1 << i)) !== 0);
  }
  /**
   * Sync pair, as in c_output.c: the lower port is "left". turn > 0 slows (and beyond 100
   * reverses) the higher port, turn < 0 the lower one. The full-speed motor does `amount`.
   */
  private sync(mask: number, speed: number, turn: number, amount: number, brake: boolean, byTime: boolean): void {
    const pair = this.masked(mask);
    if (pair.length !== 2) throw new Error(`sync needs exactly two motors, mask ${mask}`);
    if (turn < -200 || turn > 200) throw new Error(`turn ${turn} outside -200..200`);
    const ratio = (100 - Math.abs(turn)) / 100;
    const speeds = turn >= 0 ? [speed, speed * ratio] : [speed * ratio, speed];
    pair.forEach((m, i) => {
      if (byTime) this.startTime(m, speeds[i], amount, brake);
      else if (speeds[i] === 0) this.halt(m);
      else this.startStep(m, speeds[i], amount === 0 ? 0 : Math.abs(amount * (speeds[i] / speed)), brake);
    });
  }

  // ------------------------------------------------------------- interpreter

  private execute(b: Uint8Array, g: Uint8Array, opcodes: number[]): void {
    let at = 0;
    const num = (): number => {
      const r = readParam(b, at);
      at = r.next;
      if (r.param.kind !== "const") throw new Error(`expected a constant at ${at}`);
      return r.param.value;
    };
    const str = (): string => {
      const r = readParam(b, at);
      at = r.next;
      if (r.param.kind !== "string") throw new Error(`expected a string at ${at}`);
      return r.param.value;
    };
    const out = (size: number): number => {
      const r = readParam(b, at);
      at = r.next;
      if (r.param.kind !== "global") throw new Error(`expected a global at ${at}`);
      if (r.param.value + size > g.length)
        throw new Error(`global ${r.param.value}+${size} outside the ${g.length} bytes reserved`);
      return r.param.value;
    };
    const view = new DataView(g.buffer);
    const layer = () => {
      if (num() !== 0) throw new Error("only layer 0 exists");
    };
    const idx = (): Motor => {
      const i = num();
      if (i < 0 || i > 3) throw new Error(`bad output index ${i}`);
      return this.motors[i];
    };

    while (at < b.length) {
      const opcode = b[at++];
      opcodes.push(opcode);
      switch (opcode) {
        case OP.OUTPUT_STOP: {
          layer();
          const ms = this.masked(num());
          const brake = num() !== 0;
          for (const m of ms) {
            if (m.speedPct !== 0 && this.brakeLagMs > 0) m.spinUntil = this.now() + this.brakeLagMs;
            this.halt(m);
            m.holdBrake = brake;
          }
          break;
        }
        case OP.OUTPUT_POWER:
        case OP.OUTPUT_SPEED: {
          layer();
          this.masked(num());
          num();
          break;
        }
        case OP.OUTPUT_START: {
          layer();
          this.masked(num());
          this.unboundedMoves++;
          break;
        }
        case OP.OUTPUT_READ: {
          layer();
          const m = idx();
          const gs = out(1);
          const gt = out(4);
          view.setInt8(gs, m.speedPct === 0 && this.now() < m.spinUntil ? 1 : Math.round(m.stalled ? 0 : m.speedPct));
          view.setInt32(gt, Math.round(m.pos), true);
          break;
        }
        case OP.OUTPUT_TEST: {
          layer();
          const ms = this.masked(num());
          const at1 = out(1);
          g[at1] = ms.some((m) => this.isBusy(m)) ? 1 : 0;
          break;
        }
        case OP.OUTPUT_STEP_POWER:
        case OP.OUTPUT_STEP_SPEED: {
          layer();
          const ms = this.masked(num());
          const speed = num();
          const total = num() + num() + num();
          const brake = num() !== 0;
          for (const m of ms) this.startStep(m, speed, total, brake);
          break;
        }
        case OP.OUTPUT_TIME_POWER:
        case OP.OUTPUT_TIME_SPEED: {
          layer();
          const ms = this.masked(num());
          const speed = num();
          const total = num() + num() + num();
          const brake = num() !== 0;
          for (const m of ms) this.startTime(m, speed, total, brake);
          break;
        }
        case OP.OUTPUT_STEP_SYNC:
        case OP.OUTPUT_TIME_SYNC: {
          layer();
          const mask = num();
          const speed = num();
          const turn = num();
          const amount = num();
          const brake = num() !== 0;
          this.sync(mask, speed, turn, amount, brake, opcode === OP.OUTPUT_TIME_SYNC);
          break;
        }
        case OP.OUTPUT_CLR_COUNT: {
          layer();
          for (const m of this.masked(num())) {
            if (m.target !== null) m.target -= m.pos;
            m.pos = 0;
          }
          break;
        }
        case OP.OUTPUT_GET_COUNT: {
          layer();
          const m = idx();
          view.setInt32(out(4), Math.round(m.pos), true);
          break;
        }
        case OP.INPUT_DEVICE: {
          const sub = num();
          if (sub === SUB.INPUT_STOP_ALL) {
            layer();
            break;
          }
          if (sub === SUB.INPUT_GET_TYPEMODE) {
            layer();
            const port = num();
            const gt = out(1);
            const gm = out(1);
            if (port >= 0 && port <= 3) {
              g[gt] = this.sensors[port]?.type ?? TYPE_NONE;
              g[gm] = this.sensors[port]?.mode ?? 0;
            } else if (port >= 16 && port <= 19) {
              g[gt] = this.motors[port - 16].type;
              g[gm] = 0;
            } else throw new Error(`bad port ${port}`);
            break;
          }
          if (
            sub === SUB.INPUT_GET_FORMAT ||
            sub === SUB.INPUT_GET_FIGURES ||
            sub === SUB.INPUT_GET_SYMBOL ||
            sub === SUB.INPUT_GET_MODENAME
          ) {
            // c_input.c: every answer is about the current mode of the port's type, except GET_MODENAME's
            layer();
            const port = num();
            if (port < 0 || port > 3) throw new Error(`bad sensor port ${port}`);
            const s = this.sensors[port];
            const rows = s?.modes ?? [{ name: "" }];
            const row = s ? rows[s.mode] : undefined;
            const text = (length: number, t: string) => {
              const at = out(length);
              for (let i = 0; i < length - 1; i++) g[at + i] = i < t.length ? t.charCodeAt(i) : 0x20;
              g[at + length - 1] = 0;
            };
            if (sub === SUB.INPUT_GET_FORMAT) {
              const v = [s ? (s.byMode[s.mode] ?? []).length : 0, 0, s ? rows.length : 0, 1];
              for (const x of v) g[out(1)] = x;
            } else if (sub === SUB.INPUT_GET_FIGURES) {
              g[out(1)] = 4;
              g[out(1)] = row?.decimals ?? 0;
            } else if (sub === SUB.INPUT_GET_SYMBOL) {
              text(num(), row ? (row.symbol ?? "_") : "");
            } else {
              const mode = num();
              text(num(), s ? (rows[mode]?.name ?? "") : "");
            }
            break;
          }
          if (sub === SUB.INPUT_READY_SI || sub === SUB.INPUT_READY_RAW) {
            layer();
            const port = num();
            const type = num();
            const mode = num();
            const count = num();
            if (port < 0 || port > 3) throw new Error(`bad sensor port ${port}`);
            const s = this.sensors[port];
            if (s && type !== 0 && type !== s.type) throw new Error(`type ${type} forced on a type ${s.type} sensor`);
            if (s && mode >= 0) {
              if (s.mode !== mode) this.modeSwitches++;
              s.mode = mode;
            }
            const vals = s ? (s.byMode[s.mode] ?? []) : [];
            for (let i = 0; i < count; i++) {
              const o = out(4);
              // An empty port answers NaN (SI) / 0 (raw), as the firmware does.
              if (sub === SUB.INPUT_READY_SI) view.setFloat32(o, s ? (vals[i] ?? 0) : NaN, true);
              else view.setInt32(o, s ? Math.round(vals[i] ?? 0) : 0, true);
            }
            break;
          }
          throw new Error(`INPUT_DEVICE subcode 0x${sub.toString(16)} not simulated`);
        }
        case OP.SOUND: {
          const sub = num();
          if (sub === SUB.SOUND_BREAK) break;
          if (sub !== SUB.SOUND_TONE) throw new Error(`SOUND subcode ${sub} not simulated`);
          const volume = num();
          const hz = num() & 0xffff;
          const ms = num() & 0xffff;
          this.tones.push({ hz, ms, volume });
          break;
        }
        case OP.UI_DRAW: {
          const sub = num();
          if (sub === SUB.UI_DRAW_UPDATE) break;
          if (sub === SUB.UI_DRAW_FILLWINDOW) {
            num();
            num();
            num();
            this.lcd = [];
            break;
          }
          if (sub === SUB.UI_DRAW_SELECT_FONT) {
            num();
            break;
          }
          if (sub === SUB.UI_DRAW_TEXT) {
            num();
            num();
            num();
            this.lcd.push(str());
            break;
          }
          throw new Error(`UI_DRAW subcode 0x${sub.toString(16)} not simulated`);
        }
        case OP.UI_WRITE: {
          const sub = num();
          if (sub !== SUB.UI_WRITE_LED) throw new Error(`UI_WRITE subcode 0x${sub.toString(16)} not simulated`);
          this.led = num();
          break;
        }
        case OP.UI_BUTTON: {
          const sub = num();
          if (sub !== SUB.UI_BUTTON_PRESSED) throw new Error(`UI_BUTTON subcode 0x${sub.toString(16)} not simulated`);
          const button = num();
          g[out(1)] = this.buttonsDown.has(button) || (button === 7 && this.buttonsDown.size > 0) ? 1 : 0;
          break;
        }
        case OP.UI_READ: {
          const sub = num();
          if (sub === SUB.UI_READ_GET_VBATT) view.setFloat32(out(4), this.batteryV, true);
          else if (sub === SUB.UI_READ_GET_LBATT) g[out(1)] = this.batteryPct;
          else throw new Error(`UI_READ subcode 0x${sub.toString(16)} not simulated`);
          break;
        }
        default:
          throw new Error(`opcode 0x${opcode.toString(16)} not simulated`);
      }
    }
  }
}
