// The touch_panel kind (CONTRACT §2.3): four buttons on the page's screen. b1..b4 are true while a finger is on the
// button and b1_presses..b4_presses count presses since the page joined; both are pushed from the pointer events.
import type { ChannelSpec } from "../../../../packages/protocol/types";
import type { DeviceDef, Kit } from "../kit";

export const BUTTONS = 4;
export const DEFAULT_LABELS = ["1", "2", "3", "4"];

export interface TouchOptions {
  kit: Kit;
  /** The labels to draw; a button without a label is not drawn. */
  onLabels(labels: string[]): void;
}
export interface Touch {
  def: DeviceDef;
  press(i: number): void;
  release(i: number): void;
  labels(): string[];
}

export function touch(o: TouchOptions): Touch {
  const { kit } = o;
  const down = new Array<boolean>(BUTTONS).fill(false);
  const presses = new Array<number>(BUTTONS).fill(0);
  let labels = [...DEFAULT_LABELS];
  const channels: ChannelSpec[] = [];
  for (let i = 1; i <= BUTTONS; i++)
    channels.push({
      name: `b${i}`,
      type: "boolean",
      pushed: true,
      description: `true while a finger is on button ${i}.`,
    });
  for (let i = 1; i <= BUTTONS; i++)
    channels.push({
      name: `b${i}_presses`,
      type: "number",
      pushed: true,
      description: `Presses of button ${i} since the page joined.`,
    });
  const def: DeviceDef = {
    id: "touch",
    kind: "touch_panel",
    roles: ["touch"],
    description: "Four buttons on the screen of this browser page, for the person to press.",
    channels,
    commands: [
      {
        name: "set_labels",
        description:
          'Sets the labels of buttons 1..4 (each up to 16 characters); a button without a label, or with "", is not drawn.',
        params: {
          type: "object",
          properties: { labels: { type: "array", items: { type: "string", maxLength: 16 }, maxItems: BUTTONS } },
          required: ["labels"],
          additionalProperties: false,
        },
        bound: { kind: "instant", max: 0 },
        moves: false,
      },
    ],
    run(_command, args) {
      labels = Array.from({ length: BUTTONS }, (_, i) => String((args.labels as string[])[i] ?? ""));
      o.onLabels(labels);
      return { drawn: labels.filter((l) => l !== "").length };
    },
  };
  kit.device(def);
  const initial: Record<string, boolean | number> = {};
  for (let i = 0; i < BUTTONS; i++) {
    initial[`b${i + 1}`] = false;
    initial[`b${i + 1}_presses`] = 0;
  }
  kit.push("touch", initial);
  o.onLabels(labels);
  return {
    def,
    press(i) {
      if (down[i]) return;
      down[i] = true;
      presses[i]!++;
      kit.push("touch", { [`b${i + 1}`]: true, [`b${i + 1}_presses`]: presses[i]! });
    },
    release(i) {
      if (!down[i]) return;
      down[i] = false;
      kit.push("touch", { [`b${i + 1}`]: false });
    },
    labels: () => [...labels],
  };
}
