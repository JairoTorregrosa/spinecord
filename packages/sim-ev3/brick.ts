// SimBrick: a byte-level EV3 direct-command emulator behind the same Transport the real brick uses.
// It decodes real packets (packages/driver-ev3/encode.ts), runs the opcodes like the firmware (lms2012
// c_output.c / c_input.c / c_ui.c), and answers with the real reply framing and global-variable layout.
// Motors drive the 2D world physics; sensors on ports read the world's sensor model.
// Anything the emulator does not implement answers 0x04 (error), never a made-up success.
import {
  OP,
  SUB,
  SENSOR_TYPE,
  TYPE_NONE,
  TYPE_DIRECT_NO_REPLY,
  TYPE_DIRECT_REPLY,
  decodeCommand,
  encodeReply,
  readParam,
} from "../driver-ev3/encode";
import type { Transport } from "../driver-ev3/transport";
import { World, DT_MS, COLOR_RGB } from "../sim-world/world";
import type { WorldHost } from "../sim-world/world-provider";
import type { RobotProfile } from "../protocol/types";
import { parseBrickPorts, type BrickPorts, type MotorPort, type MotorType, type SensorKindName } from "./ports";

export const TYPE_LARGE_MOTOR = 7;
export const TYPE_MEDIUM_MOTOR = 8;
/** Large motor at 100 % speed, deg/s (about 170 rpm). */
export const LARGE_DEG_S = 1020;
/** Medium motor at 100 % speed, deg/s (about 260 rpm). */
export const MEDIUM_DEG_S = 1560;
/**
 * A motor released without brake keeps turning while it slows down. Here: a linear run-down that lasts this long
 * from 100 % speed (proportionally shorter from less). An approximation, to be calibrated on a real robot.
 */
export const COAST_MS_AT_100 = 200;

/** The drive wheels of the robot this brick sits in. It comes from the robot profile, never from the world file. */
export interface BrickDrivetrain {
  left: MotorPort;
  right: MotorPort;
  wheel_diameter_cm: number;
  axle_track_cm: number;
  /** 1 if positive motor rotation rolls the robot forward, -1 if the motors are mounted the other way. */
  forward_sign: 1 | -1;
}
/**
 * Builds the brick's drivetrain from a robot profile plus the ports of its motor pair (the same `pair` the EV3
 * provider is configured with). A profile without a drivetrain gives null: the twin's motors turn, the robot stays.
 */
export function drivetrainFromProfile(
  profile: RobotProfile,
  pair: { left: MotorPort; right: MotorPort },
): BrickDrivetrain | null {
  const d = profile.drivetrain;
  if (!d) return null;
  return {
    left: pair.left,
    right: pair.right,
    wheel_diameter_cm: d.wheel_diameter_cm,
    axle_track_cm: d.axle_track_cm,
    forward_sign: d.forward_sign,
  };
}
/** System reply with error: [len][counter][0x05][command][status]. */
const SYSTEM_REPLY_ERROR = 0x05;
const SYSTEM_UNKNOWN_ERROR = 0x0a;
const INPUT_CLR_ALL = 0x0a;

/** A clock you move by hand: tests and headless twins run the physics without waiting. */
export class VirtualClock {
  t = 0;
  readonly now = (): number => this.t;
  advance(ms: number): void {
    if (!(ms >= 0)) throw new Error(`VirtualClock.advance: ms must be >= 0, got ${ms}`);
    this.t += ms;
  }
}

interface Motor {
  port: MotorPort;
  plugged: MotorType | null; // null = nothing plugged in
  type: number;
  rate: number; // deg/s at 100 %
  pos: number; // tacho degrees, fractional
  speedPct: number; // signed speed while running, 0 when idle
  setPct: number; // speed/power stored by A4/A5, used by A6
  target: number | null; // stop when the tacho reaches this
  until: number | null; // stop at this brick time (ms)
  blocked: boolean; // wheel against a wall: busy, tacho frozen
  holdBrake: boolean; // end flag of the running command: true = brake, false = coast
  coastFrom: number; // deg/s (signed) when the coast began
  coastTotal: number; // ms the whole run-down takes
  coastLeft: number; // ms of run-down still to go; 0 = not coasting
}
interface Sensor {
  kind: SensorKindName;
  type: number;
  mode: number;
}

