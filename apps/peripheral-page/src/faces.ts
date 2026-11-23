// The shipped faces, drawn as SVG in the screen's root: two eyes and a mouth whose shapes make the expression.
// An extension adds its own with spinecord.screen(name, draw).
const NS = "http://www.w3.org/2000/svg";

type Shape = [tag: string, attrs: Record<string, string | number>];
const eye = (cx: number, ry = 14): Shape => ["ellipse", { cx, cy: 48, rx: 11, ry }];
const EYES: Shape[] = [eye(68), eye(132)];
const line = (d: string): Shape => ["path", { d, fill: "none", "stroke-width": 9, "stroke-linecap": "round" }];

const FACES: Record<string, Shape[]> = {
  neutral: [...EYES, line("M76 94 H124")],
  happy: [...EYES, line("M70 86 Q100 116 130 86")],
  sad: [...EYES, line("M72 104 Q100 80 128 104")],
  thinking: [
    eye(68, 5),
    eye(132),
    line("M84 96 Q104 90 124 96"),
    ["circle", { cx: 160, cy: 22, r: 5 }],
    ["circle", { cx: 176, cy: 10, r: 3 }],
  ],
  listening: [
    eye(68, 16),
    eye(132, 16),
    ["ellipse", { cx: 100, cy: 96, rx: 9, ry: 9 }],
    line("M18 40 Q8 60 18 80"),
    line("M182 40 Q192 60 182 80"),
  ],
  speaking: [...EYES, ["ellipse", { cx: 100, cy: 96, rx: 22, ry: 14 }]],
};

/** Draws a shipped face into root; false when the name is not one of them. */
export function drawFace(root: HTMLElement, name: string): boolean {
  const shapes = FACES[name];
  if (!shapes) return false;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 200 130");
  svg.setAttribute("class", `face face-${name}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${name} face`);
  for (const [tag, attrs] of shapes) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  root.replaceChildren(svg);
  return true;
}
