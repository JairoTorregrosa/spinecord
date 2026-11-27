// The shape of a robot comes from its robot file (CONTRACT §3): a pair only when declared, a drivetrain only when
// declared, a heading channel only when named. The two example robots, as a twin and behind the stock code path
// on the byte-level emulator. The ev3dev path of the same robots is in ev3dev.test.ts.
import { describe, expect, test } from "bun:test";
import { parseRobotFile, type RobotFile } from "../../../packages/driver-ev3/robot-file";
import { SimBrick } from "../../../packages/sim-ev3/brick";
import { World, parseWorld } from "../../../packages/sim-world/world";
import { EXAMPLE, loadConfig } from "../src/config";
import { LocalRobot } from "../src/robot";
import { buildFleet, ev3Runtime } from "../src/sources";
import { ARM, armWorks, file, toolsOf } from "./arm";

describe("the arm example: no pair, no drivetrain", () => {
  test("its robot file declares neither, and a drivetrain without a pair is refused when the file is read", async () => {
    const arm = await file(ARM);
    expect(arm.pair).toBeUndefined();
    expect(arm.profile.drivetrain).toBeUndefined();
    const base = await Bun.file(EXAMPLE.robot).json();
    const { pair: _pair, ...noPair } = base;
    expect(() => parseRobotFile(noPair, "x.json")).toThrow("x.json: profile.drivetrain needs `pair`");
    const noLimit = structuredClone(base);
    delete noLimit.profile.drivetrain.max_drive_cm;
    expect(() => parseRobotFile(noLimit, "x.json")).toThrow("profile.drivetrain.max_drive_cm must be a number > 0");
    const badHeading = structuredClone(base);
    badHeading.profile.drivetrain.heading = { device: "gyro" };
    expect(() => parseRobotFile(badHeading, "x.json")).toThrow("profile.drivetrain.heading.channel must be");
    // heading.device: a role of the profile or a device id; a mistyped role is refused, with the roles there are
    const heading = (device: string) => {
      const f = structuredClone(base);
      f.profile.drivetrain.heading = { device, channel: "angle_deg" };
      return () => parseRobotFile(f, "x.json");
    };
    expect(heading("gyr0")).toThrow(
      'x.json: profile.drivetrain.heading.device must be a role of profile.roles (left_wheel, right_wheel, arm, touch, gyro, color, distance) or a device id like "ev3.S2", got "gyr0"',
    );
    expect(heading("ev3 S2")).toThrow("profile.drivetrain.heading.device must be a role");
    expect(heading("gyro")().profile.drivetrain!.heading!.device).toBe("gyro");
    expect(heading("ev3.S2")().profile.drivetrain!.heading!.device).toBe("ev3.S2");
    // hardware.ir_channel: the infrared remote's channel, 1-4, absent = 1
    const ir = (v: unknown) => {
      const f = structuredClone(base);
      f.hardware.ir_channel = v;
      return () => parseRobotFile(f, "x.json");
    };
    expect(ir(3)().hardware.ir_channel).toBe(3);
    expect(parseRobotFile(base, "x.json").hardware.ir_channel).toBeUndefined();
    for (const bad of [0, 5, 2.5, "2"]) expect(ir(bad)).toThrow("x.json: hardware.ir_channel must be 1, 2, 3 or 4");
  });

  test("as a twin (--twin arm.json): drivetrain null, no pair device, drive unsupported, each motor moves", async () => {
    const fleet = await buildFleet(loadConfig(["--twin", ARM]), { log: () => {} });
    try {
      expect(fleet.robots.map((r) => r.id)).toEqual(["arm-sim"]);
      const tool = toolsOf(fleet.robots, "arm-sim");
      // the file's twin plugs a medium motor into A and a large one into B, not the room's A, B and C
      await armWorks(tool, ["ev3.A", "ev3.B"]);
      // the twin's body stays where the world put it, whatever its motors do
      const pose = (await tool("read_device", { device: "sim.world", channels: ["pose"] })).data.readings[0].value;
      expect(pose).toEqual([60, 60, 0]);
    } finally {
      await fleet.shutdown();
    }
  }, 30_000);

  test("on stock firmware (the byte-level emulator behind the real EV3 provider): the same", async () => {
    const world = {
      ...(await Bun.file(EXAMPLE.world).json()),
      extensions: { ev3: { motors: { A: "medium", B: "large" }, sensors: { "1": "touch" } } },
    };
    const brick = new SimBrick({ world: new World(parseWorld(world), 1), drivetrain: null });
    const robot = new LocalRobot({ id: "arm" });
    await robot.attach(ev3Runtime({ source: "ev3", id: "arm", robot: await file(ARM) }, brick));
    try {
      await armWorks(toolsOf([robot], "arm"), ["ev3.A", "ev3.B"]);
    } finally {
      await robot.shutdown();
    }
  }, 30_000);
});

describe("the heading of the base example", () => {
  const turn = async (robot: RobotFile) => {
    const world = await Bun.file(EXAMPLE.world).json();
    const fleet = await buildFleet(
      { port: 0, robots: [{ source: "twin", id: "base-sim", robot, world, seed: 1 }] },
      { log: () => {} },
    );
    try {
      const tool = toolsOf(fleet.robots, "base-sim");
      const described = await tool("describe_robot");
      const turned = await tool("turn", { angle_deg: 45, speed_pct: 30 });
      expect(turned).toMatchObject({ ok: true, data: { reason: "completed" } });
      // it turned left; the precision of a turn is not this test's subject
      expect(turned.data.measured.heading_change_deg).toBeGreaterThan(20);
      expect(turned.data.measured.heading_change_deg).toBeLessThan(90);
      expect(described.data.heading_error).toBeNull();
      expect("heading_error" in turned.data.measured).toBe(false);
      return { drivetrain: described.data.drivetrain, source: turned.data.measured.source as string };
    } finally {
      await fleet.shutdown();
    }
  };

  test("r1.json names its gyro's angle: turn reports source gyro", async () => {
    const r1 = await file(EXAMPLE.robot);
    const { drivetrain, source } = await turn(r1);
    expect(drivetrain.heading).toEqual({ device: "gyro", channel: "angle_deg" });
    expect(drivetrain).toMatchObject({ max_drive_cm: 100, max_turn_deg: 360 });
    expect(source).toBe("gyro");
  }, 30_000);

  test("the same robot without `heading`: turn reports source encoders, though a gyro with the role gyro is plugged in", async () => {
    const r1 = await file(EXAMPLE.robot);
    const { heading: _heading, ...drivetrain } = r1.profile.drivetrain!;
    const out = await turn({ ...r1, profile: { ...r1.profile, drivetrain } });
    expect(out.drivetrain.heading).toBeUndefined();
    expect(r1.profile.roles.gyro).toBe("ev3.S2");
    expect(out.source).toBe("encoders");
  }, 30_000);
});