export interface SimBrickOptions {
  world: World;
  /**
   * Required, from the robot profile (see drivetrainFromProfile). null = the profile has no drivetrain:
   * every motor just turns and the robot never moves.
   */
  drivetrain: BrickDrivetrain | null;
  /** Time source in ms. Default: real time (performance.now). Pass a VirtualClock's `now` in tests. */
  now?: () => number;
  /** Delay before each reply, ms (USB round trip). Default 0: the reply resolves on the next microtask. */
  replyDelayMs?: number;
  batteryV?: number;
  batteryPct?: number;
}
export interface BrickLogEntry {
  at: number;
  counter: number;
  type: number;
  opcodes: number[];
  ok: boolean;
  error?: string;
}

export class SimBrick implements Transport, WorldHost {
  world: World;
  /** Port map of the current world (its `extensions.ev3` section). */
  ports!: BrickPorts;
  readonly drivetrain: BrickDrivetrain | null;
  batteryV: number;
  batteryPct: number;
  replyDelayMs: number;
  /** Last commands received (newest last, capped). */
  readonly log: BrickLogEntry[] = [];
  /** Why each 0x04 reply was sent. */
  readonly errors: string[] = [];
  /** Commands that arrived while a reply was pending; the firmware ignores them, so they never get a reply. */
  overlaps = 0;
  /** Motions started with no bound on the brick (A6 start, or step/time 0). */
  unboundedMoves = 0;
  lcd: string[] = [];
  led = 0;
  tones: { hz: number; ms: number; volume: number }[] = [];
  /** Brick buttons held down (1 up, 2 enter, 3 down, 4 right, 5 left, 6 back). */
  readonly buttons = new Set<number>();

  private motors!: Motor[];
  private sensors!: (Sensor | null)[];
  private readonly now: () => number;
  private last: number;
  private inFlight = false;
  private bumps = 0;
  private touchWas = false;
  private hasTouch = false;

  constructor(opts: SimBrickOptions) {
    if (!(opts?.world instanceof World))
      throw new Error("SimBrick needs a world: new SimBrick({ world: new World(parseWorld(json), seed) })");
    this.now = opts.now ?? (() => performance.now());
    this.replyDelayMs = opts.replyDelayMs ?? 0;
    this.batteryV = opts.batteryV ?? 7.9;
    this.batteryPct = opts.batteryPct ?? 85;
    this.last = this.now();
    if (opts.drivetrain === undefined)
      throw new Error(
        "SimBrick needs `drivetrain` from the robot profile (drivetrainFromProfile), or null for a robot without one",
      );
    const d = opts.drivetrain;
    if (d) {
      if (!(d.wheel_diameter_cm > 0) || !(d.axle_track_cm > 0))
        throw new Error(
          `SimBrick: drivetrain needs wheel_diameter_cm and axle_track_cm > 0, got ${d.wheel_diameter_cm} and ${d.axle_track_cm}`,
        );
      if (d.forward_sign !== 1 && d.forward_sign !== -1)
        throw new Error(`SimBrick: drivetrain.forward_sign must be 1 or -1, got ${String(d.forward_sign)}`);
      if (!"ABCD".includes(d.left) || !"ABCD".includes(d.right) || d.left === d.right)
        throw new Error(`SimBrick: drivetrain needs two different motor ports A-D, got ${d.left} and ${d.right}`);
    }
    this.drivetrain = d ? { ...d } : null;
    this.world = opts.world;
    this.plug(this.portsFor(opts.world));
  }

  /** Swap the world under the brick (all motors stop, tachos and sensors reset, like re-plugging everything). Fails, changing nothing, if the world has no valid port map. */
  setWorld(world: World): void {
    const ports = this.portsFor(world); // validate before touching anything
    this.tick();
    this.world = world;
    this.plug(ports);
  }

  /** The world's port map, checked against the drivetrain: the drive wheels need a motor on their ports. */
  private portsFor(world: World): BrickPorts {
    const ports = parseBrickPorts(world.cfg.extensions.ev3);
    if (this.drivetrain) {
      for (const side of ["left", "right"] as const) {
        const port = this.drivetrain[side];
        if (!ports.motors[port])
          throw new Error(
            `world "${world.cfg.name}" plugs no motor into port ${port}, which the robot profile uses as its ${side} wheel (extensions.ev3.motors has: ${Object.keys(ports.motors).join(", ") || "none"})`,
          );
      }
    }
    return ports;
  }

