// Boxes as they are in a classroom: a light one is pushed ahead, a heavy one stops the robot like a wall, a low one
// is looked over by a sensor mounted high, and only what reaches the bumper presses it.
import { describe, expect, test } from "bun:test";
import { BOX_FLOOR_FRICTION, DEFAULT_PUSH_N, NO_NOISE, World, parseWorld } from "./world";
import { DRIVE } from "./testkit";

/** A 120 x 100 cm room with these obstacles; the robot (8 cm ahead of the axle, 10 behind, 12 wide) at (30, 50) facing +x. */
const room = (obstacles: unknown[], body: Record<string, number> = {}) =>
  new World(
    {
      ...parseWorld({
        schema: "spinecord/world@1",
        name: "boxes",
        arena: { width_cm: 120, height_cm: 100 },
        obstacles,
        start: { x: 30, y: 50, heading_deg: 0 },
        body,
      }),
      noise: { ...NO_NOISE },
    },
    1,
    { ...DRIVE },
  );
/** The mass (g) whose sliding friction is `n` newtons. */
const massFor = (n: number) => (n / (BOX_FLOOR_FRICTION * 9.81)) * 1000;

describe("a box the robot can push", () => {
  test("a light box slides ahead of the robot, in contact with its front, and the robot is not stalled", () => {
    const w = room([{ id: "cup", x: 60, y: 45, w: 10, h: 10, mass_g: 200 }]);
    const rev = w.obstacles_rev;
    const r = w.advance(40, 40, 20);
    expect(r.stalled).toBe(false);
    expect(w.pose.x).toBeCloseTo(70, 6);
    const cup = w.obstacle("cup")!;
    expect(cup.x - (w.pose.x + 8)).toBeGreaterThanOrEqual(0); // never inside the robot
    expect(cup.x - (w.pose.x + 8)).toBeLessThan(1e-4); // and against its front
    expect(cup.y).toBe(45); // pushed square on, it goes straight
    expect(w.last_push_n).toBeCloseTo((BOX_FLOOR_FRICTION * 200 * 9.81) / 1000, 9);
    expect(w.obstacles_rev).toBeGreaterThan(rev); // a viewer is told
  });
  test("a box heavier than the robot can push stops it like a wall", () => {
    const w = room([{ x: 60, y: 45, w: 10, h: 10, mass_g: massFor(DEFAULT_PUSH_N) * 1.05 }]);
    expect(w.advance(40, 40, 20).stalled).toBe(true);
    expect(w.pose.x + 8).toBeCloseTo(60, 2);
    expect(w.cfg.boxes[0]!.x).toBe(60);
    // just under the limit it slides
    const v = room([{ x: 60, y: 45, w: 10, h: 10, mass_g: massFor(DEFAULT_PUSH_N) * 0.95 }]);
    expect(v.advance(40, 40, 20).stalled).toBe(false);
  });
  test("a pushed box stops at the wall and the robot stops behind it: nothing ends inside a wall or the robot", () => {
    const w = room([{ x: 90, y: 45, w: 10, h: 10, mass_g: 200 }]);
    expect(w.advance(80, 80, 20).stalled).toBe(true);
    const b = w.cfg.boxes[0]!;
    expect(b.x + b.w).toBeLessThanOrEqual(120);
    expect(b.x + b.w).toBeGreaterThan(119.99);
    expect(w.pose.x + 8).toBeLessThanOrEqual(b.x);
    expect(w.pose.x + 8).toBeGreaterThan(b.x - 0.01);
    // and pushing on changes nothing
    const x = w.pose.x;
    expect(w.advance(10, 10, 20).stalled).toBe(true);
    expect(w.pose.x).toBeCloseTo(x, 6);
  });
  test("a pushed box stops against another box", () => {
    const w = room([
      { id: "light", x: 60, y: 45, w: 10, h: 10, mass_g: 200 },
      { id: "wall", x: 80, y: 40, w: 5, h: 20 },
    ]);
    expect(w.advance(40, 40, 20).stalled).toBe(true);
    expect(w.obstacle("light")!.x + 10).toBeCloseTo(80, 2);
    expect(w.obstacle("light")!.x + 10).toBeLessThanOrEqual(80);
    expect(w.obstacle("wall")!.x).toBe(80);
  });
  test("the push limit is the drive's whole force: boxes side by side or in a row that weigh more together stop it", () => {
    // each alone slides: 0.6 of the limit
    const each = massFor(DEFAULT_PUSH_N) * 0.6;
    expect(room([{ x: 60, y: 44, w: 10, h: 6, mass_g: each }]).advance(40, 40, 20).stalled).toBe(false);
    // side by side across the 12 cm front: both touch it at once, 1.2 of the limit together
    const side = room([
      { id: "l", x: 60, y: 44, w: 10, h: 6, mass_g: each },
      { id: "r", x: 60, y: 50, w: 10, h: 6, mass_g: each },
    ]);
    expect(side.advance(40, 40, 20).stalled).toBe(true);
    expect(side.obstacle("l")!.x).toBe(60);
    expect(side.obstacle("r")!.x).toBe(60);
    expect(side.pose.x + 8).toBeCloseTo(60, 2);
    // in a row, the first leaning on the second: the robot touches one and stops against both
    const row = room([
      { id: "a", x: 60, y: 45, w: 10, h: 10, mass_g: each },
      { id: "b", x: 70, y: 45, w: 10, h: 10, mass_g: each },
    ]);
    expect(row.advance(40, 40, 20).stalled).toBe(true);
    expect(row.obstacle("a")!.x).toBe(60);
    expect(row.obstacle("b")!.x).toBe(70);
    // two that weigh less than the limit together slide side by side
    const light = room([
      { x: 60, y: 44, w: 10, h: 6, mass_g: each / 2 },
      { x: 60, y: 50, w: 10, h: 6, mass_g: each / 2 },
    ]);
    expect(light.advance(40, 40, 20).stalled).toBe(false);
    expect(light.last_push_n).toBeCloseTo(DEFAULT_PUSH_N * 0.6, 9);
  });
  test("a robot turning against a box sweeps it aside, and the box never ends inside the robot", () => {
    const w = room([{ x: 34, y: 57, w: 6, h: 6, mass_g: 100 }]);
    for (let i = 0; i < 50; i++) {
      w.advance(-0.4, 0.4, 10);
      const b = w.cfg.boxes[0]!;
      expect(w.boxCollides({ ...b, x: b.x + 1e-7, y: b.y + 1e-7, w: b.w - 2e-7, h: b.h - 2e-7 }, w.pose)).toBe(false);
    }
    expect(w.cfg.boxes[0]!.x !== 34 || w.cfg.boxes[0]!.y !== 57).toBe(true);
  });
  test("how the steps are cut (a page ticking the physics at 60 Hz) moves neither the box nor the robot by 0.05 mm", () => {
    const a = room([{ x: 60, y: 45, w: 10, h: 10, mass_g: 300 }]),
      b = room([{ x: 60, y: 45, w: 10, h: 10, mass_g: 300 }]);
    for (let t = 0; t < 2000; t += 20) a.stepWheels(0.4, 0.4, 20);
    for (let t = 0; t < 2000; t += 50 / 3) b.stepWheels((0.4 * 50) / 3 / 20, (0.4 * 50) / 3 / 20, 50 / 3);
    expect(Math.abs(a.pose.x - b.pose.x)).toBeLessThan(0.005);
    expect(Math.abs(a.cfg.boxes[0]!.x - b.cfg.boxes[0]!.x)).toBeLessThan(0.005);
  });
  test("a box set down is fixed unless it has a mass; heights and masses are checked", () => {
    expect(() => room([{ x: 60, y: 45, w: 10, h: 10, mass_g: 0 }])).toThrow(
      /obstacles\[0\].mass_g must be a finite number/,
    );
    expect(() => room([{ x: 60, y: 45, w: 10, h: 10, height_cm: -1 }])).toThrow(/obstacles\[0\].height_cm/);
    const w = room([]);
    w.addObstacle({ x: 60, y: 45, w: 10, h: 10 });
    expect(w.advance(40, 40, 20).stalled).toBe(true);
  });
});

