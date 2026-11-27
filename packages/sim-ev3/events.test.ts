// The world's event log as a model reads it through sim.world `events`: what the body touched, what it pushed, when
// its wheels stalled or slipped, when the ultrasonic echo went. Reading it changes nothing.
import { describe, expect, test } from "bun:test";
import * as E from "../driver-ev3/encode";
import { EVENT_LOG_MAX, NO_NOISE, World, type WorldEvent } from "../sim-world/world";
import { SimWorldProvider } from "../sim-world/world-provider";
import { EXAMPLES, config, quietWorld } from "../sim-world/testkit";
import { DRIVETRAIN, regulated, rig } from "./testkit";

const BC = E.OUTPUT_MASK.B | E.OUTPUT_MASK.C;
const idle = new AbortController().signal;
/** Every event through the device, parsed back. */
const read = async (sim: SimWorldProvider, since = 0) => {
  const r = await sim.command("sim.world", "events", since ? { since } : {}, idle);
  return {
    next: r.measured.next as number,
    events: (r.measured.events as string[]).map((e) => JSON.parse(e) as WorldEvent),
  };
};
const kinds = (es: WorldEvent[]) =>
  es.map((e) => ("with" in e ? `${e.kind} ${e.with}` : "box" in e ? `${e.kind} ${e.box}` : e.kind));

describe("sim.world events", () => {
  test("driving into the wall: the contact is timed where the body met it, and the wheels stalled; backing off ends both", async () => {
    const r = rig(); // line-oval: the robot at (43, 25) facing the wall at x 120, front 8 cm ahead of the axle
    const sim = new SimWorldProvider({ host: r.brick });
    await r.call(E.outputTimeSync(BC, 50, 0, 5000, true));
    r.run(5000);
    const hit = (await read(sim)).events;
    expect(kinds(hit)).toEqual(["contact_began wall_east", "stall_began", "stall_ended"]);
    // 69 cm at 50 % of 1020 deg/s on 5.6 cm wheels, after the time the motors' rise loses
    const v = (0.5 * 1020 * Math.PI * 5.6) / 360,
      lost = 1 - regulated(510, 1000, 1020) / 510;
    expect(Math.abs(hit[0]!.t_ms - (69 / v + lost) * 1000)).toBeLessThan(5);
    const { next } = await read(sim);
    await r.call(E.outputTimeSync(BC, -50, 0, 500, true));
    r.run(1000);
    expect(kinds((await read(sim, next)).events)).toEqual(["contact_ended wall_east"]);
  });
  test("pushing a box: push_began and push_ended with how far it went", async () => {
    const r = rig(quietWorld(EXAMPLES.lineOval, { boxes: [{ id: "cup", x: 61, y: 20, w: 8, h: 10, mass_g: 150 }] }));
    const sim = new SimWorldProvider({ host: r.brick });
    await r.call(E.outputTimeSync(BC, 40, 0, 1500, true));
    r.run(2000);
    const es = (await read(sim)).events;
    expect(kinds(es)).toEqual(["contact_began cup", "push_began cup", "push_ended cup"]);
    const ended = es[2] as Extract<WorldEvent, { kind: "push_ended" }>;
    expect(ended.moved_cm).toBeCloseTo(r.world.obstacle("cup")!.x - 61, 2);
  });
  test("a tread that slips at a wall says so instead of stalling", async () => {
    const r = rig(quietWorld(), { ...DRIVETRAIN, mass_g: 1000, grip: 0.25 });
    const sim = new SimWorldProvider({ host: r.brick });
    await r.call(E.outputTimeSync(BC, 50, 0, 4000, true));
    r.run(5000);
    expect(kinds((await read(sim)).events)).toEqual(["contact_began wall_east", "slip_began", "slip_ended"]);
  });
  test("the ultrasonic echo lost on a slanted wall, and back square on", async () => {
    const w = new World(
      {
        ...config({ ...EXAMPLES.lineOval, arena: { width_cm: 300, height_cm: 300 }, obstacles: [] }),
        noise: { ...NO_NOISE },
      },
      1,
      { axle_track_cm: 12 },
    );
    const r = rig(w); // line-oval's port map has an ultrasonic sensor on 4
    const sim = new SimWorldProvider({ host: r.brick });
    w.setPose({ x: 250, y: 150, th: 0 });
    const turn = (deg: number) => Math.round((((deg * Math.PI) / 180) * 6 * 360) / (Math.PI * 5.6));
    await r.call(E.outputStepSync(BC, 20, 200, turn(60), true)); // spin 60 deg left on the spot
    r.run(3000);
    await r.call(E.outputStepSync(BC, 20, -200, turn(60), true)); // and back
    r.run(3000);
    const es = (await read(sim)).events.filter((e) => e.kind.startsWith("echo") || e.kind === "placed");
    expect(es.map((e) => e.kind)).toEqual(["placed", "echo_lost", "echo_back"]);
    expect(es[1]).toMatchObject({ why: "slant" });
    // it comes back as the cone's edge turns within 13 deg of square: a little farther than the 42 cm square on
    const back = (es[2] as Extract<WorldEvent, { kind: "echo_back" }>).cm;
    expect(back).toBeGreaterThan(42);
    expect(back).toBeLessThan(42 / Math.cos((26 * Math.PI) / 180));
  });
  test("a person's hand is in the log: the robot carried, a box set down and taken away", async () => {
    const r = rig();
    const sim = new SimWorldProvider({ host: r.brick });
    r.world.carry({ x: 60, y: 60, th: 0 });
    const id = r.world.addObstacle({ x: 90, y: 55, w: 5, h: 5 });
    r.world.removeObstacle(id);
    expect((await read(sim)).events.map((e) => ("how" in e ? e.how : "change" in e ? e.change : e.kind))).toEqual([
      "carried",
      "added",
      "removed",
    ]);
  });
  test("reading the log changes nothing: the same drive reads the same sensors, log or no log; it keeps the latest", async () => {
    const run = async (look: boolean) => {
      const r = rig(new World(config(EXAMPLES.lineOval), 9, { axle_track_cm: 12 })); // default noise
      const sim = new SimWorldProvider({ host: r.brick });
      await r.call(E.outputTimeSync(BC, 50, 0, 5000, true));
      const got: number[] = [];
      for (let i = 0; i < 25; i++) {
        r.run(200);
        if (look) await read(sim);
        got.push(r.world.senseUltrasonic(), r.world.pose.x);
      }
      return got;
    };
    expect(await run(true)).toEqual(await run(false));
    const w = quietWorld();
    for (let i = 0; i < EVENT_LOG_MAX + 30; i++) w.carry({ x: 43, y: 25 + (i % 2), th: 0 });
    const log = w.eventsSince(0);
    expect(log.events.length).toBe(EVENT_LOG_MAX);
    expect(log.dropped).toBe(30);
    expect(log.next).toBe(EVENT_LOG_MAX + 30);
    expect(w.eventsSince(log.next).events).toEqual([]);
    await expect(
      new SimWorldProvider({ host: rig().brick }).command("sim.world", "events", { since: -1 }, idle),
    ).rejects.toThrow(/since must be a whole number/);
  });
});
