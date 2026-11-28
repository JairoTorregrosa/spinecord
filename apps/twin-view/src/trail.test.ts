import { describe, expect, test } from "bun:test";
import { AUX, KIND, STEP_CM, TURN_STEP, TrailPath, driveLimits, teleported } from "./trail";

const DEG = Math.PI / 180;
const kindAt = (p: TrailPath, k: number) => p.aux[AUX * 2 * k + 2];
const progAt = (p: TrailPath, k: number) => p.aux[AUX * 2 * k + 3]!;
/** Quad k's six indices (newest first in the buffer). */
const quad = (p: TrailPath, k: number) => [...p.index.subarray((p.max - 1 - k) * 6, (p.max - k) * 6)];
const isGap = (p: TrailPath, k: number) => new Set(quad(p, k)).size === 1;

describe("which poses become points", () => {
  test("jitter under STEP_CM is skipped; a step adds one point", () => {
    const p = new TrailPath(100, 0.15, 1.4);
    expect(p.add(0, 0, 0)).toBe(true);
    for (let i = 0; i < 20; i++) expect(p.add(0.3 * Math.sin(i), 0.2 * Math.cos(i), 0.01 * Math.sin(i))).toBe(false);
    expect(p.count).toBe(1);
    expect(p.add(STEP_CM, 0, 0)).toBe(true);
    expect(p.count).toBe(2);
    expect(p.drawCount).toBe(6);
  });

  test("a turn in place leaves a fan of points on one spot, every TURN_STEP", () => {
    const p = new TrailPath(100, 0.15, 1.4);
    p.add(10, 10, 0);
    for (let a = 0; a <= 90; a += 1) p.add(10, 10, a * DEG);
    // 90° sampled every 1°: a point every TURN_STEP (5°) or the next degree past it
    expect(p.count).toBeGreaterThanOrEqual(1 + Math.floor(90 / 6));
    expect(p.count).toBeLessThanOrEqual(1 + Math.round((90 * DEG) / TURN_STEP));
    for (let k = 1; k < p.count; k++) expect(kindAt(p, k)).toBe(KIND.pivot);
    // all at the centre, the edges swept round it: the wedge is drawn, not nothing
    expect(p.pos[3 * 2 * (p.count - 1)]).toBe(10);
    expect(isGap(p, p.count - 1)).toBe(false);
    // a pivot moves the fade on by its sweep at the band's edge
    expect(progAt(p, p.count - 1)).toBeGreaterThan(80 * DEG * 1.4);
    expect(progAt(p, p.count - 1)).toBeLessThanOrEqual(90 * DEG * 1.4 + 1e-5);
  });

  test("forward and reverse are told by the heading, and a piece's first point takes its first move's kind", () => {
    const p = new TrailPath(100, 0.15, 1.4);
    p.add(0, 0, 90 * DEG);
    p.add(0, 2, 90 * DEG); // along the heading
    expect(kindAt(p, 1)).toBe(KIND.forward);
    expect(kindAt(p, 0)).toBe(KIND.forward);
    p.add(0, 0.5, 90 * DEG); // backing up
    expect(kindAt(p, 2)).toBe(KIND.reverse);
    p.break();
    p.add(50, 50, 0);
    p.add(48, 50, 0); // a new piece that starts in reverse
    expect(kindAt(p, 3)).toBe(KIND.reverse);
    expect(kindAt(p, 4)).toBe(KIND.reverse);
  });

  test("distance for chevrons counts only driving; progress for the fade counts pivots too", () => {
    const p = new TrailPath(100, 0.15, 1.4);
    p.add(0, 0, 0);
    p.add(5, 0, 0);
    p.add(5, 0, 30 * DEG);
    expect(p.aux[AUX * 2 * 2 + 1]).toBe(5);
    expect(progAt(p, 2)).toBeGreaterThan(5);
    expect(p.head).toBeCloseTo(progAt(p, 2), 5);
  });

  test("the band lies across the heading: left edge +1, right edge -1, the left normal in scene coordinates", () => {
    const p = new TrailPath(100, 0.15, 1.4);
    p.add(3, 4, 0); // heading +x: left is +y, scene -z
    expect([...p.pos.subarray(0, 6)]).toEqual([3, 0.15, -4, 3, 0.15, -4].map((v) => Math.fround(v)));
    expect(p.nrm[0]).toBeCloseTo(0);
    expect(p.nrm[1]).toBeCloseTo(-1);
    expect(p.aux[0]).toBe(1);
    expect(p.aux[AUX]).toBe(-1);
  });
});

