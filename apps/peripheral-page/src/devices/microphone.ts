// The microphone kind (CONTRACT §2.3): `listen` waits for one phrase through the browser's speech recognition and
// matches it with `expect` on the page; `level_pct` is the loudness, pushed from the audio thread. `listen` is
// declared only where the browser has speech recognition, `level_pct` only where the page has an audio stream and
// an audio worklet; a microphone with neither is not lent.
import type { CommandSpec, Value } from "../../../../packages/protocol/types";
import {
  refusal,
  type AudioContextLike,
  type AudioNodeLike,
  type RecognitionLike,
  type StreamLike,
  type TrackLike,
  type Win,
  type WorkletNodeLike,
} from "../browser";
import { ended, PageError, type DeviceDef, type Ended, type Kit, type Measured } from "../kit";

/** Case, accents and spacing ignored: "Ya me la TOMÉ " and "ya me la tome" are the same phrase. */
export const norm = (s: string): string =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/** The first expected phrase the transcript contains, else "". */
export function matchPhrase(transcript: string, expect: readonly string[]): string {
  const t = norm(transcript);
  return expect.find((p) => norm(p) !== "" && t.includes(norm(p))) ?? "";
}

/** Recognizer errors that end a listen with a contract code (the others answer internal). */
const RECOGNIZER_ERRORS: Record<
  string,
  { code: "unsupported" | "invalid_argument" | "timeout" | "device_offline"; why: string }
> = {
  "not-allowed": { code: "unsupported", why: "the browser did not allow speech recognition on this page" },
  "service-not-allowed": { code: "unsupported", why: "the browser's speech service is not available on this page" },
  "language-not-supported": { code: "invalid_argument", why: "the browser cannot recognize that language" },
  network: { code: "timeout", why: "the browser's speech service could not be reached" },
  "audio-capture": { code: "device_offline", why: "the browser could not capture audio from the microphone" },
};

const QUICK_END_MS = 250;
type Heard = { heard: true; transcript: string; confidence: number } | { heard: false; why: "timeout" | "preempted" };

/** One phrase, or nothing within maxMs. The recognizer is started again when it ends early without a phrase. */
export function recognizeOnce(
  Recognition: new () => RecognitionLike,
  lang: string,
  maxMs: number,
  signal: AbortSignal,
  now: () => number,
): Promise<Heard> {
  const deadline = now() + maxMs;
  return new Promise<Heard>((resolve, reject) => {
    let rec: RecognitionLike | null = null;
    let settled = false;
    let quick = 0; // attempts in a row that ended within QUICK_END_MS of their start
    const finish = (r: Heard | PageError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const old = rec;
      rec = null;
      try {
        old?.abort();
      } catch {
        // already ended
      }
      if (r instanceof PageError) reject(r);
      else resolve(r);
    };
    const onAbort = () => finish({ heard: false, why: "preempted" });
    const timer = setTimeout(() => finish({ heard: false, why: "timeout" }), maxMs);
    signal.addEventListener("abort", onAbort, { once: true });
    const attempt = () => {
      if (settled) return;
      if (now() >= deadline) return finish({ heard: false, why: "timeout" });
      const started = now();
      const r = new Recognition();
      rec = r;
      r.lang = lang;
      r.continuous = false;
      r.interimResults = false;
      r.maxAlternatives = 1;
      r.onresult = (ev) => {
        for (let i = 0; i < ev.results.length; i++) {
          const res = ev.results[i]!;
          if (!res.isFinal) continue;
          const alt = res[0];
          if (alt && alt.transcript.trim())
            return finish({ heard: true, transcript: alt.transcript.trim(), confidence: alt.confidence || 0 });
        }
      };
      r.onerror = (ev) => {
        if (rec !== r || ev.error === "no-speech" || ev.error === "aborted") return; // onend follows
        const known = RECOGNIZER_ERRORS[ev.error];
        finish(new PageError(known?.code ?? "internal", `speech recognition: ${known?.why ?? ev.error}`));
      };
      r.onend = () => {
        if (rec !== r) return;
        quick = now() - started < QUICK_END_MS ? quick + 1 : 0;
        if (quick >= 5)
          return finish(new PageError("device_offline", "speech recognition ends as soon as it starts on this page"));
        attempt(); // ended without a phrase: listen again while time is left
      };
      try {
        r.start();
      } catch (e) {
        finish(new PageError("internal", `speech recognition did not start: ${(e as Error).message}`));
      }
    };
    attempt();
  });
}

export interface MicrophoneOptions {
  kit: Kit;
  win: Win;
  got: { stream: StreamLike } | { why: string };
  Recognition: (new () => RecognitionLike) | null;
  audio: AudioContextLike | null;
  /** The URL of the level worklet (served next to the page). */
  workletUrl: string;
  /** The language of a listen that names none. */
  lang: string;
  now: () => number;
}
export interface Microphone {
  def: DeviceDef;
  /** The live stream; null once the person stopped lending. */
  stream(): StreamLike | null;
  /** Starts the level meter; resolves false where the page has no audio worklet. */
  meter(): Promise<boolean>;
  /** The page is visible again: a track the browser ended while it was hidden is asked for again. */
  reacquire(): Promise<void>;
  close(): void;
}

