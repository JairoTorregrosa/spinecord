// What a person does to the world by hand (a viewer): carry the robot, set boxes down, take them away, and look at
// the gyro without spending the sensor noise.
import { describe, expect, test } from "bun:test";
import { World } from "./world";
import { DRIVE, EXAMPLES, config, quietWorld } from "./testkit";

const DEG = Math.PI / 180;

describe("carry", () => {
  test("moves the robot and the gyro counts the turn by the shortest way, unlike setPose", () => {
    const w = quietWorld(EXAMPLES.wallsMaze);
    const { x, y } = w.pose;
    w.carry({ x: x + 3, y, th: w.pose.th + 30 * DEG });
    expect(w.pose.x).toBeCloseTo(x + 3, 9);
    expect(w.senseGyro()).toBe(30);
    // 350 degrees ahead is 10 degrees back for a gyro that was turned by hand
    w.carry({ x: x + 3, y, th: w.pose.th + 340 * DEG });
    expect(w.senseGyro()).toBe(10);
    w.setPose({ ...w.pose });
    expect(w.senseGyro()).toBe(0);
  });
  test("refuses a pose that overlaps a wall, changing nothing", () => {
    const w = quietWorld(EXAMPLES.wallsMaze);
    const before = { ...w.pose };
    expect(() => w.carry({ x: 1, y: 1, th: 0 })).toThrow(/does not fit/);
    expect(w.pose).toEqual(before);
    expect(() => w.carry({ x: Number.NaN, y: 1, th: 0 })).toThrow(/finite/);
  });
});

describe("obstacles by hand", () => {
  test("a box set down is seen by the distance sensor and stops the robot; taken away, it is gone", () => {
    const w = quietWorld(EXAMPLES.wallsMaze);
    w.setPose({ x: 20, y: 80, th: 0 });
    const i = w.addObstacle({ x: 40, y: 70, w: 10, h: 20 });
    expect(w.cfg.boxes[i]).toEqual({ x: 40, y: 70, w: 10, h: 20 });
    expect(w.coneDistance()).toBeCloseTo(40 - 20 - w.cfg.body.distance_sensor_x_cm, 6);
    // it rolls up to the box and no further
    expect(w.advance(30, 30, 20).stalled).toBe(true);
    expect(w.pose.x + w.cfg.body.front_cm).toBeLessThanOrEqual(40);
    expect(w.pose.x + w.cfg.body.front_cm).toBeGreaterThan(38);
    w.removeObstacle(i);
    // the wall at x 95 is what it sees now
    expect(w.coneDistance()).toBeCloseTo(95 - w.pose.x - w.cfg.body.distance_sensor_x_cm, 6);
    expect(() => w.removeObstacle(99)).toThrow(/no obstacle 99/);
  });
  test("a box on the robot is refused; clones keep their own obstacles", () => {
    const w = new World(config(EXAMPLES.wallsMaze), 1, { ...DRIVE });
    const twin = w.clone();
    const n = w.cfg.boxes.length;
    expect(() => w.addObstacle({ x: w.pose.x - 2, y: w.pose.y - 2, w: 4, h: 4 })).toThrow(/overlap the robot/);
    expect(() => w.addObstacle({ x: 0, y: 0, w: 0, h: 5 })).toThrow(/w and h > 0/);
    expect(w.cfg.boxes.length).toBe(n);
    w.addObstacle({ x: 130, y: 60, w: 5, h: 5 });
    expect(w.cfg.boxes.length).toBe(n + 1);
    expect(twin.cfg.boxes.length).toBe(n);
  });
});

test("peekGyroDeg spends no sensor noise: what the robot reads next does not change", () => {
  const a = new World(config(EXAMPLES.wallsMaze), 7, { ...DRIVE });
  const b = new World(config(EXAMPLES.wallsMaze), 7, { ...DRIVE });
  for (const w of [a, b]) w.advance(-5, 5, 10);
  for (let i = 0; i < 5; i++) a.peekGyroDeg();
  const turned = ((a.pose.th - a.cfg.start.th) * 180) / Math.PI;
  expect(Math.abs(a.peekGyroDeg() - turned)).toBeLessThan(0.05 * Math.abs(turned)); // off only by its scale error
  expect([a.senseGyro(), a.senseUltrasonic()]).toEqual([b.senseGyro(), b.senseUltrasonic()]);
});
