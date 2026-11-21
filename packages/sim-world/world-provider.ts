// SimWorldProvider: the twin-only devices next to the simulated brick.
//   sim.world  (kind sim_world): ground truth (pose, collision, named points, line and trip meters), overhead
//                                picture, load a world, put the robot somewhere.
//   sim.camera (kind camera):    first-person picture from the robot's pose.
// Image channels answer Reading.image = {mime: "image/png", b64, age_ms: 0} with value null. The robot body itself (motors, sensors) is some other provider's business.
import {
  RuntimeError,
  type Provider,
  type DeviceSpec,
  type Reading,
  type CommandResult,
  type Value,
  type BackendKind,
  type ImagePayload,
} from "../protocol/types";
import { World, parseWorld } from "./world";
import { readWorldChannel, worldChannelSpecs } from "./channels";
import { renderWorld, renderFirstPerson, encodePNG, toBase64 } from "./render";

/** Whoever owns the world and runs its physics (a simulated brick, or any other simulated robot body). */
export interface WorldHost {
  readonly world: World;
  /** Run the physics up to now. */
  tick(): void;
  /** Replace the world. Must throw, changing nothing, if this host cannot live in it. */
  setWorld(world: World): void;
}

export interface SimWorldProviderOptions {
  host: WorldHost;
  /** World files by name (parsed JSON), offered to `load_world`. */
  worlds?: Record<string, unknown>;
  /** Seed for worlds loaded later. Default: the current world's seed. */
  seed?: number;
  /** Overhead picture scale, px per cm (default 4). */
  scale?: number;
  now?: () => number;
}

export class SimWorldProvider implements Provider {
  readonly id = "sim";
  readonly backend: BackendKind = "sim";
  /** Nothing to brake here, so stop() answers at once. */
  readonly stop_worst_ms = 50;
  private readonly host: WorldHost;
  private readonly worlds: Record<string, unknown>;
  private readonly seed: number;
  private readonly scale: number;
  private readonly now: () => number;

  constructor(opts: SimWorldProviderOptions) {
    if (!opts?.host)
      throw new RuntimeError(
        "misconfigured",
        "SimWorldProvider needs the host (e.g. the simulated brick) whose world it exposes",
      );
    this.host = opts.host;
    this.worlds = opts.worlds ?? {};
    this.seed = opts.seed ?? opts.host.world.seed;
    this.scale = opts.scale ?? 4;
    this.now = opts.now ?? (() => Date.now());
  }

  private readonly changed = new Set<() => void>();

  private get world(): World {
    return this.host.world;
  }

  /**
   * Fires after `load_world` replaced the world. A world file can plug other devices into the robot body
   * (another port map), and this provider's own device description names the world, so every provider that
   * shares the host must be re-read: whoever assembles the twin calls `devices()` again on all of them
   * (a hardware-driver provider re-detects its ports there). Returns the unsubscribe function.
   */
  onDevicesChanged(cb: () => void): () => void {
    this.changed.add(cb);
    return () => {
      this.changed.delete(cb);
    };
  }

  async devices(): Promise<DeviceSpec[]> {
    const names = Object.keys(this.worlds);
    const c = this.world.cfg;
    return [
      {
        id: "sim.world",
        provider: this.id,
        kind: "sim_world",
        roles: [],
        description: `Simulation only: the 2D world the twin lives in (now "${c.name}", ${c.width} x ${c.height} cm, origin bottom-left, x right, y up). Named points: ${c.points.map((p) => `${p.label} (${p.x}, ${p.y})`).join(", ") || "none"}.`,
        channels: [
          ...worldChannelSpecs(this.world),
          {
            name: "frame",
            type: "image",
            description:
              "Overhead picture of the whole world: floor, lines, zones, obstacles, the robot (dark end = front) and its distance-sensor rays. PNG.",
          },
        ],
        commands: [
          {
            name: "load_world",
            moves: true,
            bound: { kind: "instant", max: 0 },
            description: `Replaces the world and puts the robot at that world's start pose; motors stop and tachos and sensors reset. "world" is one of: ${names.join(", ") || "(no named worlds registered)"}, or a whole world file as a JSON string (schema spinecord/world@1).`,
            params: {
              type: "object",
              properties: { world: { type: "string" } },
              required: ["world"],
              additionalProperties: false,
            },
          },
          {
            name: "reset",
            moves: true,
            bound: { kind: "instant", max: 0 },
            description:
              "Teleports the robot to x_cm, y_cm, heading_deg (all three optional: the default is the world's start pose) and re-zeroes the gyro. Fails if the robot would overlap a wall or obstacle.",
            params: {
              type: "object",
              properties: { x_cm: { type: "number" }, y_cm: { type: "number" }, heading_deg: { type: "number" } },
              additionalProperties: false,
            },
          },
        ],
      },
      {
        id: "sim.camera",
        provider: this.id,
        kind: "camera",
        roles: [],
        description: "Simulation only: a camera on the front of the robot looking forward.",
        channels: [
          {
            name: "frame",
            type: "image",
            approx: "flat-shaded render: floor colours are exact, walls and obstacles are plain grey",
            description: "First-person picture from the robot's pose, 160x120, about 70 deg wide. PNG.",
          },
        ],
        commands: [],
      },
    ];
  }