describe("where the path breaks", () => {
  test("after break() the next point starts a piece: its quad is empty, the ones after it are drawn", () => {
    const p = new TrailPath(100, 0.15, 1.4);
    p.add(0, 0, 0);
    p.add(2, 0, 0);
    p.break();
    p.add(80, 40, 0);
    p.add(82, 40, 0);
    expect(isGap(p, 1)).toBe(false);
    expect(isGap(p, 2)).toBe(true);
    expect(isGap(p, 3)).toBe(false);
    expect(quad(p, 3)).toEqual([4, 5, 6, 5, 7, 6]);
  });

  test("clear() empties it", () => {
    const p = new TrailPath(100, 0.15, 1.4);
    p.add(0, 0, 0);
    p.add(5, 0, 0);
    p.clear();
    expect(p.count).toBe(0);
    expect(p.drawCount).toBe(0);
    expect(p.head).toBe(0);
    p.add(9, 9, 0);
    expect(p.count).toBe(1);
  });

  const lim = driveLimits({ wheel_diameter_cm: 5.6, axle_track_cm: 12 });
  test("the drive's limits come from the large motor's top speed", () => {
    expect(lim.cm_s).toBeCloseTo((1020 / 360) * Math.PI * 5.6, 6);
    expect(lim.rad_s).toBeCloseTo((2 * lim.cm_s) / 12, 6);
    expect(driveLimits(null)).toEqual({ cm_s: 0, rad_s: 0 });
  });

  test("driving at full speed is a drive; a carry across the room, or time going back, is not", () => {
    const a = { x: 50, y: 50, th: 0, t_ms: 1000 };
    // one state later (33 ms) at full speed, and spinning in place at full speed
    expect(teleported(a, { x: 50 + lim.cm_s * 0.033, y: 50, th: 0, t_ms: 1033 }, lim)).toBe(false);
    expect(teleported(a, { x: 50, y: 50, th: lim.rad_s * 0.033, t_ms: 1033 }, lim)).toBe(false);
    // a person sets it down 40 cm away, or turns it round in one frame
    expect(teleported(a, { x: 90, y: 50, th: 0, t_ms: 1033 }, lim)).toBe(true);
    expect(teleported(a, { x: 50, y: 50, th: Math.PI, t_ms: 1033 }, lim)).toBe(true);
    // a heading that wraps past ±180° is a small turn
    expect(teleported({ ...a, th: 179 * DEG }, { ...a, th: -179 * DEG, t_ms: 1033 }, lim)).toBe(false);
    // the world started again
    expect(teleported(a, { x: 50, y: 50, th: 0, t_ms: 0 }, lim)).toBe(true);
    // a robot with no drive cannot move itself
    expect(teleported(a, { x: 55, y: 50, th: 0, t_ms: 2000 }, driveLimits(null))).toBe(true);
  });
});

describe("bounded memory", () => {
  test("when full the oldest half goes; the newest quads stay drawn and a kept gap stays a gap", () => {
    const max = 20;
    const p = new TrailPath(max, 0.15, 1.4);
    for (let i = 0; i < max; i++) {
      if (i === 15) p.break();
      p.add(i * 2, 0, 0);
    }
    expect(p.count).toBe(max);
    expect(p.takeDirty()).toBe(true);
    p.add(max * 2, 0, 0); // full: compacts to max/2, then adds
    expect(p.count).toBe(max / 2 + 1);
    expect(p.pos[0]).toBe(2 * (max / 2)); // the oldest kept point is the 11th
    expect(p.pos[3 * 2 * (p.count - 1)]).toBe(max * 2);
    expect(isGap(p, 5)).toBe(true); // the break at point 15 is point 5 now
    expect(isGap(p, 6)).toBe(false);
    expect(p.drawStart).toBe((max - p.count) * 6);
    expect(p.drawCount).toBe((p.count - 1) * 6);
    expect(p.takeDirty()).toBe(true);
    expect([p.dirtyLo, p.dirtyHi]).toEqual([0, max]);
    // the buffers never grow
    expect(p.pos.length).toBe(2 * max * 3);
    for (let i = 0; i < 500; i++) p.add(100 + i * 2, 0, 0);
    expect(p.count).toBeLessThanOrEqual(max);
    expect(p.pos.length).toBe(2 * max * 3);
  });

  test("only what changed is marked for upload", () => {
    const p = new TrailPath(50, 0.15, 1.4);
    p.add(0, 0, 0);
    p.add(2, 0, 0);
    p.takeDirty();
    expect(p.takeDirty()).toBe(false);
    p.add(4, 0, 0);
    expect(p.takeDirty()).toBe(true);
    expect([p.dirtyLo, p.dirtyHi]).toEqual([2, 3]);
  });
});