  private plug(ports: BrickPorts): void {
    this.ports = ports;
    // The physics gets the axle track from the profile's drivetrain; without one the body cannot roll.
    this.world.drive = this.drivetrain ? { axle_track_cm: this.drivetrain.axle_track_cm } : null;
    this.motors = (["A", "B", "C", "D"] as MotorPort[]).map((port) => {
      const plugged = ports.motors[port] ?? null;
      return {
        port,
        plugged,
        type: plugged === null ? TYPE_NONE : plugged === "medium" ? TYPE_MEDIUM_MOTOR : TYPE_LARGE_MOTOR,
        rate: plugged === "medium" ? MEDIUM_DEG_S : LARGE_DEG_S,
        pos: 0,
        speedPct: 0,
        setPct: 0,
        target: null,
        until: null,
        blocked: false,
        holdBrake: false,
        coastFrom: 0,
        coastTotal: 0,
        coastLeft: 0,
      };
    });
    this.sensors = (["1", "2", "3", "4"] as const).map((p) => {
      const kind = ports.sensors[p];
      return kind ? { kind, type: SENSOR_TYPE[kind], mode: 0 } : null;
    });
    this.hasTouch = this.sensors.some((s) => s?.kind === "touch");
    this.bumps = 0;
    this.touchWas = this.hasTouch && this.world.senseTouch() === 1;
    this.world.resetGyro();
  }

  /** Pulls the sensor out of an input port: the port then reads as empty (type none, NaN values), as on the firmware. */
  unplugSensor(port: 1 | 2 | 3 | 4): void {
    this.tick();
    this.sensors[port - 1] = null;
    this.hasTouch = this.sensors.some((s) => s?.kind === "touch");
  }

  // ------------------------------------------------------------- inspection (tests, viewer)
  tacho(port: MotorPort): number {
    this.tick();
    return Math.round(this.motors["ABCD".indexOf(port)]!.pos) + 0;
  }
  busy(mask = 0x0f): boolean {
    this.tick();
    return this.motors.some((m, i) => (mask & (1 << i)) !== 0 && m.speedPct !== 0);
  }
  pressButton(button: number, down = true): void {
    if (down) this.buttons.add(button);
    else this.buttons.delete(button);
  }

  /** Run the physics up to the clock's current time. The viewer calls this every frame. */
  tick(): void {
    const t = this.now();
    let dt = t - this.last;
    if (!(dt > 0)) return;
    let at = this.last;
    this.last = t;
    const turning = (): boolean => this.motors.some((m) => m.speedPct !== 0 || m.coastLeft > 0);
    if (!turning()) {
      this.world.wait(dt);
      return;
    }
    while (dt > 1e-9) {
      const h = Math.min(DT_MS, dt);
      this.substep(at, h);
      at += h;
      dt -= h;
      if (!turning()) {
        this.world.wait(dt);
        break;
      }
    }
  }

  private substep(at: number, h: number): void {
    const want = [0, 0, 0, 0];
    const dt = this.drivetrain;
    const li = dt ? "ABCD".indexOf(dt.left) : -1,
      ri = dt ? "ABCD".indexOf(dt.right) : -1;
    this.motors.forEach((m, i) => {
      if (m.speedPct === 0) {
        if (m.coastLeft <= 0) return;
        // Run-down after a command that ended without brake: speed falls linearly to zero.
        const active = Math.min(h, m.coastLeft);
        want[i] = m.coastFrom * ((m.coastLeft - active / 2) / m.coastTotal) * (active / 1000);
        m.coastLeft -= active;
        return;
      }
      const active = m.until !== null ? Math.max(0, Math.min(h, m.until - at)) : h;
      let d = (m.speedPct / 100) * m.rate * (active / 1000);
      if (m.target !== null && (m.speedPct > 0 ? m.pos + d >= m.target : m.pos + d <= m.target)) d = m.target - m.pos;
      want[i] = d;
    });
    // Only the profile's drive wheels move the robot; with no drivetrain the motors turn freely.
    const cmPerDeg = dt ? (dt.forward_sign * Math.PI * dt.wheel_diameter_cm) / 360 : 0;
    const blocked = dt
      ? this.world.stepWheels(want[li]! * cmPerDeg, want[ri]! * cmPerDeg, h)
      : (this.world.wait(h), false);
    this.motors.forEach((m, i) => {
      const wheel = i === li || i === ri;
      if (m.speedPct === 0) {
        if (wheel && blocked) m.coastLeft = 0;
        else m.pos += want[i]!;
        return;
      }
      m.blocked = wheel && blocked;
      if (!m.blocked) m.pos += want[i]!;
      // A step ends when the tacho gets there (never, if blocked); a time bound ends on time even against a wall.
      if ((m.target !== null && Math.abs(m.pos - m.target) < 1e-9) || (m.until !== null && at + h >= m.until - 1e-9))
        this.halt(m, m.holdBrake);
    });
    if (this.hasTouch) {
      const pressed = this.world.senseTouch() === 1;
      if (pressed && !this.touchWas) this.bumps++;
      this.touchWas = pressed;
    }
  }

