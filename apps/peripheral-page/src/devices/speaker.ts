// The speaker kind (CONTRACT §2.3): `speak` through the browser's speech synthesis, with `lang` and `voice` as
// enums of the voices this browser lists, and `tone` through Web Audio. Each is declared only where it works.
import type { CommandSpec, Value } from "../../../../packages/protocol/types";
import type { AudioContextLike, SynthLike, UtteranceLike, VoiceLike } from "../browser";
import { ended, PageError, type DeviceDef, type Ended, type Kit, type Measured } from "../kit";

/** At most this many voices in the manifest: those of the default language first. */
export const MAX_VOICES = 40;
/** Words per minute of a speech rate of 1. */
const WPM_AT_RATE_1 = 180;
const SPEAK_MS = 15000;

/** The voice for a language: an exact tag first, then the same base language; the browser's default first. */
export function voiceFor(list: readonly VoiceLike[], lang: string): VoiceLike | null {
  const l = lang.toLowerCase().replace("_", "-");
  const base = l.split("-")[0];
  const rank = (v: VoiceLike) => (v.default ? 0 : 1) + (v.localService ? 0 : 2);
  const sorted = [...list].sort((a, b) => rank(a) - rank(b));
  return (
    sorted.find((v) => v.lang.toLowerCase().replace("_", "-") === l) ??
    sorted.find((v) => v.lang.toLowerCase().split(/[-_]/)[0] === base) ??
    null
  );
}

export interface SpeakerOptions {
  kit: Kit;
  synth: { synth: SynthLike; Utterance: new (text: string) => UtteranceLike; voices: VoiceLike[] } | null;
  audio: AudioContextLike | null;
  /** The language of a speak that names none, when a voice has it. */
  lang: string;
}

export function speaker(o: SpeakerOptions): { def: DeviceDef } {
  const { kit } = o;
  const all = o.synth?.voices ?? [];
  const base = o.lang.toLowerCase().split("-")[0]!;
  const voices = [...all]
    .sort((a, b) => Number(!a.lang.toLowerCase().startsWith(base)) - Number(!b.lang.toLowerCase().startsWith(base)))
    .slice(0, MAX_VOICES);
  const langs = [...new Set(voices.map((v) => v.lang))].sort();
  const fallback = voiceFor(voices, o.lang) ?? voices.find((v) => v.default) ?? voices[0] ?? null;
  let spoken = 0;
  let utterance: UtteranceLike | null = null;
  let osc: { stop(): void } | null = null;

  const commands: CommandSpec[] = [];
  if (o.synth && voices.length)
    commands.push({
      name: "speak",
      description: `Says a text and returns when it has been said (at most 15 s). lang and voice are what this browser lists; default voice ${fallback?.name ?? "the browser's"} (${fallback?.lang ?? o.lang}). rate_wpm is words per minute. measured: {spoken}.`,
      params: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: 300 },
          lang: { type: "string", enum: langs },
          voice: { type: "string", enum: voices.map((v) => v.name) },
          rate_wpm: { type: "integer", minimum: 60, maximum: 400 },
        },
        required: ["text"],
        additionalProperties: false,
      },
      bound: { kind: "ms", max: SPEAK_MS },
      moves: false,
    });
  if (o.audio)
    commands.push({
      name: "tone",
      description: "Plays a sine tone of frequency_hz for duration_ms (at most 2000) and returns when it has ended.",
      params: {
        type: "object",
        properties: {
          frequency_hz: { type: "number", minimum: 40, maximum: 8000 },
          duration_ms: { type: "integer", minimum: 10, maximum: 2000 },
        },
        required: ["frequency_hz", "duration_ms"],
        additionalProperties: false,
      },
      bound: { kind: "ms", params: ["duration_ms"], max: 2000 },
      moves: false,
    });

  function speak(args: Record<string, Value>, signal: AbortSignal): Promise<Measured | Ended> {
    const s = o.synth!;
    const text = String(args.text);
    const u = new s.Utterance(text);
    const voice =
      (typeof args.voice === "string" ? voices.find((v) => v.name === args.voice) : null) ??
      (typeof args.lang === "string" ? voiceFor(voices, args.lang) : null) ??
      fallback;
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    if (typeof args.rate_wpm === "number") u.rate = Math.min(10, Math.max(0.1, args.rate_wpm / WPM_AT_RATE_1));
    return new Promise((resolve, reject) => {
      let done = false;
      const end = (r: Measured | Ended | PageError) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        utterance = null;
        kit.push("speaker", { speaking: false });
        if (r instanceof PageError) reject(r);
        else resolve(r);
      };
      const timer = setTimeout(() => {
        s.synth.cancel();
        end(ended("timeout", { spoken: false }));
      }, SPEAK_MS);
      signal.addEventListener(
        "abort",
        () => {
          s.synth.cancel();
          end(ended("preempted", { spoken: false }));
        },
        { once: true },
      );
      u.onend = () => {
        spoken++;
        kit.push("speaker", { last_spoken: text, spoken_count: spoken });
        end({ spoken: true });
      };
      u.onerror = (ev) => {
        if (ev.error === "interrupted" || ev.error === "canceled") return end(ended("preempted", { spoken: false }));
        end(new PageError("internal", `speech synthesis: ${ev.error}`));
      };
      // a queue left paused by an earlier utterance would hold this one
      s.synth.cancel();
      utterance = u;
      kit.push("speaker", { speaking: true });
      s.synth.speak(u);
    });
  }

  function tone(args: Record<string, Value>, signal: AbortSignal): Promise<Measured | Ended> {
    const ctx = o.audio!;
    const ms = Number(args.duration_ms);
    const node = ctx.createOscillator();
    const gain = ctx.createGain();
    node.frequency.value = Number(args.frequency_hz);
    gain.gain.value = 0.2;
    node.connect(gain).connect(ctx.destination);
    return new Promise((resolve) => {
      const stop = () => {
        try {
          node.stop();
        } catch {
          // already stopped
        }
      };
      osc = { stop };
      signal.addEventListener("abort", stop, { once: true });
      node.onended = () => {
        osc = null;
        node.disconnect();
        resolve(signal.aborted ? ended("preempted", { played: false }) : { played: true });
      };
      void ctx.resume().catch(() => {});
      node.start();
      node.stop(ctx.currentTime + ms / 1000);
    });
  }

  const def: DeviceDef = {
    id: "speaker",
    kind: "speaker",
    roles: ["voice"],
    description:
      "The speaker of this browser page: speak says a text with the voices this browser has, tone plays a sine tone.",
    channels: [
      { name: "speaking", type: "boolean", pushed: true, description: "true while a speak runs." },
      {
        name: "last_spoken",
        type: "string",
        pushed: true,
        description: 'The latest text said in full; "" before the first.',
      },
      { name: "spoken_count", type: "number", pushed: true, description: "Texts said in full since the page joined." },
    ],
    commands,
    available: () => (commands.length ? true : "this browser has neither speech synthesis nor Web Audio"),
    run(command, args, signal) {
      if (command === "speak") return speak(args, signal);
      if (command === "tone") return tone(args, signal);
      throw new PageError("unknown_command", `the speaker has no command ${command}`);
    },
    stop() {
      if (utterance) o.synth?.synth.cancel();
      osc?.stop();
    },
  };
  kit.device(def);
  kit.push("speaker", { speaking: false, last_spoken: "", spoken_count: 0 });
  return { def };
}
