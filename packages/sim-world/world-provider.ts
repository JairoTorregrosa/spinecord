// SimWorldProvider: the twin-only devices next to the simulated brick.
//   sim.world  (kind sim_world): ground truth (pose, collision, named points, line and trip meters), overhead
//                                picture, load a world, put the robot somewhere.
//   sim.camera (kind camera):    first-person picture from the robot's pose.
//   sim.speaker (kind speaker):  speak{text}: makes no sound, records the text in the channel last_spoken.
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
import { EVENT_LOG_MAX, World, parseWorld } from "./world";
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
  /**
   * What every world `load_world` takes goes through before it is parsed, by name or as JSON: whoever assembles the
   * twin puts the robot's own build into it there (CONTRACT §3, `twin`), so a loaded room never brings another
   * robot's ports, footprint or look. Throws, naming what is wrong, for a world this robot cannot live in.
   */
  prepare?: (world: unknown) => unknown;
  /** Seed for worlds loaded later. Default: the current world's seed. */
  seed?: number;
  /** Overhead picture scale, px per cm (default 4). */
  scale?: number;
  now?: () => number;
}

const DEVICE_IDS = "sim.world, sim.camera, sim.speaker";
const EVENTS_DESCRIPTION = `What happened in the world after event number "since" (default 0: every event still kept, at most ${EVENT_LOG_MAX}), oldest first. Changes nothing and spends no sensor noise. measured.events holds one JSON object per event, as a string: {n, t_ms (simulated time), kind, ...}. kind is contact_began or contact_ended {with: a box id, or the wall it touches: wall_west (x 0), wall_east, wall_south (y 0), wall_north}; push_began {box} and push_ended {box, moved_cm}: the robot slid a box; stall_began and stall_ended: a drive wheel held by what the body is against, its encoder stopped; slip_began and slip_ended: the drive wheels turn while the body is held; echo_lost {why: slant (a surface in range met too far off square to echo) or range (nothing within 250 cm)} and echo_back {cm}, only with an ultrasonic sensor plugged in; placed {how: reset or carried (a person moved the robot)}; obstacle_changed {box, change: added, moved or removed} (by a person). measured.next is the number to pass as since next time, measured.dropped how many events after since are no longer kept, measured.t_ms the world's time now. Contacts are timed to a fraction of a ms; the other events to the end of the physics step (at most 20 ms) they happen in.`;
/** speak limits of the simulated speaker: the same shape a real text-to-speech speaker declares (CONTRACT §2.3). */
export const SIM_SPEAK = { max_chars: 200, max_ms: 15000, rate_wpm: { min: 80, max: 300, default: 140 } } as const;
const SPEAKER_CHANNELS = ["last_spoken", "spoken_count"];

