// The vibrator kind (CONTRACT §2.3): vibrate{ms} through navigator.vibrate, declared only on a phone or tablet whose
// browser has it (Safari on iOS has none; a desktop browser has the call and no motor behind it).
import type { Win } from "../browser";
import { ended, PageError, type DeviceDef, type Kit } from "../kit";

export const VIBRATE_MAX_MS = 2000;

export interface VibratorOptions {
  kit: Kit;
  win: Win;
}

export function vibrator(o: VibratorOptions): { def: DeviceDef } {
  const { kit, win } = o;
  let running: (() => void) | null = null;
  const def: DeviceDef = {
    id: "vibrator",
    kind: "vibrator",
    description: "The vibration motor of this browser page's phone or tablet.",
    channels: [],
    commands: [
      {
        name: "vibrate",
        description: `Vibrates for ms milliseconds (at most ${VIBRATE_MAX_MS}) and returns when it has ended. measured: {vibrated_ms}.`,
        params: {
          type: "object",
          properties: { ms: { type: "integer", minimum: 10, maximum: VIBRATE_MAX_MS } },
          required: ["ms"],
          additionalProperties: false,
        },
        bound: { kind: "ms", params: ["ms"], max: VIBRATE_MAX_MS },
        moves: false,
      },
    ],
    available: () => {
      if (typeof win.navigator.vibrate !== "function") return "this browser has no vibration";
      if (!win.matchMedia?.("(pointer: coarse)").matches)
        return "this is not a phone or tablet: its browser can vibrate nothing";
      return true;
    },
    run(_command, args, signal) {
      const ms = Number(args.ms);
      // a method call: a detached navigator.vibrate throws "Illegal invocation"
      if (!win.navigator.vibrate!(ms))
        throw new PageError(
          "unsupported",
          "the browser refused to vibrate (it allows it only after a tap on the page)",
        );
      const t0 = Date.now();
      return new Promise((resolve) => {
        const finish = (aborted: boolean) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          running = null;
          const vibrated_ms = Math.min(ms, Date.now() - t0);
          resolve(aborted ? ended("preempted", { vibrated_ms }) : { vibrated_ms: ms });
        };
        const onAbort = () => {
          win.navigator.vibrate!(0);
          finish(true);
        };
        const timer = setTimeout(() => finish(false), ms);
        signal.addEventListener("abort", onAbort, { once: true });
        running = onAbort;
      });
    },
    stop() {
      running?.();
    },
  };
  kit.device(def);
  return { def };
}
