// The camera kind (CONTRACT §2.3): one JPEG frame per read, taken when the read asks for it, and `configure` for
// its size and quality. The frame comes from the track itself (ImageCapture.grabFrame), so its age is the time
// since that grab and never the age of a picture a hidden tab stopped painting.
import type { CommandSpec, Value } from "../../../../packages/protocol/types";
import { refusal, type BitmapLike, type StreamLike, type TrackLike, type Win } from "../browser";
import { PageError, type DeviceDef, type Frame, type Kit } from "../kit";

export const CAMERA_DEFAULTS = { max_side_px: 640, quality: 0.7 };

/** The longest side of a w × h picture scaled to at most maxSide, rounded. */
export function fit(w: number, h: number, maxSide: number): { width: number; height: number } {
  const k = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

export interface CameraOptions {
  kit: Kit;
  win: Win;
  /** The stream the tap obtained, or why there is none. */
  got: { stream: StreamLike; facings: string[] } | { why: string };
  now: () => number;
}

export interface Camera {
  def: DeviceDef;
  /** The live stream, for the preview; null once the person stopped lending. */
  stream(): StreamLike | null;
  /** The current frame as a bitmap, for an extension (the caller closes it). */
  bitmap(): Promise<BitmapLike>;
  /** The live video track, or null. */
  track(): TrackLike | null;
  /** Called after the track changes: a configure, a re-acquire, stop lending. */
  onTrack(cb: () => void): void;
  /** The page is visible again: a track the browser ended while it was hidden is asked for again. */
  reacquire(): Promise<void>;
  /** Closes the stream: the browser's camera indicator goes off. */
  close(): void;
}

export function camera(o: CameraOptions): Camera {
  const { win, kit } = o;
  let stream = "stream" in o.got ? o.got.stream : null;
  const facings = "stream" in o.got ? o.got.facings : [];
  const why = "why" in o.got ? o.got.why : null;
  const cfg = { ...CAMERA_DEFAULTS };
  const Capture = win.ImageCapture;
  const Canvas = win.OffscreenCanvas;
  const track = (): TrackLike | null => stream?.getVideoTracks()[0] ?? null;

  const changed: (() => void)[] = [];
  // an ended track may report no settings: the facing to ask for again is kept here
  let lastFacing = track()?.getSettings().facingMode;
  // events of a track other than the lent one say nothing about the camera
  const watch = (t: TrackLike | null) => {
    t?.addEventListener("mute", () => t === track() && kit.down("camera", "the camera stopped sending pictures"));
    t?.addEventListener("unmute", () => t === track() && kit.up("camera"));
    t?.addEventListener("ended", () => t === track() && kit.down("camera", "the camera was turned off or unplugged"));
  };
  const swap = (next: StreamLike | null) => {
    for (const t of stream?.getTracks() ?? []) t.stop();
    stream = next;
    watch(track());
    lastFacing = track()?.getSettings().facingMode ?? lastFacing;
    for (const cb of changed) cb();
  };
  watch(track());

  const size = () => {
    const s = track()?.getSettings() ?? {};
    return fit(s.width ?? 640, s.height ?? 480, cfg.max_side_px);
  };
  const facing = () => (track()?.getSettings().facingMode === "environment" ? "environment" : "user");

  async function bitmap(): Promise<BitmapLike> {
    const t = track();
    if (!t || t.readyState !== "live") throw new PageError("device_offline", "the camera is not live on the page");
    if (!Capture) throw new PageError("unsupported", "this browser cannot take a frame from the camera");
    return new Capture(t).grabFrame();
  }

  async function frame(): Promise<Frame & { width: number; height: number }> {
    const bmp = await bitmap();
    const captured_at = o.now();
    try {
      const { width, height } = fit(bmp.width, bmp.height, cfg.max_side_px);
      const canvas = new Canvas!(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new PageError("internal", "the page has no 2D canvas");
      ctx.drawImage(bmp, 0, 0, width, height);
      let blob = await canvas.convertToBlob({ type: "image/jpeg", quality: cfg.quality });
      // a frame over the process's 512 KiB: once more at a lower quality
      if (blob.size > 512 * 1024) blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.4 });
      return { mime: "image/jpeg", bytes: new Uint8Array(await blob.arrayBuffer()), captured_at, width, height };
    } finally {
      bmp.close();
    }
  }

  const configure: CommandSpec = {
    name: "configure",
    description:
      "Sets the size and quality of the next frames: max_side_px is the longest side (160..1280, default 640), quality the JPEG quality (0.3..0.9, default 0.7).",
    params: {
      type: "object",
      properties: {
        max_side_px: { type: "integer", minimum: 160, maximum: 1280 },
        quality: { type: "number", minimum: 0.3, maximum: 0.9 },
        ...(facings.length > 1 ? { facing: { type: "string", enum: facings } } : {}),
      },
      additionalProperties: false,
    },
    bound: { kind: "instant", max: 0 },
    moves: false,
  };

  const def: DeviceDef = {
    id: "camera",
    kind: "camera",
    roles: ["eyes"],
    description:
      "The camera of this browser page. A read of frame takes one JPEG when it is asked for (at most 2 per second); the person at the page sees a flash for each one.",
    channels: [
      { name: "frame", type: "image", description: "One JPEG frame, taken when the read asks for it." },
      { name: "width_px", type: "number", unit: "px", description: "Width of the frames this camera sends." },
      { name: "height_px", type: "number", unit: "px", description: "Height of the frames this camera sends." },
      {
        name: "facing",
        type: "string",
        description: "Which way the camera looks: user (at the person) or environment.",
      },
    ],
    commands: [configure],
    available: () => (stream && Capture && Canvas ? true : (why ?? "this browser cannot take a frame from the camera")),
    async read(channels) {
      const out: Record<string, Value | Frame | null> = {};
      if (channels.includes("frame")) {
        const f = await frame();
        Object.assign(out, { frame: f, width_px: f.width, height_px: f.height });
      } else {
        const s = size();
        Object.assign(out, { width_px: s.width, height_px: s.height });
      }
      out.facing = facing();
      return out;
    },
    async run(_command, args) {
      if (typeof args.max_side_px === "number") cfg.max_side_px = args.max_side_px;
      if (typeof args.quality === "number") cfg.quality = args.quality;
      if (typeof args.facing === "string" && args.facing !== facing()) {
        const md = win.navigator.mediaDevices;
        if (!md?.getUserMedia) throw new PageError("unsupported", "this browser cannot switch cameras");
        const next = await md.getUserMedia({ video: { facingMode: { exact: args.facing } } }).catch(() => {
          throw new PageError("unsupported", `this device has no camera facing ${String(args.facing)}`);
        });
        swap(next);
      }
      const s = size();
      return {
        max_side_px: cfg.max_side_px,
        quality: cfg.quality,
        width_px: s.width,
        height_px: s.height,
        facing: facing(),
      };
    },
  };
  kit.device(def);
  return {
    def,
    stream: () => stream,
    bitmap,
    track,
    onTrack: (cb) => void changed.push(cb),
    async reacquire() {
      const t = track();
      const md = win.navigator.mediaDevices;
      if (!t || t.readyState !== "ended" || !md?.getUserMedia) return;
      const want = lastFacing;
      try {
        const next = await md.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...(want ? { facingMode: want } : {}) },
        });
        if (stream === null) return void next.getTracks().forEach((x) => x.stop()); // the person stopped lending meanwhile
        swap(next);
        kit.up("camera");
      } catch (e) {
        kit.down("camera", `the page could not get the camera back: ${refusal(e, "camera")}`);
      }
    },
    close() {
      swap(null);
    },
  };
}
