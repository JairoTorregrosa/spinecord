// Ev3devProvider: the contract `Provider` (packages/protocol/types.ts, v2.1) for a LEGO EV3 running
// ev3dev. It speaks JSON lines to bridge/ev3dev_bridge.py, which runs on the brick and owns the
// hardware rules: one time-bounded operation per command, no writes on reads, and a watchdog that
// brakes every motor after 1 s without a message. This file has no I/O of its own: it works over
// any LineTransport (ssh in src/ssh.ts, a local process in tests).
//
// Link: closed -> opening -> ready -> closed. Opening sends `hello` with the config; a transport
// close or 3 s without a line from the bridge moves to closed and fails every pending request with
// robot_offline. The next call opens again, until close(): a closed provider opens nothing.
//
// The provider never chunks and never retries a motion: the runtime does the first, nobody the second.
import { RETRYABLE, RuntimeError } from "../../protocol/types";
import type {
  ChannelSpec,
  CommandResult,
  CommandSpec,
  DeviceSpec,
  ErrorCode,
  Limits,
  Provider,
  Reading,
  StopReason,
  Value,
} from "../../protocol/types";

/** No motion operation lasts longer than this on the brick (CONTRACT.md 0.8). The bridge enforces the same number. */
export const MAX_MOTION_MS = 3000;
/** The bridge brakes every motor after this long without a message. Fixed in the bridge, not configurable. */
export const BRICK_WATCHDOG_MS = 1000;
/** Oldest bridge this driver talks to (its hello's `bridge`): the first one that answers `read_many`. */
export const MIN_BRIDGE_VERSION = 3;
/** How long the bridge waits for every motor to read speed 0 after a stop. */
export const BRIDGE_STOP_VERIFY_MS = 800;
export const MODE_SWITCH_REQUIRED = "mode_switch_required";
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
export const BUTTON_NAMES = ["up", "enter", "down", "right", "left", "back"] as const;

/** A duplex stream of text lines to the bridge. */
export interface LineTransport {
  /** Starts the peer. Resolves when lines can be sent; rejects if it cannot start. */
  open(): Promise<void>;
  /** Sends one line (no newline inside). Throws when the transport is not open. */
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  /** Called once per open() when the peer goes away, with the reason (for ssh: its stderr). */
  onClose(cb: (reason: string) => void): void;
  close(): Promise<void>;
}

/** Facts about this brick that are not motion limits. Every field is required. */
export interface Ev3devHardware {
  /** battery.low is true under this voltage. */
  low_battery_v: number;
  /** Longest speaker tone, ms. */
  max_tone_ms: number;
  /** Loudness of `speak`, 1..100 (espeak amplitude; 100 is its loudest). `tone` and `beep` have no volume control. */
  speech_volume_pct: number;
}
/** Documented example, NOT a default: a brick with the LEGO rechargeable battery. */
export const EXAMPLE_EV3DEV_HARDWARE: Ev3devHardware = {
  low_battery_v: 6.5,
  max_tone_ms: 5000,
  speech_volume_pct: 100,
};

export type OutputPort = "A" | "B" | "C" | "D";
export interface Ev3devProviderOptions {
  /** Required: the robot profile's limits (the only source of motion limits). Only these two fields are used. */
  limits: Pick<Limits, "max_speed_pct" | "max_command_ms">;
  /** Required: see Ev3devHardware. */
  hardware: Ev3devHardware;
  /** Provider id and device id prefix. Default "ev3", so device ids match a stock-firmware brick. */
  id?: string;
  /** Ports of the pair `<id>.pair`. Default B (left) + C (right). */
  pair?: { left: OutputPort; right: OutputPort };
  /** role -> device id (from the robot profile); copied into DeviceSpec.roles. */
  roles?: Record<string, string>;
  /**
   * Longest motion one command may cause, ms (1..MAX_MOTION_MS). Default MAX_MOTION_MS. It can be this long because the
   * brick's own watchdog brakes after BRICK_WATCHDOG_MS of silence; one long operation avoids chaining coasting chunks
   * over a slow link.
   */
  maxOpMs?: number;
  /** Heartbeat period, ms. Default 300; must stay well under BRICK_WATCHDOG_MS. */
  heartbeatMs?: number;
  /** Time allowed for opening the transport plus the bridge's hello (ssh handshake, Python start), ms. Default 20000. */
  helloTimeoutMs?: number;
  /** Reply timeout of a read or an instant command, ms. Default 2000. */
  requestTimeoutMs?: number;
  /** With no line from the bridge for this long the link counts as lost, ms. Default 3000. */
  linkSilenceMs?: number;
  /** Round-trip allowance added to the bridge's stop verification to get stop_worst_ms, ms. Default 700. */
  stopLinkMs?: number;
}

