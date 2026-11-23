// A fake browser for the peripheral page (no DOM): the part of `window` the page uses (src/browser.ts `Win`), with
// switches for what the browser has and what the person allows. Frames are tiny JPEG headers of the right size;
// the recognizer hears what a test tells it; speech ends at once.
import type {
  AudioContextLike,
  BitmapLike,
  MotionEventLike,
  MotionEventType,
  OrientationEventLike,
  WakeLockSentinelLike,
  CanvasLike,
  RecognitionLike,
  StreamLike,
  SynthLike,
  TrackLike,
  UtteranceLike,
  VoiceLike,
  Win,
  WorkletNodeLike,
} from "../src/browser";
import type { SocketLike } from "../src/kit";

/** SOI + SOF0 of a w × h JPEG: enough for a size check, nothing to decode. */
export function jpegHeader(w: number, h: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    h >> 8,
    h & 0xff,
    w >> 8,
    w & 0xff,
    ...new Array(12).fill(0),
  ]);
}

export function fakeTrack(kind: "video" | "audio", settings: ReturnType<TrackLike["getSettings"]> = {}, torch = false) {
  const on: Record<string, (() => void)[]> = {};
  const track: TrackLike & {
    fire(type: "mute" | "unmute" | "ended"): void;
    /** The browser ends the track (a phone locked): ended, then the event. */
    end(): void;
    stopped: boolean;
    torchOn: boolean;
    constraints: unknown[];
  } = {
    kind,
    readyState: "live",
    muted: false,
    enabled: true,
    stopped: false,
    stop() {
      track.stopped = true;
      (track as { readyState: string }).readyState = "ended";
    },
    torchOn: false,
    constraints: [],
    getSettings: () => settings,
    ...(kind === "video"
      ? {
          // methods that check `this`, as a browser's do ("Illegal invocation")
          getCapabilities(this: unknown) {
            if (this !== track) throw new TypeError("Illegal invocation");
            return torch ? { torch: true } : {};
          },
          async applyConstraints(this: unknown, c: { advanced: { torch: boolean }[] }) {
            if (this !== track) throw new TypeError("Illegal invocation");
            track.constraints.push(c);
            if (!torch) throw Object.assign(new Error("torch is not supported"), { name: "OverconstrainedError" });
            track.torchOn = c.advanced[0]!.torch;
          },
        }
      : {}),
    addEventListener: (type, cb) => void (on[type] ??= []).push(cb),
    fire: (type) => on[type]?.forEach((cb) => cb()),
    end() {
      (track as { readyState: string }).readyState = "ended";
      track.fire("ended");
    },
  };
  return track;
}
const stream = (tracks: TrackLike[]): StreamLike => ({
  getTracks: () => tracks,
  getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
  getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
});

export interface FakeBrowserOptions {
  /** false: no navigator.mediaDevices. */
  media?: boolean;
  /** What getUserMedia does for each: allow, or a DOMException name to reject with. */
  camera?: "allow" | "NotAllowedError" | "NotFoundError";
  microphone?: "allow" | "NotAllowedError" | "NotFoundError";
  recognition?: "SpeechRecognition" | "webkitSpeechRecognition" | false;
  synthesis?: boolean;
  voices?: VoiceLike[];
  audio?: boolean;
  worklet?: boolean;
  imageCapture?: boolean;
  /** How many cameras enumerateDevices lists. */
  cameras?: number;
  /**
   * The motion sensors: false, no event types at all; "events", a first sample of each event type is sent when the
   * page listens; "silent", the event types and no sample (a desktop browser).
   */
  motion?: false | "events" | "silent";
  /** Safari on iOS: DeviceMotionEvent.requestPermission answers this. */
  motionPermission?: "granted" | "denied";
  /** navigator.vibrate exists. */
  vibrate?: boolean;
  /** The primary pointer: coarse on a phone. */
  pointer?: "coarse" | "fine";
  /** The video track has a torch. */
  torch?: boolean;
  /** navigator.wakeLock: true grants, "denied" rejects, false absent. */
  wakeLock?: boolean | "denied";
  /** navigator.permissions: present, answering "granted" for every name until a test changes one. */
  permissions?: boolean;
}