export class SimWorldProvider implements Provider {
  readonly id = "sim";
  readonly backend: BackendKind = "sim";
  /** Nothing to brake here, so stop() answers at once. */
  readonly stop_worst_ms = 50;
  private readonly host: WorldHost;
  private readonly worlds: Record<string, unknown>;
  private readonly prepare: (world: unknown) => unknown;
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
    this.prepare = opts.prepare ?? ((w) => w);
    this.seed = opts.seed ?? opts.host.world.seed;
    this.scale = opts.scale ?? 4;
    this.now = opts.now ?? (() => Date.now());
  }

  private readonly changed = new Set<() => void>();
  /** What sim.speaker said last ("" = nothing yet) and how many phrases since the last load_world or reset. */
  private lastSpoken = "";
  private spokenCount = 0;

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

  private readonly spoken = new Set<(text: string) => void>();
  /**
   * Fires each time sim.speaker completes a speak, with the text (a viewer says it aloud). A listener that throws
   * changes nothing of the command. Returns the unsubscribe function.
   */
  onSpoken(cb: (text: string) => void): () => void {
    this.spoken.add(cb);
    return () => {
      this.spoken.delete(cb);
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
            description: `Replaces the world and puts the robot at that world's start pose; motors stop, tachos and sensors reset, and sim.speaker forgets what it said. "world" is one of: ${names.join(", ") || "(no named worlds registered)"}, or a whole world file as a JSON string (schema spinecord/world@1). A robot whose file describes its own build keeps it (what is plugged into each port, its footprint, its look): the world gives the room.`,
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
              "Teleports the robot to x_cm, y_cm, heading_deg (all three optional: the default is the world's start pose), re-zeroes the gyro and clears what sim.speaker said. Fails if the robot would overlap a wall or obstacle.",
            params: {
              type: "object",
              properties: { x_cm: { type: "number" }, y_cm: { type: "number" }, heading_deg: { type: "number" } },
              additionalProperties: false,
            },
          },
          {
            name: "events",
            moves: false,
            bound: { kind: "instant", max: 0 },
            description: EVENTS_DESCRIPTION,
            params: {
              type: "object",
              properties: { since: { type: "integer", minimum: 0 } },
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
            approx:
              "flat-shaded render: floor colours are exact, walls and obstacles are plain grey, a low box as tall as it is, with the floor beyond it and sky above",
            description: "First-person picture from the robot's pose, 160x120, about 70 deg wide. PNG.",
          },
        ],
        commands: [],
      },
      {
        id: "sim.speaker",
        provider: this.id,
        kind: "speaker",
        roles: [],
        description:
          "Simulation only: a speaker that can say a text (speak). It makes no sound; it records what was said so a test or a program's success condition can check it.",
        channels: [
          {
            name: "last_spoken",
            type: "string",
            description:
              'The text of the last speak that completed, trimmed; "" when nothing was said since the last sim.world load_world or reset.',
          },
          {
            name: "spoken_count",
            type: "number",
            description: "How many speak commands completed since the last sim.world load_world or reset.",
          },
        ],
        commands: [
          {
            name: "speak",
            moves: false,
            bound: { kind: "ms", max: SIM_SPEAK.max_ms },
            description: `Says the text. On the twin no audio is produced and the command returns at once instead of lasting as long as the speech: the text goes to last_spoken, and measured.estimated_ms is how long it would take at rate_wpm (a real speaker cuts a phrase at ${SIM_SPEAK.max_ms} ms). voice is recorded but not checked, because the voices a real speaker offers depend on its hardware.`,
            params: {
              type: "object",
              properties: {
                text: { type: "string", minLength: 1, maxLength: SIM_SPEAK.max_chars },
                voice: { type: "string", minLength: 1, maxLength: 32 },
                rate_wpm: {
                  type: "number",
                  minimum: SIM_SPEAK.rate_wpm.min,
                  maximum: SIM_SPEAK.rate_wpm.max,
                  default: SIM_SPEAK.rate_wpm.default,
                },
              },
              required: ["text"],
              additionalProperties: false,
            },
          },
        ],
      },
    ];
  }

  private speak(command: string, args: Record<string, Value>, signal: AbortSignal): CommandResult {
    if (command !== "speak")
      throw new RuntimeError("unknown_command", `sim.speaker has no command "${command}"; commands: speak`);
    const extra = Object.keys(args).filter((k) => !["text", "voice", "rate_wpm"].includes(k));
    if (extra.length)
      throw new RuntimeError("invalid_argument", `speak takes text, voice, rate_wpm; unknown: ${extra.join(", ")}`);
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) throw new RuntimeError("invalid_argument", `speak needs "text": a non-empty string`);
    if (text.length > SIM_SPEAK.max_chars)
      throw new RuntimeError(
        "invalid_argument",
        `text has ${text.length} characters, at most ${SIM_SPEAK.max_chars} fit in one phrase; split it`,
      );
    const voice = args.voice;
    if (voice !== undefined && (typeof voice !== "string" || voice === ""))
      throw new RuntimeError("invalid_argument", `voice must be a non-empty string, got ${JSON.stringify(voice)}`);
    const asked = args.rate_wpm ?? SIM_SPEAK.rate_wpm.default;
    if (typeof asked !== "number" || !Number.isFinite(asked))
      throw new RuntimeError("invalid_argument", `rate_wpm must be a finite number, got ${JSON.stringify(asked)}`);
    const rate = Math.max(SIM_SPEAK.rate_wpm.min, Math.min(SIM_SPEAK.rate_wpm.max, Math.round(asked)));
    const clamped = rate !== asked;
    const measured = { ...(voice === undefined ? {} : { voice }), rate_wpm: rate, chars: text.length };
    if (signal.aborted)
      return { requested: { ...args }, measured: { ...measured, spoken: false }, clamped, reason: "preempted", ms: 0 };
    this.lastSpoken = text;
    this.spokenCount++;
    for (const cb of this.spoken) {
      try {
        cb(text);
      } catch {
        // a listener is a display: what it does never changes the command
      }
    }
    // espeak counts a word as 5 characters at its -s rate; good enough to tell a model how long a phrase is.
    const estimated_ms = Math.min(SIM_SPEAK.max_ms, Math.round((text.length / 5 / rate) * 60000));
    return {
      requested: { ...args },
      measured: { ...measured, spoken: true, estimated_ms },
      clamped,
      reason: clamped ? "clamped" : "completed",
      ms: 0,
    };
  }

  private pose(): number[] {
    this.host.tick();
    return readWorldChannel(this.world, "pose") as number[];
  }

  async read(device: string, channels?: string[]): Promise<Reading[]> {
    if (device === "sim.speaker") {
      const ts = this.now();
      return (channels ?? SPEAKER_CHANNELS).map((channel): Reading => {
        if (!SPEAKER_CHANNELS.includes(channel))
          throw new RuntimeError(
            "unknown_channel",
            `sim.speaker has no channel "${channel}"; channels: ${SPEAKER_CHANNELS.join(", ")}`,
          );
        return { device, channel, value: channel === "last_spoken" ? this.lastSpoken : this.spokenCount, ts };
      });
    }
    if (device !== "sim.world" && device !== "sim.camera")
      throw new RuntimeError("unknown_device", `the simulation has no device "${device}"; its devices: ${DEVICE_IDS}`);
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
    if (device === "sim.speaker") return this.speak(command, args, signal);
    if (device !== "sim.world")
      throw new RuntimeError("unknown_device", `the simulation has no device "${device}"; its devices: ${DEVICE_IDS}`);
    if (command === "events") return this.events(args);
    if (command !== "load_world" && command !== "reset")
      throw new RuntimeError(
        "unknown_command",
        `sim.world has no command "${command}"; commands: load_world, reset, events`,
      );
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
        next = new World(parseWorld(this.prepare(json)), this.seed);
      } catch (e) {
        throw new RuntimeError("invalid_argument", (e as Error).message);
      }
      try {
        this.host.setWorld(next);
      } catch (e) {
        throw new RuntimeError("invalid_argument", (e as Error).message);
      }
      this.forgetSpeech();
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
    this.forgetSpeech();
    return result("completed");
  }

  /** sim.world events: the world's log after `since`, with the physics run up to now first. Changes nothing. */
  private events(args: Record<string, Value>): CommandResult {
    const extra = Object.keys(args).filter((k) => k !== "since");
    if (extra.length)
      throw new RuntimeError("invalid_argument", `events takes only "since"; unknown: ${extra.join(", ")}`);
    const since = args.since ?? 0;
    if (typeof since !== "number" || !Number.isInteger(since) || since < 0)
      throw new RuntimeError("invalid_argument", `since must be a whole number >= 0, got ${JSON.stringify(since)}`);
    this.host.tick();
    const log = this.world.eventsSince(since);
    return {
      requested: { ...args },
      measured: {
        events: log.events.map((e) => JSON.stringify({ ...e, t_ms: Math.round(e.t_ms * 100) / 100 })),
        next: log.next,
        dropped: log.dropped,
        t_ms: Math.round(this.world.t_ms),
      },
      clamped: false,
      reason: "completed",
      ms: 0,
    };
  }

  /** load_world and reset start a scene over, so what the speaker said before does not leak into the next trial. */
  private forgetSpeech(): void {
    this.lastSpoken = "";
    this.spokenCount = 0;
  }

  /** This provider owns no actuator (the motors belong to the robot body's own provider). */
  async stop(): Promise<{ motors_stopped: boolean }> {
    return { motors_stopped: true };
  }
}
