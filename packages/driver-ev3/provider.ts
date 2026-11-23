// Ev3Provider: the contract `Provider` (packages/protocol/types.ts, v2.1) for a stock-firmware
// EV3 behind any Transport (WebHID, FakeEV3, a simulated brick).
//
// One command() = exactly ONE operation on the brick. Motion is always bounded by TIME on the
// brick (AF time-speed, B1 time-sync; never a degree opcode, which a blocked wheel would keep busy
// forever) and lasts at most 250 ms. A degree target is a time-bounded operation that the provider
// brakes early when the encoder reaches it. The provider never chunks: the runtime does.
//
// Per output port: idle -> running -> idle. A command on a running port is rejected with `busy`.
// A running operation ends as completed | clamped | timeout | stalled, or `preempted` when its
// AbortSignal fires or stop() is called.
//
// Reads have no side effects: a sensor channel whose mode is not the current one is not read
// unless the caller names it and passes allow_mode_switch.
import { RETRYABLE, RuntimeError } from "../protocol/types";
import type {
  ChannelSpec,
  CommandResult,
  CommandSpec,
  DeviceSpec,
  ErrorCode,
  Limits,
  LoopRead,
  LoopWrite,
  Provider,
  ProviderLoop,
  Reading,
  StopReason,
  Value,
} from "../protocol/types";
import {
  DEVICE_NAMES,
  OUTPUT_MASK,
  TYPE_NONE,
  type OutputPort,
  drawFillWindow,
  drawSelectFont,
  drawText,
  drawUpdate,
  inputGetTypeMode,
  inputReadySi,
  outputClearCount,
  outputGetCount,
  outputIndex,
  outputRead,
  outputStop,
  outputTest,
  outputTimePower,
  outputTimeSpeed,
  outputTimeSync,
  readF32,
  readI32,
  readI8,
  soundTone,
  uiBatteryVolts,
  uiButtonPressed,
  uiLed,
} from "./encode";
import { Ev3Error, Ev3Link } from "./link";
import { nextPollDelay, observedRate } from "./schedule";
import type { Transport } from "./transport";

/** No motion operation lasts longer than this on the brick (CONTRACT.md 0.8). */
export const MAX_MOTION_MS = 250;
/**
 * The fastest loop rate declared for a brick over USB (the bridge page and WebHID): one tick is one packet there and
 * back. A conservative figure, not a measurement: no loop has run on a real brick (docs/hardware-log.md).
 */
export const EV3_USB_LOOP_RATE_HZ = 50;
/** An operation shorter than this is never reported as stalled: a motor may not have left rest yet. */
export const MIN_STALL_WINDOW_MS = 100;
export const LED_PATTERNS = [
  "off",
  "green",
  "red",
  "orange",
  "green_flash",
  "red_flash",
  "orange_flash",
  "green_pulse",
  "red_pulse",
  "orange_pulse",
] as const;
export const BUTTON_NAMES = ["up", "enter", "down", "right", "left", "back"] as const; // firmware ids 1..6
export const COLOR_NAMES = ["none", "black", "blue", "green", "yellow", "red", "white", "brown"] as const;

/** Facts about this brick that are not motion limits. Every field is required. */
export interface Ev3Hardware {
  /** battery.low is true under this voltage. */
  low_battery_v: number;
  /** Longest speaker tone, ms (1..32767). */
  max_tone_ms: number;
  /** Speaker volume for tone and beep, 1..100. */
  tone_volume_pct: number;
}
/** Documented example, NOT a default: a stock brick with its rechargeable battery. */
export const EXAMPLE_EV3_HARDWARE: Ev3Hardware = { low_battery_v: 6.5, max_tone_ms: 5000, tone_volume_pct: 50 };

export interface Ev3ProviderOptions {
  /** Required: the robot profile's limits (the only source of motion limits). Only these two fields are used. */
  limits: Pick<Limits, "max_speed_pct" | "max_command_ms">;
  /** Required: see Ev3Hardware. */
  hardware: Ev3Hardware;
  /** Provider id and device id prefix. Default "ev3". */
  id?: string;
  /** Ports of the synced pair `<id>.pair`. Absent: the robot has no pair, and its motors are single motors. */
  pair?: { left: OutputPort; right: OutputPort };
  /** role -> device id (from the robot profile); copied into DeviceSpec.roles. */
  roles?: Record<string, string>;
  /** Calibration: motor speed at 100 %, deg/s. Sizes the time bound of degree targets and speed_deg_s. Default 1050. */
  degPerSecAt100?: number;
  /** Reply timeout per brick command, ms. Default 300. */
  timeoutMs?: number;
  /** Reply timeout for a command that switches a sensor mode, ms. Default 1000. */
  modeSwitchTimeoutMs?: number;
  /** How long stop() waits for the motors to read speed 0 after the brake, ms. Default 300. */
  stopSettleMs?: number;
  /**
   * Shortest pause between two questions to the brick, ms. Default 10. A running operation is asked about
   * when the answer can matter (schedule.ts) and at this tick near a degree target; stop() checks at this tick.
   */
  pollMs?: number;
  /** Clock, ms. Default performance.now. A clock that does not run at real speed needs `sleep` as well. */
  now?: () => number;
  /** Waits `ms` of the same clock as `now`. Default: a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** The fastest loop rate this provider's transport carries, Hz. Default EV3_USB_LOOP_RATE_HZ. */
  loopRateHz?: number;
}

// ---------------------------------------------------------------- device catalogue

type Decode = (values: number[]) => { value: Value | null; error?: string };
interface SensorChannel {
  spec: ChannelSpec;
  mode: number;
  count: number;
  decode: Decode;
}
const num =
  (digits: number): Decode =>
  ([v]) => ({ value: Math.round(v * 10 ** digits) / 10 ** digits });
/** Negated and rounded: the EV3 gyro counts clockwise-positive, the contract is counter-clockwise-positive. */
const ccw: Decode = ([v]) => {
  const r = Math.round(v);
  return { value: r === 0 ? 0 : -r };
};
const MODE_NOTE =
  "Shares the sensor with the other channels of its mode_group: only the channels of the current mode are active. Reading another one needs a mode switch, done only when a read names that channel while the robot is idle; it takes up to ~1 s.";

