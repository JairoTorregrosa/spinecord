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
  test("a turning pair shows its speed and tacho; the gyro follows the turn, clockwise-positive", async () => {
    const { brick, call, run } = rig();
    await call(E.outputStepSync(E.OUTPUT_MASK.B | E.OUTPUT_MASK.C, 40, 200, 360, true));
    run(100);
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
