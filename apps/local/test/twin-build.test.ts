// A robot file's `twin` (CONTRACT §3): the robot's build travels with the robot, the world keeps the room.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BODY } from "../../../packages/sim-world/world";
import { EXAMPLE, loadConfig, type RobotSource } from "../src/config";
import { buildFleet } from "../src/sources";
import { toolsOf } from "./arm";

const tmp = mkdtempSync(join(tmpdir(), "spinecord-build-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const file = (name: string, json: unknown): string => {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(json));
  return path;
};
const r1 = JSON.parse(readFileSync(EXAMPLE.robot, "utf8"));
const { twin: _r1Twin, ...r1Bare } = r1;

/** A room that holds another robot's build: four motors, a sensor on each port, a footprint and a look of its own. */
const ROOM = {
  schema: "spinecord/world@1",
  name: "hall",
  arena: { width_cm: 150, height_cm: 100 },
  obstacles: [{ x: 100, y: 40, w: 10, h: 10 }],
  start: { x: 30, y: 50, heading_deg: 0 },
  noise: { slip: 0.03 },
  body: { front_cm: 20, back_cm: 20, half_width_cm: 15, distance_sensor_x_cm: 19 },
  extensions: {
    ev3: {
      motors: { A: "medium", B: "large", C: "large", D: "medium" },
      sensors: { "1": "touch", "2": "gyro", "3": "color", "4": "ultrasonic" },
    },
    view: { drive: "wheels", label: "X" },
    other: { kept: true },
  },
};
const room = file("hall.json", ROOM);

/** A tracked base: B and C drive, an infrared sensor on 4, its own footprint and look. */
const TRACKED = {
  ...r1Bare,
  profile: {
    ...r1.profile,
    id: "tracked",
    roles: { left_wheel: "ev3.B", right_wheel: "ev3.C", distance: "ev3.S4" },
    drivetrain: { ...r1.profile.drivetrain, heading: undefined },
  },
  twin: {
    body: { front_cm: 8.5, back_cm: 13.5, half_width_cm: 9, distance_sensor_x_cm: 6 },
    ev3: { motors: { B: "large", C: "large" }, sensors: { "4": "ir" } },
    view: { drive: "tracks", phone: { x_cm: 5, bottom_cm: 10, screen: "front" } },
  },
};
delete (TRACKED.profile.drivetrain as Record<string, unknown>).heading;

const twinOf = (robot: unknown, world = room): Extract<RobotSource, { source: "twin" }> => {
  const c = loadConfig(["--twin", file("robot.json", robot), "--world", world]);
  return c.robots[0] as Extract<RobotSource, { source: "twin" }>;
};
const fails =
  (robot: unknown, world = room) =>
  () =>
    twinOf(robot, world);

describe("a robot file's twin", () => {
  test("carries its build into any room: ports, footprint and look are the robot's, the rest is the room's", () => {
    const t = twinOf(TRACKED);
    const w = t.world as typeof ROOM;
    expect(t.ownBuild).toBe(true);
    expect(w.extensions.ev3).toEqual(TRACKED.twin.ev3);
    expect(w.extensions.view).toEqual(TRACKED.twin.view as never);
    expect(w.body).toEqual(TRACKED.twin.body);
    // the room stays the room
    expect(w.arena).toEqual(ROOM.arena);
    expect(w.obstacles).toEqual(ROOM.obstacles);
    expect(w.noise).toEqual(ROOM.noise);
    expect((w.extensions as Record<string, unknown>).other).toEqual({ kept: true });
  });

  test("owns its whole build: a section it leaves out takes the package default, never the room's", () => {
    const t = twinOf({ ...TRACKED, twin: { ev3: TRACKED.twin.ev3 } });
    const w = t.world as Record<string, any>;
    expect(w.body).toBeUndefined();
    expect(w.extensions.view).toBeUndefined();
    expect(w.extensions.other).toEqual({ kept: true });
  });

  test("a file without twin takes the room's build, as before", () => {
    const t = twinOf(r1Bare);
    expect(t.ownBuild).toBe(false);
    expect((t.world as typeof ROOM).extensions.ev3).toEqual(ROOM.extensions.ev3);
    expect((t.world as typeof ROOM).body).toEqual(ROOM.body);
  });

  test("the running twin is the robot's build, also after load_world of its room by name", async () => {
    const fleet = await buildFleet(loadConfig(["--twin", file("tracked.json", TRACKED), "--world", room]), {
      log: () => {},
    });
    try {
      const brick = fleet.bricks.get("tracked-sim")!;
      expect(brick.ports).toEqual({ motors: { B: "large", C: "large" }, sensors: { "4": "ir" } });
      expect(brick.world.cfg.body).toEqual({ ...DEFAULT_BODY, ...TRACKED.twin.body });
      expect(brick.world.cfg.extensions.view).toEqual(TRACKED.twin.view);
      const tool = toolsOf(fleet.robots, "tracked-sim");
      const d = await tool("describe_robot");
      const ids = (d.data.devices as { id: string }[]).map((x) => x.id);
      expect(ids).toContain("ev3.S4");
      expect(ids).not.toContain("ev3.A");
      const loaded = await tool("command_device", {
        device: "sim.world",
        command: "load_world",
        args: { world: "hall" },
      });
      expect(loaded.ok).toBe(true);
      expect(brick.ports).toEqual({ motors: { B: "large", C: "large" }, sensors: { "4": "ir" } });
      expect(brick.world.cfg.body.front_cm).toBe(8.5);
    } finally {
      await fleet.shutdown();
    }
  }, 30_000);

  test("every combination of the brick: four free actuators and no sensor; four sensors and no motor", async () => {
    const arms = {
      description: "four actuators",
      hardware: r1.hardware,
      profile: {
        id: "arms",
        roles: { head: "ev3.A", lift: "ev3.B", grip: "ev3.C", wrist: "ev3.D" },
        limits: r1.profile.limits,
        notes: [],
      },
      twin: { ev3: { motors: { A: "medium", B: "large", C: "large", D: "medium" } } },
    };
    const eyes = {
      hardware: r1.hardware,
      profile: {
        id: "eyes",
        roles: { touch: "ev3.S1", gyro: "ev3.S2", color: "ev3.S3", distance: "ev3.S4" },
        limits: r1.profile.limits,
        notes: [],
      },
      twin: { ev3: { sensors: { "1": "touch", "2": "gyro", "3": "color", "4": "ir" } } },
    };
    const config = loadConfig([
      "--config",
      file("both.json", {
        robots: [
          { source: "twin", robot: file("arms.json", arms), world: room },
          { source: "twin", robot: file("eyes.json", eyes), world: room },
        ],
      }),
    ]);
    const fleet = await buildFleet(config, { log: () => {} });
    try {
      const kinds = async (id: string) =>
        ((await toolsOf(fleet.robots, id)("describe_robot")).data.devices as { id: string; kind: string }[])
          .filter((x) => x.id.startsWith("ev3.") && /^ev3\.(S?\d|[A-D])$/.test(x.id))
          .map((x) => `${x.id} ${x.kind}`);
      expect(await kinds("arms-sim")).toEqual(["ev3.A motor", "ev3.B motor", "ev3.C motor", "ev3.D motor"]);
      expect((await kinds("eyes-sim")).map((k) => k.split(" ")[0])).toEqual(["ev3.S1", "ev3.S2", "ev3.S3", "ev3.S4"]);
    } finally {
      await fleet.shutdown();
    }
  }, 30_000);
});

describe("refused at start, naming the field", () => {
  test("a top-level key that is not part of a robot file (a typo would run the room's build in silence)", () => {
    expect(fails({ ...r1Bare, twn: {} })).toThrow("twn is not a part of a robot file");
    // whatever source reads the file
    expect(() => loadConfig(["--ev3", file("typo.json", { ...r1Bare, twn: {} })])).toThrow(
      "twn is not a part of a robot file",
    );
  });

  test("twin itself: not an object, a key it does not have, a view that is not an object", () => {
    expect(fails({ ...r1Bare, twin: [] })).toThrow("twin must be an object");
    expect(fails({ ...r1Bare, twin: { look: {} } })).toThrow("twin.look is not a part of twin (body, ev3, view)");
    expect(fails({ ...r1Bare, twin: { ...r1.twin, view: "tracks" } })).toThrow("twin.view must be an object");
  });

  test("twin.body and twin.ev3 through the world's own validators, named twin.<field>", () => {
    expect(fails({ ...TRACKED, twin: { ...TRACKED.twin, body: { front: 3 } } })).toThrow(
      "twin.body.front is not a known field",
    );
    expect(fails({ ...TRACKED, twin: { ...TRACKED.twin, body: { front_cm: -1 } } })).toThrow(
      "twin.body.front_cm must be a finite number >= 0",
    );
    expect(fails({ ...TRACKED, twin: { ev3: { motors: { E: "large" } } } })).toThrow(
      "twin.ev3.motors.E is not a motor port",
    );
    expect(fails({ ...TRACKED, twin: { ev3: { motors: { B: "big" } } } })).toThrow(
      'twin.ev3.motors.B must be large or medium, got "big"',
    );
    expect(fails({ ...TRACKED, twin: { ev3: { sensors: { "4": "sound" } } } })).toThrow(
      'twin.ev3.sensors.4 must be touch, color, ultrasonic, gyro or ir, got "sound"',
    );
    // on hardware too: the file is wrong wherever it is read
    expect(() =>
      loadConfig(["--ev3", file("bad-ev3.json", { ...TRACKED, twin: { ev3: { motors: { E: 1 } } } })]),
    ).toThrow("twin.ev3.motors.E");
  });

  test("a role on a sensor port with nothing plugged in says how to fix it", () => {
    const noIr = { ...TRACKED, twin: { ...TRACKED.twin, ev3: { motors: { B: "large", C: "large" } } } };
    const e = fails(noIr);
    expect(e).toThrow("profile.roles.distance names ev3.S4, and the twin has no sensor on port 4");
    expect(e).toThrow('add "sensors": {"4": "<touch|color|ultrasonic|gyro|ir>"} to twin.ev3');
    expect(e).toThrow("or change profile.roles.distance");
  });

  test("a role on a motor port with nothing plugged in", () => {
    const arm = { ...TRACKED, profile: { ...TRACKED.profile, roles: { ...TRACKED.profile.roles, arm: "ev3.A" } } };
    expect(fails(arm)).toThrow("profile.roles.arm names ev3.A, and the twin has no motor on port A");
  });

  test("a pair on a port with no motor", () => {
    const e = fails({ ...TRACKED, pair: { left: "A", right: "C" }, profile: { ...TRACKED.profile, roles: {} } });
    expect(e).toThrow("pair.left is port A, and the twin has no motor there");
  });

  test("a heading device named by id on an empty port, and a pair_device that is not ev3.pair", () => {
    const drivetrain = { ...TRACKED.profile.drivetrain, heading: { device: "ev3.S2", channel: "angle_deg" } };
    expect(fails({ ...TRACKED, profile: { ...TRACKED.profile, drivetrain } })).toThrow(
      "profile.drivetrain.heading.device names ev3.S2, and the twin has no sensor on port 2",
    );
    const other = { ...TRACKED.profile.drivetrain, pair_device: "ev3.B" };
    expect(fails({ ...TRACKED, profile: { ...TRACKED.profile, drivetrain: other } })).toThrow(
      'profile.drivetrain.pair_device must be "ev3.pair"',
    );
  });

  test("a file without twin in a room without ports: points at twin.ev3 of the robot file", () => {
    const bare = file("bare-room.json", { ...ROOM, extensions: {} });
    expect(fails(r1Bare, bare)).toThrow("add a twin section to");
    expect(fails(r1Bare, bare)).toThrow("this robot file has no twin section");
  });

  test("ids of other providers are not ports: a role on a page device or sim.camera passes", () => {
    const roles = { ...TRACKED.profile.roles, eyes: "sim.camera", face: "phone.display" };
    expect(twinOf({ ...TRACKED, profile: { ...TRACKED.profile, roles } }).ownBuild).toBe(true);
  });
});
