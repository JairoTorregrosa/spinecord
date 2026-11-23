// The page without its DOM: the kit, the kinds that need no permission (screen, touch) from the start, the kinds
// the tap unlocks (camera, microphone, speaker, imu, vibrator, torch), the wake lock, and `spinecord`, the
// extension API (docs/peripheral-pages.md). main.ts draws it; a test drives it with a fake browser (test/fakes.ts).
// Hidden and visible again: a hidden page's imu is down; a visible one takes the wake lock again and asks again
// for a camera or microphone track the browser ended meanwhile. A page whose socket closed (a phone locks it, or
// puts the browser in the background) joins again by itself; each try waits for that taking back while the page is
// visible, so the hello it sends lends what the page has again.
import type { Scalar } from "../../../packages/protocol/types";
import { unlock, type BitmapLike, type StreamLike, type Win } from "./browser";
import { camera, type Camera } from "./devices/camera";
import { imu, type Imu } from "./devices/imu";
import { torch } from "./devices/torch";
import { vibrator } from "./devices/vibrator";
import { display, type Display, type ScreenDraw, type View } from "./devices/display";
import { microphone, type Microphone } from "./devices/microphone";
import { speaker } from "./devices/speaker";
import { touch, type Touch } from "./devices/touch";
import { createKit, ended, PageError, type DeviceDef, type Kit, type KitOptions } from "./kit";
import { wakeLock, type WakeState } from "./wake";

/** How long the tap waits for a first motion sample before it joins; a later first sample announces the imu. */
export const MOTION_WAIT_MS = 1000;

/** The extension API: what `window.spinecord` is. */
export interface Spinecord {
  device(def: DeviceDef): void;
  push(id: string, values: Record<string, Scalar | null>): void;
  screen(name: string, draw: ScreenDraw): void;
  /** The lent camera's current frame; rejects when no camera is lent. The caller closes the bitmap. */
  cameraFrame(): Promise<BitmapLike>;
  ended: typeof ended;
  PageError: typeof PageError;
}

export interface PageOptions extends Omit<KitOptions, "now"> {
  win: Win;
  now?: () => number;
  /** The language of listen and speak when a command names none. */
  lang: string;
  /** Where the level worklet is served. */
  workletUrl: string;
  render(view: View, draw: ScreenDraw | null): void;
  onLabels(labels: string[]): void;
  /** The wake lock changed: held, refused (with why), released. */
  onWake?(s: WakeState): void;
}

export interface Page {
  kit: Kit;
  spinecord: Spinecord;
  screen: Display;
  touch: Touch;
  /** The person's tap: asks for everything a browser gates behind a gesture, builds the manifest, joins. */
  lend(join: { name: string; robot?: string }): Promise<void>;
  /** The live streams, for the banner and the preview. */
  live(): { camera: StreamLike | null; mic: StreamLike | null };
  /** Stop lending: the camera, the microphone and the motion sensors leave the manifest; their streams close. */
  stopLending(): void;
  /** Call on every visibilitychange. */
  visibilityChanged(): void;
  /** The kinds whose permission the browser would prompt for again: the banner offers the tap that asks. */
  needsTap(): ("camera" | "mic")[];
  /** The person's tap on "Tap to resume camera and microphone": asks the browser again, inside that gesture. */
  resumeMedia(): Promise<void>;
  wake(): WakeState;
}

export function createPage(o: PageOptions): Page {
  const now = o.now ?? (() => Date.now());
  const wake = wakeLock(o.win, (s) => o.onWake?.(s));
  const kit = createKit({
    ...o,
    now,
    beforeRejoin: async () => {
      if (!o.visible()) return;
      wake.acquire();
      await Promise.all([cam?.reacquire(), mic?.reacquire()]);
    },
    onStatus: (s) => {
      if (s.state === "closed") wake.release();
      o.onStatus?.(s);
    },
  });
  const screen = display({ kit, render: o.render });
  const buttons = touch({ kit, onLabels: o.onLabels });
  let cam: Camera | null = null;
  let mic: Microphone | null = null;
  let motion: Imu | null = null;
  const spinecord: Spinecord = {
    device: (def) => kit.device(def),
    push: (id, values) => kit.push(id, values),
    screen: (name, draw) => screen.screen(name, draw),
    cameraFrame: () =>
      cam && cam.stream() ? cam.bitmap() : Promise.reject(new PageError("device_offline", "no camera is lent")),
    ended,
    PageError,
  };
  return {
    kit,
    spinecord,
    screen,
    touch: buttons,
    async lend(join) {
      wake.acquire(); // in the tap, before any await
      const got = await unlock(o.win);
      cam = camera({ kit, win: o.win, got: got.camera, now });
      mic = microphone({
        kit,
        win: o.win,
        got: got.mic,
        Recognition: got.Recognition,
        audio: got.audio,
        workletUrl: o.workletUrl,
        lang: o.lang,
        now,
      });
      motion = imu({ kit, win: o.win, permission: got.motion, now });
      vibrator({ kit, win: o.win });
      const c = cam;
      torch({ kit, track: () => c.track(), onTrack: (cb) => c.onTrack(cb) });
      await Promise.all([mic.meter().catch(() => false), motion.ready(MOTION_WAIT_MS)]);
      speaker({ kit, synth: got.synth, audio: got.audio, lang: o.lang });
      kit.start(join);
    },
    live: () => ({ camera: cam?.stream() ?? null, mic: mic?.stream() ?? null }),
    stopLending() {
      const lent = kit.status().devices;
      if (cam && lent.includes("camera")) {
        cam.close();
        kit.withdraw("camera", "the person stopped lending it");
      }
      if (mic && lent.includes("mic")) {
        mic.close();
        kit.withdraw("mic", "the person stopped lending it");
      }
      if (motion) {
        motion.close();
        if (lent.includes("imu")) kit.withdraw("imu", "the person stopped lending it");
      }
    },
    visibilityChanged() {
      const state = kit.status().state;
      const rejoining = state === "joining" && kit.status().rejoin !== null;
      if (state !== "lending" && state !== "paused" && state !== "reconnecting" && !rejoining) return;
      const visible = o.visible();
      motion?.visible(visible);
      if (!visible) return;
      // the try takes the wake lock and the media back before its hello
      if (state === "reconnecting") return kit.reconnectNow();
      wake.acquire();
      // a track taken back can bring a device of its own (the torch): the manifest follows once both settled
      void Promise.all([cam?.reacquire(), mic?.reacquire()]).then(() => kit.reconcile());
    },
    wake: () => wake.state(),
    needsTap: () => [...(cam?.needsTap() ? ["camera" as const] : []), ...(mic?.needsTap() ? ["mic" as const] : [])],
    async resumeMedia() {
      wake.acquire(); // in the tap, before any await
      // each getUserMedia is called before the first await, so both are inside the gesture
      await Promise.all([
        cam?.needsTap() ? cam.reacquire({ tap: true }) : undefined,
        mic?.needsTap() ? mic.reacquire({ tap: true }) : undefined,
      ]);
      kit.reconcile();
      o.onStatus?.(kit.status());
    },
  };
}
