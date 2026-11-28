// A robot file's `twin` (CONTRACT §3): the robot's build travels with the robot, the world keeps the room.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BODY } from "../../../packages/sim-world/world";
import { EXAMPLE, REPO, loadConfig, type RobotSource } from "../src/config";
import { buildFleet } from "../src/sources";
import { describeTwin, describeUnconfirmed, MOVES } from "../src/twin-build";
import { toolsOf } from "./arm";
import { eyeOffset, poseOfBody, rayEnd } from "../../twin-view/src/sensor-pose";
import { sensorRays } from "../src/view";

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
      // a room handed over whole, as JSON, keeps the robot's build too
      const whole = await tool("command_device", {
        device: "sim.world",
        command: "load_world",
        args: { world: JSON.stringify({ ...ROOM, name: "pasted" }) },
      });
      expect(whole.ok).toBe(true);
      expect(brick.world.cfg.name).toBe("pasted");
      expect(brick.ports).toEqual({ motors: { B: "large", C: "large" }, sensors: { "4": "ir" } });
      expect(brick.world.cfg.body.front_cm).toBe(8.5);
      expect(brick.world.cfg.extensions.view).toEqual(TRACKED.twin.view);
    } finally {
      await fleet.shutdown();
    }
  }, 30_000);

  test("a pair of medium motors: the provider sizes moves and reports speed for medium motors, not large ones", async () => {
    const medium = {
      ...TRACKED,
      twin: { ...TRACKED.twin, ev3: { motors: { B: "medium", C: "medium" }, sensors: { "4": "ir" } } },
    };
    const fleet = await buildFleet(loadConfig(["--twin", file("medium.json", medium), "--world", room]), {
      log: () => {},
    });
    try {
      const tool = toolsOf(fleet.robots, "tracked-sim");
      const b = await tool("describe_device", { device: "ev3.B" });
      const speed = (b.data.channels as { name: string; range: number[] }[]).find((c) => c.name === "speed_deg_s")!;
      expect(speed.range).toEqual([-1560, 1560]);
      const world = fleet.bricks.get("tracked-sim")!.world;
      const x0 = world.pose.x;
      const r = await tool("drive", { distance_cm: 20, speed_pct: 40 });
      expect(r.ok).toBe(true);
      expect(Math.abs(world.pose.x - x0 - 20)).toBeLessThan(1.5);
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
    expect(fails({ ...r1Bare, twin: { look: {} } })).toThrow(
      "twin.look is not a part of twin (body, ev3, view, drive, unconfirmed)",
    );
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

  test("a role on ev3.pair in a file without pair", () => {
    const { pair: _p, ...noPair } = TRACKED;
    const profile = { ...TRACKED.profile, roles: { drive: "ev3.pair" } };
    delete (profile as Record<string, unknown>).drivetrain;
    expect(fails({ ...noPair, profile })).toThrow("profile.roles.drive names ev3.pair, and the file has no pair");
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

describe("twin.unconfirmed: a draft twin says what nobody confirmed", () => {
  const draft = (unconfirmed: unknown, base: Record<string, unknown> = TRACKED) => ({
    ...base,
    twin: { ...TRACKED.twin, unconfirmed },
  });
  test("runs as any twin; the list reaches the page in extensions.view.unconfirmed, beside the look", () => {
    const t = twinOf(draft(["B", "C", "S4", "front", "wheel_diameter", "axle_track"]));
    expect(t.unconfirmed).toEqual(["B", "C", "S4", "front", "wheel_diameter", "axle_track"]);
    const view = (t.world as { extensions: { view: Record<string, unknown> } }).extensions.view;
    expect(view).toEqual({ ...TRACKED.twin.view, unconfirmed: t.unconfirmed });
    expect(describeTwin(t.robot, t.world, true)).toContain("look drive, phone;");
    expect(describeUnconfirmed(t.unconfirmed!)).toBe(
      "6 unconfirmed (6 change how it moves): ports B, C, S4; front; wheel diameter; axle track",
    );
    expect(describeUnconfirmed(["places", "S2", "left_right"])).toBe(
      "3 unconfirmed (2 change how it moves): port S2; left/right; places",
    );
  });
  test("absent or empty: not a draft, and the page gets no list; a port that the build leaves empty may be listed", () => {
    for (const u of [undefined, []]) {
      const t = twinOf(draft(u));
      expect(t.unconfirmed).toEqual([]);
      expect((t.world as { extensions: { view: Record<string, unknown> } }).extensions.view).toEqual(TRACKED.twin.view);
    }
    const noView = twinOf({ ...TRACKED, twin: { ev3: TRACKED.twin.ev3, unconfirmed: ["A"] } });
    expect((noView.world as { extensions: { view: unknown } }).extensions.view).toEqual({ unconfirmed: ["A"] });
    expect(describeTwin(noView.robot, noView.world, true)).toContain("look default;");
  });
  test("the running twin keeps the list in its world, also after load_world of its room by name", async () => {
    const fleet = await buildFleet(loadConfig(["--twin", file("draft.json", draft(["B", "front"])), "--world", room]), {
      log: () => {},
    });
    try {
      const brick = fleet.bricks.get("tracked-sim")!;
      expect(brick.world.cfg.extensions.view).toEqual({ ...TRACKED.twin.view, unconfirmed: ["B", "front"] });
      const loaded = await toolsOf(fleet.robots, "tracked-sim")("command_device", {
        device: "sim.world",
        command: "load_world",
        args: { world: "hall" },
      });
      expect(loaded.ok).toBe(true);
      expect(brick.world.cfg.extensions.view).toEqual({ ...TRACKED.twin.view, unconfirmed: ["B", "front"] });
    } finally {
      await fleet.shutdown();
    }
  }, 30_000);
  test("refused when read, from any source, naming twin.unconfirmed", () => {
    expect(fails(draft("front"))).toThrow("twin.unconfirmed must be a list");
    expect(fails(draft(["ports"]))).toThrow('twin.unconfirmed: "ports" is not one of A, B, C, D, S1');
    expect(fails(draft([3]))).toThrow("twin.unconfirmed: 3 is not one of");
    expect(fails(draft(["front", "front"]))).toThrow("twin.unconfirmed: front is listed twice");
    const { pair: _p, ...noPair } = TRACKED;
    const noDrive = { ...noPair, profile: { ...TRACKED.profile, drivetrain: undefined } };
    expect(fails(draft(["left_right"], noDrive))).toThrow("left_right needs a pair");
    expect(fails(draft(["wheel_diameter"], noDrive))).toThrow("wheel_diameter needs profile.drivetrain");
    expect(fails(draft(["axle_track"], noDrive))).toThrow("axle_track needs profile.drivetrain");
    expect(twinOf(draft(["drive", "front", "A"], noDrive)).unconfirmed).toEqual(["drive", "front", "A"]);
    expect(fails({ ...TRACKED, twin: { ...TRACKED.twin, view: { unconfirmed: ["B"] } } })).toThrow(
      "twin.view.unconfirmed is not a field of the look",
    );
    expect(() => loadConfig(["--ev3", file("hw.json", draft(["B", "B"]))])).toThrow("B is listed twice");
  });
});

describe("the robot-twin skill", () => {
  const skill = join(import.meta.dir, "..", "..", "..", ".claude", "skills", "robot-twin");
  test("its template is a robot file the server takes, and its links point at files that are there", () => {
    const ref = readFileSync(join(skill, "reference", "robot-file.md"), "utf8");
    const template = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(ref)![1]);
    const t = twinOf(template);
    expect(t.ownBuild).toBe(true);
    expect(t.id).toBe("my-robot-sim");
    // the template is a draft: every value that changes how a drive base moves starts unconfirmed
    expect([...t.unconfirmed!].sort()).toEqual([...MOVES].sort());
    for (const md of ["SKILL.md", join("reference", "robot-file.md")]) {
      const text = readFileSync(join(skill, md), "utf8");
      for (const [, link] of text.matchAll(/\]\(((?:reference\/)?[a-z-]+\.md)\)/g))
        expect(Bun.file(join(skill, md.includes("reference") ? "reference" : "", link)).size).toBeGreaterThan(0);
    }
  });
});

describe("twin.drive: the drivetrain as it physically is, apart from what the profile believes", () => {
  const ORUGAS = join(REPO, "deployments", "orugas", "robots", "orugas.json");
  const SALA = join(REPO, "deployments", "orugas", "worlds", "sala.json");
  const orugas = JSON.parse(readFileSync(ORUGAS, "utf8"));
  /** One `turn 360` on the orugas twin in sala, with `axle_track_cm` as the person wrote it: degrees it really turned. */
  const turn360 = async (axle_track_cm: number): Promise<{ real: number; reported: number }> => {
    const robot = {
      ...orugas,
      profile: { ...orugas.profile, drivetrain: { ...orugas.profile.drivetrain, axle_track_cm } },
    };
    const fleet = await buildFleet(loadConfig(["--twin", file("orugas.json", robot), "--world", SALA]), {
      log: () => {},
    });
    try {
      const world = fleet.bricks.get("orugas-sim")!.world;
      const th0 = world.pose.th;
      const r = await toolsOf(fleet.robots, "orugas-sim")("turn", { angle_deg: 360, speed_pct: 40 });
      expect(r.ok).toBe(true);
      // the unwrapped heading: the pose channel wraps to +-180, and 288 deg would read as -72
      return { real: ((world.pose.th - th0) * 180) / Math.PI, reported: r.data.measured.heading_change_deg };
    } finally {
      await fleet.shutdown();
    }
  };

  test("a person who measures turn 360, corrects axle_track_cm and turns again sees the turn come right", async () => {
    const before = await turn360(orugas.profile.drivetrain.axle_track_cm);
    // the tracks scrub (twin.drive.turn_scrub 0.2) and slip: the encoders say 360, the robot turns about 280
    expect(Math.abs(before.reported - 360)).toBeLessThan(5);
    expect(before.real).toBeLessThan(300);
    expect(before.real).toBeGreaterThan(260);
    // the correction a person makes on the real robot: the wheels must travel more per degree
    const corrected = orugas.profile.drivetrain.axle_track_cm * (360 / before.real);
    const after = await turn360(corrected);
    // motor noise and wheel bias of sala stay (about 1 % each); what was a 70-80 deg error is now a few degrees
    expect(Math.abs(after.real - 360)).toBeLessThan(10);
  }, 30_000);

  test("without twin.drive the profile is the physical truth too, as before", () => {
    const { twin: t, ...rest } = orugas;
    const { drive: _drive, ...build } = t;
    expect(twinOf({ ...rest, twin: build }).build?.drive).toBeUndefined();
    expect(twinOf(orugas).build?.drive).toEqual({ wheel_diameter_cm: 3.5, axle_track_cm: 13.5, turn_scrub: 0.2 });
  });

  test("twin.drive is refused, naming the field, when it is not a drivetrain", () => {
    const withDrive = (drive: unknown, over: object = {}) =>
      fails({ ...orugas, ...over, twin: { ...orugas.twin, drive } });
    expect(withDrive([])).toThrow("twin.drive must be an object");
    expect(withDrive({ wheel_cm: 3 })).toThrow("twin.drive.wheel_cm is not a part of twin.drive");
    expect(withDrive({ axle_track_cm: 0 })).toThrow("twin.drive.axle_track_cm must be a number > 0");
    expect(withDrive({ turn_scrub: 1 })).toThrow(
      "twin.drive.turn_scrub must be a number from 0 up to (not including) 1",
    );
    const { drivetrain: _d, ...noDrivetrain } = orugas.profile;
    expect(withDrive({ turn_scrub: 0.1 }, { profile: noDrivetrain })).toThrow(
      /no profile.drivetrain: remove twin.drive/,
    );
  });

  test("twin.drive.tread names the tread's grip (TREAD_GRIP): with the weight it decides slip or stall at a wall", async () => {
    const withDrive = (drive: object) => ({
      ...orugas,
      twin: { ...orugas.twin, drive: { ...orugas.twin.drive, ...drive } },
    });
    expect(twinOf(withDrive({ tread: "tracks", mass_g: 900 })).build?.drive).toMatchObject({ grip: 0.25, mass_g: 900 });
    expect(twinOf(withDrive({ tread: "tyres", mass_g: 900 })).build?.drive).toMatchObject({ grip: 1, mass_g: 900 });
    expect(fails(withDrive({ tread: "wheels", mass_g: 900 }))).toThrow("twin.drive.tread must be one of tyres, tracks");
    expect(fails(withDrive({ tread: "tracks", grip: 0.3, mass_g: 900 }))).toThrow("give tread or grip, not both");
    expect(fails(withDrive({ tread: "tracks" }))).toThrow("mass_g and grip (or tread) go together");
    // orugas on its plastic tracks, 900 g, driven into sala's wall: the tracks slip, the encoders keep counting
    const fleet = await buildFleet(
      loadConfig(["--twin", file("orugas-tracks.json", withDrive({ tread: "tracks", mass_g: 900 })), "--world", SALA]),
      { log: () => {} },
    );
    try {
      const w = fleet.bricks.get("orugas-sim")!.world;
      w.setPose({ x: w.cfg.width - w.cfg.body.front_cm - 3, y: w.cfg.height / 2, th: 0 });
      const r = await toolsOf(fleet.robots, "orugas-sim")("drive", { distance_cm: 20, speed_pct: 40 });
      expect(r.ok).toBe(true);
      expect(r.data.reason).toBe("completed"); // the encoders say 20 cm; the body stopped at the wall
      expect(w.eventsSince(0).events.map((e) => e.kind)).toContain("slip_began");
    } finally {
      await fleet.shutdown();
    }
  }, 30_000);

  test("--doctor shows what the twin physically has where it is not what the profile believes", () => {
    const robot = {
      ...orugas,
      profile: { ...orugas.profile, drivetrain: { ...orugas.profile.drivetrain, axle_track_cm: 16 } },
    };
    const t = twinOf(robot, SALA);
    expect(describeTwin(t.robot, t.world, true, t.build?.drive)).toContain(
      "wheel 3.5 cm, axle track 16 cm (really 13.5 cm), turns scrub 0.2,",
    );
  });
});

describe("the distance sensor's pose: the reading, the rays and the drawn sensor from one point", () => {
  const ORUGAS = join(REPO, "deployments", "orugas", "robots", "orugas.json");
  const orugas = JSON.parse(readFileSync(ORUGAS, "utf8"));
  /** A build as the robot-twin skill writes it: body x only, the sensor's real place (off-centre, turned, low) in the look. */
  const offCentre = (sensor: object, body: object = {}) => ({
    ...orugas,
    twin: {
      ...orugas.twin,
      body: { front_cm: 8.5, back_cm: 13.5, half_width_cm: 9, distance_sensor_x_cm: 6, ...body },
      view: { ...orugas.twin.view, sensors: { "4": sensor } },
    },
  });
  const PLACE = { x_cm: 4, y_cm: -5, z_cm: 12, facing: "forward", yaw_deg: 20 };
  const eye = eyeOffset("ir");
  const rad = (20 * Math.PI) / 180;

  test("a place in the look sets the side, the height and the heading the physics reads with", () => {
    const b = (twinOf(offCentre(PLACE)).world as { body: Record<string, number> }).body;
    expect(b.distance_sensor_x_cm).toBe(6); // the body's measured number wins
    expect(b.distance_sensor_y_cm).toBeCloseTo(-5 + eye[0] * Math.sin(rad), 2);
    expect(b.distance_sensor_z_cm).toBeCloseTo(12 + eye[2], 2);
    expect(b.distance_sensor_yaw_deg).toBe(20);
  });

  test("the running twin reads along the drawn sensor's axis: a box on it is where its rays end", async () => {
    const SALA = join(REPO, "deployments", "orugas", "worlds", "sala.json");
    const fleet = await buildFleet(loadConfig(["--twin", file("offc.json", offCentre(PLACE)), "--world", SALA]), {
      log: () => {},
    });
    try {
      const w = fleet.bricks.get("orugas-sim")!.world;
      const pose = poseOfBody(w.cfg.body);
      w.setPose({ x: 40, y: 75, th: 0 });
      const { o } = w.distanceSensorAxis();
      // a tall box whose face is 30 cm from the eye along its heading: the middle ray ends there
      const ahead = 30;
      const hit: [number, number] = [o[0] + ahead * Math.cos(rad), o[1] + ahead * Math.sin(rad)];
      w.addObstacle({ x: hit[0], y: hit[1] - 4, w: 6, h: 8 });
      const rays = sensorRays(w, ["ir"]);
      expect(rays.from).toEqual(pose);
      const mid = rays.ir!.rays[(rays.ir!.rays.length - 1) / 2]!;
      expect(mid.deg).toBe(0);
      expect(mid.cm).toBeCloseTo(ahead, 1);
      // the drawn end of that ray, robot frame, is on the box's face
      const end = rayEnd(rays.from, mid.deg, mid.cm);
      expect(end[0]).toBeCloseTo(hit[0] - 40, 0);
      expect(-end[2]).toBeCloseTo(hit[1] - 75, 0);
      expect(end[1]).toBeCloseTo(pose.z_cm, 9);
      // the reading comes from the eye, not from the centre line: it sees the box
      expect(w.irProximity()).toBeLessThan(100);
    } finally {
      await fleet.shutdown();
    }
  }, 30_000);

  test("orugas: its eye on top of the phone, 4.6 cm left of the centre line, as the body states it", () => {
    const b = (twinOf(orugas).world as { body: Record<string, number> }).body;
    expect([b.distance_sensor_x_cm, b.distance_sensor_y_cm, b.distance_sensor_z_cm]).toEqual([6, 4.6, 20]);
    expect(b.distance_sensor_yaw_deg).toBeUndefined(); // looking ahead, the default
  });

  test("refused when the body and the look put the eye on different sides or looking different ways", () => {
    expect(fails(offCentre(PLACE, { distance_sensor_y_cm: 5 }))).toThrow(
      "twin.view.sensors.4 puts the distance sensor's eye at distance_sensor_y_cm",
    );
    expect(fails(offCentre(PLACE, { distance_sensor_yaw_deg: -20 }))).toThrow("distance_sensor_yaw_deg 20");
    // the same pose written in both is one pose
    const y = -5 + eye[0] * Math.sin(rad);
    expect(() => twinOf(offCentre(PLACE, { distance_sensor_y_cm: y, distance_sensor_yaw_deg: 20 }))).not.toThrow();
  });
});
