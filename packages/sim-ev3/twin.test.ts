// The twin as it will be assembled: one SimBrick is both the Transport for the EV3 code path and the
// WorldHost behind the sim.world / sim.camera devices.
import { test, expect } from "bun:test";
import * as E from "../driver-ev3/encode";
import { SimWorldProvider } from "../sim-world/world-provider";
import { EXAMPLES } from "../sim-world/testkit";
import { rig } from "./testkit";

const BC = E.OUTPUT_MASK.B | E.OUTPUT_MASK.C;
const idle = new AbortController().signal;

test("packets move the robot and sim.world sees it; reset and load_world act on the brick's world", async () => {
  const { brick, call, clock } = rig();
  const sim = new SimWorldProvider({ host: brick, worlds: { "walls-maze": EXAMPLES.wallsMaze } });
  await call(E.outputStepSync(BC, 40, 0, Math.round((20 * 360) / (Math.PI * 5.6)), true));
  clock.advance(5000); // sim.world must tick the brick itself before answering
  const [x, y, h] = (await sim.read("sim.world", ["pose"]))[0]!.value as number[];
  expect(x).toBeCloseTo(63, 0);
  expect([y, h]).toEqual([25, 0]);

  await sim.command("sim.world", "reset", { x_cm: 30, y_cm: 45, heading_deg: 0 }, idle);
  expect(E.readF32((await call(E.inputReadySi(3, E.SENSOR_TYPE.ultrasonic, 0, 1, 0), 4)).globals, 0)).toBeCloseTo(
    17,
    4,
  );
  expect(E.readF32((await call(E.inputReadySi(1, E.SENSOR_TYPE.gyro, 0, 1, 0), 4)).globals, 0)).toBe(0);

  await call(E.outputStepSync(BC, 40, 0, 3600, true));
  clock.advance(100);
  await sim.command("sim.world", "load_world", { world: "walls-maze" }, idle);
  expect(brick.busy()).toBe(false);
  expect(brick.world.cfg.name).toBe("walls-maze");
  expect((await call(E.inputGetTypeMode(3, 0, 1), 2)).globals[0]).toBe(E.SENSOR_TYPE.ir);
});

test("load_world of a world without an EV3 port map is refused and the twin keeps running", async () => {
  const { brick } = rig();
  const sim = new SimWorldProvider({ host: brick });
  const bare = { ...EXAMPLES.lineOval, name: "bare", extensions: {} };
  await expect(sim.command("sim.world", "load_world", { world: JSON.stringify(bare) }, idle)).rejects.toThrow(
    /extensions\.ev3/,
  );
  expect(brick.world.cfg.name).toBe("line-oval");
});
