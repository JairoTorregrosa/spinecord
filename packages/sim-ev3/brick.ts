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
import { World, DT_MS, COLOR_RGB, DEFAULT_PUSH_N, checkDrive } from "../sim-world/world";
import type { WorldHost } from "../sim-world/world-provider";
import type { RobotProfile } from "../protocol/types";
import {
  parseBrickPorts,
  type BrickPorts,
  type MotorPort,
  type MotorType,
  type SensorKindName,
  type SensorPort,
} from "./ports";

export const TYPE_LARGE_MOTOR = 7;
export const TYPE_MEDIUM_MOTOR = 8;
/** Large motor at 100 % speed, deg/s (about 170 rpm). */
export const LARGE_DEG_S = 1020;
/**
 * Medium motor at 100 % speed, deg/s (about 260 rpm): ev3dev's max_speed of lego-ev3-m-motor. LEGO states 240-250 rpm
 * under load (https://robolab.inf.tu-dresden.de/hardware/motors).
 */
export const MEDIUM_DEG_S = 1560;
/**
 * Stall torque, N·cm: the most a motor turns against, at zero speed and full power. LEGO gives 40 for the large motor
 * and 12 for the medium (https://robolab.inf.tu-dresden.de/hardware/motors; 0.4 and 0.12 N·m); one measurement found
 * 43 for the large (https://www.eurobricks.com/forum/forums/topic/87670-ev3-large-and-medium-motors-comparison).
 * Between no load and that, the speed a motor can reach falls in a straight line (a DC motor's torque-speed line).
 */
export const LARGE_STALL_NCM = 40;
export const MEDIUM_STALL_NCM = 12;
/** Standard gravity, m/s2. */
const G = 9.81;
/**
 * The most the EV3 gyro (45505) measures, deg/s: the LEGO MINDSTORMS Education EV3 User Guide (2013) gives 440 deg/s,
 * and ev3dev's sensor table GYRO-RATE -440..440. A faster spin reads 440 (signed).
 */
export const GYRO_MAX_DEG_S = 440;
/** The fastest loop rate the twin declares: a tick is an exchange with this emulator in the same process. */
export const SIM_BRICK_LOOP_RATE_HZ = 100;
/**
 * A motor released without brake keeps turning while friction slows it down: a constant deceleration that takes
 * this long from 100 % speed (proportionally shorter from less), so about 710 deg from 100 % and 180 from 50 %.
 * An estimate, not a measurement (docs/twin-fidelity.md, scripts/twin-bench/real.json `coast_ms_100`): the
 * friction torque is the no-load current times the torque constant, 0.06 A x 0.43 N m / 1.8 A = 0.014 N m
 * (Philo's EV3 motor figures), against a shaft inertia of 0.0009-0.0014 kg m2 (Things DAQ) at 17.6 rad/s:
 * 1.1-1.7 s. The middle of that. A wheel under a robot coasts differently (more inertia, rolling friction); not
 * measured either.
 */
export const COAST_MS_AT_100 = 1400;
/**
 * Mechanical time constant of a motor: the shaft speed follows a speed or power command as a first-order lag with
 * this constant, at 63 % of the new speed after it and at 90 % after 2.3 times it (175 ms). Things DAQ measured
 * 76 ms (median of four EV3 large motors at 40-100 % input, bare shaft):
 * https://thingsdaq.org/2022/08/26/dc-motor-characterization-2-of-2/ . A load slows it (86-98 ms there with
 * 0.00023-0.00045 kg m2 on the shaft, about a 1 kg robot on small sprockets); the twin does not add a robot's
 * inertia. This is the large motor's; the medium motor has MEDIUM_MOTOR_TAU_MS.
 */
export const MOTOR_TAU_MS = 76;
/**
 * The medium motor's time constant. No measurement found (Things DAQ measured only the large motor): the large
 * motor's number, named apart so that a measurement can replace it. A lighter rotor would answer faster, and a twin
 * that answers no faster than the robot keeps a strategy from depending on a quicker response than it will get.
 */
export const MEDIUM_MOTOR_TAU_MS = 76;
/**
 * The lag reaches the commanded speed within this fraction of full speed, and from then on runs at it exactly: the
 * speed the brick reports (whole percent) is then the commanded one, and a stopping motor reads exactly 0.
 */