export function microphone(o: MicrophoneOptions): Microphone {
  const { kit } = o;
  let stream = "stream" in o.got ? o.got.stream : null;
  const refused = "why" in o.got ? o.got.why : null;
  let node: WorkletNodeLike | null = null;
  let source: AudioNodeLike | null = null;
  const track = (): TrackLike | null => stream?.getAudioTracks()[0] ?? null;
  // events of a track that is no longer the lent one say nothing about the microphone
  const watch = (t: TrackLike | null) => {
    t?.addEventListener("mute", () => t === track() && kit.down("mic", "the microphone stopped sending sound"));
    t?.addEventListener("unmute", () => t === track() && kit.up("mic"));
    t?.addEventListener("ended", () => t === track() && kit.down("mic", "the microphone was turned off or unplugged"));
  };
  watch(track());
  const connect = () => {
    source?.disconnect();
    source = null;
    if (stream && node && o.audio) {
      source = o.audio.createMediaStreamSource(stream);
      source.connect(node);
    }
  };
  let metered = false;
  let heard = 0;
  const listen: CommandSpec = {
    name: "listen",
    description: `Waits for one spoken phrase, at most max_ms. lang is a BCP 47 tag (default ${o.lang}). expect: phrases matched on the page, case and accents ignored, as a substring. measured: {heard, transcript, confidence, match}.`,
    params: {
      type: "object",
      properties: {
        max_ms: { type: "integer", minimum: 500, maximum: 15000 },
        lang: { type: "string", minLength: 2, maxLength: 35 },
        expect: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 8 },
      },
      required: ["max_ms"],
      additionalProperties: false,
    },
    bound: { kind: "ms", params: ["max_ms"], max: 15000 },
    moves: false,
  };
  const canListen = () => stream !== null && o.Recognition !== null;
  const where =
    "Recognition runs in the browser's speech service: on desktop Chrome and Edge it may send the audio to the browser vendor's service.";

  const def: DeviceDef = {
    id: "mic",
    kind: "microphone",
    roles: ["ears"],
    get description() {
      return canListen()
        ? `The microphone of this browser page. listen hears one phrase on demand, never continuously. ${where}`
        : "The microphone of this browser page: loudness only, this browser has no speech recognition.";
    },
    get channels() {
      return [
        { name: "listening", type: "boolean" as const, pushed: true, description: "true while a listen runs." },
        {
          name: "last_transcript",
          type: "string" as const,
          pushed: true,
          description: 'The latest phrase heard; "" before the first.',
        },
        {
          name: "last_match",
          type: "string" as const,
          pushed: true,
          description: 'The expected phrase the latest phrase matched; "" when none.',
        },
        {
          name: "heard_count",
          type: "number" as const,
          pushed: true,
          description: "Phrases heard since the page joined.",
        },
        ...(metered
          ? [
              {
                name: "level_pct",
                type: "number" as const,
                unit: "pct",
                range: [0, 100] as [number, number],
                max_rate_hz: 10,
                pushed: true,
                description: "Loudness at the microphone, 0..100, pushed at most 10 times per second.",
              },
            ]
          : []),
      ];
    },
    get commands() {
      return canListen() ? [listen] : [];
    },
    available: () => {
      if (!stream) return refused ?? "the person stopped lending it";
      if (!canListen() && !metered) return "this browser has neither speech recognition nor an audio level meter";
      return true;
    },
    async run(_command, args, signal): Promise<Measured | Ended> {
      if (!canListen()) throw new PageError("unsupported", "this browser has no speech recognition");
      const expect = Array.isArray(args.expect) ? (args.expect as Value[]).map(String) : [];
      const lang = typeof args.lang === "string" ? args.lang : o.lang;
      kit.push("mic", { listening: true });
      try {
        const r = await recognizeOnce(o.Recognition!, lang, Number(args.max_ms), signal, o.now);
        if (!r.heard) return ended(r.why, { heard: false, transcript: "", confidence: 0, match: "" });
        const match = matchPhrase(r.transcript, expect);
        heard++;
        kit.push("mic", { last_transcript: r.transcript, last_match: match, heard_count: heard });
        return { heard: true, transcript: r.transcript, confidence: r.confidence, match };
      } finally {
        if (stream) kit.push("mic", { listening: false });
      }
    },
  };
  kit.device(def);
  kit.push("mic", { listening: false, last_transcript: "", last_match: "", heard_count: 0 });

  return {
    def,
    stream: () => stream,
    async meter() {
      const Node = o.win.AudioWorkletNode;
      if (!stream || !o.audio?.audioWorklet || !Node) return false;
      await o.audio.audioWorklet.addModule(o.workletUrl);
      const n = new Node(o.audio, "spinecord-level");
      node = n;
      connect();
      n.port.onmessage = (ev) => {
        const v = Number(ev.data);
        if (stream && metered && Number.isFinite(v))
          kit.push("mic", { level_pct: Math.max(0, Math.min(100, Math.round(v))) });
      };
      metered = true;
      kit.announce();
      kit.push("mic", { level_pct: 0 });
      return true;
    },
    async reacquire() {
      const t = track();
      const md = o.win.navigator.mediaDevices;
      if (!t || t.readyState !== "ended" || !md?.getUserMedia) return;
      try {
        const next = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (stream === null) return void next.getTracks().forEach((x) => x.stop()); // the person stopped lending meanwhile
        for (const old of stream.getTracks()) old.stop();
        stream = next;
        watch(track());
        connect();
        kit.up("mic");
      } catch (e) {
        kit.down("mic", `the page could not get the microphone back: ${refusal(e, "microphone")}`);
      }
    },
    close() {
      source?.disconnect();
      source = null;
      node?.disconnect();
      node = null;
      for (const t of stream?.getTracks() ?? []) t.stop();
      stream = null;
    },
  };
}