const SENSOR_KINDS: Record<number, { kind: string; description: string; channels: SensorChannel[]; reset?: boolean }> =
  {
    16: {
      kind: "touch",
      description: "EV3 touch sensor (a button).",
      channels: [
        {
          mode: 0,
          count: 1,
          decode: ([v]) => ({ value: v >= 0.5 }),
          spec: { name: "pressed", type: "boolean", max_rate_hz: 20, description: "true while the button is held in." },
        },
        {
          mode: 1,
          count: 1,
          decode: num(0),
          spec: {
            name: "presses",
            type: "number",
            unit: "count",
            range: [0, 9999],
            max_rate_hz: 5,
            approx: MODE_NOTE,
            description: "Number of press-and-release bumps counted by the sensor.",
          },
        },
      ],
    },
    29: {
      kind: "color",
      description: "EV3 color sensor. Works at 0.5-2 cm from the surface.",
      channels: [
        {
          mode: 0,
          count: 1,
          decode: num(0),
          spec: {
            name: "reflected_pct",
            type: "number",
            unit: "pct",
            range: [0, 100],
            noise: 5,
            max_rate_hz: 20,
            approx: "Depends on distance and surface; calibrate on the actual floor.",
            description: "Reflected red light, 0 dark to 100 bright.",
          },
        },
        {
          mode: 1,
          count: 1,
          decode: num(0),
          spec: {
            name: "ambient_pct",
            type: "number",
            unit: "pct",
            range: [0, 100],
            noise: 5,
            max_rate_hz: 5,
            approx: MODE_NOTE,
            description: "Ambient light, 0 dark to 100 bright.",
          },
        },
        {
          mode: 2,
          count: 1,
          decode: num(0),
          spec: {
            name: "color",
            type: "number",
            range: [0, 7],
            max_rate_hz: 5,
            approx: `LEGO colors only, unreliable beyond 2 cm. ${MODE_NOTE}`,
            description: "Color id: 0 none, 1 black, 2 blue, 3 green, 4 yellow, 5 red, 6 white, 7 brown.",
          },
        },
        {
          mode: 4,
          count: 3,
          decode: (v) => ({ value: v.map((x) => Math.round(x)) }),
          spec: {
            name: "rgb",
            type: "vector",
            length: 3,
            range: [0, 1020],
            noise: 30,
            max_rate_hz: 5,
            approx: `Raw uncalibrated counts, not 0-255. ${MODE_NOTE}`,
            description: "Raw reflected red, green, blue.",
          },
        },
      ],
    },
    30: {
      kind: "ultrasonic",
      description: "EV3 ultrasonic distance sensor.",
      channels: [
        {
          mode: 0,
          count: 1,
          decode: num(1),
          spec: {
            name: "distance_cm",
            type: "number",
            unit: "cm",
            range: [3, 255],
            noise: 2,
            max_rate_hz: 20,
            approx: "About +-1 cm from 3 to 250 cm; 255 means nothing detected; soft or angled surfaces read long.",
            description: "Distance to the nearest object in front.",
          },
        },
      ],
    },
    32: {
      kind: "gyro",
      reset: true,
      description: "EV3 gyro sensor (single axis). Must be still when the brick powers it, or it drifts.",
      channels: [
        {
          mode: 0,
          count: 1,
          decode: ccw,
          spec: {
            name: "angle_deg",
            type: "number",
            unit: "deg",
            range: [-32767, 32768],
            noise: 2,
            max_rate_hz: 20,
            approx: "About +-3 deg per 90 deg turn; drifts over time.",
            description:
              "Accumulated rotation since the last reset. Positive = counter-clockwise (left) seen from above, with the sensor mounted flat, arrows up; the provider negates the sensor's native clockwise-positive value.",
          },
        },
        {
          mode: 1,
          count: 1,
          decode: ccw,
          spec: {
            name: "rate_deg_s",
            type: "number",
            unit: "deg_s",
            range: [-440, 440],
            noise: 3,
            max_rate_hz: 5,
            approx: `Switching between rate_deg_s and angle_deg resets the angle to 0. ${MODE_NOTE}`,
            description:
              "Rotation speed. Positive = counter-clockwise (left) seen from above; the provider negates the sensor's native clockwise-positive value.",
          },
        },
      ],
    },
    33: {
      kind: "infrared",
      description: "EV3 infrared sensor: proximity, beacon seeking and remote buttons (beacon channel 1).",
      channels: [
        {
          mode: 0,
          count: 1,
          decode: num(0),
          spec: {
            name: "proximity_pct",
            type: "number",
            unit: "pct",
            range: [0, 100],
            noise: 3,
            max_rate_hz: 20,
            approx:
              "Not a distance: roughly 0.7 cm per unit, depends strongly on surface color; 100 means nothing in range (~70 cm).",
            description: "Proximity of the nearest object, 0 touching to 100 far.",
          },
        },
        {
          mode: 1,
          count: 2,
          decode: ([h, d]) =>
            // native: negative = beacon to the left; the contract is counter-clockwise-positive (left = positive)
            d < 0 || d > 100 ? NO_BEACON : { value: -Math.round(h) + 0 },
          spec: {
            name: "beacon_heading",
            null_when_absent: true,
            type: "number",
            range: [-25, 25],
            noise: 2,
            max_rate_hz: 5,
            approx: `Unitless, positive = beacon to the left (counter-clockwise), 0 = straight ahead. ${MODE_NOTE}`,
            description:
              "Direction of the remote beacon (channel 1). The provider negates the sensor's native value, which is negative to the left.",
          },
        },
        {
          mode: 1,
          count: 2,
          decode: ([, d]) => (d < 0 || d > 100 ? NO_BEACON : { value: Math.round(d) }),
          spec: {
            name: "beacon_distance_pct",
            null_when_absent: true,
            type: "number",
            unit: "pct",
            range: [0, 100],
            noise: 3,
            max_rate_hz: 5,
            approx: `Relative, not centimetres. ${MODE_NOTE}`,
            description: "Closeness of the remote beacon (channel 1), 0 near to 100 far.",
          },
        },
        {
          mode: 2,
          count: 1,
          decode: num(0),
          spec: {
            name: "remote_buttons",
            type: "number",
            range: [0, 11],
            max_rate_hz: 5,
            approx: MODE_NOTE,
            description:
              "Remote button code on channel 1: 0 none, 1 red up, 2 red down, 3 blue up, 4 blue down, 5-8 two-button combinations, 9 beacon on, 10-11 same-side pairs.",
          },
        },
      ],
    },
  };
const MOTOR_TYPES: Record<number, string> = { 7: "large", 8: "medium" };
export const MODE_SWITCH_REQUIRED = "mode_switch_required";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});
const BRAKE_PARAM = {
  type: "boolean",
  default: true,
  description: "true = brake at the end; false = coast, so the next operation can follow without a jolt.",
};

type Args = Record<string, Value>;
type Got = { value: Value | null; error?: string; absent?: true };
/** What a beacon channel answers while the sensor sees no beacon: an answer of the sensor, not a failed read. */
const NO_BEACON: Got = { value: null, error: "no beacon in view on channel 1", absent: true };
interface Lookup {
  spec: DeviceSpec;
  local: string;
}

interface Operation {
  requested: Args;
  clamped: boolean;
  applied: Record<string, Value>;
  mask: number;
  /** Output indexes whose encoder deltas are reported, in order. */
  ports: number[];
  /** Index into `ports` and direction of the motor that measures progress. */
  lead: number;
  leadDir: 1 | -1;
  /** Degrees the lead motor should travel, or null for a pure time operation. */
  targetDeg: number | null;
  /** Time bound given to the brick, ms. */
  opMs: number;
  /** Degrees the lead motor is expected to cover in opMs at the commanded speed. */
  expectDeg: number;
  /** Commanded speed of the lead motor, deg/s (> 0). */
  rate: number;
  brake: boolean;
  start: number[];
  measure: (deltas: number[], positions: number[]) => Record<string, Value>;
}