const SETTLE_FRACTION = 0.002;

/**
 * One motor's speed (deg/s) over `h` ms, integrated exactly so that the result does not depend on how time is cut.
 * `tauMs` is that motor's time constant (MOTOR_TAU_MS, MEDIUM_MOTOR_TAU_MS).
 *
 * `run` is the speed the command asks for. A power command (`full` absent) is the motor's own first-order lag to the
 * speed that power gives. A speed command (`full` = the speed full power reaches now, `rate` unloaded) is regulated:
 * the firmware's speed loop (lms2012 d_pwm.c, dRegulateSpeed) saturates at full power while the speed is short of
 * the setpoint, so the shaft rises along the full-power lag and holds the setpoint once there. That is why a
 * regulated start is faster than an unregulated one. Measured on ev3dev (its own speed regulator, the nearest
 * measurement there is; docs/twin-fidelity.md, hw-log rows): `run_degrees 90 @20` turned 47 deg in its first 250 ms
 * and `run_pair @25` 59-60, where a 76 ms lag to the setpoint gives 36 and 45. No stock-firmware trace was found.
 */
export function motorStep(
  v0: number,
  how: { run: number; full?: number } | "brake" | "coast",
  h: number,
  rate: number,
  tauMs: number = MOTOR_TAU_MS,
): { v: number; d: number } {
  const t = h / 1000,
    tau = tauMs / 1000,
    f = rate / (COAST_MS_AT_100 / 1000);
  if (typeof how === "object") {
    const vt = how.run,
      e0 = v0 - vt,
      eps = SETTLE_FRACTION * rate;
    if (Math.abs(e0) <= eps) return { v: vt, d: vt * t };
    if (how.full !== undefined) {
      // Saturated: the full-power lag toward vp, until it crosses vt at ts.
      const vp = -Math.sign(e0) * how.full;
      if ((vp - vt) * -Math.sign(e0) > eps) {
        const ts = tau * Math.log((v0 - vp) / (vt - vp));
        const dAt = (u: number) => vp * u + (v0 - vp) * tau * (1 - Math.exp(-u / tau));
        if (t <= ts) return { v: vp + (v0 - vp) * Math.exp(-t / tau), d: dAt(t) };
        return { v: vt, d: dAt(ts) + vt * (t - ts) };
      }
      // the setpoint is at (or past) what full power reaches: nothing to saturate toward, the plain lag
    }
    const ts = tau * Math.log(Math.abs(e0) / eps);
    if (t <= ts) {
      const e = Math.exp(-t / tau);
      return { v: vt + e0 * e, d: vt * t + e0 * tau * (1 - e) };
    }
    return { v: vt, d: vt * t + e0 * tau * (1 - eps / Math.abs(e0)) };
  }
  if (v0 === 0) return { v: 0, d: 0 };
  if (how === "coast") {
    // Friction alone.
    const s = Math.sign(v0),
      u0 = Math.abs(v0),
      ts = u0 / f,
      tt = Math.min(t, ts);
    return { v: t >= ts ? 0 : s * (u0 - f * t), d: s * (u0 * tt - (f * tt * tt) / 2) };
  }
  // Brake: the firmware holds the shaft where the brake came (lms2012 d_pwm.c, state BRAKED: BrakeMotor sets
  // Power = -TachoCnt * 400, full reverse power one degree past the stop point). The overshoot and return of that
  // hold last some tens of ms and end on the stop point: the twin skips them and stops there.
  return { v: 0, d: 0 };
}

/**
 * The drive wheels of the robot this brick sits in, as they physically are: the wheel that really rolls and the
 * track the body really turns on. The runtime plans its moves with the profile's numbers, which may be wrong; the
 * brick and the physics run on these, so calibrating the profile changes what the robot does, as on the floor.
 */