  // ------------------------------------------------------------- transport
  send(bytes: Uint8Array): Promise<Uint8Array> {
    const cmd = decodeCommand(bytes); // garbage that cannot be framed throws: a brick would just ignore it
    const entry: BrickLogEntry = { at: this.now(), counter: cmd.counter, type: cmd.type, opcodes: [], ok: true };
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
    if (this.inFlight) {
      // The firmware handles one command at a time; one arriving before the previous reply left is dropped.
      this.overlaps++;
      entry.ok = false;
      entry.error = "ignored: arrived while the previous command was in flight";
      return new Promise(() => {});
    }
    if (cmd.type !== TYPE_DIRECT_REPLY && cmd.type !== TYPE_DIRECT_NO_REPLY) {
      // System commands (file system, firmware update) are not emulated: answer a system error.
      const why = `system command 0x${(cmd.bytecodes[0] ?? 0).toString(16)} (type 0x${cmd.type.toString(16)}) is not emulated`;
      entry.ok = false;
      entry.error = why;
      this.errors.push(why);
      if (cmd.type & 0x80) return Promise.resolve(new Uint8Array(0));
      return this.reply(
        new Uint8Array([
          5,
          0,
          cmd.counter & 0xff,
          cmd.counter >> 8,
          SYSTEM_REPLY_ERROR,
          cmd.bytecodes[0] ?? 0,
          SYSTEM_UNKNOWN_ERROR,
        ]),
      );
    }
    this.tick();
    const globals = new Uint8Array(cmd.globals);
    try {
      this.execute(cmd.bytecodes, globals, entry.opcodes);
    } catch (e) {
      entry.ok = false;
      entry.error = (e as Error).message;
      this.errors.push(entry.error);
    }
    // Type 0x80: executed, and the brick sends nothing back. Resolve with zero bytes so no caller hangs.
    if (cmd.type === TYPE_DIRECT_NO_REPLY) return Promise.resolve(new Uint8Array(0));
    return this.reply(encodeReply(cmd.counter, entry.ok, entry.ok ? globals : []));
  }

  private reply(bytes: Uint8Array): Promise<Uint8Array> {
    this.inFlight = true;
    return new Promise((resolve) => {
      const done = (): void => {
        this.inFlight = false;
        resolve(bytes);
      };
      if (this.replyDelayMs > 0) setTimeout(done, this.replyDelayMs);
      else queueMicrotask(done);
    });
  }