/** What the bridge reports in `hello`. Raw sysfs names are kept so a mismatch is visible. */
export interface BridgeInventory {
  bridge: string;
  python: string;
  watchdog_ms: number;
  max_op_ms: number;
  stop_verify_ms: number;
  motors: {
    port: OutputPort;
    address: string;
    driver_name: string;
    count_per_rot: number;
    max_speed: number;
    commands: string[] | null;
    stop_actions: string[] | null;
  }[];
  sensors: {
    port: number;
    address: string;
    driver_name: string;
    kind: string;
    mode: string | null;
    modes: string[] | null;
    channel_modes: Record<string, string>;
  }[];
  unknown: {
    local: string;
    class: string;
    address: string | null;
    driver_name: string | null;
    modes: string[] | null;
    error?: string;
  }[];
  ports: { address: string; status: string }[];
  capabilities: { battery: boolean; led: boolean; buttons: boolean; beep: boolean; display: boolean; speak: boolean };
  /** Text-to-speech found on the brick (`espeak` + `aplay`), or null. The limits are the bridge's. */
  speech: {
    voices: string[];
    default_voice: string;
    max_ms: number;
    max_chars: number;
    rate_wpm: { min: number; max: number; default: number };
  } | null;
  /** Why `speech` is null. */
  no_speech: string | null;
}

const ERROR_CODES: readonly ErrorCode[] = [
  "unknown_robot",
  "unknown_device",
  "unknown_channel",
  "unknown_command",
  "unsupported",
  "robot_offline",
  "busy",
  "illegal_state",
  "invalid_argument",
  "fault",
  "timeout",
  "stop_unverified",
  "stale_image",
  "internal",
  "misconfigured",
];
const err = (code: ErrorCode, message: string) => new RuntimeError(code, message, RETRYABLE.includes(code));

// ---------------------------------------------------------------- device catalogue

const MODE_NOTE =
  "Shares the sensor with the other channels of its mode_group: only the channels of the current mode are active. Reading another one needs a mode switch, done only when a read names that channel while the robot is idle; it takes about 0.1 s.";
