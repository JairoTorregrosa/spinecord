// SimBrick.peek: what a viewer shows of the brick. Its sensor values carry no noise and spend nothing of the
// world's sensor generator, so looking never changes what the robot reads.
import { describe, expect, test } from "bun:test";
import * as E from "../driver-ev3/encode";
import { World } from "../sim-world/world";
import { DRIVE, EXAMPLES, config } from "../sim-world/testkit";
import { rig } from "./testkit";

/** A twin in the line-oval world with its noise on (ports: A medium, B and C large, touch, gyro, colour, ultrasonic). */
const noisy = (seed = 5) => rig(new World(config(EXAMPLES.lineOval), seed, { ...DRIVE }));
const readUltrasonic = async (call: ReturnType<typeof rig>["call"]) =>
  E.readF32((await call(E.inputReadySi(3, 0, 0, 1, 0), 4)).globals, 0);

describe("peek", () => {
  test("motors and ports as plugged in, values in the unit of each sensor's mode", () => {
    const { brick, world } = noisy();
    const p = brick.peek();
    expect(p.motors.map((m) => [m.port, m.type])).toEqual([
      ["A", "medium"],
      ["B", "large"],
      ["C", "large"],
      ["D", null],
    ]);
    expect(p.sensors.map((s) => s.kind)).toEqual(["touch", "gyro", "color", "ultrasonic"]);
    const us = p.sensors[3]!.values[0]!;
    expect(Math.abs(us - world.coneDistance())).toBeLessThan(0.06);
    expect(p.sensors[1]!.values).toEqual([0]); // the gyro, clockwise-positive like the real one
    expect(p.led).toBe(0);
    expect(p.tone_count).toBe(0);
  });
  test("looking spends no noise: two equal twins read the same after one of them was peeked at", async () => {
    const a = noisy(9),
      b = noisy(9);
    for (let i = 0; i < 20; i++) a.brick.peek();
    expect(await readUltrasonic(a.call)).toBe(await readUltrasonic(b.call));
  });
  test("reflect mode shows the average of the spot, as the robot reads it: in between on the edge of a line", async () => {
    const { brick, call, world } = rig();
    world.setPose({ x: 43, y: 26.5, th: 0 }); // the sensor's centre on the line's edge
    await call(E.inputReadySi(2, 0, 0, 1, 0), 4); // the colour sensor in reflect mode
    const shown = brick.peek().sensors[2]!.values[0]!;
    expect(shown).toBeGreaterThan(25);
    expect(shown).toBeLessThan(70);
    expect(E.readF32((await call(E.inputReadySi(2, 0, 0, 1, 0), 4)).globals, 0)).toBe(shown);
  });
  test("watching changes nothing: a twin ticked every frame drives the same path as one never looked at", async () => {
    const BC = E.OUTPUT_MASK.B | E.OUTPUT_MASK.C;
    const watched = noisy(3),
      alone = noisy(3);
    for (const t of [watched, alone]) await t.call(E.outputTimeSync(BC, 40, 30, 2000, false));
    for (let i = 0; i < 90; i++) watched.run(33); // a viewer at 30 frames a second
    watched.brick.peek();
    alone.run(2970);
    const a = watched.world.pose,
      b = alone.world.pose;
    // the same noise is drawn; steps cut elsewhere integrate a changing curvature a hair differently
    expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBeLessThan(0.005);
    expect(Math.abs(a.th - b.th)).toBeLessThan(1e-4);
    expect(watched.brick.tacho("B")).toBe(alone.brick.tacho("B"));
    expect(await readUltrasonic(watched.call)).toBe(await readUltrasonic(alone.call));
  });
  test("a turning pair shows its speed and tacho; the gyro follows the turn, clockwise-positive", async () => {
    const { brick, call, run } = rig();
    await call(E.outputStepSync(E.OUTPUT_MASK.B | E.OUTPUT_MASK.C, 40, 200, 3600, true));
    run(600); // past the motors' lag
    const p = brick.peek();
    const b = p.motors[1]!,
      c = p.motors[2]!;
    expect(b.speed_pct).toBe(40);
    expect(c.speed_pct).toBe(-40);
    expect(b.tacho_deg).toBeGreaterThan(0);
    expect(p.sensors[1]!.values[0]).toBeGreaterThan(0); // left wheel ahead, right back: a clockwise turn
  });
  test("tones are counted past the 100 the brick keeps", async () => {
    const { brick, call } = rig();
    for (let i = 0; i < 103; i++) await call(E.soundTone(10, 440 + i, 20));
    expect(brick.tones.length).toBe(100);
    expect(brick.peek().tone_count).toBe(103);
  });
});