  // ------------------------------------------------------------- motors
  /** Ends a motor's command. brake = true stops it dead and holds; false lets it run down (unless it is blocked). */
  private halt(m: Motor, brake: boolean): void {
    if (m.speedPct === 0 && !brake) return; // already stopped or running down: releasing it changes nothing
    const speed = m.blocked ? 0 : (m.speedPct / 100) * m.rate;
    m.speedPct = 0;
    m.target = null;
    m.until = null;
    m.blocked = false;
    if (brake || speed === 0) {
      m.coastLeft = 0;
      return;
    }
    m.coastFrom = speed;
    m.coastTotal = m.coastLeft = COAST_MS_AT_100 * Math.min(1, Math.abs(speed) / m.rate);
  }
  /** A new command takes the motor over, also in the middle of a run-down. */
  private drive(m: Motor, speed: number, brake: boolean): void {
    m.speedPct = speed;
    m.holdBrake = brake;
    m.coastLeft = 0;
  }
  /** Speed in percent as OUTPUT_READ reports it: commanded while running, the run-down speed while coasting, 0 if blocked. */
  private speedNow(m: Motor): number {
    if (m.speedPct !== 0) return m.blocked ? 0 : m.speedPct;
    return m.coastLeft > 0 ? ((m.coastFrom * (m.coastLeft / m.coastTotal)) / m.rate) * 100 : 0;
  }
  private masked(mask: number): Motor[] {
    if (mask < 0 || mask > 0x0f) throw new Error(`bad output mask ${mask}`);
    return this.motors.filter((_, i) => (mask & (1 << i)) !== 0);
  }
  private pct(v: number, what: string): number {
    if (v < -100 || v > 100) throw new Error(`${what} ${v} outside -100..100`);
    return v;
  }
  private startStep(m: Motor, speed: number, degrees: number, brake: boolean): void {
    if (degrees < 0) throw new Error(`negative step ${degrees}`);
    if (speed === 0) {
      this.halt(m, true);
      return;
    }
    this.drive(m, speed, brake);
    m.until = null;
    if (degrees === 0) {
      m.target = null;
      this.unboundedMoves++;
    } else m.target = m.pos + Math.sign(speed) * degrees;
  }
  private startTime(m: Motor, speed: number, ms: number, brake: boolean): void {
    if (ms < 0) throw new Error(`negative time ${ms}`);
    if (speed === 0) {
      this.halt(m, true);
      return;
    }
    this.drive(m, speed, brake);
    m.target = null;
    if (ms === 0) {
      m.until = null;
      this.unboundedMoves++;
    } else m.until = this.last + ms;
  }
  /**
   * Synchronised pair as in c_output.c: the lower port leads. turn > 0 slows the higher port (beyond 100 it
   * reverses; 200 = same speed backwards), turn < 0 does that to the lower port. The faster motor does `amount`.
   */
  private sync(mask: number, speed: number, turn: number, amount: number, brake: boolean, byTime: boolean): void {
    const pair = this.masked(mask);
    if (pair.length !== 2) throw new Error(`sync needs exactly two motors, mask ${mask}`);
    if (turn < -200 || turn > 200) throw new Error(`turn ${turn} outside -200..200`);
    if (byTime && amount < 0) throw new Error(`negative time ${amount}`);
    // d_pwm.c: a step whose sign disagrees with the speed is flipped; the direction comes from the speed.
    if (!byTime) amount = Math.abs(amount);
    const ratio = (100 - Math.abs(turn)) / 100;
    const speeds = turn >= 0 ? [speed, speed * ratio] : [speed * ratio, speed];
    pair.forEach((m, i) => {
      const s = speeds[i]!;
      if (byTime) this.startTime(m, s, amount, brake);
      else if (s === 0) this.halt(m, true);
      else this.startStep(m, s, amount === 0 ? 0 : Math.abs(amount * (s / speed)), brake);
    });
  }

  // ------------------------------------------------------------- sensors
  /** SI values of a sensor in its current mode, as the firmware's device tables define them. */
  private sensorValues(s: Sensor): number[] {
    const w = this.world;
    switch (s.kind) {
      case "touch":
        if (s.mode === 0) return [w.senseTouch()];
        if (s.mode === 1) return [this.bumps];
        break;
      case "color": {
        if (s.mode === 0) return [w.senseReflect()];
        if (s.mode === 1) return [5]; // ambient: the sim has no room light model; a dim constant
        if (s.mode === 2) return [w.senseColorId()];
        if (s.mode === 4) return COLOR_RGB[w.senseColorId()]!.map((c) => Math.round((c / 255) * 400)); // RGB-RAW, approximate scale
        break;
      }
      case "ultrasonic": {
        if (s.mode === 0) return [w.senseUltrasonic()];
        if (s.mode === 1) return [Math.round((w.senseUltrasonic() / 2.54) * 10) / 10];
        if (s.mode === 2) return [0]; // listen: no other ultrasonic sensor in the world
        break;
      }
      case "gyro": {
        // The real EV3 gyro counts CLOCKWISE as positive. The world is counter-clockwise positive, so negate.
        if (s.mode === 0) return [-w.senseGyro() + 0];
        if (s.mode === 1) return [Math.round(-w.rate_deg_s) + 0];
        if (s.mode === 3) return [-w.senseGyro() + 0, Math.round(-w.rate_deg_s) + 0];
        break;
      }
      case "ir": {
        if (s.mode === 0) return [w.senseIrProximity()];
        if (s.mode === 1) return [0, -128, 0, -128, 0, -128, 0, -128]; // seek: no beacon in the world
        if (s.mode === 2) return [0, 0, 0, 0]; // remote: no button pressed
        break;
      }
    }
    throw new Error(`mode ${s.mode} of the ${s.kind} sensor is not emulated`);
  }
  private setMode(s: Sensor, mode: number): void {
    if (mode === s.mode) return;
    s.mode = mode;
    if (s.kind === "gyro") this.world.resetGyro(); // the real gyro re-zeroes when its mode changes
  }