export const VOICES: VoiceLike[] = [
  { name: "Mónica", lang: "es-ES", default: false, localService: true },
  { name: "Paulina", lang: "es-MX", default: false, localService: true },
  { name: "Samantha", lang: "en-US", default: true, localService: true },
];

export function fakeBrowser(o: FakeBrowserOptions = {}) {
  const videos = [fakeTrack("video", { width: 1280, height: 720, facingMode: "user" }, o.torch)];
  const audios = [fakeTrack("audio")];
  const asked: string[] = [];
  // the getUserMedia calls after the first ones (a configure, a re-acquire) get new tracks
  const nextVideo = (facing: string) => {
    const t = fakeTrack("video", { width: 1280, height: 720, facingMode: facing }, o.torch);
    videos.push(t);
    return t;
  };
  let videoCalls = 0;
  let audioCalls = 0;
  let refuseAgain: string | null = null;
  let holdMedia = false;
  const permissionStates: Record<string, string> = {};
  const winListeners: Partial<Record<MotionEventType, ((ev: any) => void)[]>> = {};
  const vibrations: (number | number[])[] = [];
  const wake = { requests: 0, sentinels: [] as (WakeLockSentinelLike & { fireRelease(): void })[] };
  const permissionAsks: string[] = [];
  let motionAllowed = o.motionPermission !== "denied";
  const sample = (type: MotionEventType): OrientationEventLike & MotionEventLike =>
    type === "devicemotion"
      ? {
          alpha: null,
          beta: null,
          gamma: null,
          acceleration: { x: 0, y: 0, z: 0 },
          accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 },
          rotationRate: { alpha: 0, beta: 0, gamma: 0 },
        }
      : {
          alpha: type === "deviceorientationabsolute" ? 90 : 10,
          beta: 0,
          gamma: 0,
          absolute: type === "deviceorientationabsolute",
        };
  const fireWin = (type: MotionEventType, ev: unknown) => winListeners[type]?.forEach((cb) => cb(ev));
  const recognizers: FakeRecognition[] = [];
  const spoken: UtteranceLike[] = [];
  const worklets: WorkletNodeLike[] = [];
  let heard: { transcript: string; confidence: number } | "silence" | { error: string } = "silence";

  const reject = (name: string) => Promise.reject(Object.assign(new Error(name), { name }));
  class FakeRecognition implements RecognitionLike {
    lang = "";
    continuous = true;
    interimResults = true;
    maxAlternatives = 5;
    onresult: RecognitionLike["onresult"] = null;
    onerror: RecognitionLike["onerror"] = null;
    onend: RecognitionLike["onend"] = null;
    aborted = false;
    start() {
      recognizers.push(this);
      const h = heard;
      setTimeout(
        () => {
          if (this.aborted) return;
          if (h === "silence") this.onerror?.({ error: "no-speech" });
          else if ("error" in h) this.onerror?.({ error: h.error });
          else {
            const alt = Object.assign([{ transcript: h.transcript, confidence: h.confidence }], { isFinal: true });
            this.onresult?.({ results: [alt] });
          }
          this.onend?.();
        },
        h === "silence" ? 300 : 20,
      );
    }
    abort() {
      if (this.aborted) return;
      this.aborted = true;
      setTimeout(() => {
        this.onerror?.({ error: "aborted" });
        this.onend?.();
      }, 0);
    }
  }
  class FakeUtterance implements UtteranceLike {
    lang = "";
    voice: VoiceLike | null = null;
    rate = 1;
    onend: (() => void) | null = null;
    onerror: ((ev: { error: string }) => void) | null = null;
    constructor(public text: string) {}
  }
  let speaking: UtteranceLike | null = null;
  const synth: SynthLike & { hold: boolean } = {
    hold: false,
    getVoices: () => o.voices ?? VOICES,
    speak(u) {
      spoken.push(u);
      speaking = u;
      if (!synth.hold) setTimeout(() => speaking === u && ((speaking = null), u.onend?.()), 5);
    },
    cancel() {
      const u = speaking;
      speaking = null;
      u?.onerror?.({ error: "interrupted" });
    },
    addEventListener() {},
  };
  const node = (): WorkletNodeLike => ({ connect: (t) => t, disconnect() {}, port: { onmessage: null } });
  class FakeAudioContext implements AudioContextLike {
    currentTime = 0;
    destination = {};
    state = "running";
    async resume() {}
    createOscillator() {
      const osc = {
        frequency: { value: 0 },
        onended: null as (() => void) | null,
        connect: <T>(t: T) => t,
        disconnect() {},
        start() {},
        stop(when?: number) {
          setTimeout(() => osc.onended?.(), when === undefined ? 0 : Math.max(0, when * 1000));
        },
      };
      return osc;
    }
    createGain() {
      return { gain: { value: 1 }, connect: <T>(t: T) => t, disconnect() {} };
    }
    createMediaStreamSource() {
      return { connect: <T>(t: T) => t, disconnect() {} };
    }
    audioWorklet = o.worklet === false ? undefined : { addModule: async () => {} };
  }
  class FakeImageCapture {
    constructor(private t: TrackLike) {}
    async grabFrame(): Promise<BitmapLike> {
      const s = this.t.getSettings();
      return { width: s.width ?? 640, height: s.height ?? 480, close() {} };
    }
  }
  class FakeCanvas implements CanvasLike {
    constructor(
      private w: number,
      private h: number,
    ) {}
    getContext() {
      return { drawImage() {} };
    }
    async convertToBlob() {
      return new Blob([jpegHeader(this.w, this.h) as Uint8Array<ArrayBuffer>], { type: "image/jpeg" });
    }
  }

  const win: Win = {
    isSecureContext: true,
    navigator: {
      language: "es-ES",
      ...(o.media === false
        ? {}
        : {
            mediaDevices: {
              async getUserMedia(c) {
                if (holdMedia) return new Promise(() => {}); // a prompt nobody answers
                if (c.video) {
                  asked.push("camera");
                  const how = refuseAgain && videoCalls > 0 ? refuseAgain : (o.camera ?? "allow");
                  if (how !== "allow") return reject(how);
                  const facing = (c.video as { facingMode?: string | { exact: string } }).facingMode;
                  const f = typeof facing === "string" ? facing : (facing?.exact ?? "user");
                  return stream([videoCalls++ === 0 ? videos[0]! : nextVideo(f)]);
                }
                asked.push("microphone");
                const how = refuseAgain && audioCalls > 0 ? refuseAgain : (o.microphone ?? "allow");
                if (how !== "allow") return reject(how);
                if (audioCalls++ > 0) audios.push(fakeTrack("audio"));
                return stream([audios.at(-1)!]);
              },
              enumerateDevices: async () => Array.from({ length: o.cameras ?? 1 }, () => ({ kind: "videoinput" })),
            },
          }),
      ...(o.vibrate
        ? {
            vibrate(this: unknown, pattern: number | number[]) {
              if (this !== win.navigator) throw new TypeError("Illegal invocation");
              vibrations.push(pattern);
              return true;
            },
          }
        : {}),
      ...(o.permissions
        ? {
            permissions: {
              async query(d: { name: string }) {
                permissionAsks.push(`query ${d.name}`);
                return { state: permissionStates[d.name] ?? "granted" };
              },
            },
          }
        : {}),
      ...(o.wakeLock === false
        ? {}
        : {
            wakeLock: {
              async request() {
                wake.requests++;
                if (o.wakeLock === "denied") throw Object.assign(new Error("not allowed"), { name: "NotAllowedError" });
                const on: (() => void)[] = [];
                const sentinel = {
                  released: false,
                  async release() {
                    if (sentinel.released) return;
                    sentinel.released = true;
                    on.forEach((cb) => cb());
                  },
                  addEventListener: (_t: "release", cb: () => void) => void on.push(cb),
                  fireRelease: () => void sentinel.release(),
                };
                wake.sentinels.push(sentinel);
                return sentinel;
              },
            },
          }),
    },
    matchMedia: (q: string) => ({ matches: q === "(pointer: coarse)" && o.pointer === "coarse" }),
    ...(o.motion
      ? {
          addEventListener(type: MotionEventType, cb: (ev: any) => void) {
            const first = !winListeners[type]?.length;
            (winListeners[type] ??= []).push(cb);
            if (first && o.motion === "events") setTimeout(() => motionAllowed && fireWin(type, sample(type)), 1);
          },
          removeEventListener(type: MotionEventType, cb: (ev: any) => void) {
            winListeners[type] = (winListeners[type] ?? []).filter((x) => x !== cb);
          },
          DeviceMotionEvent: o.motionPermission
            ? {
                requestPermission: async () => {
                  permissionAsks.push("motion");
                  return o.motionPermission!;
                },
              }
            : {},
          DeviceOrientationEvent: o.motionPermission
            ? {
                requestPermission: async () => {
                  permissionAsks.push("orientation");
                  return o.motionPermission!;
                },
              }
            : {},
        }
      : {}),
    ...(o.recognition === false ? {} : { [o.recognition ?? "webkitSpeechRecognition"]: FakeRecognition }),
    ...(o.synthesis === false ? {} : { speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance }),
    ...(o.audio === false ? {} : { AudioContext: FakeAudioContext }),
    ...(o.worklet === false
      ? {}
      : {
          // a constructor function: `new` returns the node it made
          AudioWorkletNode: function AudioWorkletNode() {
            const n = node();
            worklets.push(n);
            return n;
          } as unknown as Win["AudioWorkletNode"],
        }),
    ...(o.imageCapture === false ? {} : { ImageCapture: FakeImageCapture }),
    OffscreenCanvas: FakeCanvas,
  };
  return {
    win,
    /** The latest video and audio tracks getUserMedia gave. */
    get video() {
      return videos.at(-1)!;
    },
    get audioTrack() {
      return audios.at(-1)!;
    },
    videos,
    asked,
    vibrations,
    wake,
    permissionAsks,
    /** Further getUserMedia calls are refused: NotAllowedError, the person or the browser took the permission back. */
    refuseAgain(name = "NotAllowedError") {
      refuseAgain = name;
    },
    /** Further getUserMedia calls never settle (a prompt nobody answers). */
    holdMedia() {
      holdMedia = true;
    },
    /** What navigator.permissions.query answers for a name from then on. */
    permission(name: "camera" | "microphone", state: "granted" | "denied" | "prompt") {
      permissionStates[name] = state;
    },
    /** A deviceorientation (or deviceorientationabsolute) event. */
    orient(ev: OrientationEventLike, absolute = false) {
      fireWin(absolute ? "deviceorientationabsolute" : "deviceorientation", ev);
    },
    /** A devicemotion event. */
    move(ev: MotionEventLike) {
      fireWin("devicemotion", ev);
    },
    recognizers,
    spoken,
    synth,
    /** What the next recognizer hears. */
    hear(h: typeof heard) {
      heard = h;
    },
    /** The level worklet posts a loudness. */
    level(v: number) {
      for (const n of worklets) n.port.onmessage?.({ data: v });
    },
  };
}

/** A socket that records what the page sends and lets a test play the process. */
export function fakeSocket() {
  const on: Record<string, ((ev: { data?: unknown; code?: number; reason?: string }) => void)[]> = {};
  const sent: unknown[] = [];
  const socket: SocketLike & { opened: number } = {
    opened: 0,
    binaryType: "blob",
    send: (d) => void sent.push(typeof d === "string" ? JSON.parse(d) : d),
    close: (code = 1000, reason = "") => on.close?.forEach((cb) => cb({ code, reason })),
    addEventListener: (type, cb) => void (on[type] ??= []).push(cb),
  };
  return {
    socket,
    sent,
    /** The text messages sent, parsed. */
    json: () => sent.filter((m) => !(m instanceof Uint8Array)) as Record<string, any>[],
    open: () => on.open?.forEach((cb) => cb({})),
    receive: (m: unknown) => on.message?.forEach((cb) => cb({ data: JSON.stringify(m) })),
    closeFromServer: (code: number, reason: string) => on.close?.forEach((cb) => cb({ code, reason })),
  };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