const SENSOR_KINDS: Record<string, { description: string; channels: ChannelSpec[]; reset?: boolean }> = {
  touch: {
    description: "EV3 touch sensor (a button).",
    channels: [
      { name: "pressed", type: "boolean", max_rate_hz: 20, description: "true while the button is held in." },
      {
        name: "presses",
        type: "number",
        unit: "count",
        range: [0, 999999],
        max_rate_hz: 20,
        approx:
          "Counted by the bridge on the brick, which samples the button about 50 times a second since it started; a tap shorter than 20 ms can be missed.",
        description: "Number of press-and-release bumps since the bridge started.",
      },
    ],
  },
  color: {
    description: "EV3 color sensor. Works at 0.5-2 cm from the surface.",
    channels: [
      {
        name: "reflected_pct",
        type: "number",
        unit: "pct",
        range: [0, 100],
        max_rate_hz: 20,
        approx: `Depends on distance and surface; calibrate on the actual floor. ${MODE_NOTE}`,
        description: "Reflected red light, 0 dark to 100 bright.",
      },
      {
        name: "ambient_pct",
        type: "number",
        unit: "pct",
        range: [0, 100],
        max_rate_hz: 5,
        approx: MODE_NOTE,
        description: "Ambient light, 0 dark to 100 bright.",
      },
      {
        name: "color",
        type: "number",
        range: [0, 7],
        max_rate_hz: 5,
        approx: `LEGO colors only, unreliable beyond 2 cm. ${MODE_NOTE}`,
        description: "Color id: 0 none, 1 black, 2 blue, 3 green, 4 yellow, 5 red, 6 white, 7 brown.",
      },
      {
        name: "rgb",
        type: "vector",
        length: 3,
        range: [0, 1020],
        max_rate_hz: 5,
        approx: `Raw uncalibrated counts, not 0-255. ${MODE_NOTE}`,
        description: "Raw reflected red, green, blue.",
      },
    ],
  },
  ultrasonic: {
    description: "EV3 ultrasonic distance sensor.",
    channels: [
      {
        name: "distance_cm",
        type: "number",
        unit: "cm",
        range: [3, 255],
        max_rate_hz: 20,
        approx: "About +-1 cm from 3 to 250 cm; 255 means nothing detected; soft or angled surfaces read long.",
        description: "Distance to the nearest object in front.",
      },
    ],
  },
  gyro: {
    reset: true,
    description: "EV3 gyro sensor (single axis). Must be still when the brick powers it, or it drifts.",
    channels: [
      {
        name: "angle_deg",
        type: "number",
        unit: "deg",
        range: [-32767, 32768],
        max_rate_hz: 20,
        approx: `About +-3 deg per 90 deg turn; drifts over time. ${MODE_NOTE}`,
        description:
          "Accumulated rotation since the last reset. Positive = counter-clockwise (left) seen from above, with the sensor mounted flat, arrows up; the driver negates the sensor's native clockwise-positive value.",
      },
      {
        name: "rate_deg_s",
        type: "number",
        unit: "deg_s",
        range: [-440, 440],
        max_rate_hz: 5,
        approx: `Switching between rate and angle resets the angle to 0. ${MODE_NOTE}`,
        description:
          "Rotation speed. Positive = counter-clockwise (left) seen from above; the driver negates the sensor's native clockwise-positive value.",
      },
    ],
  },
  infrared: {
    description: "EV3 infrared sensor: proximity, beacon seeking and remote buttons (beacon channel 1).",
    channels: [
      {
        name: "proximity_pct",
        type: "number",
        unit: "pct",
        range: [0, 100],
        max_rate_hz: 20,
        approx: `Not a distance: roughly 0.7 cm per unit, depends strongly on surface color; 100 means nothing in range (~70 cm). ${MODE_NOTE}`,
        description: "Proximity of the nearest object, 0 touching to 100 far.",
      },
      {
        name: "beacon_heading",
        type: "number",
        range: [-25, 25],
        max_rate_hz: 5,
        approx: `Unitless, negative = beacon to the left. ${MODE_NOTE}`,
        description: "Direction of the remote beacon (channel 1).",
      },
      {
        name: "beacon_distance_pct",
        type: "number",
        unit: "pct",
        range: [0, 100],
        max_rate_hz: 5,
        approx: `Relative, not centimetres. ${MODE_NOTE}`,
        description: "Closeness of the remote beacon (channel 1), 0 near to 100 far.",
      },
      {
        name: "remote_buttons",
        type: "number",
        range: [0, 11],
        max_rate_hz: 5,
        approx: MODE_NOTE,
        description:
          "Remote button code on channel 1: 0 none, 1 red up, 2 red down, 3 blue up, 4 blue down, 5-8 two-button combinations, 9 beacon on, 10-11 same-side pairs.",
      },
    ],
  },
};
const MOTOR_SIZES: Record<string, string> = { "lego-ev3-l-motor": "large", "lego-ev3-m-motor": "medium" };
const BRAKE_PARAM = {
  type: "boolean",
  default: true,
  description:
    "true = brake at the end; false = coast, so the next operation can follow without a jolt. After a coasting operation the motor is still turning when the command returns: measured is the encoder change at that moment, and the motor rolls on (tens of degrees at speed) until the next operation or a brake. The next operation starts from wherever the motor then is.",
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

const fail = (m: string): never => {
  throw new RuntimeError("misconfigured", `Ev3devProvider: ${m}`);
};
const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
const missing = (what: string) => ` Not found on this brick (${what}): it answers with an error.`;

/** An error line of the bridge as a contract error; a code the contract does not know is `internal`. */
const bridgeError = (code: unknown, message: unknown): RuntimeError =>
  err(
    ERROR_CODES.includes(code as ErrorCode) ? (code as ErrorCode) : "internal",
    `ev3dev: ${String(message ?? "the bridge reported an error without a message")}`,
  );

type LinkState = "closed" | "opening" | "ready";
interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface Lookup {
  spec: DeviceSpec;
  local: string;
}
/** What the bridge answers to one read, alone or inside read_many. */
interface ReadReply {
  readings?: { channel: string; value: Value | null; error?: string }[];
  mode?: unknown;
}
/** A read waiting to leave with the others of the same turn. */
interface QueuedRead {
  device: string;
  channels: string[];
  resolve: (r: ReadReply) => void;
  reject: (e: Error) => void;
}

export class Ev3devProvider implements Provider {
  readonly id: string;
  /** The contract has no ev3dev backend value; this is an EV3 brick, so it reports "ev3". */
  readonly backend = "ev3" as const;
  /** Upper bound for stop() to resolve: the bridge's verification window plus a link round trip. */
  readonly stop_worst_ms: number;
  private readonly o: {
    pair: { left: OutputPort; right: OutputPort };
    maxSpeedPct: number;
    boundMs: number;
    hw: Ev3devHardware;
    heartbeatMs: number;
    helloTimeoutMs: number;
    requestTimeoutMs: number;
    linkSilenceMs: number;
  };
  private readonly roles: Record<string, string>;
  private state: LinkState = "closed";
  /** Why the link is down, in words a caller can act on; null while it is up or has never been opened. */
  private closedWhy: string | null = null;
  private opening: Promise<void> | null = null;
  private ended = false; // close() was called: this provider opens no link again
  private fresh = false; // the inventory comes from the hello that just opened the link
  private inv: BridgeInventory | null = null;
  private specs: Map<string, DeviceSpec> | null = null;
  private readonly modes = new Map<number, string | null>(); // current mode per sensor port
  private readonly pending = new Map<number, Pending>();
  private readQueue: QueuedRead[] = [];
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  private lastRx = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private wired = false;

  constructor(
    private readonly transport: LineTransport,
    opts: Ev3devProviderOptions,
  ) {
    if (!opts || typeof opts !== "object") fail("config is required: { limits, hardware }");
    if (!opts.limits || typeof opts.limits !== "object")
      fail("config.limits is required: pass the robot profile's limits (max_speed_pct, max_command_ms)");
    for (const k of ["max_speed_pct", "max_command_ms"] as const) {
      if (!positive(opts.limits[k]))
        fail(`config.limits.${k} is required and must be a number > 0, got ${JSON.stringify(opts.limits[k])}`);
    }
    if (opts.limits.max_speed_pct > 100) fail("config.limits.max_speed_pct must be 1..100");
    if (!opts.hardware || typeof opts.hardware !== "object")
      fail("config.hardware is required (low_battery_v, max_tone_ms, speech_volume_pct); see EXAMPLE_EV3DEV_HARDWARE");
    for (const k of ["low_battery_v", "max_tone_ms", "speech_volume_pct"] as const) {
      if (!positive(opts.hardware[k]))
        fail(`config.hardware.${k} is required and must be a number > 0, got ${JSON.stringify(opts.hardware[k])}`);
    }
    if (opts.hardware.speech_volume_pct > 100) fail("config.hardware.speech_volume_pct must be 1..100");
    this.id = opts.id ?? "ev3";
    if (!/^[a-z0-9_-]+$/i.test(this.id)) fail(`id "${this.id}" must be letters, digits, _ or -`);
    this.roles = { ...opts.roles };
    this.o = {
      pair: opts.pair ?? { left: "B", right: "C" },
      maxSpeedPct: opts.limits.max_speed_pct,
      boundMs: Math.max(
        1,
        Math.floor(Math.min(MAX_MOTION_MS, opts.maxOpMs ?? MAX_MOTION_MS, opts.limits.max_command_ms)),
      ),
      hw: {
        low_battery_v: opts.hardware.low_battery_v,
        max_tone_ms: Math.round(opts.hardware.max_tone_ms),
        speech_volume_pct: opts.hardware.speech_volume_pct,
      },
      heartbeatMs: opts.heartbeatMs ?? 300,
      helloTimeoutMs: opts.helloTimeoutMs ?? 20000,
      requestTimeoutMs: opts.requestTimeoutMs ?? 2000,
      linkSilenceMs: opts.linkSilenceMs ?? 3000,
    };
    const ports = ["A", "B", "C", "D"];
    if (
      !ports.includes(this.o.pair.left) ||
      !ports.includes(this.o.pair.right) ||
      this.o.pair.left === this.o.pair.right
    )
      fail("pair needs two different ports A-D");
    if (opts.maxOpMs !== undefined && !(positive(opts.maxOpMs) && opts.maxOpMs <= MAX_MOTION_MS))
      fail(`maxOpMs must be 1..${MAX_MOTION_MS}`);
    for (const k of ["heartbeatMs", "helloTimeoutMs", "requestTimeoutMs", "linkSilenceMs"] as const)
      if (!positive(this.o[k])) fail(`${k} must be > 0`);
    if (this.o.heartbeatMs > BRICK_WATCHDOG_MS / 2)
      fail(
        `heartbeatMs must be <= ${BRICK_WATCHDOG_MS / 2}: the brick brakes after ${BRICK_WATCHDOG_MS} ms of silence`,
      );
    const stopLinkMs = opts.stopLinkMs ?? 700;
    if (!positive(stopLinkMs)) fail("stopLinkMs must be > 0");
    this.stop_worst_ms = BRIDGE_STOP_VERIFY_MS + Math.ceil(stopLinkMs);
  }

  // ------------------------------------------------------------- link

  private wire(): void {
    if (this.wired) return;
    this.wired = true;
    this.transport.onLine((line) => this.onLine(line));
    this.transport.onClose((reason) => this.teardown(`link to the brick closed: ${reason}`));
  }

  private onLine(line: string): void {
    this.lastRx = Date.now();
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    } // not ours (a login banner on stdout)
    if (msg === null || typeof msg !== "object" || typeof msg.id !== "number") return; // events: hb, watchdog
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok === true) {
      p.resolve(msg);
      return;
    }
    p.reject(bridgeError(msg.code, msg.message));
  }

  private teardown(reason: string): void {
    // the first reason is why the link went down; what follows is cleanup
    this.closedWhy ??= reason;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.state = "closed";
    this.opening = null;
    const failed = [...this.pending.values()];
    this.pending.clear();
    for (const p of failed) {
      clearTimeout(p.timer);
      p.reject(err("robot_offline", `ev3dev: ${reason}`));
    }
  }

  private request(
    body: Record<string, unknown>,
    timeoutMs: number,
  ): { id: number; reply: Promise<Record<string, unknown>> } {
    const id = this.nextId++;
    const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(err("timeout", `ev3dev: no reply to ${String(body.op)} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport.send(JSON.stringify({ ...body, id }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err("robot_offline", `ev3dev: cannot send to the brick: ${(e as Error)?.message ?? String(e)}`));
      }
    });
    return { id, reply };
  }

  private async hello(timeoutMs: number): Promise<void> {
    const config = {
      bounds: {
        max_speed_pct: this.o.maxSpeedPct,
        max_op_ms: this.o.boundMs,
        low_battery_v: this.o.hw.low_battery_v,
        max_tone_ms: this.o.hw.max_tone_ms,
        speech_volume_pct: this.o.hw.speech_volume_pct,
      },
      pair: this.o.pair,
    };
    const inv = (await this.request({ op: "hello", config }, timeoutMs).reply) as unknown as BridgeInventory;
    if (!Array.isArray(inv.motors) || !Array.isArray(inv.sensors) || !Array.isArray(inv.unknown) || !inv.capabilities) {
      throw err(
        "internal",
        "ev3dev: the bridge's hello has no motors/sensors/unknown/capabilities; is the installed bridge older than this driver? Copy this version's bridge to the brick: start the server with --install-bridge (installBridge() in code).",
      );
    }
    if (inv.speech === undefined)
      throw err(
        "misconfigured",
        "ev3dev: the bridge's hello does not say whether the brick can speak; the installed bridge is older than this driver. Copy this version's bridge to the brick: start the server with --install-bridge (installBridge() in code).",
      );
    if (!(Number(inv.bridge) >= MIN_BRIDGE_VERSION))
      throw err(
        "misconfigured",
        `ev3dev: the installed bridge is version ${JSON.stringify(inv.bridge)}, this driver needs ${MIN_BRIDGE_VERSION} or newer. Copy this version's bridge to the brick: start the server with --install-bridge (installBridge() in code).`,
      );
    if (inv.watchdog_ms !== BRICK_WATCHDOG_MS)
      throw err(
        "misconfigured",
        `ev3dev: the bridge's watchdog is ${inv.watchdog_ms} ms, this driver expects ${BRICK_WATCHDOG_MS}; reinstall the bridge`,
      );
    this.inv = inv;
    this.modes.clear();
    for (const s of inv.sensors) this.modes.set(s.port, s.mode);
    this.rebuild();
  }

  /** Opens the link if it is closed: start the transport, start the heartbeat, send hello. */
  private ensure(): Promise<void> {
    if (this.ended) return Promise.reject(this.closedForGood());
    if (this.state === "ready") return Promise.resolve();
    if (this.opening) return this.opening;
    this.state = "opening";
    this.wire();
    const opening = (async () => {
      try {
        const t0 = Date.now();
        try {
          await this.transport.open();
        } catch (e) {
          throw e instanceof RuntimeError
            ? e
            : err("robot_offline", `ev3dev: cannot open the link to the brick: ${(e as Error)?.message ?? String(e)}`);
        }
        if (this.ended) throw this.closedForGood(); // closed while the transport was starting
        this.lastRx = Date.now();
        this.heartbeat = setInterval(() => this.beat(), this.o.heartbeatMs);
        await this.hello(Math.max(1000, this.o.helloTimeoutMs - (Date.now() - t0)));
        this.fresh = true;
        this.state = "ready";
        this.closedWhy = null;
      } catch (e) {
        this.teardown("the link to the brick could not be opened");
        await this.transport.close().catch(() => {});
        throw e;
      } finally {
        this.opening = null;
      }
    })();
    this.opening = opening;
    return opening;
  }

  private beat(): void {
    if (this.state === "ready" && Date.now() - this.lastRx > this.o.linkSilenceMs) {
      this.teardown(`no line from the bridge for ${this.o.linkSilenceMs} ms`);
      void this.transport.close().catch(() => {});
      return;
    }
    try {
      this.transport.send('{"op":"hb"}');
    } catch {
      /* the close callback reports it */
    }
  }

  private closedForGood(): RuntimeError {
    return err(
      "robot_offline",
      `ev3dev: ${this.closedWhy ?? "the link to the brick was closed on this side"}; this call ended with it. list_robots shows the robot's link and what brings it online.`,
    );
  }

  /**
   * Stops the heartbeat and closes the transport, for good: every later call answers robot_offline at once and
   * opens nothing. The bridge brakes every motor when its input closes.
   */
  async close(): Promise<void> {
    this.ended = true;
    this.teardown("the link to the brick was closed on this side");
    await this.transport.close();
  }

  onDevicesChanged(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** The bridge's last hello, with raw sysfs names (driver_name, mode, modes) for debugging. */
  inventory(): BridgeInventory | null {
    return this.inv ? structuredClone(this.inv) : null;
  }

  // ------------------------------------------------------------- devices

  /** Asks the bridge to scan sysfs again and returns the device list. */
  async devices(): Promise<DeviceSpec[]> {
    await this.ensure();
    if (this.fresh) this.fresh = false;
    else await this.hello(this.o.requestTimeoutMs);
    return [...this.specs!.values()].map((s) => structuredClone(s));
  }

  private rebuild(): void {
    this.specs = new Map(this.build(this.inv!).map((s) => [s.id, s]));
  }

  private build(inv: BridgeInventory): DeviceSpec[] {
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
    const speed = {
      type: "number",
      minimum: 1,
      maximum: o.maxSpeedPct,
      description: "Speed, percent of the motor's maximum.",
    };
    const motion = { kind: "ms" as const, max: o.boundMs };
    const oneOp = `One operation, at most ${o.boundMs} ms of motion, bounded by time on the brick.`;
    const target = `${oneOp} If the target needs longer, the motor is braked at the time bound with reason "timeout" and measured.time_limited true: send the rest in another command. A motor that could not turn ends with reason "stalled".`;
    const POS =
      "Positive = the direction a positive speed turns the shaft (the driver's forward). This is shaft rotation, not a heading: whether it moves the robot forward or turns it depends on how the motor is mounted.";
    const out: DeviceSpec[] = [];
    const motors = new Map(inv.motors.map((m) => [m.port, m]));

    for (const p of ["A", "B", "C", "D"] as OutputPort[]) {
      const m = motors.get(p);
      if (!m) continue;
      const top = Math.round((m.max_speed * 360) / m.count_per_rot);
      out.push(
        mk(
          p,
          "motor",
          `EV3 ${MOTOR_SIZES[m.driver_name] ?? m.driver_name} motor on output port ${p}, with a ${360 / m.count_per_rot}-degree encoder.`,
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
              range: [-top, top],
              max_rate_hz: 50,
              description: "Current rotation speed, measured by the motor driver from the encoder.",
            },
            {
              name: "stalled",
              type: "boolean",
              max_rate_hz: 50,
              description: "true if the last operation on this motor ended because the motor could not turn.",
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
              description: `Runs for a time at a regulated speed. ${oneOp} measured.degrees is the encoder change.`,
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
              description:
                "Brakes this motor now, preempts an operation running on it, and returns once it reads speed 0 (stop_unverified if it does not within 800 ms).",
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
    if (motors.has(o.pair.left) && motors.has(o.pair.right)) {
      out.push(
        mk(
          "pair",
          "motor_pair",
          `Motor pair: left = port ${o.pair.left}, right = port ${o.pair.right}.`,
          [
            {
              name: "left_deg",
              type: "number",
              unit: "deg",
              max_rate_hz: 50,
              description: `Encoder position of the left motor (port ${o.pair.left}). Positive = the motor's own forward direction, the same sign run_pair uses.`,
            },
            {
              name: "right_deg",
              type: "number",
              unit: "deg",
              max_rate_hz: 50,
              description: `Encoder position of the right motor (port ${o.pair.right}). Positive = the motor's own forward direction, the same sign run_pair uses.`,
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
              description: `Rotates both motors toward their own signed degrees so they finish together, and stops when both encoders reach their targets. ${target} The two motors are started a few milliseconds apart with speeds in proportion to their travel, and each regulates its own speed: nothing couples them, so a wheel under more load lags the other during the move. Read measured.left_deg / measured.right_deg.`,
            },
            {
              name: "brake",
              moves: true,
              bound: { kind: "instant", max: 0 },
              params: obj({}),
              description:
                "Brakes these two motors now (no other motor), preempts an operation running on them, and returns once both read speed 0 (stop_unverified if they do not within 800 ms).",
            },
          ],
        ),
      );
    }
    const unknown = (u: {
      local: string;
      address: string | null;
      driver_name: string | null;
      modes: string[] | null;
      error?: string;
    }) =>
      mk(
        u.local,
        "unknown",
        `Unsupported device${u.address ? ` on ${u.address}` : ""}: ev3dev driver ${u.driver_name ?? "unreadable"}${u.modes?.length ? ` (modes: ${u.modes.join(", ")})` : ""}${u.error ? `; ${u.error}` : ""}. This provider cannot read or command it.`,
        [],
        [],
      );
    for (const u of inv.unknown.filter((x) => x.class === "tacho-motor")) out.push(unknown(u));
    const sensors = [
      ...inv.sensors.map((s) => ({ at: `S${s.port}`, s })),
      ...inv.unknown.filter((x) => x.class !== "tacho-motor").map((u) => ({ at: u.local, u })),
      // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array; toSorted needs lib ES2023, the repo targets ES2022
    ].sort((a, b) => a.at.localeCompare(b.at));
    for (const e of sensors) {
      if ("u" in e) {
        out.push(unknown(e.u!));
        continue;
      }
      const s = e.s!;
      const k = SENSOR_KINDS[s.kind];
      if (!k) {
        out.push(unknown({ local: e.at, address: s.address, driver_name: s.driver_name, modes: s.modes }));
        continue;
      }
      const mode = this.modes.get(s.port) ?? null;
      out.push(
        mk(
          e.at,
          s.kind,
          `${k.description} Input port ${s.port}.`,
          k.channels.map((c) =>
            c.name in s.channel_modes ? { ...c, mode_group: e.at, active: s.channel_modes[c.name] === mode } : { ...c },
          ),
          k.reset
            ? [
                {
                  name: "reset",
                  moves: false,
                  bound: { kind: "instant", max: 0 },
                  params: obj({}),
                  description:
                    "Sets angle_deg to 0 by switching the sensor mode and back; afterwards angle_deg is the active channel. Keep the robot still while it runs (about 0.2 s).",
                },
              ]
            : [],
        ),
      );
    }
    const cap = inv.capabilities;
    const speech = inv.speech;
    const beepMs = Math.min(200, o.hw.max_tone_ms);
    out.push(
      mk(
        "speaker",
        "speaker",
        `The brick's speaker. tone and beep go through the brick's \`beep\` program at the brick's own volume.${cap.beep ? "" : missing("no `beep` program on its PATH")} ${
          speech
            ? "It can also say a text aloud (speak)."
            : `It cannot say a text aloud: there is no speak command (${inv.no_speech ?? "no text-to-speech on the brick"}).`
        }`,
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
          ...(speech
            ? [
                {
                  name: "speak",
                  moves: false,
                  bound: { kind: "ms" as const, max: speech.max_ms },
                  params: obj(
                    {
                      text: { type: "string", minLength: 1, maxLength: speech.max_chars },
                      voice: { type: "string", enum: [...speech.voices], default: speech.default_voice },
                      rate_wpm: {
                        type: "number",
                        minimum: speech.rate_wpm.min,
                        maximum: speech.rate_wpm.max,
                        default: speech.rate_wpm.default,
                      },
                    },
                    ["text"],
                  ),
                  description: `Says the text aloud with the brick's espeak synthesizer and returns when the speech has ended (measured.spoken true). Write the text in the language of the voice; voice is an espeak language code (default ${speech.default_voice}), rate_wpm is words per minute (default ${speech.rate_wpm.default}). One phrase at a time: a second speak while one is playing fails with busy. A phrase still playing after ${speech.max_ms} ms is cut (reason timeout, measured.spoken false); stop or aborting the call cuts the audio at once (reason preempted). Volume is fixed by the robot's configuration.`,
                },
              ]
            : []),
        ],
      ),
    );
    const noDisplay = "Not supported on ev3dev by this driver: always fails with `unsupported` and draws nothing.";
    out.push(
      mk(
        "display",
        "display",
        "The brick's 178x128 LCD. This driver cannot draw on it under ev3dev (the brick's own menu owns the screen): both commands fail with `unsupported`.",
        [],
        [
          {
            name: "text",
            moves: false,
            bound: { kind: "instant", max: 0 },
            params: obj({ lines: { type: "array", items: { type: "string", maxLength: 22 }, maxItems: 10 } }, [
              "lines",
            ]),
            description: noDisplay,
          },
          { name: "clear", moves: false, bound: { kind: "instant", max: 0 }, params: obj({}), description: noDisplay },
        ],
      ),
    );
    out.push(
      mk(
        "led",
        "led",
        `The two lights around the brick's buttons, set together.${cap.led ? "" : missing("no brick-status LEDs in sysfs")}`,
        [],
        [
          {
            name: "set",
            moves: false,
            bound: { kind: "instant", max: 0 },
            params: obj({ pattern: { type: "string", enum: [...LED_PATTERNS] } }, ["pattern"]),
            description:
              "Sets the light color and animation. flash = 0.5 s on, 0.5 s off; pulse = a 0.15 s blink every second (the stock firmware's double pulse is not reproduced). In orange animations the red and green parts blink on separate kernel timers and can drift apart.",
          },
        ],
      ),
    );
    out.push(
      mk(
        "buttons",
        "buttons",
        `The six buttons on the brick.${cap.buttons ? "" : missing("no gpio-keys input device")}`,
        [
          {
            name: "pressed",
            type: "vector",
            max_rate_hz: 20,
            description: `Names of the buttons held down right now, out of: ${BUTTON_NAMES.join(", ")}. Empty when none. The brick's own menu also reacts to these buttons.`,
          },
        ],
        [],
      ),
    );
    out.push(
      mk(
        "battery",
        "battery",
        `The brick's battery.${cap.battery ? "" : missing("no power supply with a voltage in sysfs")}`,
        [
          {
            name: "voltage_v",
            type: "number",
            unit: "v",
            range: [0, 10],
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

  private async lookup(device: string): Promise<Lookup> {
    await this.ensure();
    this.fresh = false;
    const idOrRole = this.specs!.has(device) ? device : (this.roles[device] ?? device);
    const spec = this.specs!.get(idOrRole);
    if (!spec)
      throw err("unknown_device", `unknown device "${device}"; devices: ${[...this.specs!.keys()].join(", ")}`);
    return { spec, local: spec.id.slice(this.id.length + 1) };
  }

  /** Records the mode a sensor reported; a change flips `active` flags, so listeners are told. */
  private noteMode(local: string, mode: unknown): void {
    if (!/^S[1-4]$/.test(local) || typeof mode !== "string") return;
    const port = Number(local[1]);
    if (this.modes.get(port) === mode) return;
    this.modes.set(port, mode);
    this.rebuild();
    for (const cb of this.listeners) cb();
  }

  // ------------------------------------------------------------- read

  /**
   * One Reading per channel, without changing anything on the brick. A channel that cannot be read has
   * value null and an error, never a default. Sensor channels of a mode other than the current one come
   * back as null + "mode_switch_required" unless they are named in `channels` AND opts.allow_mode_switch is true.
   * Reads issued in the same turn (a read of every device) leave as one request line and come back as one.
   */
  async read(device: string, channels?: string[], opts?: { allow_mode_switch?: boolean }): Promise<Reading[]> {
    const { spec, local } = await this.lookup(device);
    const names = channels ?? spec.channels.map((c) => c.name);
    for (const n of names) {
      if (!spec.channels.some((c) => c.name === n)) {
        throw err(
          "unknown_channel",
          `device ${spec.id} has no channel "${n}"; channels: ${spec.channels.map((c) => c.name).join(", ") || "none"}`,
        );
      }
    }
    if (!names.length) return [];
    const allow = channels !== undefined && opts?.allow_mode_switch === true;
    // A read that may switch a mode waits for the sensor and goes alone; the others share a line.
    const res: ReadReply = allow
      ? await this.request(
          { op: "read", device: local, channels: names, allow_mode_switch: true },
          this.o.requestTimeoutMs + 1000,
        ).reply
      : await this.readTogether(local, names);
    const got = res.readings;
    if (!Array.isArray(got)) throw err("internal", `ev3dev: read of ${spec.id} returned no readings`);
    const ts = Date.now();
    const out = names.map((n): Reading => {
      const r = got.find((x) => x.channel === n);
      const reading: Reading = { device: spec.id, channel: n, value: r?.value ?? null, ts };
      const unit = spec.channels.find((c) => c.name === n)!.unit;
      if (unit) reading.unit = unit;
      if (reading.value === null) reading.error = r?.error ?? "the bridge returned no value for this channel";
      return reading;
    });
    this.noteMode(local, res.mode);
    return out;
  }

  /** Queues one read; a microtask later every read queued by then is sent as one `read_many` line. */
  private readTogether(device: string, channels: string[]): Promise<ReadReply> {
    return new Promise((resolve, reject) => {
      this.readQueue.push({ device, channels, resolve, reject });
      if (this.readQueue.length === 1) queueMicrotask(() => this.flushReads());
    });
  }

  private flushReads(): void {
    const batch = this.readQueue;
    this.readQueue = [];
    if (!batch.length) return; // already sent ahead of a command
    const body =
      batch.length === 1
        ? { op: "read", device: batch[0]!.device, channels: batch[0]!.channels, allow_mode_switch: false }
        : { op: "read_many", reads: batch.map((r) => ({ device: r.device, channels: r.channels })) };
    this.request(body, this.o.requestTimeoutMs).reply.then(
      (res) => {
        if (batch.length === 1) return batch[0]!.resolve(res);
        const results = res.results as ({ ok?: boolean; code?: unknown; message?: unknown } & ReadReply)[];
        if (!Array.isArray(results) || results.length !== batch.length) {
          const e = err(
            "internal",
            `ev3dev: read_many of ${batch.length} reads returned ${JSON.stringify(res.results)}`,
          );
          for (const r of batch) r.reject(e);
          return;
        }
        // Each read is answered as if it had been sent alone: one that failed fails alone.
        batch.forEach((r, i) => {
          const one = results[i]!;
          if (one?.ok === true) r.resolve(one);
          else r.reject(bridgeError(one?.code, one?.message));
        });
      },
      (e: Error) => {
        for (const r of batch) r.reject(e);
      },
    );
  }

  // ------------------------------------------------------------- command

  /** Exactly one operation on the brick. Motion is cut by the brick itself at the command's time bound. */
  async command(
    device: string,
    command: string,
    args: Record<string, Value>,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    const { spec, local } = await this.lookup(device);
    const cmd = spec.commands.find((c) => c.name === command);
    if (!cmd)
      throw err(
        "unknown_command",
        `device ${spec.id} has no command "${command}"; commands: ${spec.commands.map((c) => c.name).join(", ") || "none"}`,
      );
    if (args === null || typeof args !== "object" || Array.isArray(args))
      throw err("invalid_argument", "args must be an object");
    for (const k of Object.keys(args)) {
      if (!(k in cmd.params.properties))
        throw err(
          "invalid_argument",
          `${spec.id}.${command}: unknown argument "${k}"; allowed: ${Object.keys(cmd.params.properties).join(", ") || "none"}`,
        );
    }
    for (const k of cmd.params.required ?? []) {
      if (args[k] === undefined) throw err("invalid_argument", `${spec.id}.${command}: missing argument "${k}"`);
    }
    if (signal.aborted) return { requested: args, measured: {}, clamped: false, reason: "preempted", ms: 0 };
    // Calls are served in the order they were made (CONTRACT §4): reads waiting to be sent together go out
    // before this command, so they show the device before it starts.
    this.flushReads();
    const { id, reply } = this.request(
      { op: "command", device: local, command, args },
      // speak answers when the speech ends, so its reply may take the whole declared bound
      this.o.requestTimeoutMs +
        (cmd.moves
          ? this.o.boundMs
          : local === "speaker" && command === "speak"
            ? cmd.bound.max
            : BRIDGE_STOP_VERIFY_MS),
    );
    const abort = () => {
      try {
        this.transport.send(JSON.stringify({ op: "abort", target: id }));
      } catch {
        /* the close callback fails the request */
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const res = await reply;
      const r = res.result as
        | { measured: Record<string, Value>; clamped: boolean; reason: StopReason; ms: number }
        | undefined;
      if (!r || typeof r.reason !== "string") throw err("internal", `ev3dev: ${spec.id}.${command} returned no result`);
      this.noteMode(local, res.mode);
      return { requested: args, measured: r.measured ?? {}, clamped: r.clamped === true, reason: r.reason, ms: r.ms };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  // ------------------------------------------------------------- stop

  /**
   * Brakes every motor on the brick, which preempts running operations, and verifies that each one
   * reads speed 0. With the link closed nothing can be verified, so it throws robot_offline (the bridge
   * brakes on its own when the link drops).
   */
  async stop(): Promise<{ motors_stopped: boolean }> {
    if (this.state !== "ready") {
      throw err(
        "robot_offline",
        "ev3dev: the link to the brick is not open, so the stop cannot be sent or verified; the bridge brakes every motor by itself when its link drops",
      );
    }
    const res = await this.request({ op: "stop" }, this.stop_worst_ms).reply;
    return { motors_stopped: res.motors_stopped === true };
  }
}

/** Ops that cannot move or change anything on the brick. */
export const READ_ONLY_OPS = ["hello", "read", "read_many", "hb"] as const;
/**
 * Wraps a transport so that only hello, read and hb reach the brick, and no read may switch a sensor
 * mode. Anything else throws before it is sent. For checks that must not move a robot.
 */
export function readOnlyTransport(inner: LineTransport): LineTransport {
  return {
    open: () => inner.open(),
    close: () => inner.close(),
    onLine: (cb) => inner.onLine(cb),
    onClose: (cb) => inner.onClose(cb),
    send(line) {
      const msg = JSON.parse(line) as { op?: string; allow_mode_switch?: boolean };
      if (!(READ_ONLY_OPS as readonly string[]).includes(String(msg.op)))
        throw new Error(`read-only transport: refused to send op "${msg.op}"`);
      if (msg.allow_mode_switch === true)
        throw new Error("read-only transport: refused a read that switches a sensor mode");
      inner.send(line);
    },
  };
}
