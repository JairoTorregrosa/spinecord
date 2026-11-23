// The torch kind (CONTRACT §2.3): the light next to the lent camera, switched through that camera track's `torch`
// constraint. Declared only while the lent track says it has one (getCapabilities().torch); on most phones that is
// the camera facing the environment, so configuring the camera's facing can make the torch appear or go.
// `set` returns at once; a torch switched on goes off by itself after `ms`, when the robot stops, and when the
// camera's track changes.
import type { TrackLike } from "../browser";
import { PageError, type DeviceDef, type Kit } from "../kit";

export const TORCH_MAX_MS = 30000;

export interface TorchOptions {
  kit: Kit;
  /** The lent camera's video track, or null when no camera is lent. */
  track(): TrackLike | null;
  /** Called when the camera's track changes (configure, re-acquire, stop lending). */
  onTrack(cb: () => void): void;
}

const hasTorch = (t: TrackLike | null): boolean =>
  !!t && t.readyState === "live" && typeof t.getCapabilities === "function" && t.getCapabilities().torch === true;

export function torch(o: TorchOptions): { def: DeviceDef } {
  const { kit } = o;
  let on = false;
  let lit: TrackLike | null = null;
  let off: ReturnType<typeof setTimeout> | null = null;
  let had = hasTorch(o.track());

  async function apply(t: TrackLike, want: boolean): Promise<void> {
    // a method call on the track: a detached applyConstraints throws "Illegal invocation"
    await t.applyConstraints!({ advanced: [{ torch: want }] });
  }
  function switchOff(): void {
    if (off) clearTimeout(off);
    off = null;
    const t = lit;
    lit = null;
    if (t && t.readyState === "live") void apply(t, false).catch(() => {});
    if (on) {
      on = false;
      kit.push("torch", { on: false });
    }
  }

  const def: DeviceDef = {
    id: "torch",
    kind: "torch",
    description: "The light next to the camera of this browser page's device.",
    channels: [{ name: "on", type: "boolean", pushed: true, description: "true while the torch is on." }],
    commands: [
      {
        name: "set",
        description: `Switches the torch on or off and returns at once. A torch switched on goes off by itself after ms (default and at most ${TORCH_MAX_MS}). measured: {on}.`,
        params: {
          type: "object",
          properties: { on: { type: "boolean" }, ms: { type: "integer", minimum: 100, maximum: TORCH_MAX_MS } },
          required: ["on"],
          additionalProperties: false,
        },
        bound: { kind: "ms", params: ["ms"], max: TORCH_MAX_MS },
        moves: false,
      },
    ],
    available: () => {
      const t = o.track();
      if (!t) return "the camera is not lent";
      if (!hasTorch(t))
        return "the lent camera has no torch the browser can switch (on a phone the torch is usually next to the camera facing environment)";
      return true;
    },
    async run(_command, args) {
      const t = o.track();
      if (!hasTorch(t)) throw new PageError("device_offline", "the lent camera has no torch at the moment");
      if (args.on !== true) {
        switchOff();
        return { on: false };
      }
      try {
        await apply(t!, true);
      } catch (e) {
        throw new PageError("unsupported", `the browser refused to switch the torch on (${(e as Error).message})`);
      }
      if (off) clearTimeout(off);
      lit = t;
      off = setTimeout(switchOff, typeof args.ms === "number" ? args.ms : TORCH_MAX_MS);
      if (!on) {
        on = true;
        kit.push("torch", { on: true });
      }
      return { on: true };
    },
    stop: switchOff,
  };
  kit.device(def);
  kit.push("torch", { on: false });
  o.onTrack(() => {
    if (lit && lit !== o.track()) switchOff();
    const now = hasTorch(o.track());
    if (now !== had) {
      had = now;
      kit.announce();
    }
  });
  return { def };
}
