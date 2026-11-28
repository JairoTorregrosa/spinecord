// Restore is one operation (SimWorldProvider.restore, also sim.world `restore`): after any edits of the room (boxes
// set down, moved or taken away, the robot carried or driven into a stall, a sensor gone silent, a whole other
// world taken with load_world, named points and all) the twin is exactly what a fresh start in its world file is.
import { expect, test } from "bun:test";
import * as E from "../driver-ev3/encode";
import { SimWorldProvider } from "../sim-world/world-provider";
import { EXAMPLES, quietWorld } from "../sim-world/testkit";
import { rig } from "./testkit";

const BC = E.OUTPUT_MASK.B | E.OUTPUT_MASK.C;
const idle = new AbortController().signal;

/** A twin in line-oval as a start makes it: the brick and the world provider over it. */
function twin() {
  const r = rig(quietWorld(EXAMPLES.lineOval));
  const sim = new SimWorldProvider({ host: r.brick, worlds: { "walls-maze": EXAMPLES.wallsMaze } });
  return { ...r, sim };
}

/**
 * Everything of the twin that a restore must bring back: the whole World (its configuration with every box, zone,
 * line and named point, the pose, gyro, trip meters, noise streams, event log, obstacle ids) and the brick's own
 * state of the room (ports, motors, sensors, a stall). The brick's screen, LED, tones and log are its own output and
 * stay; the clock goes on.
 */
function snapshot(t: ReturnType<typeof twin>) {
  const b = t.brick as unknown as Record<string, unknown>;
  const peek = t.brick.peek();
  return {
    world: t.brick.world,
    ports: t.brick.ports,
    motors: peek.motors,
    sensors: peek.sensors,
    inner: ["motors", "sensors", "driveState", "slipNow", "touchWas", "hasTouch", "bumps", "loadNcm"].map((k) => b[k]),
  };
}

/** A room as a model might write it: no boxes or zones, 27 named points, the robot somewhere else. */
const markers = JSON.stringify({
  ...EXAMPLES.lineOval,
  name: "marcas",
  obstacles: [],
  zones: [],
  lines: [],
  points: Array.from({ length: 27 }, (_, i) => ({
    label: `p${String(i + 1).padStart(2, "0")}`,
    x: 10 + (i % 9) * 12,
    y: 20 + Math.floor(i / 9) * 25,
    radius_cm: 3,
  })),
  start: { x: 60, y: 45, heading_deg: 90 },
});

async function edit(t: ReturnType<typeof twin>): Promise<void> {
  const w = t.brick.world;
  // a person's hand: a box set down, the world's own box moved, then taken away, the robot carried and turned
  w.addObstacle({ x: 100, y: 40, w: 8, h: 8 });
  w.moveObstacle("box1", { x: 30, y: 60, w: 10, h: 10 });
  w.removeObstacle("box1");
  w.carry({ x: 20, y: 45, th: Math.PI });
  // the robot drives into the west wall until its wheels stall, and a sensor goes silent
  await t.call(E.outputPower(BC, 60));
  await t.call(E.outputStart(BC));
  t.run(4000);
  t.brick.silenceSensor(3);
  expect(w.eventsSince(0).events.some((e) => e.kind === "stall_began")).toBe(true);
  await t.sim.command("sim.speaker", "speak", { text: "hola" }, idle);
}

test("restore after a person's edits and a stall equals a fresh start in the world file", async () => {
  const fresh = snapshot(twin());
  const t = twin();
  await edit(t);
  expect(Bun.deepEquals(snapshot(t), fresh)).toBe(false);
  t.sim.restore();
  expect(snapshot(t)).toEqual(fresh);
  expect(Bun.deepEquals(snapshot(t), fresh, true)).toBe(true);
  expect((await t.sim.read("sim.speaker", ["last_spoken"]))[0]!.value).toBe("");
});

test("restore drops a world a model took with load_world (its named points too) and goes back to the file's", async () => {
  const fresh = snapshot(twin());
  const t = twin();
  await t.sim.command("sim.world", "load_world", { world: markers }, idle);
  expect(t.brick.world.cfg.points).toHaveLength(27);
  await edit(t);
  await t.sim.command("sim.world", "load_world", { world: "walls-maze" }, idle);
  await t.sim.command("sim.world", "load_world", { world: markers }, idle);
  t.brick.world.addObstacle({ x: 90, y: 70, w: 6, h: 6 });
  // the model's own reset is a teleport inside the room it is in: the points stay
  await t.sim.command("sim.world", "reset", {}, idle);
  expect(t.brick.world.cfg.points).toHaveLength(27);
  t.sim.restore();
  expect(Bun.deepEquals(snapshot(t), fresh, true)).toBe(true);
  expect(t.brick.world.cfg.name).toBe("line-oval");
});

test("sim.world restore is the same operation as the page's button", async () => {
  const fresh = snapshot(twin());
  const t = twin();
  await t.sim.command("sim.world", "load_world", { world: markers }, idle);
  await edit(t);
  const r = await t.sim.command("sim.world", "restore", {}, idle);
  expect(r.reason).toBe("completed");
  expect(r.measured.world).toBe("line-oval");
  expect(Bun.deepEquals(snapshot(t), fresh, true)).toBe(true);
  await expect(t.sim.command("sim.world", "restore", { x_cm: 1 }, idle)).rejects.toThrow(/takes no arguments/);
});

test("a restore twice in a row gives two fresh worlds that do not share state", async () => {
  const t = twin();
  t.sim.restore();
  const first = t.brick.world;
  first.addObstacle({ x: 100, y: 40, w: 8, h: 8 });
  t.sim.restore();
  expect(t.brick.world).not.toBe(first);
  expect(t.brick.world.cfg.boxes.map((b) => b.id)).toEqual(["box1"]);
});
