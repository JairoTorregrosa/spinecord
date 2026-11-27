// Where the robot fits, worked out on the page while the hand carries it, so the ghost turns red before the
// person lets go. The same rule as sim-world's World.collides (footprint inside the arena, no overlap with a box:
// separating axes); the process still decides, and apps/local/test/view.test.ts holds the two together.
import type { Box, WorldShape } from "./messages";

export type Fit = "free" | "wall" | "box";

/** The footprint's corners at pose `x, y, th` (cm, radians), as the world counts them. */
export function corners(body: WorldShape["body"], x: number, y: number, th: number): [number, number][] {
  const c = Math.cos(th),
    s = Math.sin(th);
  const loc: [number, number][] = [
    [body.front_cm, body.half_width_cm],
    [body.front_cm, -body.half_width_cm],
    [-body.back_cm, -body.half_width_cm],
    [-body.back_cm, body.half_width_cm],
  ];
  return loc.map(([lx, ly]) => [x + lx * c - ly * s, y + lx * s + ly * c]);
}

/** Whether the robot fits at `x, y, th` in `world` with `boxes`; when not, what it would overlap. */
export function fit(world: WorldShape, boxes: readonly Box[], x: number, y: number, th: number): Fit {
  const g = world.body;
  let minx = Infinity,
    maxx = -Infinity,
    miny = Infinity,
    maxy = -Infinity;
  for (const [px, py] of corners(g, x, y, th)) {
    if (px < 0 || px > world.width || py < 0 || py > world.height) return "wall";
    minx = Math.min(minx, px);
    maxx = Math.max(maxx, px);
    miny = Math.min(miny, py);
    maxy = Math.max(maxy, py);
  }
  const c = Math.cos(th),
    s = Math.sin(th);
  for (const b of boxes) {
    if (maxx < b.x || minx > b.x + b.w || maxy < b.y || miny > b.y + b.h) continue;
    let umin = Infinity,
      umax = -Infinity,
      vmin = Infinity,
      vmax = -Infinity;
    for (const [bx, by] of [
      [b.x, b.y],
      [b.x + b.w, b.y],
      [b.x + b.w, b.y + b.h],
      [b.x, b.y + b.h],
    ] as const) {
      const dx = bx - x,
        dy = by - y;
      const u = dx * c + dy * s,
        v = -dx * s + dy * c;
      umin = Math.min(umin, u);
      umax = Math.max(umax, u);
      vmin = Math.min(vmin, v);
      vmax = Math.max(vmax, v);
    }
    if (umax < -g.back_cm || umin > g.front_cm || vmax < -g.half_width_cm || vmin > g.half_width_cm) continue;
    return "box";
  }
  return "free";
}

/** Whether box `b` would sit on the robot at `x, y, th` (what the process refuses as box_on_robot). */
export const boxOnRobot = (world: WorldShape, b: Box, x: number, y: number, th: number): boolean =>
  fit(world, [b], x, y, th) === "box";
