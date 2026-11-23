// The page without its DOM: the kit, the kinds that need no permission (screen, touch) from the start, the kinds
// the tap unlocks (camera, microphone, speaker), and `spinecord`, the extension API (docs/peripheral-pages.md).
// main.ts draws it; a test drives it with a fake browser (test/fakes.ts).
import type { Scalar } from "../../../packages/protocol/types";
import { unlock, type BitmapLike, type StreamLike, type Win } from "./browser";
import { camera, type Camera } from "./devices/camera";
import { display, type Display, type ScreenDraw, type View } from "./devices/display";
import { microphone, type Microphone } from "./devices/microphone";
import { speaker } from "./devices/speaker";
import { touch, type Touch } from "./devices/touch";
import { createKit, ended, PageError, type DeviceDef, type Kit, type KitOptions } from "./kit";

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
  /** Stop lending: the camera and the microphone leave the manifest and their streams close. */
  stopLending(): void;
}

export function createPage(o: PageOptions): Page {
  const now = o.now ?? (() => Date.now());
  const kit = createKit({ ...o, now });
  const screen = display({ kit, render: o.render });
  const buttons = touch({ kit, onLabels: o.onLabels });
  let cam: Camera | null = null;
  let mic: Microphone | null = null;
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
      await mic.meter().catch(() => false);
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
    },
  };
}
