// What the page takes from the browser, and the one tap that asks for it (CONTRACT §2.4, "Only what works is
// declared"). `Win` is the part of `window` the page uses; a test hands a fake (test/fakes.ts). Every capability is
// feature-detected here, and every refusal is kept with its reason for the manifest's `unavailable`.

/** A media track, as much as the page uses. */
export interface TrackLike {
  readonly kind: string;
  readonly readyState: string;
  readonly muted: boolean;
  enabled: boolean;
  stop(): void;
  getSettings(): { width?: number; height?: number; facingMode?: string; deviceId?: string };
  /** What the track can be set to; `torch` where the browser can switch the camera's light. */
  getCapabilities?(): { torch?: boolean };
  applyConstraints?(c: { advanced: { torch: boolean }[] }): Promise<void>;
  addEventListener(type: "mute" | "unmute" | "ended", cb: () => void): void;
}
export interface StreamLike {
  getTracks(): TrackLike[];
  getVideoTracks(): TrackLike[];
  getAudioTracks(): TrackLike[];
}
export interface BitmapLike {
  readonly width: number;
  readonly height: number;
  close(): void;
}
export interface CanvasLike {
  getContext(kind: "2d"): { drawImage(img: unknown, x: number, y: number, w: number, h: number): void } | null;
  convertToBlob(o: { type: string; quality: number }): Promise<Blob>;
}
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  onresult:
    | ((ev: {
        results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onerror: ((ev: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
export interface VoiceLike {
  readonly name: string;
  readonly lang: string;
  readonly default: boolean;
  readonly localService: boolean;
}
export interface UtteranceLike {
  text: string;
  lang: string;
  voice: VoiceLike | null;
  rate: number;
  onend: (() => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
}
export interface SynthLike {
  getVoices(): VoiceLike[];
  speak(u: UtteranceLike): void;
  cancel(): void;
  addEventListener(type: "voiceschanged", cb: () => void): void;
}
export interface AudioParamLike {
  value: number;
}
export interface AudioNodeLike {
  connect<T>(to: T): T;
  disconnect(): void;
}
export interface OscillatorLike extends AudioNodeLike {
  frequency: AudioParamLike;
  onended: (() => void) | null;
  start(when?: number): void;
  stop(when?: number): void;
}
export interface WorkletNodeLike extends AudioNodeLike {
  port: { onmessage: ((ev: { data: unknown }) => void) | null };
}
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  readonly state: string;
  resume(): Promise<void>;
  createOscillator(): OscillatorLike;
  createGain(): AudioNodeLike & { gain: AudioParamLike };
  createMediaStreamSource(s: StreamLike): AudioNodeLike;
  audioWorklet?: { addModule(url: string): Promise<void> };
}

/** One sample of the motion sensors, as a DeviceOrientationEvent or a DeviceMotionEvent carries it. */
export interface OrientationEventLike {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  absolute?: boolean;
  /** Safari on iOS: the compass heading, clockwise from north. */
  webkitCompassHeading?: number;
}
export interface MotionEventLike {
  acceleration?: { x: number | null; y: number | null; z: number | null } | null;
  accelerationIncludingGravity?: { x: number | null; y: number | null; z: number | null } | null;
  rotationRate?: { alpha: number | null; beta: number | null; gamma: number | null } | null;
}
/** DeviceMotionEvent or DeviceOrientationEvent: Safari on iOS asks the person through requestPermission. */
export interface MotionPermissionLike {
  requestPermission?(): Promise<string>;
}
export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener?(type: "release", cb: () => void): void;
}
export type MotionEventType = "deviceorientation" | "deviceorientationabsolute" | "devicemotion";

/** The part of `window` the page uses. Every member a browser may lack is optional. */
export interface Win {
  navigator: {
    language?: string;
    mediaDevices?: {
      getUserMedia?(c: { video?: unknown; audio?: unknown }): Promise<StreamLike>;
      enumerateDevices?(): Promise<{ kind: string }[]>;
    };
    wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
    /** What the browser grants, asked without a prompt. */
    permissions?: { query(d: { name: string }): Promise<{ state: string }> };
    vibrate?(pattern: number | number[]): boolean;
  };
  matchMedia?(query: string): { matches: boolean };
  addEventListener?(type: MotionEventType, cb: (ev: OrientationEventLike & MotionEventLike) => void): void;
  removeEventListener?(type: MotionEventType, cb: (ev: OrientationEventLike & MotionEventLike) => void): void;
  DeviceMotionEvent?: MotionPermissionLike;
  DeviceOrientationEvent?: MotionPermissionLike;
  isSecureContext?: boolean;
  SpeechRecognition?: new () => RecognitionLike;
  webkitSpeechRecognition?: new () => RecognitionLike;
  speechSynthesis?: SynthLike;
  SpeechSynthesisUtterance?: new (text: string) => UtteranceLike;
  AudioContext?: new () => AudioContextLike;
  webkitAudioContext?: new () => AudioContextLike;
  AudioWorkletNode?: new (ctx: AudioContextLike, name: string) => WorkletNodeLike;
  ImageCapture?: new (track: TrackLike) => { grabFrame(): Promise<BitmapLike> };
  OffscreenCanvas?: new (w: number, h: number) => CanvasLike;
}

/** What the tap obtained: each capability, or why not. */
export interface Unlocked {
  camera: { stream: StreamLike; facings: string[] } | { why: string };
  mic: { stream: StreamLike } | { why: string };
  /** The motion sensors: allowed (or no permission to ask), or why not. */
  motion: true | { why: string };
  audio: AudioContextLike | null;
  Recognition: (new () => RecognitionLike) | null;
  synth: { synth: SynthLike; Utterance: new (text: string) => UtteranceLike; voices: VoiceLike[] } | null;
}

/** Why a getUserMedia call failed, in plain words for `unavailable`. */
export function refusal(e: unknown, what: "camera" | "microphone"): string {
  const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "the person did not allow it";
  if (name === "NotFoundError" || name === "OverconstrainedError") return `this computer has no ${what}`;
  if (name === "NotReadableError" || name === "AbortError") return `another program holds the ${what}`;
  return `the browser refused it (${e instanceof Error ? e.message : String(e)})`.slice(0, 200);
}

/** A getUserMedia refusal that means the permission is gone, not that the device is busy or missing. */
export function denied(e: unknown): boolean {
  const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
  return name === "NotAllowedError" || name === "SecurityError";
}

/**
 * What the browser says of the camera's or the microphone's permission, without a prompt: "denied" (taken back),
 * "prompt" (asking would show the person a prompt: Safari on iOS answers so after a lock), or null when it says
 * granted or cannot say (no Permissions API, or one that does not know the name). The page asks outside a tap only on
 * null, and a refusal then is said the same way as "denied".
 */
export async function permissionState(win: Win, what: "camera" | "microphone"): Promise<"denied" | "prompt" | null> {
  let state: string | undefined;
  try {
    state = (await win.navigator.permissions?.query({ name: what }))?.state;
  } catch {
    return null;
  }
  return state === "denied" || state === "prompt" ? state : null;
}
/** Why a device whose permission the browser would ask for again is down: the banner's button is that tap. */
export const tapToResume = (what: "camera" | "microphone") =>
  `the browser asks for the ${what} again: tap the page to resume`;
/** The end of the reason a device left the manifest for: what the person does to lend it again. */
export const LEND_AGAIN = "reload the page and tap Lend this device to lend it again";

/** The voices the browser lists; some browsers fill the list only after `voiceschanged`. */
export function voices(synth: SynthLike, waitMs = 1500): Promise<VoiceLike[]> {
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(synth.getVoices());
    synth.addEventListener("voiceschanged", done);
    setTimeout(done, waitMs);
  });
}

/**
 * Whether the page may have motion events. Safari on iOS (and Chrome from 152) asks the person through
 * DeviceMotionEvent.requestPermission, which a browser allows only inside a tap: call this before any await.
 */
export function motionPermission(win: Win): Promise<true | { why: string }> {
  const kinds = [win.DeviceMotionEvent, win.DeviceOrientationEvent].filter((k) => k !== undefined);
  if (!kinds.length || !win.addEventListener) return Promise.resolve({ why: "this browser has no motion sensors" });
  const asks = kinds.filter((k) => typeof k.requestPermission === "function");
  if (!asks.length) return Promise.resolve(true);
  return Promise.all(
    asks.map((k) =>
      k.requestPermission!().then(
        (r) => r,
        (e: unknown) => (e && typeof e === "object" && "name" in e ? String(e.name) : "denied"),
      ),
    ),
  ).then((answers) =>
    answers.some((a) => a === "granted") ? true : { why: "the person did not allow the motion sensors" },
  );
}

/**
 * The one tap ("Lend this device"): asks for the camera, the microphone and the motion sensors, starts audio and
 * warms speech up. Call it from the click handler: a browser gates each of these behind a gesture.
 */
export async function unlock(win: Win): Promise<Unlocked> {
  const md = win.navigator.mediaDevices;
  const noMedia =
    win.isSecureContext === false
      ? "the page is not a secure context"
      : "this browser gives a page no camera or microphone (mediaDevices.getUserMedia)";
  const Ctx = win.AudioContext ?? win.webkitAudioContext;
  let audio: AudioContextLike | null = null;
  if (Ctx) {
    audio = new Ctx();
    void audio.resume().catch(() => {});
  }
  const synth =
    win.speechSynthesis && win.SpeechSynthesisUtterance
      ? { synth: win.speechSynthesis, Utterance: win.SpeechSynthesisUtterance }
      : null;
  const [motion, camera, mic, voiceList] = await Promise.all([
    motionPermission(win),
    md?.getUserMedia
      ? md.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } }).then(
          async (stream) => ({ stream, facings: await facings(win, stream) }),
          (e: unknown) => ({ why: refusal(e, "camera") }),
        )
      : Promise.resolve({ why: noMedia }),
    md?.getUserMedia
      ? md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(
          (stream) => ({ stream }),
          (e: unknown) => ({ why: refusal(e, "microphone") }),
        )
      : Promise.resolve({ why: noMedia }),
    synth ? voices(synth.synth) : Promise.resolve([] as VoiceLike[]),
  ]);
  return {
    camera,
    mic,
    motion,
    audio,
    Recognition: win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null,
    synth: synth ? { ...synth, voices: voiceList } : null,
  };
}

/** The facings a configure may ask for: both only where the device has more than one camera. */
async function facings(win: Win, stream: StreamLike): Promise<string[]> {
  const own = stream.getVideoTracks()[0]?.getSettings().facingMode;
  const list = (await win.navigator.mediaDevices?.enumerateDevices?.().catch(() => [])) ?? [];
  const cameras = list.filter((d) => d.kind === "videoinput").length;
  return cameras > 1 ? ["user", "environment"] : [own === "environment" ? "environment" : "user"];
}