export interface BrickDrivetrain {
  left: MotorPort;
  right: MotorPort;
  wheel_diameter_cm: number;
  axle_track_cm: number;
  /** 1 if positive motor rotation rolls the robot forward, -1 if the motors are mounted the other way. */
  forward_sign: 1 | -1;
  /** Share of a turn a skid-steer base loses to its treads scrubbing sideways (World DriveGeometry). Default 0. */
  turn_scrub?: number;
  /**
   * What the robot weighs (g) and the friction coefficient of its tread on the floor, both or neither. With them
   * the drive pushes at most grip x weight, and when that is less than its motors can turn against, its wheels slip
   * and keep turning against a wall instead of stalling. Without them it pushes DEFAULT_PUSH_N and stalls at walls.
   */
  mass_g?: number;
  grip?: number;
}
/** What a twin's build says the drivetrain physically is (a robot file's `twin.drive`); each absent field is the profile's. */
export interface PhysicalDrive {
  wheel_diameter_cm?: number;
  axle_track_cm?: number;
  turn_scrub?: number;
  /** What the robot weighs (g) and how its tread grips the floor (friction coefficient): both or neither. */
  mass_g?: number;
  grip?: number;
}
/**
 * Builds the brick's drivetrain from a robot profile plus the ports of its motor pair (the same `pair` the EV3
 * provider is configured with), with `physical` (a twin's build) in place of the profile's numbers where it gives
 * them. A robot without a drivetrain or without a pair gives null: the twin's motors turn, the robot stays.
 */
