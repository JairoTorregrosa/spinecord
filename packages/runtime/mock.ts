// In-memory Provider for tests of anything built on the runtime. It simulates time through the injected
// clock: a motor command "takes" degrees / (speed_pct × deg_s_per_pct) seconds and can be aborted midway.
// Like a real driver it runs ONE operation per command, cut at 250 ms of device time; it never chunks.
import type { BackendKind, CommandResult, DeviceSpec, Provider, Reading, Value } from "../protocol/types";
import type { Clock } from "./clock";

type Source = Value | null | (() => Value | null);
export interface MockOptions {
  id?: string; // provider id, default "mock"
  clock: Clock;
  deg_s_per_pct?: number; // motor speed model, default 10 (100 % = 1000 deg/s)
  // Adds <id>.gyro whose angle follows the wheels: heading degrees per degree of (right - left)/2, which is
  // wheel_diameter / axle_track of the robot being mocked. sign -1 = the gyro counts clockwise as positive.
  gyro?: { heading_per_wheel_deg: number; sign?: 1 | -1 };
  stop_worst_ms?: number; // default 100
  latency_ms?: number; // transport round trip added to every read and command (a driver over a slow link)
  // Declared per-operation time bound of the pair's run_pair (a device with its own watchdog may declare a
  // long one). Absent: run_pair is bounded in degrees and every operation is cut at 250 ms.
  op_ms?: number;
  backend?: BackendKind; // default "sim"
  max_speed_pct?: number; // the maximum of every speed argument, as a driver writes the profile's limit; default 100
  pair_brake?: boolean; // false = the pair has no brake{} command (a manifest the runtime must refuse)
  extra?: DeviceSpec[]; // more manifests; their channels read from `values`
}
const num = (unit: string, description: string, extra: object = {}) => ({
  type: "number" as const,
  unit,
  description,
  ...extra,
});

export class MockProvider implements Provider {
  readonly id: string;
  readonly backend: BackendKind;
  readonly stop_worst_ms: number;
  stopDelayMs = 0; // how long stop() takes
  modeSwitches = 0; // reads that switched a sensor mode
  switchReads = 0; // reads that arrived with allow_mode_switch
  readonly log: { device: string; command: string; args: Record<string, Value>; ms: number; reason: string }[] = [];
  readonly values = new Map<string, Source>(); // "<device>.<channel>" → value or function
  left = 0;
  right = 0;
  arm = 0;
  slip = 1; // fraction of commanded wheel motion that really happens
  reverseFromOp = 0; // from this run_pair operation on (1-based), the wheels turn the wrong way (a driver bug)
  echo = false; // run_pair's `measured` repeats what was asked, whatever the wheels did (a driver that does not measure)
  coastDeg = 0; // extra wheel degrees a brake:false operation rolls on after it ends
  stalled = false; // motors do not move and report "stalled"
  stopVerified = true; // what stop() reports
  stops = 0;
  readonly brakes: string[] = []; // devices braked with their own brake{} command
  readonly reads: string[] = []; // device of every read(), in the order they were made
  frameTs = 0; // capture time of the camera frame
  failRead: string | undefined; // device id whose reads throw
  // "<device>.<channel>" → error: that channel's reads fail (value null with this error), whatever `values` holds
  readonly readErrors = new Map<string, string>();
  failScans = 0; // how many of the next devices() calls throw
  scans = 0; // devices() calls
  private readonly clock: Clock;
  private readonly rate: number;
  latency: number; // transport round trip, ms; a test may change it between calls (a link that got slower)
  private readonly opMs: number;
  private specs: DeviceSpec[];
  private readonly changed = new Set<() => void>();