const noop = () => {};
const fail = (m: string): never => {
  throw new RuntimeError("misconfigured", `Ev3Provider: ${m}`);
};
const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
const floats = (g: Uint8Array, at: number, count: number) =>
  Array.from({ length: count }, (_, i) => readF32(g, at + i * 4));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Ev3Provider implements Provider {
  readonly id: string;
  readonly backend = "ev3" as const;
  readonly link: Ev3Link;
  /**
   * Upper bound for stop() to resolve: one command already in flight (worst case a sensor mode
   * switch) + the brake + the settle window + the last speed read, each at its reply timeout.
   * A reply that does not arrive inside its timeout makes stop() reject sooner, with `timeout`.
   */
  readonly stop_worst_ms: number;
  private readonly o: {
    pair: { left: OutputPort; right: OutputPort } | undefined;
    maxSpeedPct: number;
    boundMs: number;
    hw: Ev3Hardware;
    degPerSecAt100: number;
    timeoutMs: number;
    modeSwitchTimeoutMs: number;
    stopSettleMs: number;
    pollMs: number;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
  };
  private readonly roles: Record<string, string>;
  private specs: Map<string, DeviceSpec> | null = null;
  private types: number[] = []; // ports 1-4 then A-D
  private modes: number[] = [0, 0, 0, 0]; // current mode of sensor ports 1-4
  private readonly running = new Map<number, { abort: (byStop?: boolean) => void }>(); // output index -> running operation
  private readonly stalled = [false, false, false, false];
  /** The power the latest power operation or loop refresh applies on each output, and until when (clock ms). */
  private readonly powered: { pct: number; until: number }[] = [0, 1, 2, 3].map(() => ({ pct: 0, until: 0 }));
  /** Output indexes a loop drives: claimed from its first tick to its end. */
  private readonly looped = new Set<number>();
  /** stop() or a brake preempted the loop: its ticks are refused until the runtime ends it. */
  private loopHalted = false;
  /** Counts the ends of loops: a tick started under an earlier count belongs to a loop that has ended. */
  private loopEpoch = 0;
  private readonly loopClaim = {
    abort: () => {
      this.loopHalted = true;
    },
  };
  /** CONTRACT §4: a loop on a stock brick runs on the host, one packet per tick. */
  readonly loop: ProviderLoop;
  private readonly listeners = new Set<() => void>();

  constructor(transport: Transport, opts: Ev3ProviderOptions) {
    if (!opts || typeof opts !== "object") fail("config is required: { limits, hardware }");
    if (!opts.limits || typeof opts.limits !== "object")
      fail("config.limits is required: pass the robot profile's limits (max_speed_pct, max_command_ms)");
    for (const k of ["max_speed_pct", "max_command_ms"] as const) {
      if (!positive(opts.limits[k]))
        fail(`config.limits.${k} is required and must be a number > 0, got ${JSON.stringify(opts.limits[k])}`);
    }
    if (opts.limits.max_speed_pct > 100) fail("config.limits.max_speed_pct must be 1..100");
    if (!opts.hardware || typeof opts.hardware !== "object")
      fail("config.hardware is required (low_battery_v, max_tone_ms, tone_volume_pct); see EXAMPLE_EV3_HARDWARE");
    const hw = opts.hardware;
    for (const k of ["low_battery_v", "max_tone_ms", "tone_volume_pct"] as const) {
      if (!positive(hw[k]))
        fail(`config.hardware.${k} is required and must be a number > 0, got ${JSON.stringify(hw[k])}`);
    }
    if (hw.max_tone_ms > 32767) fail("config.hardware.max_tone_ms must be 1..32767");
    if (hw.tone_volume_pct > 100) fail("config.hardware.tone_volume_pct must be 1..100");
    this.id = opts.id ?? "ev3";
    if (!/^[a-z0-9_-]+$/i.test(this.id)) fail(`id "${this.id}" must be letters, digits, _ or -`);
    this.roles = { ...opts.roles };
    this.o = {
      pair: opts.pair,
      maxSpeedPct: opts.limits.max_speed_pct,
      boundMs: Math.max(1, Math.floor(Math.min(MAX_MOTION_MS, opts.limits.max_command_ms))),
      hw: {
        low_battery_v: hw.low_battery_v,
        max_tone_ms: Math.round(hw.max_tone_ms),
        tone_volume_pct: Math.round(hw.tone_volume_pct),
      },
      degPerSecAt100: opts.degPerSecAt100 ?? 1050,
      timeoutMs: opts.timeoutMs ?? 300,
      modeSwitchTimeoutMs: opts.modeSwitchTimeoutMs ?? 1000,
      stopSettleMs: opts.stopSettleMs ?? 300,
      pollMs: opts.pollMs ?? 10,
      now: opts.now ?? (() => performance.now()),
      sleep: opts.sleep ?? sleep,
    };
    const pair: unknown = this.o.pair;
    if (pair !== undefined) {
      const { left, right } = (typeof pair === "object" && pair !== null ? pair : {}) as Record<string, unknown>;
      if (typeof left !== "string" || typeof right !== "string" || !(left in OUTPUT_MASK) || !(right in OUTPUT_MASK))
        fail("pair needs two different ports A-D");
      if (left === right) fail("pair needs two different ports A-D");
    }
    for (const k of ["degPerSecAt100", "timeoutMs", "modeSwitchTimeoutMs", "stopSettleMs", "pollMs"] as const)
      if (!positive(this.o[k])) fail(`${k} must be > 0`);
    this.stop_worst_ms = Math.ceil(
      Math.max(this.o.timeoutMs, this.o.modeSwitchTimeoutMs) +
        this.o.timeoutMs +
        this.o.stopSettleMs +
        this.o.pollMs +
        this.o.timeoutMs,
    );
    this.link = new Ev3Link(transport, { timeoutMs: this.o.timeoutMs, now: this.o.now });
    const rate = opts.loopRateHz ?? EV3_USB_LOOP_RATE_HZ;
    if (!positive(rate)) fail(`loopRateHz must be > 0, got ${JSON.stringify(rate)}`);
    this.loop = {
      runs_on: "host",
      max_rate_hz: rate,
      tick: (writes, reads, hold_ms) => this.tick(writes, reads, hold_ms),
      end: (devices) => this.endLoop(devices),
    };
  }

  /** Called when the device list or a channel's `active` flag changed (a sensor mode switch, a swapped sensor). */
  onDevicesChanged(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  private changed(): void {
    if (this.specs) this.specs = new Map(this.build().map((s) => [s.id, s]));
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  // ------------------------------------------------------------- errors

  private toRuntime(e: unknown): RuntimeError {
    if (e instanceof RuntimeError) return e;
    if (e instanceof Ev3Error) {
      const map: Record<Ev3Error["code"], ErrorCode> = {
        no_reply: "timeout",
        brick_error: "internal",
        bad_reply: "internal",
        transport: "robot_offline",
        stopped: "busy",
        bad_param: "invalid_argument",
      };
      const code = map[e.code];
      return new RuntimeError(code, `ev3 ${e.code}: ${e.message}`, RETRYABLE.includes(code));
    }
    if (e instanceof RangeError) return new RuntimeError("invalid_argument", e.message);
    return new RuntimeError("internal", `ev3: ${(e as Error)?.message ?? String(e)}`);
  }
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw this.toRuntime(e);
    }
  }

  // ------------------------------------------------------------- devices

  /** Detects what is plugged in and each sensor's current mode (99 05 on ports 1-4 and A-D). Changes nothing on the brick. */
  devices(): Promise<DeviceSpec[]> {
    return this.guard(async () => {
      const ports = [0, 1, 2, 3, 16, 17, 18, 19];
      const g = await this.link.command(
        ports.flatMap((no, i) => inputGetTypeMode(no, i * 2, i * 2 + 1)),
        16,
      );
      this.types = ports.map((_, i) => g[i * 2]);
      this.modes = [0, 1, 2, 3].map((i) => g[i * 2 + 1]);
      const specs = this.build();
      this.specs = new Map(specs.map((s) => [s.id, s]));
      return specs.map((s) => structuredClone(s));
    });
  }

  private build(): DeviceSpec[] {
    const o = this.o,
      id = this.id;
    const mk = (
      local: string,
      kind: string,
      description: string,
      channels: ChannelSpec[],
      commands: CommandSpec[],
    ): DeviceSpec => {
      const full = `${id}.${local}`;
      return {
        id: full,
        provider: id,
        kind,
        roles: Object.keys(this.roles).filter((r) => this.roles[r] === full),
        channels,
        commands,
        description,
      };
    };
    const unknown = (local: string, where: string, type: number) =>
      mk(
        local,
        "unknown",
        `Unsupported device on ${where}: EV3 type id ${type}${DEVICE_NAMES[type] ? ` (${DEVICE_NAMES[type]})` : ""}. This provider cannot read or command it.`,
        [],
        [],
      );
    const speed = {
      type: "number",
      minimum: 1,
      maximum: o.maxSpeedPct,
      description: "Speed, percent of the motor's maximum.",
    };
    const motion = { kind: "ms" as const, max: o.boundMs };
    const oneOp = `One operation, at most ${o.boundMs} ms of motion, bounded by time on the brick.`;
    const target = `${oneOp} If the target needs longer, the motor stops at the time bound with reason "timeout" and measured.time_limited true: send the rest in another command. A motor that could not turn ends with reason "stalled".`;
    const out: DeviceSpec[] = [];
    const isMotor = (p: OutputPort) => this.types[4 + outputIndex(p)] in MOTOR_TYPES;
    const POS =
      "Positive = the direction a positive speed turns the shaft (the firmware's forward). This is shaft rotation, not a heading: whether it moves the robot forward or turns it depends on how the motor is mounted.";

    for (const p of ["A", "B", "C", "D"] as OutputPort[]) {
      const type = this.types[4 + outputIndex(p)];
      if (type === TYPE_NONE) continue;
      if (!isMotor(p)) {
        out.push(unknown(p, `output port ${p}`, type));
        continue;
      }
      out.push(
        mk(
          p,
          "motor",
          `EV3 ${MOTOR_TYPES[type]} motor on output port ${p}, with a 1-degree encoder.`,
          [
            {
              name: "position_deg",
              type: "number",
              unit: "deg",
              max_rate_hz: 50,
              description: `Encoder position since power-on or the last reset_position. ${POS}`,
            },
            {
              name: "speed_deg_s",
              type: "number",
              unit: "deg_s",
              range: [-o.degPerSecAt100, o.degPerSecAt100],
              max_rate_hz: 50,
              approx: `Derived from the brick's -100..100 speed reading at ${o.degPerSecAt100} deg/s per 100 %; coarse.`,
              description: "Current rotation speed.",
            },
            {
              name: "stalled",
              type: "boolean",
              max_rate_hz: 50,
              description: "true if the last operation on this motor ended because the motor could not turn.",
            },
            {
              name: "power_pct",
              type: "number",
              unit: "pct",
              range: [-o.maxSpeedPct, o.maxSpeedPct],
              max_rate_hz: 50,
              approx:
                "The duty cycle this provider's latest power command or loop refresh applies, while it lasts; 0 otherwise. The firmware does not report it.",
              description: "The unregulated power being applied, percent; negative = backwards.",
            },
          ],
          [
            {
              name: "run_degrees",
              moves: true,
              bound: motion,
              params: obj(
                {
                  degrees: { type: "number", description: "Rotation relative to now; negative = backwards." },
                  speed_pct: speed,
                  brake: BRAKE_PARAM,
                },
                ["degrees", "speed_pct"],
              ),
              description: `Rotates toward a number of degrees and stops when the encoder reaches it. ${target} measured.degrees is the encoder change.`,
            },
            {
              name: "run_time",
              moves: true,
              bound: { ...motion, params: ["ms"] },
              params: obj(
                {
                  ms: { type: "number", minimum: 1, maximum: o.boundMs },
                  speed_pct: {
                    type: "number",
                    minimum: -o.maxSpeedPct,
                    maximum: o.maxSpeedPct,
                    description: "Signed speed; negative = backwards. Not 0.",
                  },
                  brake: BRAKE_PARAM,
                },
                ["ms", "speed_pct"],
              ),
              drives: { arg: "speed_pct", max_hold_ms: o.boundMs },
              description: `Runs for a time at a regulated speed. ${oneOp} measured.degrees is the encoder change. A loop refreshes speed_pct every tick, each refresh for the loop's hold time.`,
            },
            {
              name: "power",
              moves: true,
              bound: { ...motion, params: ["ms"] },
              params: obj(
                {
                  power_pct: {
                    type: "number",
                    minimum: -o.maxSpeedPct,
                    maximum: o.maxSpeedPct,
                    description: "Signed unregulated power (duty cycle), percent; negative = backwards. Not 0.",
                  },
                  ms: { type: "number", minimum: 1, maximum: o.boundMs },
                },
                ["power_pct", "ms"],
              ),
              drives: { arg: "power_pct", max_hold_ms: o.boundMs },
              description: `Applies unregulated power for a time, then brakes: the speed follows the load. ${oneOp} measured.degrees is the encoder change. A loop refreshes power_pct every tick, each refresh for the loop's hold time.`,
            },
            {
              name: "run_to_position",
              moves: true,
              bound: motion,
              params: obj(
                {
                  position_deg: { type: "number", description: "Target encoder position." },
                  speed_pct: speed,
                  brake: BRAKE_PARAM,
                },
                ["position_deg", "speed_pct"],
              ),
              description: `Rotates toward an absolute encoder position and stops when the encoder reaches it. ${target}`,
            },
            {
              name: "brake",
              moves: false,
              bound: { kind: "instant", max: 0 },
              params: obj({}),
              description: "Brakes this motor now and preempts an operation running on it.",
            },
            {
              name: "reset_position",
              moves: false,
              bound: { kind: "instant", max: 0 },
              params: obj({}),
              description: "Sets position_deg to 0. Rejected with busy while the motor runs.",
            },
          ],
        ),
      );
    }
    const pair = o.pair;
    if (pair && isMotor(pair.left) && isMotor(pair.right)) {
      out.push(
        mk(
          "pair",
          "motor_pair",
          `Synchronized motor pair: left = port ${pair.left}, right = port ${pair.right}.`,
          [
            {
              name: "left_deg",
              type: "number",
              unit: "deg",
              max_rate_hz: 50,
              description: `Encoder position of the left motor (port ${pair.left}). Positive = the motor's own forward direction, the same sign run_pair uses.`,
            },
            {
              name: "right_deg",
              type: "number",
              unit: "deg",
              max_rate_hz: 50,
              description: `Encoder position of the right motor (port ${pair.right}). Positive = the motor's own forward direction, the same sign run_pair uses.`,
            },
          ],
          [
            {
              name: "run_pair",
              moves: true,
              bound: motion,
              params: obj(
                {
                  left_deg: {
                    type: "number",
                    description: "Left motor rotation; positive = that motor's forward direction.",
                  },
                  right_deg: {
                    type: "number",
                    description: "Right motor rotation; positive = that motor's forward direction.",
                  },
                  speed_pct: { ...speed, description: "Speed of the motor that travels farther." },
                  brake: BRAKE_PARAM,
                },
                ["left_deg", "right_deg", "speed_pct"],
              ),
              description: `Rotates both motors toward their own signed degrees, synchronized so they finish together, and stops when the farther-travelling motor's encoder reaches its target. ${target} The speed ratio is set in 1 % steps, so the slower motor can end a few degrees off: read measured.left_deg / measured.right_deg.`,
            },
            {
              name: "brake",
              moves: true,
              bound: { kind: "instant", max: 0 },
              params: obj({}),
              description:
                "Brakes only this pair's two motors now, preempts an operation running on them, and checks that both read speed 0. Use it to end a move made of coasting (brake:false) operations. Fails with stop_unverified if a motor is still turning.",
            },
          ],
        ),
      );
    }
    for (let i = 0; i < 4; i++) {
      const type = this.types[i];
      if (type === TYPE_NONE) continue;
      const k = SENSOR_KINDS[type];
      if (!k) {
        out.push(unknown(`S${i + 1}`, `input port ${i + 1}`, type));
        continue;
      }
      out.push(
        mk(
          `S${i + 1}`,
          k.kind,
          `${k.description} Input port ${i + 1}.`,
          k.channels.map((c) => ({ ...c.spec, mode_group: `S${i + 1}`, active: c.mode === this.modes[i] })),
          k.reset
            ? [
                {
                  name: "reset",
                  moves: false,
                  bound: { kind: "instant", max: 0 },
                  params: obj({}),
                  description:
                    "Sets angle_deg to 0 by switching the sensor mode and back; afterwards angle_deg is the active channel. Keep the robot still while it runs (up to ~2 s).",
                },
              ]
            : [],
        ),
      );
    }
    const beepMs = Math.min(200, o.hw.max_tone_ms);
    out.push(
      mk(
        "speaker",
        "speaker",
        "The brick's speaker.",
        [],
        [
          {
            name: "tone",
            moves: false,
            bound: { kind: "ms", params: ["duration_ms"], max: o.hw.max_tone_ms },
            params: obj(
              {
                frequency_hz: { type: "number", minimum: 250, maximum: 10000 },
                duration_ms: { type: "number", minimum: 1, maximum: o.hw.max_tone_ms },
              },
              ["frequency_hz", "duration_ms"],
            ),
            description: "Plays a tone. Returns as soon as the brick accepts it; the sound continues for duration_ms.",
          },
          {
            name: "beep",
            moves: false,
            bound: { kind: "ms", max: beepMs },
            params: obj({}),
            description: `Plays a ${beepMs} ms beep at 1000 Hz.`,
          },
        ],
      ),
    );
    out.push(
      mk(
        "display",
        "display",
        "The brick's 178x128 monochrome LCD. Text only: 10 lines of 22 ASCII characters; accents are dropped.",
        [],
        [
          {
            name: "text",
            moves: false,
            bound: { kind: "instant", max: 0 },
            params: obj({ lines: { type: "array", items: { type: "string", maxLength: 22 }, maxItems: 10 } }, [
              "lines",
            ]),
            description: "Clears the screen and writes the lines from the top.",
          },
          {
            name: "clear",
            moves: false,
            bound: { kind: "instant", max: 0 },
            params: obj({}),
            description: "Clears the screen.",
          },
        ],
      ),
    );
    out.push(
      mk(
        "led",
        "led",
        "The light around the brick's buttons.",
        [],
        [
          {
            name: "set",
            moves: false,
            bound: { kind: "instant", max: 0 },
            params: obj({ pattern: { type: "string", enum: [...LED_PATTERNS] } }, ["pattern"]),
            description: "Sets the light color and animation.",
          },
        ],
      ),
    );
    out.push(
      mk(
        "buttons",
        "buttons",
        "The six buttons on the brick.",
        [
          {
            name: "pressed",
            type: "vector",
            max_rate_hz: 20,
            description: `Names of the buttons held down right now, out of: ${BUTTON_NAMES.join(", ")}. Empty when none.`,
          },
        ],
        [],
      ),
    );
    out.push(
      mk(
        "battery",
        "battery",
        "The brick's battery.",
        [
          {
            name: "voltage_v",
            type: "number",
            unit: "v",
            range: [0, 10],
            noise: 0.2,
            max_rate_hz: 1,
            description: "Battery voltage.",
          },
          {
            name: "low",
            type: "boolean",
            max_rate_hz: 1,
            description: `true when voltage_v is under ${o.hw.low_battery_v} V: motors lose torque and the brick may shut down.`,
          },
        ],
        [],
      ),
    );
    return out;
  }

  /** The ports behind `<id>.pair`. That device is announced only for a declared pair, so a lookup found it. */
  private pairPorts(): { left: OutputPort; right: OutputPort } {
    if (!this.o.pair) throw new RuntimeError("unknown_device", `${this.id}.pair: this robot declares no motor pair`);
    return this.o.pair;
  }

  private async lookup(device: string): Promise<Lookup> {
    if (!this.specs) await this.devices();
    const idOrRole = this.specs!.has(device) ? device : (this.roles[device] ?? device);
    const spec = this.specs!.get(idOrRole);
    if (!spec)
      throw new RuntimeError(
        "unknown_device",
        `unknown device "${device}"; devices: ${[...this.specs!.keys()].join(", ")}`,
      );
    return { spec, local: spec.id.slice(this.id.length + 1) };
  }

  // ------------------------------------------------------------- read

  /**
   * One Reading per channel, without changing anything on the brick. Reads issued together (a read of every
   * device) share one packet: see Ev3Link.read(). A channel that cannot be read has
   * value null and an error, never a default. Sensor channels of a mode other than the current one come
   * back as null + "mode_switch_required" unless they are named in `channels` AND opts.allow_mode_switch is true.
   */
  async read(device: string, channels?: string[], opts?: { allow_mode_switch?: boolean }): Promise<Reading[]> {
    const { spec, local } = await this.guard(() => this.lookup(device));
    const names = channels ?? spec.channels.map((c) => c.name);
    for (const n of names) {
      if (!spec.channels.some((c) => c.name === n)) {
        throw new RuntimeError(
          "unknown_channel",
          `device ${spec.id} has no channel "${n}"; channels: ${spec.channels.map((c) => c.name).join(", ") || "none"}`,
        );
      }
    }
    if (!names.length) return [];
    const reading = (channel: string, r: Got): Reading => {
      const out: Reading = { device: spec.id, channel, value: r.value, ts: Date.now() };
      const u = spec.channels.find((c) => c.name === channel)!.unit;
      if (u) out.unit = u;
      if (r.value === null) out.error = r.error ?? "no value";
      if (r.value === null && r.absent) out.absent = true;
      return out;
    };
    /** One brick exchange for all the channels; a failure becomes null readings. */
    const group = async (fn: () => Promise<Record<string, Got>>): Promise<Reading[]> => {
      try {
        const got = await fn();
        return names.map((c) => reading(c, got[c]));
      } catch (e) {
        const err = this.toRuntime(e);
        return names.map((c) => reading(c, { value: null, error: `${err.code}: ${err.message}` }));
      }
    };

    switch (spec.kind) {
      case "motor": {
        const i = outputIndex(local as OutputPort);
        return group(async () => {
          const g = await this.link.read((b) => outputRead(i, b + 4, b), 5);
          return {
            position_deg: { value: readI32(g, 0) },
            speed_deg_s: { value: Math.round((readI8(g, 4) / 100) * this.o.degPerSecAt100) },
            stalled: { value: this.stalled[i] },
            power_pct: { value: this.powerNow(i) },
          };
        });
      }
      case "motor_pair":
        return group(async () => {
          const pair = this.pairPorts();
          const li = outputIndex(pair.left),
            ri = outputIndex(pair.right);
          const g = await this.link.read((b) => [...outputGetCount(li, b), ...outputGetCount(ri, b + 4)], 8);
          return { left_deg: { value: readI32(g, 0) }, right_deg: { value: readI32(g, 4) } };
        });
      case "battery":
        return group(async () => {
          const v = readF32(await this.link.read(uiBatteryVolts, 4), 0);
          if (!Number.isFinite(v)) {
            const none = { value: null, error: "the brick returned no battery voltage" };
            return { voltage_v: none, low: none };
          }
          return { voltage_v: { value: Math.round(v * 100) / 100 }, low: { value: v < this.o.hw.low_battery_v } };
        });
      case "buttons":
        return group(async () => {
          const g = await this.link.read(
            (b) => BUTTON_NAMES.flatMap((_, i) => uiButtonPressed(i + 1, b + i)),
            BUTTON_NAMES.length,
          );
          return { pressed: { value: BUTTON_NAMES.filter((_, i) => g[i] !== 0) } };
        });
    }
    const port = Number(local.slice(1)) - 1;
    const allow = channels !== undefined && opts?.allow_mode_switch === true;
    return group(() => this.readSensor(port, names, allow));
  }

  private async readSensor(
    port: number,
    names: string[],
    allow: boolean,
    retried = false,
  ): Promise<Record<string, Got>> {
    const type = this.types[port];
    const kind = SENSOR_KINDS[type];
    const chan = (n: string) => kind.channels.find((c) => c.spec.name === n)!;
    const res: Record<string, Got> = {};
    const decodeInto = (ns: string[], values: number[]) => {
      for (const n of ns) {
        const mine = values.slice(0, chan(n).count);
        res[n] = mine.every(Number.isFinite)
          ? chan(n).decode(mine)
          : { value: null, error: `sensor on input port ${port + 1} returned no value (unplugged?)` };
      }
    };

    // Channels of the current mode: one exchange that also re-checks type and mode, and changes nothing
    // (READY_SI with type 0 and mode -1 keeps both).
    const current = names.filter((n) => chan(n).mode === this.modes[port]);
    if (current.length) {
      const count = Math.max(...current.map((n) => chan(n).count));
      const g = await this.link.read(
        (b) => [...inputReadySi(port, 0, -1, count, b), ...inputGetTypeMode(port, b + count * 4, b + count * 4 + 1)],
        count * 4 + 2,
      );
      const nowType = g[count * 4],
        nowMode = g[count * 4 + 1];
      if (nowType !== type) {
        for (const n of names)
          res[n] = {
            value: null,
            error: `the device on input port ${port + 1} changed (type ${type} -> ${nowType}); list the devices again`,
          };
        this.types[port] = nowType;
        this.modes[port] = nowMode;
        this.changed();
        return res;
      }
      if (nowMode !== this.modes[port]) {
        // Something else switched the sensor: trust the brick, tell the listeners, and read again once.
        this.modes[port] = nowMode;
        this.changed();
        if (!retried) return this.readSensor(port, names, allow, true);
        for (const n of names) res[n] = { value: null, error: "the sensor mode keeps changing" };
        return res;
      }
      decodeInto(current, floats(g, 0, count));
    }
    // Channels of another mode: only with an explicit request, one switch per mode, in the order asked.
    let switched = false;
    for (const n of names) {
      if (n in res) continue;
      const mode = chan(n).mode;
      if (!allow) {
        res[n] = { value: null, error: MODE_SWITCH_REQUIRED };
        continue;
      }
      const same = names.filter((m) => !(m in res) && chan(m).mode === mode);
      const count = Math.max(...same.map((m) => chan(m).count));
      try {
        const g = await this.link.command(inputReadySi(port, type, mode, count, 0), count * 4, {
          timeoutMs: this.o.modeSwitchTimeoutMs,
        });
        this.modes[port] = mode;
        switched = true;
        decodeInto(same, floats(g, 0, count));
      } catch (e) {
        const err = this.toRuntime(e);
        for (const m of same) res[m] = { value: null, error: `${err.code}: ${err.message}` };
      }
    }
    if (switched) this.changed();
    return res;
  }

  // ------------------------------------------------------------- command

  command(device: string, command: string, args: Record<string, Value>, signal: AbortSignal): Promise<CommandResult> {
    return this.guard(async () => {
      const { spec, local } = await this.lookup(device);
      const cmd = spec.commands.find((c) => c.name === command);
      if (!cmd)
        throw new RuntimeError(
          "unknown_command",
          `device ${spec.id} has no command "${command}"; commands: ${spec.commands.map((c) => c.name).join(", ") || "none"}`,
        );
      if (args === null || typeof args !== "object" || Array.isArray(args))
        throw new RuntimeError("invalid_argument", "args must be an object");
      const where = `${spec.id}.${command}`;
      for (const k of Object.keys(args)) {
        if (!(k in cmd.params.properties))
          throw new RuntimeError(
            "invalid_argument",
            `${where}: unknown argument "${k}"; allowed: ${Object.keys(cmd.params.properties).join(", ") || "none"}`,
          );
      }
      for (const k of cmd.params.required ?? []) {
        if (args[k] === undefined) throw new RuntimeError("invalid_argument", `${where}: missing argument "${k}"`);
      }
      const t0 = this.o.now();
      const done = (measured: Record<string, Value> = {}, clamped = false): CommandResult => ({
        requested: args,
        measured,
        clamped,
        reason: clamped ? "clamped" : "completed",
        ms: Math.round(this.o.now() - t0),
      });
      const preempted = (): CommandResult => ({
        requested: args,
        measured: {},
        clamped: false,
        reason: "preempted",
        ms: 0,
      });
      const o = this.o;

      switch (`${spec.kind}.${command}`) {
        case "motor.run_degrees":
        case "motor.run_to_position": {
          const port = local as OutputPort,
            i = outputIndex(port),
            mask = OUTPUT_MASK[port];
          const s = this.speed(args, where);
          const brake = this.brakeArg(args, where);
          let degrees: number;
          if (command === "run_degrees") degrees = this.number(args, "degrees", where);
          else {
            const target = this.number(args, "position_deg", where);
            this.claim([i]);
            if (signal.aborted) return preempted();
            degrees = target - readI32(await this.link.command(outputGetCount(i, 0), 4), 0);
          }
          const total = Math.abs(degrees);
          const dir = degrees < 0 ? -1 : 1;
          const rate = (s.v / 100) * o.degPerSecAt100;
          const opMs = this.timeFor(total, rate);
          return this.operate(
            {
              requested: args,
              clamped: s.clamped,
              applied: { applied_speed_pct: s.v },
              mask,
              ports: [i],
              lead: 0,
              leadDir: dir,
              targetDeg: total,
              opMs,
              expectDeg: (rate * opMs) / 1000,
              rate,
              brake,
              start: total < 0.5 ? [] : outputTimeSpeed(mask, dir * s.v, 0, opMs, 0, brake),
              measure: (d, at): Record<string, Value> =>
                command === "run_degrees" ? { degrees: d[0] } : { position_deg: at[0], degrees: d[0] },
            },
            signal,
          );
        }
        case "motor.run_time": {
          const port = local as OutputPort,
            i = outputIndex(port),
            mask = OUTPUT_MASK[port];
          const ms = this.number(args, "ms", where);
          if (ms < 1) throw new RuntimeError("invalid_argument", `${where}: ms must be >= 1, got ${ms}`);
          const opMs = Math.min(Math.round(ms), o.boundMs);
          const raw = this.number(args, "speed_pct", where);
          if (raw === 0) throw new RuntimeError("invalid_argument", `${where}: speed_pct must not be 0`);
          const v = Math.sign(raw) * Math.max(1, Math.min(o.maxSpeedPct, Math.round(Math.abs(raw))));
          const brake = this.brakeArg(args, where);
          const timeCut = Math.round(ms) > opMs,
            speedCut = Math.abs(raw) > o.maxSpeedPct;
          return this.operate(
            {
              requested: args,
              clamped: timeCut || speedCut,
              applied: { ...(timeCut ? { applied_ms: opMs } : {}), ...(speedCut ? { applied_speed_pct: v } : {}) },
              mask,
              ports: [i],
              lead: 0,
              leadDir: v < 0 ? -1 : 1,
              targetDeg: null,
              opMs,
              expectDeg: ((Math.abs(v) / 100) * o.degPerSecAt100 * opMs) / 1000,
              rate: (Math.abs(v) / 100) * o.degPerSecAt100,
              brake,
              start: outputTimeSpeed(mask, v, 0, opMs, 0, brake),
              measure: (d) => ({ degrees: d[0] }),
            },
            signal,
          );
        }
        case "motor.power": {
          const port = local as OutputPort,
            i = outputIndex(port),
            mask = OUTPUT_MASK[port];
          const ms = this.number(args, "ms", where);
          if (ms < 1) throw new RuntimeError("invalid_argument", `${where}: ms must be >= 1, got ${ms}`);
          const opMs = Math.min(Math.round(ms), o.boundMs);
          const raw = this.number(args, "power_pct", where);
          if (raw === 0) throw new RuntimeError("invalid_argument", `${where}: power_pct must not be 0`);
          const v = Math.sign(raw) * Math.max(1, Math.min(o.maxSpeedPct, Math.round(Math.abs(raw))));
          const timeCut = Math.round(ms) > opMs,
            powerCut = Math.abs(raw) > o.maxSpeedPct;
          this.claim([i]);
          this.powered[i] = { pct: v, until: o.now() + opMs };
          try {
            return await this.operate(
              {
                requested: args,
                clamped: timeCut || powerCut,
                applied: { ...(timeCut ? { applied_ms: opMs } : {}), ...(powerCut ? { applied_power_pct: v } : {}) },
                mask,
                ports: [i],
                lead: 0,
                leadDir: v < 0 ? -1 : 1,
                targetDeg: null,
                opMs,
                expectDeg: ((Math.abs(v) / 100) * o.degPerSecAt100 * opMs) / 1000,
                rate: (Math.abs(v) / 100) * o.degPerSecAt100,
                brake: true,
                start: outputTimePower(mask, v, 0, opMs, 0, true),
                measure: (d) => ({ degrees: d[0] }),
              },
              signal,
            );
          } finally {
            this.powered[i] = { pct: 0, until: 0 };
          }
        }
        case "motor.brake": {
          const i = outputIndex(local as OutputPort);
          this.running.get(i)?.abort();
          await this.link.command(outputStop(OUTPUT_MASK[local as OutputPort], true), 0, { urgent: true });
          return done();
        }
        case "motor.reset_position": {
          this.claim([outputIndex(local as OutputPort)]);
          if (signal.aborted) return preempted();
          await this.link.command(outputClearCount(OUTPUT_MASK[local as OutputPort]));
          return done();
        }
        case "motor_pair.run_pair": {
          const left = this.number(args, "left_deg", where),
            right = this.number(args, "right_deg", where);
          const s = this.speed(args, where);
          const brake = this.brakeArg(args, where);
          const pair = this.pairPorts();
          const li = outputIndex(pair.left),
            ri = outputIndex(pair.right);
          const mask = OUTPUT_MASK[pair.left] | OUTPUT_MASK[pair.right];
          // B1 (c_output.c / d_pwm.c): the master runs at `speed`, the other at speed*(100-|turn|)/100.
          // turn > 0: master = lower port; turn < 0: master = higher port.
          const leftLeads = Math.abs(left) >= Math.abs(right);
          const leadDeg = leftLeads ? left : right,
            otherDeg = leftLeads ? right : left;
          const total = Math.abs(leadDeg);
          const dir = leadDeg < 0 ? -1 : 1;
          const ratio = total === 0 ? 1 : otherDeg / leadDeg; // -1..1
          const magnitude = Math.round(100 * (1 - ratio)); // 0..200
          const leadIsLower = (leftLeads ? li : ri) < (leftLeads ? ri : li);
          const turn = leadIsLower ? magnitude : -magnitude;
          const rate = (s.v / 100) * o.degPerSecAt100;
          const opMs = this.timeFor(total, rate);
          return this.operate(
            {
              requested: args,
              clamped: s.clamped,
              applied: { applied_speed_pct: s.v },
              mask,
              ports: [li, ri],
              lead: leftLeads ? 0 : 1,
              leadDir: dir,
              targetDeg: total,
              opMs,
              expectDeg: (rate * opMs) / 1000,
              rate,
              brake,
              start: total < 0.5 ? [] : outputTimeSync(mask, dir * s.v, turn, opMs, brake),
              measure: (d) => ({ left_deg: d[0], right_deg: d[1] }),
            },
            signal,
          );
        }
        case "motor_pair.brake": {
          const pair = this.pairPorts();
          const ports = [outputIndex(pair.left), outputIndex(pair.right)];
          for (const r of new Set(ports.map((i) => this.running.get(i)))) r?.abort(true);
          const g0 = await this.link.command(
            ports.flatMap((p, i) => outputGetCount(p, i * 4)),
            8,
            { urgent: true },
          );
          if (!(await this.brakeVerified(ports)))
            throw new RuntimeError(
              "stop_unverified",
              `${where}: a motor of the pair still reads a speed ${o.stopSettleMs} ms after the brake`,
            );
          const g1 = await this.link.command(
            ports.flatMap((p, i) => outputGetCount(p, i * 4)),
            8,
          );
          return done({ left_deg: readI32(g1, 0) - readI32(g0, 0), right_deg: readI32(g1, 4) - readI32(g0, 4) });
        }
        case "gyro.reset": {
          const port = Number(local.slice(1)) - 1;
          if (signal.aborted) return preempted();
          // Stock firmware has no reset opcode for the gyro: leaving angle mode and returning zeroes it.
          const slow = { timeoutMs: o.modeSwitchTimeoutMs };
          await this.link.command(inputReadySi(port, 32, 1, 1, 0), 4, slow);
          this.modes[port] = 1;
          const v = readF32(await this.link.command(inputReadySi(port, 32, 0, 1, 0), 4, slow), 0);
          this.modes[port] = 0;
          this.changed();
          if (!Number.isFinite(v))
            throw new RuntimeError("internal", `${where}: the gyro returned no value after the reset (unplugged?)`);
          return done({ angle_deg: ccw([v]).value as number });
        }
        case "speaker.tone": {
          const hz = Math.round(this.number(args, "frequency_hz", where)),
            ms = Math.round(this.number(args, "duration_ms", where));
          if (ms < 1) throw new RuntimeError("invalid_argument", `${where}: duration_ms must be >= 1, got ${ms}`);
          const f = Math.max(250, Math.min(10000, hz)),
            d = Math.min(o.hw.max_tone_ms, ms);
          if (signal.aborted) return preempted();
          await this.link.command(soundTone(o.hw.tone_volume_pct, f, d));
          return done({ frequency_hz: f, duration_ms: d }, f !== hz || d !== ms);
        }
        case "speaker.beep": {
          const d = Math.min(200, o.hw.max_tone_ms);
          if (signal.aborted) return preempted();
          await this.link.command(soundTone(o.hw.tone_volume_pct, 1000, d));
          return done({ frequency_hz: 1000, duration_ms: d });
        }
        case "display.clear":
          if (signal.aborted) return preempted();
          await this.link.command([...drawFillWindow(0, 0, 0), ...drawUpdate()]);
          return done();
        case "display.text": {
          const lines = args.lines as unknown;
          if (!Array.isArray(lines) || lines.some((x) => typeof x !== "string"))
            throw new RuntimeError("invalid_argument", `${where}: lines must be an array of strings`);
          if (lines.length > 10)
            throw new RuntimeError("invalid_argument", `${where}: ${lines.length} lines given, the screen fits 10`);
          const ascii = (lines as string[]).map((t) =>
            t
              .normalize("NFD")
              .replace(/[̀-ͯ]/g, "")
              .replace(/[^\x20-\x7e]/g, "?"),
          );
          const long = ascii.findIndex((t) => t.length > 22);
          if (long >= 0)
            throw new RuntimeError(
              "invalid_argument",
              `${where}: line ${long + 1} has ${ascii[long].length} characters, the screen fits 22`,
            );
          const bc = [...drawFillWindow(0, 0, 0), ...drawSelectFont(1)];
          ascii.forEach((t, i) => {
            if (t) bc.push(...drawText(1, 2, 2 + i * 12, t));
          });
          if (signal.aborted) return preempted();
          await this.link.command([...bc, ...drawUpdate()]);
          return done({ lines: ascii.length });
        }
        case "led.set": {
          const p = LED_PATTERNS.indexOf(args.pattern as (typeof LED_PATTERNS)[number]);
          if (p < 0)
            throw new RuntimeError("invalid_argument", `${where}: pattern must be one of ${LED_PATTERNS.join(", ")}`);
          if (signal.aborted) return preempted();
          await this.link.command(uiLed(p));
          return done();
        }
      }
      throw new RuntimeError("unknown_command", `${where} is declared but not implemented`);
    });
  }

  private number(args: Args, key: string, where: string): number {
    const v = args[key];
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new RuntimeError("invalid_argument", `${where}: ${key} must be a finite number, got ${JSON.stringify(v)}`);
    return v;
  }
  private brakeArg(args: Args, where: string): boolean {
    if (args.brake === undefined) return true;
    if (typeof args.brake !== "boolean")
      throw new RuntimeError(
        "invalid_argument",
        `${where}: brake must be true or false, got ${JSON.stringify(args.brake)}`,
      );
    return args.brake;
  }
  private speed(args: Args, where: string): { v: number; clamped: boolean } {
    const raw = this.number(args, "speed_pct", where);
    if (raw <= 0)
      throw new RuntimeError(
        "invalid_argument",
        `${where}: speed_pct must be > 0 (direction comes from the sign of the degrees), got ${raw}`,
      );
    return { v: Math.max(1, Math.min(this.o.maxSpeedPct, Math.round(raw))), clamped: raw > this.o.maxSpeedPct };
  }
  /** Time bound for a degree target: the estimated travel time with margin, never over the motion bound. */
  private timeFor(degrees: number, rate: number): number {
    return Math.max(1, Math.min(this.o.boundMs, Math.ceil((degrees / rate) * 1000 * 1.2) + 30));
  }
  private claim(indexes: number[]): void {
    for (const i of indexes) {
      if (this.running.has(i))
        throw new RuntimeError(
          "busy",
          `an operation is already running on output port ${"ABCD"[i]}; wait for it or call stop`,
          true,
        );
    }
  }

  /** Runs one time-bounded operation and watches it: early brake at the degree target, abort, stall. */
  private async operate(op: Operation, signal: AbortSignal): Promise<CommandResult> {
    this.claim(op.ports);
    const t0 = this.o.now();
    let preempted = signal.aborted;
    let wake: () => void = noop;
    const woken = new Promise<void>((r) => {
      wake = r;
    });
    let byStop = false; // stop() brakes every port itself: the operation must not add commands to its path
    const abort = (fromStop?: unknown) => {
      preempted = true;
      byStop ||= fromStop === true;
      wake();
    };
    const entry = { abort };
    for (const i of op.ports) this.running.set(i, entry);
    signal.addEventListener("abort", abort, { once: true });
    const n = op.ports.length;
    // Positions and busy flag travel together, and with whatever else the operation has to say: the
    // start goes out behind the read of where it starts from, the early stop ahead of the read of where it ended.
    const countsBc = op.ports.flatMap((p, i) => outputGetCount(p, i * 4));
    const pollBc = [...countsBc, ...outputTest(op.mask, n * 4)];
    let at: number[] = [];
    let start: number[] = [];
    const ask = async (bc: number[], opts: { droppable?: boolean; urgent?: boolean }): Promise<boolean> => {
      const g = await this.link.command(bc, n * 4 + 1, opts);
      at = op.ports.map((_, i) => readI32(g, i * 4));
      return g[n * 4] !== 0;
    };
    const poll = (droppable: boolean) => ask(pollBc, { droppable });
    const moved = () => op.leadDir * (at[op.lead] - start[op.lead]);
    let reason: StopReason | null = null;
    let sent = false;
    /** `at` is already the operation's last word: it ended coasting, so there is no rest position to wait for. */
    let settled = false;
    try {
      try {
        if (preempted) reason = "preempted";
        else if (!op.start.length) {
          await poll(true);
          start = at.slice();
          reason = "completed"; // nothing to do: a zero-degree target
        }
        if (reason === null) {
          // One packet: where the motors are, then the time-bounded start. The packet may wait in the
          // queue: what it carries is decided when it is built. Aborted by then, it carries the read
          // alone, so a preempted motion never begins; once it is on the wire, the brake path below stands.
          let launched = false;
          const g = await this.link.command(
            () => {
              if (preempted) return countsBc;
              launched = true;
              return [...countsBc, ...op.start];
            },
            n * 4,
            { droppable: true },
          );
          start = op.ports.map((_, i) => readI32(g, i * 4));
          at = start.slice();
          sent = launched;
          if (!launched) reason = "preempted";
          const started = this.o.now();
          // The brick ends the operation by itself at opMs; past this, something is wrong with the brick.
          const giveUp = started + op.opMs + 2 * this.o.timeoutMs + 100;
          let seenAt = started;
          let rate = op.rate;
          let rateSeen = false;
          while (reason === null) {
            const wait = nextPollDelay({
              pollMs: this.o.pollMs,
              rttMs: this.link.rttMs,
              endInMs: started + op.opMs - seenAt,
              ...(op.targetDeg === null ? {} : { remainingDeg: op.targetDeg - moved(), rateDegS: rate, rateSeen }),
            });
            await Promise.race([this.o.sleep(wait - (this.o.now() - seenAt)), woken]);
            if (preempted) {
              reason = "preempted";
              break;
            }
            const before = moved();
            const busy = await poll(true);
            const t = this.o.now();
            // A motor that turns faster than its calibration says is approached at the speed it shows.
            const seen = observedRate(moved() - before, t - seenAt);
            if (seen !== null) {
              rate = Math.max(rate, seen);
              rateSeen = true;
            }
            seenAt = t;
            if (op.targetDeg !== null && moved() >= op.targetDeg) {
              // One packet: the stop, then where the motors are.
              await ask([...outputStop(op.mask, op.brake), ...pollBc], { urgent: true });
              // Coasting on: the next operation reads its own start. Braked: read once more below, at rest.
              settled = !op.brake;
              reason = "completed";
            } else if (!busy) {
              settled = !op.brake;
              // Ended at the time bound.
              // "stalled" needs a window long enough for a real motor to get going from rest.
              if (op.opMs >= MIN_STALL_WINDOW_MS && op.expectDeg >= 5 && moved() < Math.max(1, 0.1 * op.expectDeg))
                reason = "stalled";
              else reason = op.targetDeg === null || op.targetDeg - moved() < 1 ? "completed" : "timeout";
            } else if (this.o.now() > giveUp) {
              await this.link.command(outputStop(op.mask, true), 0, { urgent: true });
              throw new RuntimeError(
                "internal",
                `the motors on mask ${op.mask} were still busy ${Math.round(this.o.now() - t0)} ms into a ${op.opMs} ms operation; braked`,
              );
            }
          }
        }
      } catch (e) {
        // stop() drops this operation's queued commands: that is a preemption, not a failure.
        if (e instanceof Ev3Error && e.code === "stopped" && preempted) reason = "preempted";
        else throw e;
      }
      if (reason === "preempted" && sent && !byStop)
        await this.link.command(outputStop(op.mask, true), 0, { urgent: true });
      if (sent && !settled) await poll(false);
    } finally {
      signal.removeEventListener("abort", abort);
      for (const i of op.ports) if (this.running.get(i) === entry) this.running.delete(i);
    }
    if (reason === "preempted" && !sent)
      return { requested: op.requested, measured: {}, clamped: false, reason, ms: Math.round(this.o.now() - t0) };
    if (sent) for (const i of op.ports) this.stalled[i] = reason === "stalled";
    if (!start.length) start = at.slice();
    const measured = op.measure(
      at.map((v, i) => v - start[i]),
      at,
    );
    if (op.targetDeg !== null) measured.time_limited = reason === "timeout";
    if (reason === "completed" && op.clamped) reason = "clamped";
    return {
      requested: op.requested,
      clamped: op.clamped,
      reason: reason!,
      ms: Math.round(this.o.now() - t0),
      measured: { ...measured, ...(op.clamped ? op.applied : {}) },
    };
  }

  // ------------------------------------------------------------- loop

  /** The power applied on an output at this moment: what the latest power operation or loop refresh set, while it lasts. */
  private powerNow(i: number): number {
    const p = this.powered[i]!;
    return this.o.now() < p.until ? p.pct : 0;
  }

  /**
   * One tick of a host loop as ONE direct command: every output refresh (a timed operation of `hold_ms`, so the
   * brick ends it by itself when no refresh follows), then every input read. A refresh supersedes the operation in
   * flight on its port. A value that rounds to 0 brakes the port. The packet waits in the queue like a start does:
   * what it carries is decided when it is built, so a tick that a stop overtook carries no refresh.
   */
  private tick(writes: LoopWrite[], reads: LoopRead[], hold_ms: number): Promise<(number | null)[]> {
    const epoch = this.loopEpoch;
    const ended = () => this.loopHalted || epoch !== this.loopEpoch;
    return this.guard(async () => {
      if (ended())
        throw new RuntimeError("busy", "the loop was preempted by a stop or a brake; it takes no more ticks");
      if (!this.specs) await this.devices();
      const o = this.o;
      const hold = Math.max(1, Math.min(Math.round(hold_ms), o.boundMs));
      const refresh: { i: number; bc: number[]; power: number }[] = [];
      for (const w of writes) {
        const { spec, local } = await this.lookup(w.device);
        const cmd = spec.commands.find((c) => c.name === w.command);
        const where = `${spec.id}.${w.command}`;
        if (spec.kind !== "motor" || !cmd?.drives)
          throw new RuntimeError("unsupported", `${where}: a loop refreshes only commands that declare drives`);
        const port = local as OutputPort;
        const i = outputIndex(port),
          mask = OUTPUT_MASK[port];
        const raw = this.number(w.args, cmd.drives.arg, where);
        const v = Math.sign(raw) * Math.min(o.maxSpeedPct, Math.round(Math.abs(raw)));
        const claim = this.running.get(i);
        if (claim && claim !== this.loopClaim)
          throw new RuntimeError("busy", `an operation is already running on output port ${port}`, true);
        const brake = w.args.brake === undefined ? true : this.brakeArg(w.args, where);
        refresh.push({
          i,
          power: w.command === "power" ? v : 0,
          bc:
            v === 0
              ? outputStop(mask, true)
              : w.command === "power"
                ? outputTimePower(mask, v, 0, hold, 0, true)
                : outputTimeSpeed(mask, v, 0, hold, 0, brake),
        });
      }
      // each read: its bytecodes at a global offset, and how its bytes become a number (null = no value)
      const parts: { size: number; bc: (base: number) => number[]; value: (g: Uint8Array) => number | null }[] = [];
      for (const r of reads) parts.push(await this.loopRead(r));
      // the loop ended while this tick was being planned: it claims nothing and refreshes nothing
      if (ended()) throw new RuntimeError("busy", "the loop ended; it takes no more ticks");
      for (const r of refresh) {
        this.running.set(r.i, this.loopClaim);
        this.looped.add(r.i);
      }
      let globals = 0;
      const bases = parts.map((p) => {
        const at = globals;
        globals += p.size;
        return at;
      });
      const readBc = parts.flatMap((p, k) => p.bc(bases[k]!));
      const g = await this.link.command(
        () => (ended() ? readBc : [...refresh.flatMap((r) => r.bc), ...readBc]),
        globals,
        { droppable: true },
      );
      const until = o.now() + hold;
      if (!ended()) for (const r of refresh) this.powered[r.i] = { pct: r.power, until: r.power === 0 ? 0 : until };
      return parts.map((p, k) => p.value(g.subarray(bases[k]!, bases[k]! + p.size)));
    });
  }

  /** How one loop input is read inside a tick packet, with the decoders read() uses. */
  private async loopRead(r: LoopRead): Promise<{
    size: number;
    bc: (base: number) => number[];
    value: (g: Uint8Array) => number | null;
  }> {
    const { spec, local } = await this.lookup(r.device);
    const none = { size: 0, bc: () => [], value: () => null };
    const pick = (v: Value | null): number | null => {
      const x = Array.isArray(v) ? (r.index === undefined ? undefined : v[r.index]) : v;
      return typeof x === "boolean" ? (x ? 1 : 0) : typeof x === "number" && Number.isFinite(x) ? x : null;
    };
    if (spec.kind === "motor") {
      const i = outputIndex(local as OutputPort);
      if (r.channel === "position_deg")
        return { size: 4, bc: (b) => outputGetCount(i, b), value: (g) => readI32(g, 0) };
      if (r.channel === "speed_deg_s")
        return {
          size: 5,
          bc: (b) => outputRead(i, b + 4, b),
          value: (g) => Math.round((readI8(g, 4) / 100) * this.o.degPerSecAt100),
        };
      if (r.channel === "stalled") return { ...none, value: () => (this.stalled[i] ? 1 : 0) };
      if (r.channel === "power_pct") return { ...none, value: () => this.powerNow(i) };
      return none;
    }
    if (spec.kind === "motor_pair" && (r.channel === "left_deg" || r.channel === "right_deg")) {
      const pair = this.pairPorts();
      const i = outputIndex(r.channel === "left_deg" ? pair.left : pair.right);
      return { size: 4, bc: (b) => outputGetCount(i, b), value: (g) => readI32(g, 0) };
    }
    if (spec.kind === "battery" && (r.channel === "voltage_v" || r.channel === "low")) {
      // the decoding of read(): low is 1 under low_battery_v
      const low = r.channel === "low";
      return {
        size: 4,
        bc: uiBatteryVolts,
        value: (g) => {
          const v = readF32(g, 0);
          if (!Number.isFinite(v)) return null;
          return low ? (v < this.o.hw.low_battery_v ? 1 : 0) : Math.round(v * 100) / 100;
        },
      };
    }
    const port = /^S[1-4]$/.test(local) ? Number(local.slice(1)) - 1 : -1;
    const kind = port < 0 ? undefined : SENSOR_KINDS[this.types[port]!];
    const chan = kind?.channels.find((c) => c.spec.name === r.channel);
    // a loop never switches a mode: a channel of another mode has no value
    if (!chan || chan.mode !== this.modes[port]) return none;
    const type = this.types[port]!,
      mode = chan.mode,
      count = chan.count;
    return {
      size: count * 4 + 2,
      // the values of the current mode, and the type and mode they were read in (READY_SI keeps both)
      bc: (b) => [...inputReadySi(port, 0, -1, count, b), ...inputGetTypeMode(port, b + count * 4, b + count * 4 + 1)],
      value: (g) => {
        if (g[count * 4] !== type || g[count * 4 + 1] !== mode) {
          // another sensor, or another mode: the scan learns of it, the loop gets no value
          this.types[port] = g[count * 4]!;
          this.modes[port] = g[count * 4 + 1]!;
          this.changed();
          return null;
        }
        const values = floats(g, 0, count);
        return values.every(Number.isFinite) ? pick(chan.decode(values).value) : null;
      },
    };
  }

  /** The end of a loop: brakes every port it drove (and `devices`), ahead of the queue, and releases them. */
  private endLoop(devices: string[]): Promise<void> {
    // No refresh may follow the brake: a tick still queued goes without its refreshes, or not at all.
    this.loopEpoch++;
    this.loopHalted = true;
    this.link.dropQueued();
    return this.guard(async () => {
      const ports = new Set(this.looped);
      try {
        // a named device the scan no longer has is skipped: every port the loop refreshed is in `looped`
        for (const d of devices) {
          const found = await this.lookup(d).catch(() => null);
          if (found?.spec.kind === "motor") ports.add(outputIndex(found.local as OutputPort));
        }
        const mask = [...ports].reduce((m, i) => m | (1 << i), 0);
        if (mask) await this.link.command(outputStop(mask, true), 0, { urgent: true });
      } catch (e) {
        // dropped by a stop() that brakes every port itself: the brake is done all the same
        if (!(e instanceof Ev3Error && e.code === "stopped")) throw e;
      } finally {
        for (const i of ports) {
          this.powered[i] = { pct: 0, until: 0 };
          if (this.running.get(i) === this.loopClaim) this.running.delete(i);
        }
        this.looped.clear();
        this.loopHalted = false;
      }
    });
  }

  // ------------------------------------------------------------- stop

  /** A3 brake on the given outputs ahead of the queue, then A8/A9 until every one reads speed 0 and not busy, or the settle window ends. */
  private async brakeVerified(ports: number[]): Promise<boolean> {
    const mask = ports.reduce((m, i) => m | (1 << i), 0);
    const n = ports.length;
    // tachos first (4 bytes each), then speeds (1 byte each), then busy
    const verifyBc = [...ports.flatMap((p, i) => outputRead(p, n * 4 + i, i * 4)), ...outputTest(mask, n * 5)];
    const still = (g: Uint8Array) => g[n * 5] === 0 && ports.every((_, i) => readI8(g, n * 4 + i) === 0);
    // Other commands are held back until the verdict, so nothing gets between the brake and its
    // checks and stretches the wait: that is what makes stop_worst_ms a real bound.
    const release = this.link.hold();
    try {
      const ask = () => this.link.command(verifyBc, n * 5 + 1, { urgent: true });
      // Brake and its first check are queued together.
      const braked = this.link.command(outputStop(mask, true), 0, { urgent: true });
      let check = ask();
      check.catch(() => {});
      await braked;
      const deadline = this.o.now() + this.o.stopSettleMs;
      for (;;) {
        if (still(await check)) return true;
        if (this.o.now() >= deadline) return false;
        await this.o.sleep(this.o.pollMs); // a real pause: the shaft (or a simulated one driven by timers) needs time to stop
        check = ask();
      }
    } finally {
      release();
    }
  }

  /**
   * Brakes every output ahead of anything queued and preempts running operations. Verified = after
   * the brake every motor reads speed 0 (A8) and nothing is busy (A9), within the settle window.
   * Resolves within stop_worst_ms.
   */
  stop(): Promise<{ motors_stopped: boolean }> {
    return this.guard(async () => {
      for (const r of new Set(this.running.values())) r.abort(true);
      for (const p of this.powered) p.until = 0;
      // Everything queued goes, urgent commands of running operations included: stop brakes all ports itself.
      this.link.dropQueued(true);
      return { motors_stopped: await this.brakeVerified([0, 1, 2, 3]) };
    });
  }
}
