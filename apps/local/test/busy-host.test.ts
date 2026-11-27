// A twin on a busy computer drives as one on an idle computer, and a robot on a slow link as one on a fast link:
// a stall is declared from what the robot did, never from how slow the link or the host was. A busy host makes
// even the twin's in-process link answer late, so its round trips look like a slow cable's; this test gives the
// twin a slow cable on a virtual clock, which is the same path, deterministic.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Ev3Provider } from "../../../packages/driver-ev3/provider";
import type { Transport } from "../../../packages/driver-ev3/transport";
import { FakeClock } from "../../../packages/runtime/clock";
import { createRuntime } from "../../../packages/runtime/runtime";
import {
  LARGE_DEG_S,
  MEDIUM_DEG_S,
  SIM_BRICK_LOOP_RATE_HZ,
  SimBrick,
  drivetrainFromProfile,
} from "../../../packages/sim-ev3/brick";
import { World, parseWorld } from "../../../packages/sim-world/world";
import { SimWorldProvider } from "../../../packages/sim-world/world-provider";
import { REPO, loadConfig, type RobotSource } from "../src/config";
import { LocalRobot } from "../src/robot";
import { callTool } from "../src/tools";

const ORUGAS = join(REPO, "deployments", "orugas", "robots", "orugas.json");
const SALA = join(REPO, "deployments", "orugas", "worlds", "sala.json");

/** A cable whose every packet takes `rttMs` there and back, on the virtual clock. */
class SlowCable implements Transport {
  constructor(
    private readonly brick: SimBrick,
    private readonly clock: FakeClock,
    private readonly rttMs: number,
  ) {}
  async send(bytes: Uint8Array): Promise<Uint8Array> {
    await this.clock.sleep(this.rttMs / 2);
    const reply = await this.brick.send(bytes);
    await this.clock.sleep(this.rttMs / 2);
    return reply;
  }
}

/** The orugas twin in sala as the app builds it (sources.ts twinRuntime), behind a cable of `rttMs`. */
async function orugas(rttMs: number) {
  const s = loadConfig(["--twin", ORUGAS, "--world", SALA]).robots[0] as Extract<RobotSource, { source: "twin" }>;
  const clock = new FakeClock();
  const time = { now: () => clock.now(), sleep: (ms: number) => clock.sleep(ms) };
  const profile = { ...s.robot.profile, id: s.id };
  const config = parseWorld(s.world);
  const brick = new SimBrick({
    world: new World(config, s.seed),
    drivetrain: drivetrainFromProfile(profile, s.robot.pair, s.build?.drive),
    now: time.now,
  });
  const runtime = createRuntime({
    profile,
    providers: [
      new SimWorldProvider({ host: brick, worlds: { [config.name]: s.world }, seed: s.seed, now: time.now }),
      (limits) =>
        new Ev3Provider(rttMs > 0 ? new SlowCable(brick, clock, rttMs) : brick, {
          limits,
          hardware: s.robot.hardware,
          pair: s.robot.pair,
          roles: profile.roles,
          degPerSecAt100: LARGE_DEG_S,
          mediumDegPerSecAt100: MEDIUM_DEG_S,
          loopRateHz: SIM_BRICK_LOOP_RATE_HZ,
          ...time,
        }),
    ],
    clock,
  });
  const robot = new LocalRobot({ id: s.id, clock });
  await robot.attach(runtime);
  return { robot, world: brick.world, id: s.id };
}

/** drive 50 cm @40, as a model sends it; its data (an error envelope throws). */
async function drive50(robot: LocalRobot, id: string) {
  const { envelope: e } = await callTool([robot], "drive", { robot_id: id, distance_cm: 50, speed_pct: 40 });
  if (!e.ok) throw new Error(JSON.stringify(e.error));
  return { data: e.data as { reason: string; measured: { distance_cm: number } } };
}

describe("a slow link or a busy computer", () => {
  test("a clear-floor drive 50 cm on the orugas twin covers 50 cm and completes, also when every operation brakes", async () => {
    for (const rtt of [0, 30, 50, 120]) {
      const { robot, world, id } = await orugas(rtt);
      const x0 = world.pose.x;
      const e = await drive50(robot, id);
      // before the fix, from 30 ms on: "stalled" after three operations at 7.8-10.5 cm, nothing in the way
      expect({ rtt, reason: e.data.reason }).toEqual({ rtt, reason: "completed" });
      expect(world.eventsSince(0).events.filter((x) => x.kind === "contact_began")).toEqual([]);
      expect(Math.abs(e.data.measured.distance_cm - 50)).toBeLessThan(1.5);
      expect(world.pose.x - x0).toBeGreaterThan(45); // sala's tracks slip a little; the encoders say 50
      await robot.shutdown();
    }
  }, 120_000);
  test("a drive into a wall on the same slow link still ends stalled, at the wall", async () => {
    const { robot, world, id } = await orugas(50);
    const { width, height, body } = world.cfg;
    world.setPose({ x: width - body.front_cm - 10, y: height / 2, th: 0 }); // 10 cm from the wall ahead, clear around
    const e = await drive50(robot, id);
    expect(e.data.reason).toBe("stalled");
    expect(world.eventsSince(0).events.some((x) => x.kind === "contact_began" && x.with === "wall_east")).toBe(true);
    expect(e.data.measured.distance_cm).toBeLessThan(15);
    await robot.shutdown();
  }, 60_000);
});