  private pose(): number[] {
    this.host.tick();
    return readWorldChannel(this.world, "pose") as number[];
  }

  async read(device: string, channels?: string[]): Promise<Reading[]> {
    if (device !== "sim.world" && device !== "sim.camera")
      throw new RuntimeError(
        "unknown_device",
        `provider sim has no device "${device}"; devices: sim.world, sim.camera`,
      );
    this.host.tick(); // bring the physics up to now before looking
    const values = device === "sim.world" ? worldChannelSpecs(this.world).map((c) => c.name) : [];
    const wanted = channels ?? values; // omitted -> every non-image channel
    const ts = this.now();
    return wanted.map((channel): Reading => {
      if (channel === "frame") {
        const img =
          device === "sim.world" ? renderWorld(this.world, { scale: this.scale }) : renderFirstPerson(this.world);
        // Image channels: value null, the frame in `image`. Rendered on demand, so its age is 0.
        const image: ImagePayload = { mime: "image/png", b64: toBase64(encodePNG(img)), age_ms: 0 };
        return { device, channel, value: null, image, ts };
      }
      if (!values.includes(channel))
        throw new RuntimeError(
          "unknown_channel",
          `${device} has no channel "${channel}"; channels: ${[...values, "frame"].join(", ")}`,
        );
      const unit = worldChannelSpecs(this.world).find((c) => c.name === channel)?.unit;
      return { device, channel, value: readWorldChannel(this.world, channel), ...(unit ? { unit } : {}), ts };
    });
  }

  async command(
    device: string,
    command: string,
    args: Record<string, Value>,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    if (device === "sim.camera")
      throw new RuntimeError("unknown_command", `sim.camera has no commands; read its "frame" channel`);
    if (device !== "sim.world")
      throw new RuntimeError(
        "unknown_device",
        `provider sim has no device "${device}"; devices: sim.world, sim.camera`,
      );
    if (command !== "load_world" && command !== "reset")
      throw new RuntimeError("unknown_command", `sim.world has no command "${command}"; commands: load_world, reset`);
    const result = (reason: CommandResult["reason"]): CommandResult => ({
      requested: { ...args },
      measured: { world: this.world.cfg.name, pose: this.pose() },
      clamped: false,
      reason,
      ms: 0,
    });
    if (signal.aborted) return result("preempted");
    if (command === "load_world") {
      const extra = Object.keys(args).filter((k) => k !== "world");
      if (extra.length)
        throw new RuntimeError("invalid_argument", `load_world takes only "world"; unknown: ${extra.join(", ")}`);
      const w = args.world;
      if (typeof w !== "string" || w === "")
        throw new RuntimeError(
          "invalid_argument",
          `load_world needs "world": a name (${Object.keys(this.worlds).join(", ") || "none registered"}) or a world file as a JSON string`,
        );
      let json: unknown;
      if (w.trimStart().startsWith("{")) {
        try {
          json = JSON.parse(w);
        } catch (e) {
          throw new RuntimeError("invalid_argument", `world is not valid JSON: ${(e as Error).message}`);
        }
      } else if (Object.hasOwn(this.worlds, w)) json = this.worlds[w];
      else
        throw new RuntimeError(
          "invalid_argument",
          `unknown world "${w}"; worlds: ${Object.keys(this.worlds).join(", ") || "none registered"}`,
        );
      let next: World;
      try {
        next = new World(parseWorld(json), this.seed);
      } catch (e) {
        throw new RuntimeError("invalid_argument", (e as Error).message);
      }
      try {
        this.host.setWorld(next);
      } catch (e) {
        throw new RuntimeError("invalid_argument", (e as Error).message);
      }
      for (const cb of [...this.changed]) cb();
      return result("completed");
    }
    const start = this.world.cfg.start;
    const pick = (key: string, fallback: number): number => {
      const v = args[key];
      if (v === undefined) return fallback;
      if (typeof v !== "number" || !Number.isFinite(v))
        throw new RuntimeError("invalid_argument", `${key} must be a finite number, got ${JSON.stringify(v)}`);
      return v;
    };
    const extra = Object.keys(args).filter((k) => !["x_cm", "y_cm", "heading_deg"].includes(k));
    if (extra.length)
      throw new RuntimeError("invalid_argument", `reset takes x_cm, y_cm, heading_deg; unknown: ${extra.join(", ")}`);
    const pose = {
      x: pick("x_cm", start.x),
      y: pick("y_cm", start.y),
      th: (pick("heading_deg", (start.th * 180) / Math.PI) * Math.PI) / 180,
    };
    this.host.tick();
    if (this.world.collides(pose)) {
      throw new RuntimeError(
        "invalid_argument",
        `the robot does not fit at x_cm ${pose.x}, y_cm ${pose.y}: it would overlap a wall or obstacle (world is ${this.world.cfg.width} x ${this.world.cfg.height} cm; keep about 12 cm clear)`,
      );
    }
    this.world.setPose(pose);
    return result("completed");
  }

  /** This provider owns no actuator (the motors belong to the robot body's own provider). */
  async stop(): Promise<{ motors_stopped: boolean }> {
    return { motors_stopped: true };
  }
}
