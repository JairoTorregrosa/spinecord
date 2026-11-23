// The display kind (CONTRACT §2.3): text, a face and a color on the page's screen. The faces are screens in a
// registry: the shipped ones and any an extension adds with `spinecord.screen(name, draw)`, each a value of the
// `face` command's enum. Drawing is the page's (main.ts, faces.ts); this file decides what is shown.
import type { CommandSpec, Value } from "../../../../packages/protocol/types";
import { PageError, type DeviceDef, type Kit } from "../kit";

export const SHIPPED_FACES = ["neutral", "happy", "sad", "thinking", "listening", "speaking"] as const;
export const MAX_LINES = 6;
export const MAX_LINE_CHARS = 40;

/** Draws one screen into its root element; `args` are the face command's arguments. */
export type ScreenDraw = (root: unknown, args: Record<string, Value>) => void;

export type View =
  | { t: "face"; name: string; args: Record<string, Value> }
  | { t: "text"; lines: string[] }
  | { t: "color"; color: string }
  | { t: "blank" };

/** What `showing` says of a view. */
export function showing(v: View): string {
  if (v.t === "face") return `face: ${v.name}`;
  if (v.t === "text") return `text: ${v.lines.join(" / ")}`;
  if (v.t === "color") return `color: ${v.color}`;
  return "";
}

export interface DisplayOptions {
  kit: Kit;
  /** Shows a view on the page. */
  render(view: View, draw: ScreenDraw | null): void;
}
export interface Display {
  def: DeviceDef;
  /** Adds a face: the face command's enum gains `name`, and the manifest is sent again. */
  screen(name: string, draw: ScreenDraw): void;
  view(): View;
}

export function display(o: DisplayOptions): Display {
  const { kit } = o;
  const screens = new Map<string, ScreenDraw | null>(SHIPPED_FACES.map((f) => [f, null]));
  let current: View = { t: "face", name: "neutral", args: {} };
  let revert: ReturnType<typeof setTimeout> | null = null;
  const show = (v: View) => {
    current = v;
    o.render(v, v.t === "face" ? (screens.get(v.name) ?? null) : null);
    kit.push("screen", { showing: showing(v) });
  };
  const instant = { kind: "instant" as const, max: 0 };
  const def: DeviceDef = {
    id: "screen",
    kind: "display",
    roles: ["face"],
    description:
      "The screen of this browser page: text lines, a face or a full-screen color. The person can make it fill the page as the robot's face.",
    channels: [
      {
        name: "showing",
        type: "string",
        pushed: true,
        description: 'What the screen shows: "face: happy", "text: a / b", "color: #ff0000", or "" when clear.',
      },
    ],
    get commands(): CommandSpec[] {
      return [
        {
          name: "text",
          description: `Shows up to ${MAX_LINES} lines of text, each up to ${MAX_LINE_CHARS} characters.`,
          params: {
            type: "object",
            properties: {
              lines: {
                type: "array",
                items: { type: "string", maxLength: MAX_LINE_CHARS },
                minItems: 1,
                maxItems: MAX_LINES,
              },
            },
            required: ["lines"],
            additionalProperties: false,
          },
          bound: instant,
          moves: false,
        },
        {
          name: "clear",
          description: "Clears the screen.",
          params: { type: "object", properties: {}, additionalProperties: false },
          bound: instant,
          moves: false,
        },
        {
          name: "face",
          description: "Shows one of the faces this page draws.",
          params: {
            type: "object",
            properties: { expression: { type: "string", enum: [...screens.keys()] } },
            required: ["expression"],
            additionalProperties: false,
          },
          bound: instant,
          moves: false,
        },
        {
          name: "color",
          description:
            "Fills the screen with a color (#rrggbb) for ms milliseconds, then shows again what it showed before.",
          params: {
            type: "object",
            properties: {
              color: { type: "string", minLength: 7, maxLength: 7 },
              ms: { type: "integer", minimum: 100, maximum: 30000 },
            },
            required: ["color", "ms"],
            additionalProperties: false,
          },
          bound: instant,
          moves: false,
        },
      ];
    },
    run(command, args) {
      if (revert) clearTimeout(revert);
      revert = null;
      if (command === "text") show({ t: "text", lines: (args.lines as string[]).map(String) });
      else if (command === "clear") show({ t: "blank" });
      else if (command === "face") {
        const name = String(args.expression);
        if (!screens.has(name)) throw new PageError("invalid_argument", `no face named ${name}`);
        show({ t: "face", name, args });
      } else if (command === "color") {
        const color = String(args.color);
        if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new PageError("invalid_argument", "color must be #rrggbb");
        const before = current;
        show({ t: "color", color: color.toLowerCase() });
        revert = setTimeout(() => {
          revert = null;
          show(before);
        }, Number(args.ms));
      } else throw new PageError("unknown_command", `the screen has no command ${command}`);
      return { showing: showing(current) };
    },
  };
  kit.device(def);
  show(current);
  return {
    def,
    screen(name, draw) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(name))
        throw new Error(`spinecord.screen: name "${name}" must match ^[a-z][a-z0-9_]{0,31}$`);
      const added = !screens.has(name);
      screens.set(name, draw);
      if (added) kit.announce();
      if (current.t === "face" && current.name === name) show(current);
    },
    view: () => current,
  };
}
