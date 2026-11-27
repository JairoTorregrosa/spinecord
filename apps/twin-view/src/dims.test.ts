// The sizes the 3D robot is drawn at are the LEGO parts map's: the numbers a person can check with a ruler.
import { describe, expect, test } from "bun:test";
import { BEAM, BRICK, CASTER, MODULE, MOTOR, SENSOR, TRACKS, wheelFor } from "./dims";

const r2 = (v: number) => Math.round(v * 100) / 100;
const size = (d: { min: number[]; max: number[] }) => d.max.map((m, i) => r2(m - d.min[i]!));

describe("the parts are drawn at their real size", () => {
  test("the brick: 11.12 × 7.2 × 4.36 cm, 5.08 high with the rechargeable battery", () => {
    expect(size(BRICK.aa)).toEqual([11.12, 7.2, 4.36]);
    expect(size(BRICK.rechargeable)).toEqual([11.12, 7.2, 5.08]);
    // the top is the same height either way: the battery hangs lower
    expect(r2(BRICK.aa.max[2] - BRICK.aa.at.screen![2])).toBe(
      r2(BRICK.rechargeable.max[2] - BRICK.rechargeable.at.screen![2]),
    );
  });
  test("motor ports 1.12 cm apart, A at the left; the PC port beyond D; sensor ports 1.52 apart and centred", () => {
    // across the brick, seen from behind with the screen end ahead: y is to the left, LDraw x to the right
    const across = (p: string) => r2(-BRICK.aa.at[p]![1]);
    expect(["port_A", "port_B", "port_C", "port_D", "pc_usb"].map(across)).toEqual([-2.28, -1.16, -0.04, 1.08, 2.32]);
    expect(["port_1", "port_2", "port_3", "port_4"].map(across)).toEqual([-2.28, -0.76, 0.76, 2.28]);
    // motor ports at the screen end, sensor ports at the other
    expect(BRICK.aa.at.port_A![0]).toBeGreaterThan(0);
    expect(BRICK.aa.at.screen![0]).toBeGreaterThan(0);
    expect(BRICK.aa.at.port_1![0]).toBeLessThan(0);
  });
  test("the large motor: 4.0 wide, 5.52 high, 10.72 long, its red hub Ø 2.32 and 2.4 wide", () => {
    const [l, w, h] = size(MOTOR.large);
    expect([w, h, l]).toEqual([4, 5.52, 10.72]);
    expect([MOTOR.large.hub.d, MOTOR.large.hub.w]).toEqual([2.32, 2.4]);
    // the output is at the frame's origin, the body behind it
    expect(MOTOR.large.min[0]).toBeLessThan(0);
    expect(MOTOR.large.max[0]).toBeGreaterThan(9);
  });
  test("the sensors, the caster, the tracks, the grid", () => {
    expect(size(SENSOR.ultrasonic).map(r2)).toEqual([4.74, 5.52, 3.12]);
    expect(size(SENSOR.color)).toEqual([3.96, 2.4, 3.12]);
    expect(CASTER.ball).toBe(1.8);
    expect([TRACKS.rubber.rim, TRACKS.rubber.rimsApart, TRACKS.rubber.d].map(r2)).toEqual([3.04, 9.6, 3.68]);
    expect([TRACKS.links.w, TRACKS.links.pitch, TRACKS.links.teeth].map(r2)).toEqual([3.84, 1.36, 10]);
    expect([MODULE, BEAM.across, BEAM.hole]).toEqual([0.8, 0.72, 0.48]);
    expect(wheelFor(5.6).part).toBe("41897");
  });
});