  // ------------------------------------------------------------- interpreter
  private execute(b: Uint8Array, g: Uint8Array, opcodes: number[]): void {
    let at = 0;
    const num = (): number => {
      const r = readParam(b, at);
      at = r.next;
      if (r.param.kind !== "const") throw new Error(`expected a constant before offset ${at}`);
      return r.param.value;
    };
    const str = (): string => {
      const r = readParam(b, at);
      at = r.next;
      if (r.param.kind !== "string") throw new Error(`expected a string before offset ${at}`);
      return r.param.value;
    };
    const out = (size: number): number => {
      const r = readParam(b, at);
      at = r.next;
      if (r.param.kind !== "global") throw new Error(`expected a global variable before offset ${at}`);
      if (r.param.value + size > g.length)
        throw new Error(`global ${r.param.value}+${size} is outside the ${g.length} bytes reserved`);
      return r.param.value;
    };
    const view = new DataView(g.buffer);
    const layer = (): void => {
      const l = num();
      if (l !== 0) throw new Error(`layer ${l}: only layer 0 exists (no daisy chain)`);
    };
    const idx = (): Motor => {
      const i = num();
      if (i < 0 || i > 3) throw new Error(`bad output index ${i}`);
      return this.motors[i]!;
    };

    while (at < b.length) {
      const opcode = b[at++]!;
      opcodes.push(opcode);
      switch (opcode) {
        case OP.OUTPUT_STOP: {
          layer();
          const ms = this.masked(num());
          const brake = num() !== 0;
          for (const m of ms) {
            this.halt(m, brake);
            m.holdBrake = brake;
          }
          break;
        }
        case OP.OUTPUT_POWER:
        case OP.OUTPUT_SPEED: {
          layer();
          const ms = this.masked(num());
          const v = this.pct(num(), "speed");
          // Sets the level; a motor already running changes speed at once, an idle one waits for OUTPUT_START.
          for (const m of ms) {
            m.setPct = v;
            if (m.speedPct !== 0) {
              if (v === 0) this.halt(m, true);
              else m.speedPct = v;
            }
          }
          break;
        }
        case OP.OUTPUT_START: {
          layer();
          for (const m of this.masked(num())) {
            if (m.setPct === 0) continue;
            this.drive(m, m.setPct, true);
            m.target = null;
            m.until = null;
            this.unboundedMoves++;
          }
          break;
        }
        case OP.OUTPUT_READ: {
          layer();
          const m = idx();
          const gs = out(1);
          const gt = out(4);
          view.setInt8(gs, Math.round(this.speedNow(m)));
          view.setInt32(gt, Math.round(m.pos), true);
          break;
        }
        case OP.OUTPUT_TEST: {
          layer();
          const ms = this.masked(num());
          const o = out(1);
          g[o] = ms.some((m) => m.speedPct !== 0) ? 1 : 0;
          break;
        }
        case OP.OUTPUT_STEP_POWER:
        case OP.OUTPUT_STEP_SPEED: {
          layer();
          const ms = this.masked(num());
          const speed = this.pct(num(), "speed");
          const s1 = num(),
            s2 = num(),
            s3 = num();
          const brake = num() !== 0;
          if (s1 < 0 || s2 < 0 || s3 < 0) throw new Error("negative step");
          for (const m of ms) this.startStep(m, speed, s1 + s2 + s3, brake); // ramp-up and ramp-down are not modelled: constant speed over the whole step
          break;
        }
        case OP.OUTPUT_TIME_POWER:
        case OP.OUTPUT_TIME_SPEED: {
          layer();
          const ms = this.masked(num());
          const speed = this.pct(num(), "speed");
          const t1 = num(),
            t2 = num(),
            t3 = num();
          const brake = num() !== 0;
          if (t1 < 0 || t2 < 0 || t3 < 0) throw new Error("negative time");
          for (const m of ms) this.startTime(m, speed, t1 + t2 + t3, brake);
          break;
        }
        case OP.OUTPUT_STEP_SYNC:
        case OP.OUTPUT_TIME_SYNC: {
          layer();
          const mask = num();
          const speed = this.pct(num(), "speed");
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
          if (sub === INPUT_CLR_ALL) {
            // CLR_ALL: clears sensor state. Here: gyro angle back to 0 and touch bump count to 0.
            layer();
            this.bumps = 0;
            this.world.resetGyro();
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
              g[gt] = this.motors[port - 16]!.type;
              g[gm] = 0;
            } else throw new Error(`bad port ${port}`);
            break;
          }
          if (sub === SUB.INPUT_READY_SI || sub === SUB.INPUT_READY_RAW) {
            layer();
            const port = num();
            const type = num();
            const mode = num();
            const count = num();
            if (port < 0 || port > 3) throw new Error(`bad sensor port ${port}`);
            if (count < 0 || count > 8) throw new Error(`bad value count ${count}`);
            const s = this.sensors[port] ?? null;
            if (s && type !== 0 && type !== s.type)
              throw new Error(`type ${type} forced on port ${port + 1}, which holds a type ${s.type} sensor`);
            if (s && mode >= 0) this.setMode(s, mode);
            const values = s ? this.sensorValues(s) : [];
            for (let i = 0; i < count; i++) {
              const o = out(4);
              // An empty port answers NaN (SI) / 0 (raw), as the firmware does.
              if (sub === SUB.INPUT_READY_SI) view.setFloat32(o, s ? (values[i] ?? 0) : NaN, true);
              else view.setInt32(o, s ? Math.round(values[i] ?? 0) : 0, true);
            }
            break;
          }
          throw new Error(`INPUT_DEVICE subcode 0x${sub.toString(16)} is not emulated`);
        }
        case OP.SOUND: {
          const sub = num();
          if (sub === SUB.SOUND_BREAK) break;
          if (sub !== SUB.SOUND_TONE) throw new Error(`SOUND subcode 0x${sub.toString(16)} is not emulated`);
          const volume = num();
          const hz = num() & 0xffff;
          const ms = num() & 0xffff;
          this.tones.push({ hz, ms, volume });
          if (this.tones.length > 100) this.tones.shift();
          break;
        }
        case OP.UI_DRAW: {
          const sub = num();
          if (sub === SUB.UI_DRAW_UPDATE) break;
          if (sub === 0x01) {
            this.lcd = [];
            break;
          } // CLEAN
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
          if (sub === 0x12) {
            num();
            break;
          } // TOPLINE(enable)
          if (sub === SUB.UI_DRAW_TEXT) {
            num();
            num();
            num();
            this.lcd.push(str());
            break;
          }
          if (sub === 0x02) {
            num();
            num();
            num();
            break;
          } // PIXEL(color, x, y)
          if (sub === 0x04) {
            num();
            num();
            num();
            num();
            break;
          } // CIRCLE(color, x, y, r)
          if (sub === 0x03 || sub === 0x09 || sub === 0x0a) {
            num();
            num();
            num();
            num();
            num();
            break;
          } // LINE / FILLRECT / RECT
          throw new Error(`UI_DRAW subcode 0x${sub.toString(16)} is not emulated`);
        }
        case OP.UI_WRITE: {
          const sub = num();
          if (sub !== SUB.UI_WRITE_LED) throw new Error(`UI_WRITE subcode 0x${sub.toString(16)} is not emulated`);
          const pattern = num();
          if (pattern < 0 || pattern > 9) throw new Error(`bad LED pattern ${pattern}`);
          this.led = pattern;
          break;
        }
        case OP.UI_BUTTON: {
          const sub = num();
          if (sub !== SUB.UI_BUTTON_PRESSED) throw new Error(`UI_BUTTON subcode 0x${sub.toString(16)} is not emulated`);
          const button = num();
          const o = out(1);
          g[o] = (button === 7 ? this.buttons.size > 0 : this.buttons.has(button)) ? 1 : 0;
          break;
        }
        case OP.UI_READ: {
          const sub = num();
          if (sub === SUB.UI_READ_GET_VBATT) view.setFloat32(out(4), this.batteryV, true);
          else if (sub === SUB.UI_READ_GET_LBATT) g[out(1)] = this.batteryPct;
          else throw new Error(`UI_READ subcode 0x${sub.toString(16)} is not emulated`);
          break;
        }
        default:
          throw new Error(`opcode 0x${opcode.toString(16)} is not emulated`);
      }
    }
  }
}