  constructor(o: MockOptions) {
    this.id = o.id ?? "mock";
    this.backend = o.backend ?? "sim";
    this.clock = o.clock;
    this.rate = o.deg_s_per_pct ?? 10;
    this.latency = o.latency_ms ?? 0;
    this.opMs = o.op_ms ?? 250;
    this.stop_worst_ms = o.stop_worst_ms ?? 100;
    this.frameTs = o.clock.now();
    const id = (local: string) => `${this.id}.${local}`;
    const maxSpeed = o.max_speed_pct ?? 100;
    const speed = { type: "number", minimum: 1, maximum: maxSpeed };
    const brake = {
      type: "boolean",
      description: "false = coast at the end so the next chunk chains smoothly. Default true.",
    };
    const instantBrake = {
      name: "brake",
      description: "Brakes this device now.",
      moves: false,
      bound: { kind: "instant" as const, max: 0 },
      params: { type: "object" as const, properties: {}, additionalProperties: false },
    };
    this.specs = [
      {
        id: id("pair"),
        provider: this.id,
        kind: "motor_pair",
        roles: [],
        description: "Two synchronized drive motors.",
        channels: [
          { name: "left_deg", ...num("deg", "Left wheel encoder.") },
          { name: "right_deg", ...num("deg", "Right wheel encoder.") },
        ],
        commands: [
          {
            name: "run_pair",
            description: "Turns both wheels by the given degrees; both finish together.",
            moves: true,
            bound: o.op_ms
              ? { kind: "ms", max: o.op_ms }
              : { kind: "degrees", params: ["left_deg", "right_deg"], max: 3600 },
            params: {
              type: "object",
              properties: { left_deg: { type: "number" }, right_deg: { type: "number" }, speed_pct: speed, brake },
              required: ["left_deg", "right_deg", "speed_pct"],
              additionalProperties: false,
            },
          },
          ...(o.pair_brake === false ? [] : [instantBrake]),
        ],
      },
      {
        id: id("arm"),
        provider: this.id,
        kind: "motor",
        roles: [],
        description: "A single motor.",
        channels: [{ name: "position_deg", ...num("deg", "Encoder position.") }],
        commands: [
          instantBrake,
          {
            name: "run_degrees",
            description: "Turns by degrees.",
            moves: true,
            bound: { kind: "degrees", params: ["degrees"], max: 720 },
            params: {
              type: "object",
              properties: { degrees: { type: "number" }, speed_pct: speed, brake },
              required: ["degrees", "speed_pct"],
              additionalProperties: false,
            },
          },
          // bound in ms on a moving command = the longest single operation; the runtime chains operations
          {
            name: "run_to_position",
            description:
              "Rotates toward an absolute position. Cut at 250 ms with reason timeout and measured.time_limited.",
            moves: true,
            bound: { kind: "ms", max: 250 },
            params: {
              type: "object",
              properties: { position_deg: { type: "number" }, speed_pct: speed, brake },
              required: ["position_deg", "speed_pct"],
              additionalProperties: false,
            },
          },
          {
            name: "run_time",
            description: "Runs for ms.",
            moves: true,
            bound: { kind: "ms", params: ["ms"], max: 250 },
            params: {
              type: "object",
              properties: {
                ms: { type: "integer", minimum: 1, maximum: 250 },
                speed_pct: { type: "number", minimum: -maxSpeed, maximum: maxSpeed },
                brake,
              },
              required: ["ms", "speed_pct"],
              additionalProperties: false,
            },
          },
        ],
      },
      {
        id: id("color"),
        provider: this.id,
        kind: "color",
        roles: [],
        description: "Color sensor.",
        channels: [
          {
            name: "reflected_pct",
            ...num("pct", "Reflected light.", { range: [0, 100], max_rate_hz: 20, mode_group: "light", active: true }),
          },
          {
            name: "ambient_pct",
            ...num("pct", "Ambient light. Needs a mode switch.", { mode_group: "light", active: false }),
          },
          { name: "color", ...num("", "Color code 0..7.") },
          { name: "rgb", type: "vector", length: 3, description: "Raw RGB." },
        ],
        commands: [],
      },
      {
        id: id("speaker"),
        provider: this.id,
        kind: "speaker",
        roles: [],
        description: "Speaker.",
        channels: [],
        commands: [
          {
            name: "tone",
            description: "Plays a tone.",
            moves: false,
            bound: { kind: "ms", params: ["duration_ms"], max: 2000 },
            params: {
              type: "object",
              properties: {
                frequency_hz: { type: "number", minimum: 100, maximum: 10000 },
                duration_ms: { type: "integer", minimum: 1 },
              },
              required: ["frequency_hz", "duration_ms"],
              additionalProperties: false,
            },
          },
          {
            name: "beep",
            description: "Short beep.",
            moves: false,
            bound: { kind: "instant", max: 0 },
            params: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      },
      {
        id: id("camera"),
        provider: this.id,
        kind: "camera",
        roles: [],
        description: "Camera.",
        channels: [
          { name: "frame", type: "image", description: "Latest frame." },
          { name: "fps", ...num("hz", "Frame rate.") },
        ],
        commands: [],
      },
      {
        id: id("gas"),
        provider: this.id,
        kind: "gas",
        roles: [],
        description: "A kind nobody wrote code for.",
        channels: [{ name: "ppm", ...num("ppm", "Gas concentration.") }],
        commands: [],
      },
      ...(o.gyro
        ? [
            {
              id: id("gyro"),
              provider: this.id,
              kind: "gyro",
              roles: [],
              description: "Gyro.",
              channels: [{ name: "angle_deg", ...num("deg", "Accumulated rotation.") }],
              commands: [],
            } satisfies DeviceSpec,
          ]
        : []),
      ...(o.extra ?? []),
    ];
    this.values.set(id("color.reflected_pct"), 50);
    this.values.set(id("color.color"), 6);
    this.values.set(id("color.ambient_pct"), 12);
    this.values.set(id("color.rgb"), [10, 20, 30]);
    this.values.set(id("camera.fps"), 15);
    this.values.set(id("gas.ppm"), 412);
    this.values.set(id("pair.left_deg"), () => this.left);
    this.values.set(id("pair.right_deg"), () => this.right);
    this.values.set(id("arm.position_deg"), () => this.arm);
    this.values.set(
      id("gyro.angle_deg"),
      () => (o.gyro?.sign ?? 1) * ((this.right - this.left) / 2) * (o.gyro?.heading_per_wheel_deg ?? 0),
    );
  }

  async devices(): Promise<DeviceSpec[]> {
    this.scans++;
    if (this.failScans > 0) {
      this.failScans--;
      throw new Error("the brick did not answer the device scan");
    }
    return this.specs;
  }
  onDevicesChanged(cb: () => void): () => void {
    this.changed.add(cb);
    return () => void this.changed.delete(cb);
  }
  get subscribers(): number {
    return this.changed.size;
  }
  // Hot-plug: add or replace a device (its channels read from `values`), or remove one, and tell subscribers.
  plug(spec: DeviceSpec): void {
    this.specs = [...this.specs.filter((d) => d.id !== spec.id), spec];
    for (const cb of this.changed) cb();
  }
  unplug(id: string): void {
    this.specs = this.specs.filter((d) => d.id !== id);
    for (const cb of this.changed) cb();
  }

  async read(device: string, channels?: string[], opts?: { allow_mode_switch?: boolean }): Promise<Reading[]> {
    if (opts?.allow_mode_switch) this.switchReads++;
    this.reads.push(device);
    if (this.latency) await this.clock.sleep(this.latency / 2); // request on its way
    if (this.failRead === device) throw new Error(`mock: ${device} unplugged`);
    const spec = this.specs.find((d) => d.id === device);
    if (!spec) throw new Error(`mock: no device ${device}`);
    const got = (channels ?? spec.channels.filter((c) => c.active !== false).map((c) => c.name)).map(
      (channel): Reading => {
        if (spec.channels.find((c) => c.name === channel)?.active === false) {
          if (!(channels?.includes(channel) && opts?.allow_mode_switch))
            return { device, channel, value: null, ts: this.clock.now(), error: "mode_switch_required" };
          this.modeSwitches++;
        }
        if (spec.channels.find((c) => c.name === channel)?.type === "image") {
          return {
            device,
            channel,
            value: null,
            image: { mime: "image/jpeg" as const, b64: "/9j/AAAA", age_ms: this.clock.now() - this.frameTs },
            ts: this.frameTs,
          };
        }
        const ts = this.clock.now();
        const failed = this.readErrors.get(`${device}.${channel}`);
        if (failed !== undefined) return { device, channel, value: null, ts, error: failed };
        const src = this.values.get(`${device}.${channel}`);
        const value = typeof src === "function" ? src() : (src ?? null);
        if (value !== null) return { device, channel, value, ts };
        // a null_when_absent channel answers "nothing to report"; any other channel without a value failed
        return spec.channels.find((c) => c.name === channel)?.null_when_absent
          ? { device, channel, value, ts, error: "nothing in view", absent: true }
          : { device, channel, value, ts, error: "no value" };
      },
    );
    if (this.latency) await this.clock.sleep(this.latency / 2); // reply on its way
    return got;
  }

  async command(
    device: string,
    command: string,
    args: Record<string, Value>,
    caller: AbortSignal,
  ): Promise<CommandResult> {
    const called = this.clock.now();
    // On a slow link an abort travels like the request did: it reaches the device half a round trip after it
    // was raised, and never before the request it aborts.
    let signal = caller;
    if (this.latency) {
      const device = new AbortController();
      const forward = () => void this.clock.sleep(this.latency / 2).then(() => device.abort());
      if (caller.aborted) device.abort();
      else caller.addEventListener("abort", forward, { once: true });
      signal = device.signal;
      await this.clock.sleep(this.latency / 2, signal); // request on its way
    }
    const t0 = this.clock.now();
    const speed = Math.abs(Number(args.speed_pct ?? 50)) || 50;
    let limited = false; // the target needed more than one 250 ms operation
    const finish = async (reason: CommandResult["reason"], measured: Record<string, Value>): Promise<CommandResult> => {
      if (limited) measured = { ...measured, time_limited: true };
      if (this.latency) await this.clock.sleep(this.latency / 2); // reply on its way
      const ms = Math.round(this.clock.now() - called);
      this.log.push({ device, command, args, ms, reason });
      return { requested: args, measured, clamped: false, reason, ms };
    };
    // Moves `apply(fraction)` over `ms`, stopping where an abort lands.
    // One operation, cut at 250 ms of device time: a longer request only gets that far (the caller chunks).
    const motion = async (ms: number, apply: (f: number) => void) => {
      if (this.stalled) {
        await this.clock.sleep(Math.min(ms, 100), signal);
        return "stalled" as const;
      }
      await this.clock.sleep(Math.min(ms, this.opMs), signal);
      const f = ms > 0 ? Math.min(1, (this.clock.now() - t0) / ms) : 1;
      apply(f);
      limited = !signal.aborted && f < 1;
      return signal.aborted ? ("preempted" as const) : limited ? ("timeout" as const) : ("completed" as const);
    };
    const local = device.slice(this.id.length + 1);
    if (local === "pair" && command === "run_pair") {
      const op = this.log.filter((x) => x.command === "run_pair").length + 1;
      const dir = this.reverseFromOp && op >= this.reverseFromOp ? -1 : 1;
      const l = Number(args.left_deg),
        r = Number(args.right_deg);
      const l0 = this.left,
        r0 = this.right;
      const reason = await motion((Math.max(Math.abs(l), Math.abs(r)) / (speed * this.rate)) * 1000, (f) => {
        this.left = l0 + dir * l * f * this.slip;
        this.right = r0 + dir * r * f * this.slip;
      });
      const out = this.echo ? { left_deg: l, right_deg: r } : { left_deg: this.left - l0, right_deg: this.right - r0 };
      if (args.brake === false && reason !== "stalled") {
        this.left += dir * Math.sign(l) * this.coastDeg;
        this.right += dir * Math.sign(r) * this.coastDeg;
      } // rolls on, unseen by `measured`
      return finish(reason, out);
    }
    if (local === "arm" && command === "run_degrees") {
      const d = Number(args.degrees),
        a0 = this.arm;
      const reason = await motion((Math.abs(d) / (speed * this.rate)) * 1000, (f) => {
        this.arm = a0 + d * f;
      });
      return finish(reason, { degrees: this.arm - a0 });
    }
    if (local === "arm" && command === "run_to_position") {
      const a0 = this.arm,
        d = Number(args.position_deg) - a0;
      const reason = await motion((Math.abs(d) / (speed * this.rate)) * 1000, (f) => {
        this.arm = a0 + d * f;
      });
      return finish(reason, { degrees: this.arm - a0 });
    }
    if (local === "arm" && command === "run_time") {
      const ms = Number(args.ms),
        a0 = this.arm,
        dir = Math.sign(Number(args.speed_pct));
      const reason = await motion(ms, (f) => {
        this.arm = a0 + dir * speed * this.rate * (ms / 1000) * f;
      });
      return finish(reason, { degrees: this.arm - a0 });
    }
    if (command === "brake" && (local === "pair" || local === "arm")) {
      this.brakes.push(device);
      return finish("completed", {});
    }
    if (local === "speaker") return finish("completed", {});
    throw new Error(`mock: ${device} has no command ${command}`);
  }

  async stop(): Promise<{ motors_stopped: boolean }> {
    this.stops++;
    if (this.stopDelayMs) await this.clock.sleep(this.stopDelayMs);
    return { motors_stopped: this.stopVerified };
  }
}