describe("how tall a box is", () => {
  test("a distance sensor mounted 20 cm up looks over a 10 cm box nearby, sees it farther off, and always sees a tall one", () => {
    const low = room([{ x: 70, y: 30, w: 10, h: 40, height_cm: 10 }], { distance_sensor_z_cm: 20 });
    const sensor = () => low.pose.x + 8;
    // 32 cm from the box: the cone (+-12 deg) comes down only 6.8 cm, to 13.2 cm, above its top: it sees the far wall
    expect(low.ultrasonicCm()).toBeCloseTo(120 - sensor(), 1);
    // 50 cm off it comes down to 9.4 cm: the box's top edge echoes, a little farther than its face
    low.setPose({ x: 12, y: 50, th: 0 });
    expect(low.ultrasonicCm()).toBeCloseTo(Math.hypot(70 - sensor(), 10), 1);
    const tall = room([{ x: 70, y: 30, w: 10, h: 40, height_cm: 25 }], { distance_sensor_z_cm: 20 });
    expect(tall.ultrasonicCm()).toBeCloseTo(70 - 38, 1);
    // the infrared beam, wider (+-25 deg), sees it from there too
    expect(low.irProximity()).toBeLessThan(100);
  });
  test("only what reaches the bumper presses the touch sensor, and a wall along the side does not", () => {
    const w = room([{ x: 38.3, y: 45, w: 5, h: 10, height_cm: 2 }], { touch_z_cm: 3 });
    expect(w.senseTouch()).toBe(0); // 2 cm tall, under a bumper whose lowest part is at 3 cm
    const v = room([{ x: 38.3, y: 45, w: 5, h: 10, height_cm: 4 }], { touch_z_cm: 3 });
    expect(v.senseTouch()).toBe(1);
    const side = room([]);
    side.setPose({ x: 30, y: 6, th: 0 }); // its right side against the wall at y 0
    expect(side.senseTouch()).toBe(0);
    side.setPose({ x: 111.5, y: 50, th: 0 }); // its front 0.5 cm from the wall at x 120
    expect(side.senseTouch()).toBe(1);
  });
});