export function drivetrainFromProfile(
  profile: RobotProfile,
  pair: { left: MotorPort; right: MotorPort } | undefined,
  physical: PhysicalDrive = {},
): BrickDrivetrain | null {
  const d = profile.drivetrain;
  if (!d || !pair) {
    if (Object.keys(physical).length > 0)
      throw new Error("a physical drive (twin.drive) needs a robot whose profile has a drivetrain and a pair");
    return null;
  }
  return {
    left: pair.left,
    right: pair.right,
    wheel_diameter_cm: physical.wheel_diameter_cm ?? d.wheel_diameter_cm,
    axle_track_cm: physical.axle_track_cm ?? d.axle_track_cm,
    forward_sign: d.forward_sign,
    turn_scrub: physical.turn_scrub ?? 0,
    ...(physical.mass_g === undefined ? {} : { mass_g: physical.mass_g }),
    ...(physical.grip === undefined ? {} : { grip: physical.grip }),
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
  tau: number; // time constant of its lag, ms
  pos: number; // tacho degrees, fractional
  speedPct: number; // signed commanded speed while a command runs, 0 when none does
  setPct: number; // speed/power stored by A4/A5, used by A6
  target: number | null; // stop when the tacho reaches this
  until: number | null; // stop at this brick time (ms)
  blocked: boolean; // wheel against a wall: busy, tacho frozen
  holdBrake: boolean; // end flag of the running command: true = brake, false = coast
  regulated: boolean; // the running command holds a speed (the SPEED and SYNC opcodes), not a power
  setRegulated: boolean; // the level stored by A4/A5 is a speed (A5), not a power (A4)
  vel: number; // deg/s (signed) the shaft really turns at: it lags the command and runs down after it
  braking: boolean; // with no command running: true = the brake slows it, false = it coasts
}
interface Sensor {
  kind: SensorKindName;
  type: number;
  mode: number;
  /** The sensor is still plugged in (type and mode answer) and returns no value: NaN, as the firmware does. */
  silent?: boolean;
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
/** One motor as a viewer shows it. */
export interface MotorPeek {
  port: MotorPort;
  /** What is plugged in; null = nothing. */
  type: MotorType | null;
  tacho_deg: number;
  /** Signed speed in percent, as OUTPUT_READ reports it (0 when blocked, the run-down speed while coasting). */
  speed_pct: number;
  /** A drive wheel held by a wall or obstacle: the command runs, the tacho does not move. */
  blocked: boolean;
  coasting: boolean;
}
/** One input port as a viewer shows it. */
export interface SensorPeek {
  port: SensorPort;
  /** What is plugged in; null = nothing. */
  kind: SensorKindName | null;
  mode: number;
  silent: boolean;
  /** The SI values of the current mode as the firmware gives them, but without noise; [] for an empty port. */
  values: number[];
}
/** Everything about the brick a viewer shows (see SimBrick.peek). */
export interface BrickPeek {
  motors: MotorPeek[];
  sensors: SensorPeek[];
  /** LED pattern 0..9 (UI_WRITE LED): off, green, red, orange, then the flashing and pulsing ones. */
  led: number;
  lcd: string[];
  battery_v: number;
  battery_pct: number;
  /** Buttons held down (1 up, 2 enter, 3 down, 4 right, 5 left, 6 back). */
  buttons: number[];
  /** Tones played so far: a viewer plays those after the count it saw last (the newest are in `tones`). */
  tone_count: number;
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
  /** Tones played since this brick was made; `tones` keeps only the last 100. */
  toneCount = 0;
  /** Brick buttons held down (1 up, 2 enter, 3 down, 4 right, 5 left, 6 back). */
  readonly buttons = new Set<number>();

  private motors!: Motor[];
  private sensors!: (Sensor | null)[];
  private readonly now: () => number;
  private last: number;
  private inFlight = false;
  private bumps = 0;
  /** The drive's wheels slip at a wall (its tread's traction is below what its motors turn against): see BrickDrivetrain. */
  private slips = false;
  /** Traction of the tread (N), or null when the build does not say. */
  private tractionN: number | null = null;
  /** Torque (N·cm) the last physics step put on each drive motor: a box it slides, or a tread slipping at a wall. */
  private loadNcm = 0;
  /** What the drive wheels do, for the world's event log: they turn freely, are held by a wall, or slip against one. */
  private driveState: "free" | "stalled" | "slipping" = "free";
  private slipNow = false;
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
      checkDrive({ axle_track_cm: d.axle_track_cm, turn_scrub: d.turn_scrub ?? 0 });
      if ((d.mass_g === undefined) !== (d.grip === undefined) || !((d.mass_g ?? 1) > 0 && (d.grip ?? 1) > 0))
        throw new Error(
          `SimBrick: drivetrain needs mass_g and grip both > 0, or neither, got ${d.mass_g} and ${d.grip}`,
        );
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

  private stallNcm(type: MotorType): number {
    return type === "medium" ? MEDIUM_STALL_NCM : LARGE_STALL_NCM;
  }
  private plug(ports: BrickPorts): void {
    this.ports = ports;
    // The physics gets the axle track and the scrub of the physical drivetrain; without one the body cannot roll.
    const d = this.drivetrain;
    if (d) {
      // what the drive pushes: what its tread grips with, and never more than its two motors turn against
      const stall = Math.min(...[d.left, d.right].map((p) => this.stallNcm(ports.motors[p] ?? "large")));
      const motorN = (2 * stall) / (d.wheel_diameter_cm / 2);
      this.tractionN = d.mass_g !== undefined && d.grip !== undefined ? (d.grip * d.mass_g * G) / 1000 : null;
      this.slips = this.tractionN !== null && this.tractionN < motorN;
      this.world.drive = {
        axle_track_cm: d.axle_track_cm,
        turn_scrub: d.turn_scrub ?? 0,
        push_n: Math.min(this.tractionN ?? DEFAULT_PUSH_N, motorN),
      };
    } else this.world.drive = null;
    this.loadNcm = 0;
    this.motors = (["A", "B", "C", "D"] as MotorPort[]).map((port) => {
      const plugged = ports.motors[port] ?? null;
      return {
        port,
        plugged,
        type: plugged === null ? TYPE_NONE : plugged === "medium" ? TYPE_MEDIUM_MOTOR : TYPE_LARGE_MOTOR,
        rate: plugged === "medium" ? MEDIUM_DEG_S : LARGE_DEG_S,
        tau: plugged === "medium" ? MEDIUM_MOTOR_TAU_MS : MOTOR_TAU_MS,
        pos: 0,
        speedPct: 0,
        setPct: 0,
        target: null,
        until: null,
        blocked: false,
        holdBrake: false,
        regulated: false,
        setRegulated: false,
        vel: 0,
        braking: false,
      };
    });
    this.sensors = (["1", "2", "3", "4"] as const).map((p) => {
      const kind = ports.sensors[p];
      return kind ? { kind, type: SENSOR_TYPE[kind], mode: 0 } : null;
    });
    this.hasTouch = this.sensors.some((s) => s?.kind === "touch");
    this.world.watch_echo = this.sensors.some((s) => s?.kind === "ultrasonic");
    this.driveState = "free";
    this.slipNow = false;
    this.bumps = 0;
    this.touchWas = this.hasTouch && this.world.senseTouch() === 1;
    this.world.resetGyro();
  }

  /** The sensor on an input port stops returning values (NaN) while it stays plugged in, or returns them again. */
  silenceSensor(port: 1 | 2 | 3 | 4, silent = true): void {
    this.tick();
    const s = this.sensors[port - 1];
    if (!s) throw new Error(`no sensor on input port ${port}`);
    s.silent = silent;
  }

  /** Pulls the sensor out of an input port: the port then reads as empty (type none, NaN values), as on the firmware. */
  unplugSensor(port: 1 | 2 | 3 | 4): void {
    this.tick();
    this.sensors[port - 1] = null;
    this.hasTouch = this.sensors.some((s) => s?.kind === "touch");
    this.world.watch_echo = this.sensors.some((s) => s?.kind === "ultrasonic");
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
  /** A hand turns a motor's shaft by `degrees` (a disturbance in a test, a person moving an arm): the encoder follows. */
  turnShaft(port: MotorPort, degrees: number): void {
    this.tick();
    this.motors["ABCD".indexOf(port)]!.pos += degrees;
  }
  /**
   * The brick as a viewer shows it, after running the physics up to now. Sensor values carry no noise and spend
   * nothing of the world's sensor generator, so looking never changes what the robot reads.
   */
  peek(): BrickPeek {
    this.tick();
    return {
      motors: this.motors.map((m) => ({
        port: m.port,
        type: m.plugged,
        tacho_deg: m.pos,
        speed_pct: this.speedNow(m),
        blocked: m.blocked,
        coasting: m.speedPct === 0 && m.vel !== 0 && !m.braking,
      })),
      sensors: this.sensors.map((s, i) => ({
        port: String(i + 1) as SensorPort,
        kind: s?.kind ?? null,
        mode: s?.mode ?? 0,
        silent: s?.silent === true,
        values: s && !s.silent ? this.peekValues(s) : [],
      })),
      led: this.led,
      lcd: [...this.lcd],
      battery_v: this.batteryV,
      battery_pct: this.batteryPct,
      buttons: [...this.buttons].sort((a, b) => a - b),
      tone_count: this.toneCount,
    };
  }
  /** sensorValues without noise (see peek); [] for a mode the emulator does not have. */
  private peekValues(s: Sensor): number[] {
    const w = this.world;
    switch (s.kind) {
      case "touch":
        return s.mode === 0 ? [w.senseTouch()] : s.mode === 1 ? [this.bumps] : [];
      case "color":
        if (s.mode === 0) return [Math.round(Math.min(100, Math.max(0, w.reflectSpot())))];
        if (s.mode === 1) return [5];
        if (s.mode === 2) return [w.senseColorId()];
        if (s.mode === 4) return COLOR_RGB[w.senseColorId()]!.map((c) => Math.round((c / 255) * 400));
        return [];
      case "ultrasonic":
        if (s.mode === 0) return [w.ultrasonicCm()];
        if (s.mode === 1) return [Math.round((w.ultrasonicCm() / 2.54) * 10) / 10];
        return s.mode === 2 ? [0] : [];
      case "gyro": {
        const angle = -Math.round(w.peekGyroDeg()) + 0,
          rate = Math.round(-w.gyroRateDegS()) + 0;
        return s.mode === 0 ? [angle] : s.mode === 1 ? [rate] : s.mode === 3 ? [angle, rate] : [];
      }
      case "ir":
        return s.mode === 0 ? [Math.round(w.irProximity())] : [];
    }
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
    const turning = (): boolean => this.motors.some((m) => m.speedPct !== 0 || m.vel !== 0);
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
    const want = [0, 0, 0, 0],
      vEnd = [0, 0, 0, 0],
      ends = [false, false, false, false];
    const dt = this.drivetrain;
    const li = dt ? "ABCD".indexOf(dt.left) : -1,
      ri = dt ? "ABCD".indexOf(dt.right) : -1;
    this.motors.forEach((m, i) => {
      if (m.speedPct === 0) {
        const r = motorStep(m.vel, m.braking ? "brake" : "coast", h, m.rate, m.tau);
        want[i] = r.d;
        vEnd[i] = r.v;
        return;
      }
      // A time bound can end the command inside this step: the rest of the step is its brake or run-down.
      const active = m.until !== null ? Math.max(0, Math.min(h, m.until - at)) : h;
      // a load on a drive wheel lowers the speed its motor can reach (its torque-speed line), whatever it was told
      let vt = (m.speedPct / 100) * m.rate,
        cap = m.rate;
      if ((i === li || i === ri) && this.loadNcm > 0) {
        cap = m.rate * Math.max(0, 1 - this.loadNcm / this.stallNcm(m.plugged ?? "large"));
        vt = Math.sign(vt) * Math.min(Math.abs(vt), cap);
      }
      const run = motorStep(m.vel, m.regulated ? { run: vt, full: cap } : { run: vt }, active, m.rate, m.tau);
      let d = run.d,
        v = run.v;
      if (m.until !== null && at + h >= m.until - 1e-9) {
        ends[i] = true;
        const after = motorStep(v, m.holdBrake ? "brake" : "coast", h - active, m.rate, m.tau);
        d += after.d;
        v = after.v;
      }
      // A step ends on its count: the twin lands on it exactly (CONTRACT §4 Twin).
      if (m.target !== null && (m.speedPct > 0 ? m.pos + d >= m.target : m.pos + d <= m.target)) {
        d = m.target - m.pos;
        v = 0;
        ends[i] = true;
      }
      want[i] = d;
      vEnd[i] = v;
    });
    // Only the profile's drive wheels move the robot; with no drivetrain the motors turn freely.
    const cmPerDeg = dt ? (dt.forward_sign * Math.PI * dt.wheel_diameter_cm) / 360 : 0;
    const blocked = dt
      ? this.world.stepWheels(want[li]! * cmPerDeg, want[ri]! * cmPerDeg, h)
      : (this.world.wait(h), false);
    // A tread that grips less than its motors push slips at a wall: the wheels keep turning, the body stays.
    const slipping = blocked && this.slips;
    const r = dt ? dt.wheel_diameter_cm / 2 : 0;
    this.loadNcm = ((slipping ? this.tractionN! : blocked ? 0 : this.world.last_push_n) / 2) * r;
    this.motors.forEach((m, i) => {
      const held = (i === li || i === ri) && blocked && !slipping;
      // A drive wheel held by a wall stops: its tacho counts up to where the body came to rest, then stays.
      m.pos += held ? want[i]! * this.world.last_step_fraction : want[i]!;
      m.vel = held ? 0 : vEnd[i]!;
      if (m.speedPct === 0) return;
      m.blocked = held;
      // A time bound ends on time even against a wall; a step ends on its count (never, while blocked).
      if (ends[i] && !(held && m.target !== null)) this.halt(m, m.holdBrake);
    });
    // slipping while the wheels still turn after this step (a command that ended here has stopped them)
    const turns = (i: number) => this.motors[i]!.speedPct !== 0 || this.motors[i]!.vel !== 0;
    this.slipNow = slipping && (turns(li) || turns(ri));
    this.noteDrive();
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
  /** Ends a motor's command. brake = true stops it where it is; false lets it run down (unless it is blocked). */
  private halt(m: Motor, brake: boolean): void {
    if (m.speedPct === 0 && !brake) return; // already stopped or running down: releasing it changes nothing
    if (m.blocked || brake) m.vel = 0; // a brake holds the shaft where it is (see motorStep)
    m.speedPct = 0;
    m.target = null;
    m.until = null;
    m.blocked = false;
    m.braking = brake;
    // Both drive wheels held: the body stops turning now, so a gyro reset at this instant sees a still robot.
    const d = this.drivetrain;
    if (d && this.motors["ABCD".indexOf(d.left)]!.vel === 0 && this.motors["ABCD".indexOf(d.right)]!.vel === 0) {
      this.world.rate_deg_s = 0;
      this.slipNow = false;
    }
    this.noteDrive();
  }
  /** Tells the world's event log when the drive wheels begin or end being held (stalled) or slipping. */
  private noteDrive(): void {
    const d = this.drivetrain;
    if (!d) return;
    const held = this.motors["ABCD".indexOf(d.left)]!.blocked || this.motors["ABCD".indexOf(d.right)]!.blocked;
    const now = held ? "stalled" : this.slipNow ? "slipping" : "free";
    if (now === this.driveState) return;
    if (this.driveState === "stalled") this.world.note({ kind: "stall_ended" });
    if (this.driveState === "slipping") this.world.note({ kind: "slip_ended" });
    if (now === "stalled") this.world.note({ kind: "stall_began" });
    if (now === "slipping") this.world.note({ kind: "slip_began" });
    this.driveState = now;
  }
  /** A new command takes the motor over, also in the middle of a run-down: the shaft goes on from its speed. */
  private drive(m: Motor, speed: number, brake: boolean, regulated: boolean): void {
    m.speedPct = speed;
    m.holdBrake = brake;
    m.regulated = regulated;
  }
  /** Speed in percent as OUTPUT_READ reports it: what the shaft really does (it lags the command), 0 if blocked. */
  private speedNow(m: Motor): number {
    return m.blocked ? 0 : (m.vel / m.rate) * 100;
  }
  private masked(mask: number): Motor[] {
    if (mask < 0 || mask > 0x0f) throw new Error(`bad output mask ${mask}`);
    return this.motors.filter((_, i) => (mask & (1 << i)) !== 0);
  }
  private pct(v: number, what: string): number {
    if (v < -100 || v > 100) throw new Error(`${what} ${v} outside -100..100`);
    return v;
  }
  private startStep(m: Motor, speed: number, degrees: number, brake: boolean, regulated: boolean): void {
    if (degrees < 0) throw new Error(`negative step ${degrees}`);
    if (speed === 0) {
      this.halt(m, true);
      return;
    }
    this.drive(m, speed, brake, regulated);
    m.until = null;
    if (degrees === 0) {
      m.target = null;
      this.unboundedMoves++;
    } else m.target = m.pos + Math.sign(speed) * degrees;
  }
  private startTime(m: Motor, speed: number, ms: number, brake: boolean, regulated: boolean): void {
    if (ms < 0) throw new Error(`negative time ${ms}`);
    if (speed === 0) {
      this.halt(m, true);
      return;
    }
    this.drive(m, speed, brake, regulated);
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
      // c_output.c runs a synchronised pair under speed regulation
      if (byTime) this.startTime(m, s, amount, brake, true);
      else if (s === 0) this.halt(m, true);
      else this.startStep(m, s, amount === 0 ? 0 : Math.abs(amount * (s / speed)), brake, true);
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
        // Its rate saturates at GYRO_MAX_DEG_S. (The angle a saturated gyro loses is not modelled.)
        const rate = () => Math.round(Math.max(-GYRO_MAX_DEG_S, Math.min(GYRO_MAX_DEG_S, -w.gyroRateDegS()))) + 0;
        if (s.mode === 0) return [-w.senseGyro() + 0];
        if (s.mode === 1) return [rate()];
        if (s.mode === 3) return [-w.senseGyro() + 0, rate()];
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
            m.setRegulated = opcode === OP.OUTPUT_SPEED;
            if (m.speedPct !== 0) {
              if (v === 0) this.halt(m, true);
              else {
                m.speedPct = v;
                m.regulated = m.setRegulated;
              }
            }
          }
          break;
        }
        case OP.OUTPUT_START: {
          layer();
          for (const m of this.masked(num())) {
            if (m.setPct === 0) continue;
            this.drive(m, m.setPct, true, m.setRegulated);
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
          // the ramp is the motor's own rise (motorStep), not s1 and s3
          for (const m of ms) this.startStep(m, speed, s1 + s2 + s3, brake, opcode === OP.OUTPUT_STEP_SPEED);
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
          for (const m of ms) this.startTime(m, speed, t1 + t2 + t3, brake, opcode === OP.OUTPUT_TIME_SPEED);
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
              if (sub === SUB.INPUT_READY_SI) view.setFloat32(o, s && !s.silent ? (values[i] ?? 0) : NaN, true);
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
          this.toneCount++;
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
