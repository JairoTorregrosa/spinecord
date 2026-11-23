// The screen wake lock while the page lends (CONTRACT §2.4, Sleep): taken in the person's tap, taken again each
// time the page is visible again (a browser releases it whenever the page is hidden), released when lending ends.
//   none ─acquire→ asking ─granted→ held ─released by the browser→ none        asking ─refused→ refused
import type { Win, WakeLockSentinelLike } from "./browser";

export type WakeState =
  | { t: "unsupported" }
  | { t: "none" }
  | { t: "asking" }
  | { t: "held" }
  | { t: "refused"; why: string };

export interface WakeLock {
  /** Asks for the lock unless it is held or being asked for. */
  acquire(): void;
  release(): void;
  state(): WakeState;
}

export function wakeLock(win: Win, onChange: (s: WakeState) => void = () => {}): WakeLock {
  let state: WakeState = win.navigator.wakeLock ? { t: "none" } : { t: "unsupported" };
  let sentinel: WakeLockSentinelLike | null = null;
  let wanted = false;
  const set = (s: WakeState) => {
    state = s;
    onChange(s);
  };
  return {
    acquire() {
      wanted = true;
      const api = win.navigator.wakeLock;
      if (!api || state.t === "asking" || (state.t === "held" && sentinel && !sentinel.released)) return;
      set({ t: "asking" });
      api.request("screen").then(
        (s) => {
          if (!wanted) return void s.release().catch(() => {});
          sentinel = s;
          s.addEventListener?.("release", () => {
            if (sentinel !== s) return;
            sentinel = null;
            set({ t: "none" });
          });
          set({ t: "held" });
        },
        (e: unknown) =>
          set({ t: "refused", why: `the browser refused to keep the screen on (${(e as Error)?.message ?? e})` }),
      );
    },
    release() {
      wanted = false;
      const s = sentinel;
      sentinel = null;
      if (s && !s.released) void s.release().catch(() => {});
      if (state.t !== "unsupported") set({ t: "none" });
    },
    state: () => state,
  };
}
