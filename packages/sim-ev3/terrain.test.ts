// The brick on terrain: gravity along the slope moves the drive motors' torque-speed line, a slope too steep for the
// tread spins it, an edge too high stalls it, a fall holds it.
import { describe, expect, test } from "bun:test";
import * as E from "../driver-ev3/encode";
import { NO_NOISE, World, parseWorld } from "../sim-world/world";
import { DRIVETRAIN, rig } from "./testkit";

const BC = E.OUTPUT_MASK.B | E.OUTPUT_MASK.C;
/** A long ramp rising east from x 40 to 240 by `rise` cm (start on the floor at x 20 or on the ramp at `x`). */
function slope(rise: number, x = 140, heading_deg = 0, drive = {}) {
  const cfg = parseWorld({
    schema: "spinecord/world@1",
    name: "slope",
    arena: { width_cm: 300, height_cm: 100 },
    start: { x, y: 50, heading_deg },
    terrain: [{ id: "cuesta", kind: "ramp", x: 40, y: 0, w: 200, h: 100, rises: "east", low_cm: 0, high_cm: rise }],
    extensions: { ev3: { motors: { B: "large", C: "large" } } },
  });
  return rig(new World({ ...cfg, noise: { ...NO_NOISE } }, 1), { ...DRIVETRAIN, ...drive });
}
const flat = () => slope(1e-9);

/** How far (cm, along the map) the body goes in `ms` under one command. */
async function travel(r: ReturnType<typeof rig>, bytes: number[], ms: number): Promise<number> {
  const x0 = r.world.pose.x;
  await r.call(bytes);
  r.run(ms);
  return Math.abs(r.world.pose.x - x0);
}

describe("SimBrick on a slope", () => {
  test("a power command runs slower uphill and faster downhill than on the flat", async () => {
    const power = E.outputTimePower(BC, 40, 0, 1000, 0, true);
    const onFlat = await travel(flat(), power, 1000);
    const up = await travel(slope(40, 140, 0, { mass_g: 2000, grip: 1 }), power, 1000); // 11.3 deg, 2 kg
    const down = await travel(slope(40, 140, 180, { mass_g: 2000, grip: 1 }), power, 1000);
    expect(up).toBeLessThan(onFlat * 0.95);
    expect(down).toBeGreaterThan(onFlat * 1.03);
  });

  test("how the viewer's ticks cut time does not move where a power command takes it on a slope", async () => {
    // up a ramp onto a platform: the pitch changes along the way, so each step must feel the slope at the same times
    const end = async (tick_ms: number) => {
      const cfg = parseWorld({
        schema: "spinecord/world@1",
        name: "ramp",
        arena: { width_cm: 300, height_cm: 100 },
        start: { x: 20, y: 50, heading_deg: 0 },
        terrain: [
          { id: "subida", kind: "ramp", x: 40, y: 0, w: 50, h: 100, rises: "east", low_cm: 0, high_cm: 10 },
          { id: "arriba", kind: "platform", x: 90, y: 0, w: 120, h: 100, height_cm: 10 },
        ],
        extensions: { ev3: { motors: { B: "large", C: "large" } } },
      });
      const r = rig(new World({ ...cfg, noise: { ...NO_NOISE } }, 1), DRIVETRAIN);
      await r.call(E.outputTimePower(BC, 60, 0, 4000, 0, true));
      for (let t = 0; t < 4000; t += tick_ms) r.run(Math.min(tick_ms, 4000 - t));
      return r.world.pose;
    };
    const one = await end(1);
    for (const tick of [16, 1000]) {
      const p = await end(tick);
      expect(Math.abs(p.x - one.x)).toBeLessThan(1e-6);
      expect(Math.abs(p.th - one.th)).toBeLessThan(1e-9);
    }
    expect(one.x).toBeGreaterThan(100); // it went up and onto the platform
  });

  test("a speed command holds its setpoint uphill and down, while full power reaches it", async () => {
    const speed = E.outputTimeSpeed(BC, 40, 0, 1000, 0, true);
    const onFlat = await travel(flat(), speed, 1000);
    const up = await travel(slope(40, 140, 0, { mass_g: 2000, grip: 1 }), speed, 1000);
    const down = await travel(slope(40, 140, 180, { mass_g: 2000, grip: 1 }), speed, 1000);
    // the map sees cos(11.3 deg) of the tread on the slope; the encoders all of it
    const along = Math.cos(Math.atan(40 / 200));
    expect(up).toBeCloseTo(onFlat * along, 0);
    expect(down).toBeCloseTo(onFlat * along, 0);
  });

  test("on a slope steeper than its grip the tread spins: the encoders count, the body climbs no higher", async () => {
    // 28 deg against the default grip 0.5 (26.6 deg); the body starts on the floor below it
    const r = slope(106, 20);
    await r.call(E.outputTimeSpeed(BC, 40, 0, 4000, 0, true));
    r.run(4000);
    expect(r.world.last_block?.by).toBe("steep");
    const kinds = r.world.eventsSince(0).events.map((e) => e.kind);
    expect(kinds).toContain("too_steep");
    expect(kinds).toContain("slip_began");
    expect(kinds).not.toContain("stall_began");
    const tacho = r.brick.peek().motors.find((m) => m.port === "B")!.tacho_deg;
    expect(tacho).toBeGreaterThan(3 * 360); // about 4 s of turning at 40 %
    expect(Math.abs(Math.tan(r.world.rest!.pitch))).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  test("the climb the brick hands the world is its wheel's radius", () => {
    expect(slope(10).world.drive!.climb_cm).toBe(DRIVETRAIN.wheel_diameter_cm / 2);
    // on a flat world the drive carries nothing of terrain
    const cfg = parseWorld({
      schema: "spinecord/world@1",
      name: "f",
      arena: { width_cm: 100, height_cm: 100 },
      start: { x: 50, y: 50, heading_deg: 0 },
      extensions: { ev3: { motors: { B: "large", C: "large" } } },
    });
    expect(rig(new World(cfg, 1)).world.drive!.climb_cm).toBeUndefined();
  });
});
