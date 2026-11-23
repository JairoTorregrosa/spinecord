// A fake browser for the peripheral page (no DOM): the part of `window` the page uses (src/browser.ts `Win`), with
// switches for what the browser has and what the person allows. Frames are tiny JPEG headers of the right size;
// the recognizer hears what a test tells it; speech ends at once.
import type {
  AudioContextLike,
  BitmapLike,
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

export function fakeTrack(kind: "video" | "audio", settings: ReturnType<TrackLike["getSettings"]> = {}) {
  const on: Record<string, (() => void)[]> = {};
  const track: TrackLike & { fire(type: "mute" | "unmute" | "ended"): void; stopped: boolean } = {
    kind,
    readyState: "live",
    muted: false,
    enabled: true,
    stopped: false,
    stop() {
      track.stopped = true;
      (track as { readyState: string }).readyState = "ended";
    },
    getSettings: () => settings,
    addEventListener: (type, cb) => void (on[type] ??= []).push(cb),
    fire: (type) => on[type]?.forEach((cb) => cb()),
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
}

export const VOICES: VoiceLike[] = [
  { name: "Mónica", lang: "es-ES", default: false, localService: true },
  { name: "Paulina", lang: "es-MX", default: false, localService: true },
  { name: "Samantha", lang: "en-US", default: true, localService: true },
];

export function fakeBrowser(o: FakeBrowserOptions = {}) {
  const video = fakeTrack("video", { width: 1280, height: 720, facingMode: "user" });
  const audioTrack = fakeTrack("audio");
  const asked: string[] = [];
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
                if (c.video) {
                  asked.push("camera");
                  const how = o.camera ?? "allow";
                  return how === "allow" ? stream([video]) : reject(how);
                }
                asked.push("microphone");
                const how = o.microphone ?? "allow";
                return how === "allow" ? stream([audioTrack]) : reject(how);
              },
              enumerateDevices: async () => Array.from({ length: o.cameras ?? 1 }, () => ({ kind: "videoinput" })),
            },
          }),
    },
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
    video,
    audioTrack,
    asked,
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
