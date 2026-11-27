// The point of the twin: the REAL Ev3Provider (and its Ev3Link) running unchanged on a SimBrick.
// Time is the real clock sped up 5x for both sides, so the provider's polling and stall windows run as on hardware.
// The provider executes ONE time-bounded operation per command (<= 250 ms); chaining them is the runtime's job,
// done here by a few lines (`pairMove`) so that long moves can be checked end to end.
import { test, expect, describe } from "bun:test";
import { Ev3Provider, EXAMPLE_EV3_HARDWARE } from "../driver-ev3/provider";
import * as E from "../driver-ev3/encode";
import type { CommandResult } from "../protocol/types";
import { World } from "../sim-world/world";
import { SimWorldProvider } from "../sim-world/world-provider";
import { quietWorld, EXAMPLES, config, DRIVE } from "../sim-world/testkit";
import { SimBrick, LARGE_DEG_S, type BrickDrivetrain } from "./brick";
import { DRIVETRAIN, lagged } from "./testkit";

// Kept low on purpose: the provider's polls ride on real timers, whose granularity (about 15 ms on Windows)
// times this factor is how late the provider can see a target.
const SPEEDUP = 2;
const now = (): number => performance.now() * SPEEDUP;
const DEG_PER_CM = 360 / (Math.PI * 5.6);
function twin(world: World = quietWorld(), drivetrain: BrickDrivetrain | null = DRIVETRAIN) {
  const brick = new SimBrick({ world, drivetrain, now });
  const ev3 = new Ev3Provider(brick, {
    limits: { max_speed_pct: 60, max_command_ms: 15000 },
    hardware: EXAMPLE_EV3_HARDWARE,
    // the robot file's pair: the same ports the brick's drivetrain rolls on, and none for a robot without one
    ...(drivetrain ? { pair: { left: drivetrain.left, right: drivetrain.right } } : {}),
    degPerSecAt100: LARGE_DEG_S,
    pollMs: 2,
    now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms / SPEEDUP)),
  });
  return { world, brick, ev3 };
}
const idle = () => new AbortController().signal;
const value = async (ev3: Ev3Provider, device: string, channel: string, allow_mode_switch = false) => {
  const r = (await ev3.read(device, [channel], { allow_mode_switch }))[0]!;
  if (r.error) throw new Error(`${device}.${channel}: ${r.error}`);
  return r.value;
};
const TOLERANCE_DEG = 25;
/** Chains single operations toward a wheel-degree target, as the runtime does: coast between them, brake on the last one. */
async function pairMove(
  ev3: Ev3Provider,
  left: number,
  right: number,
  speed_pct: number,
): Promise<{ reason: string; left_deg: number; right_deg: number; ops: CommandResult[] }> {
  let l = 0,
    r = 0;
  const ops: CommandResult[] = [];
  for (let i = 0; i < 80; i++) {
    const remL = left - l,
      remR = right - r;
    // Close enough: the provider brakes when a poll sees the target, so a move ends a few degrees past it.
    if (Math.max(Math.abs(remL), Math.abs(remR)) <= TOLERANCE_DEG) {
      await ev3.command("ev3.pair", "brake", {}, idle()); // the operations coasted: end the move with a verified brake
      return { reason: "completed", left_deg: l, right_deg: r, ops };
    }
    // Coast while more operations follow; brake on the one that can reach the target.
    const last = Math.max(Math.abs(remL), Math.abs(remR)) <= (speed_pct / 100) * LARGE_DEG_S * 0.25 * 0.9;
    const op = await ev3.command(
      "ev3.pair",
      "run_pair",
      { left_deg: remL, right_deg: remR, speed_pct, brake: last },
      idle(),
    );
    ops.push(op);
    l += op.measured.left_deg as number;
    r += op.measured.right_deg as number;
    if (op.reason !== "completed" && op.reason !== "timeout") {
      await ev3.command("ev3.pair", "brake", {}, idle());
      return { reason: op.reason, left_deg: l, right_deg: r, ops };
    }
  }
  throw new Error("pairMove: did not converge");
}
function expectClean(brick: SimBrick): void {
  expect(brick.errors).toEqual([]); // the brick never had to answer 0x04
  expect(brick.overlaps).toBe(0); // never two commands in flight
  expect(brick.unboundedMoves).toBe(0); // every motion bounded on the brick
  for (const entry of brick.log) {
    expect(entry.type).toBe(E.TYPE_DIRECT_REPLY);
    // Safety rule of the contract: motion is limited by TIME on the brick, never by degrees.
    for (const op of [E.OP.OUTPUT_STEP_SPEED, E.OP.OUTPUT_STEP_SYNC, E.OP.OUTPUT_STEP_POWER, E.OP.OUTPUT_START])
      expect(entry.opcodes).not.toContain(op);
  }
}

describe("Ev3Provider on SimBrick", () => {
  test("devices() detects exactly what the world file plugs in", async () => {
    const { ev3, brick } = twin();
    const devs = await ev3.devices();
    const kinds = Object.fromEntries(devs.map((d) => [d.id, d.kind]));
    expect(kinds).toMatchObject({
      "ev3.A": "motor",
      "ev3.B": "motor",
      "ev3.C": "motor",
      "ev3.pair": "motor_pair",
      "ev3.S1": "touch",
      "ev3.S2": "gyro",
      "ev3.S3": "color",
      "ev3.S4": "ultrasonic",
    });
    expect(kinds["ev3.D"]).toBeUndefined();
    const other = twin(quietWorld(EXAMPLES.wallsMaze));
    expect(Object.fromEntries((await other.ev3.devices()).map((d) => [d.id, d.kind]))["ev3.S4"]).toBe("infrared");
    expectClean(brick);
    expectClean(other.brick);
  });

  test("one run_pair is one time-bounded operation on the brick: about 250 ms of travel, reported as time-limited", async () => {
    const { ev3, brick, world } = twin();
    await ev3.devices();
    const op = await ev3.command("ev3.pair", "run_pair", { left_deg: 2000, right_deg: 2000, speed_pct: 50 }, idle());
    expect(op.reason).toBe("timeout");
    expect(op.measured.time_limited).toBe(true);
    const deg = op.measured.left_deg as number;
    expect(Math.abs(deg - lagged(0.5 * LARGE_DEG_S, 250))).toBeLessThan(8); // a start from rest lags
    expect(world.pose.x - 43).toBeCloseTo(deg / DEG_PER_CM, 1);
    expect(brick.busy()).toBe(false);
    expectClean(brick);
  });

  test("chained operations drive the simulated robot the commanded distance", async () => {
    const { ev3, brick, world } = twin(new World(config(), 4, DRIVE)); // default noise
    await ev3.devices();
    const deg = Math.round(30 * DEG_PER_CM);
    const r = await pairMove(ev3, deg, deg, 50);
    expect(r.reason).toBe("completed");
    expect(r.ops.length).toBeGreaterThan(2);
    expect(Math.abs(r.left_deg - deg)).toBeLessThanOrEqual(TOLERANCE_DEG + 15); // coasting between operations; the encoder tells the truth
    const moved = Math.hypot(world.pose.x - 43, world.pose.y - 25);
    expect(Math.abs(moved - r.left_deg / DEG_PER_CM)).toBeLessThan(30 * 0.05);
    expect(moved).toBeGreaterThan(30 * 0.93);
    expect(moved).toBeLessThan(30 * 1.07);
    expect(await value(ev3, "ev3.B", "position_deg")).toBe(brick.tacho("B"));
    expectClean(brick);
  });

  test("a spin turns the robot; the gyro channel comes out counter-clockwise-positive, as the contract says", async () => {
    const { ev3, brick, world } = twin();
    await ev3.devices();
    const wheel = Math.round((Math.PI / 2) * 6 * DEG_PER_CM);
    const r = await pairMove(ev3, -wheel, wheel, 30);
    expect(r.reason).toBe("completed");
    const heading = (world.pose.th * 180) / Math.PI;
    expect(heading).toBeGreaterThan(76); // left turn, counter-clockwise in the world
    expect(heading).toBeLessThan(104);
    // The brick answers clockwise-positive like the real sensor (see brick.test.ts); the provider normalizes it.
    expect(await value(ev3, "ev3.S2", "angle_deg")).toBe(Math.round(heading));
    const reset = await ev3.command("ev3.S2", "reset", {}, idle());
    expect(reset.reason).toBe("completed");
    expect(await value(ev3, "ev3.S2", "angle_deg")).toBe(0);
    expectClean(brick);
  });

  test("an arc: the wheels turn in the commanded ratio", async () => {
    const { ev3, brick, world } = twin();
    await ev3.devices();
    const r = await pairMove(ev3, 400, 200, 40);
    expect(r.reason).toBe("completed");
    expect(Math.abs(r.left_deg - 400)).toBeLessThanOrEqual(TOLERANCE_DEG + 15);
    expect(Math.abs(r.right_deg / r.left_deg - 0.5)).toBeLessThan(0.03);
    expect(world.pose.th).toBeLessThan(-0.5); // left wheel faster: curves right
    expectClean(brick);
  });

  test("reads have no side effects: a channel in another sensor mode needs an explicit mode switch", async () => {
    const { ev3, brick, world } = twin();
    await ev3.devices();
    world.setPose({ x: 30, y: 45, th: 0 });
    expect(await value(ev3, "ev3.S4", "distance_cm")).toBe(17);
    expect(await value(ev3, "ev3.S3", "reflected_pct")).toBe(85);
    expect(await value(ev3, "ev3.S1", "pressed")).toBe(false);
    const refused = (await ev3.read("ev3.S3", ["color"]))[0]!;
    expect([refused.value, refused.error]).toEqual([null, "mode_switch_required"]);
    expect(await value(ev3, "ev3.S3", "color", true)).toBe(6);
    world.setPose({ x: 15, y: 60, th: Math.PI / 2 });
    expect(await value(ev3, "ev3.S3", "color")).toBe(5); // the sensor is in colour mode now: a plain read
    expect(await value(ev3, "ev3.battery", "voltage_v")).toBeCloseTo(7.9, 1);
    expectClean(brick);
  });

  test("reading the gyro's rate needs a switch, and the switch zeroes the angle exactly like the real sensor", async () => {
    const { ev3, brick } = twin();
    await ev3.devices();
    const wheel = Math.round((Math.PI / 4) * 6 * DEG_PER_CM);
    await pairMove(ev3, -wheel, wheel, 30);
    const angle = (await value(ev3, "ev3.S2", "angle_deg")) as number;
    expect(angle).toBeGreaterThan(30);
    expect(await value(ev3, "ev3.S2", "angle_deg")).toBe(angle); // plain reads change nothing
    expect((await ev3.read("ev3.S2", ["rate_deg_s"]))[0]!.error).toBe("mode_switch_required");
    expect(await value(ev3, "ev3.S2", "angle_deg")).toBe(angle); // the refused read changed nothing either
    expect(await value(ev3, "ev3.S2", "rate_deg_s", true)).toBe(0); // explicit switch to rate mode
    expect(await value(ev3, "ev3.S2", "angle_deg", true)).toBe(0); // and back: the angle restarted from zero
    expectClean(brick);
  });

  test("driving into a wall: the blocked operation ends at its time bound and is reported as stalled", async () => {
    const { ev3, brick, world } = twin();
    await ev3.devices();
    world.setPose({ x: 100, y: 20, th: 0 }); // 12 cm of room
    const deg = Math.round(40 * DEG_PER_CM);
    const r = await pairMove(ev3, deg, deg, 50);
    expect(r.reason).toBe("stalled");
    expect(r.left_deg).toBeLessThan(13 * DEG_PER_CM);
    expect(r.left_deg).toBeGreaterThan(10 * DEG_PER_CM);
    expect(world.pose.x).toBeLessThanOrEqual(112);
    expect(brick.busy()).toBe(false);
    expect(await value(ev3, "ev3.S1", "pressed")).toBe(true);
    expect(await value(ev3, "ev3.B", "stalled")).toBe(true);
    expectClean(brick);
  }, 15000);

  test("stop() preempts a running operation: it resolves preempted, verified, and the robot stays put", async () => {
    const { ev3, brick, world } = twin();
    await ev3.devices();
    const move = ev3.command("ev3.pair", "run_pair", { left_deg: 3000, right_deg: 3000, speed_pct: 30 }, idle());
    await new Promise((r) => setTimeout(r, 100)); // a start from rest turns little in its first tens of ms
    expect(await ev3.stop()).toEqual({ motors_stopped: true });
    const r = await move;
    expect(r.reason).toBe("preempted");
    expect(r.measured.left_deg as number).toBeGreaterThan(5);
    expect(r.measured.left_deg as number).toBeLessThan(0.3 * LARGE_DEG_S * 0.25);
    const x = world.pose.x;
    await new Promise((r2) => setTimeout(r2, 60));
    brick.tick();
    expect(world.pose.x).toBe(x);
    expectClean(brick);
  });

  test("a coasting operation leaves the motors turning; the pair's brake ends it and verifies speed 0", async () => {
    const { ev3, brick } = twin();
    await ev3.devices();
    await ev3.command("ev3.pair", "run_pair", { left_deg: 3000, right_deg: 3000, speed_pct: 60, brake: false }, idle());
    const speed = (await value(ev3, "ev3.B", "speed_deg_s")) as number;
    expect(speed).toBeGreaterThan(0); // running down
    await ev3.command("ev3.pair", "brake", {}, idle());
    expect(await value(ev3, "ev3.B", "speed_deg_s")).toBe(0);
    expectClean(brick);
  });

  test("a profile without a drivetrain: the same commands turn the motors and the robot does not move", async () => {
    const { ev3, brick, world } = twin(quietWorld(), null);
    const devices = await ev3.devices();
    // no pair declared: the motors on B and C are two motors, and there is no pair device to command
    expect(devices.filter((d) => d.kind === "motor").map((d) => d.id)).toEqual(["ev3.A", "ev3.B", "ev3.C"]);
    expect(devices.some((d) => d.kind === "motor_pair")).toBe(false);
    await expect(ev3.read("ev3.pair", ["left_deg"])).rejects.toMatchObject({ code: "unknown_device" });
    await expect(
      ev3.command("ev3.pair", "run_pair", { left_deg: 90, right_deg: 90, speed_pct: 30 }, idle()),
    ).rejects.toMatchObject({ code: "unknown_device" });
    const op = await ev3.command("ev3.B", "run_time", { ms: 200, speed_pct: 50 }, idle());
    expect(op.reason).toBe("completed");
    expect(op.measured.degrees as number).toBeGreaterThan(50);
    expect(world.pose).toEqual({ x: 43, y: 25, th: 0 });
    expectClean(brick);
  });

  test("the free motor, speaker, display and LED go through the same packets", async () => {
    const { ev3, brick, world } = twin();
    const devs = await ev3.devices();
    const pose = { ...world.pose };
    const r = await ev3.command("ev3.A", "run_degrees", { degrees: -90, speed_pct: 40 }, idle());
    expect(r.reason).toBe("completed");
    expect(Math.abs(brick.tacho("A") + 90)).toBeLessThanOrEqual(40); // braked by the provider when a poll sees the target
    expect(world.pose).toEqual(pose);
    await ev3.command("ev3.speaker", "tone", { frequency_hz: 440, duration_ms: 100 }, idle());
    expect(brick.tones.at(-1)).toMatchObject({ hz: 440, ms: 100 });
    await ev3.command("ev3.display", "text", { lines: ["hello", "twin"] }, idle());
    expect(brick.lcd).toEqual(["hello", "twin"]);
    const led = devs.find((d) => d.id === "ev3.led")!;
    expect(led.commands.map((c) => c.name)).toContain("set");
    await ev3.command("ev3.led", "set", { pattern: "red" }, idle());
    expect(brick.led).toBe(2);
    brick.pressButton(2);
    expect(await value(ev3, "ev3.buttons", "pressed")).toEqual(["enter"]);
    expectClean(brick);
  });

  test("both providers of the twin side by side: ev3.* moves, sim.world tells the truth about it", async () => {
    const { ev3, brick } = twin();
    const sim = new SimWorldProvider({ host: brick, worlds: { "walls-maze": EXAMPLES.wallsMaze } });
    await ev3.devices();
    const deg = Math.round(20 * DEG_PER_CM);
    const r = await pairMove(ev3, deg, deg, 50);
    const [x, y] = (await sim.read("sim.world", ["pose"]))[0]!.value as number[];
    expect(r.reason).toBe("completed");
    const travelled = brick.tacho("B") / DEG_PER_CM; // the tacho includes the coasting between operations
    expect(x).toBeCloseTo(43 + travelled, 1);
    expect(y).toBe(25);
    // The odometer counts every centimetre rolled, including a small overshoot and the correction back.
    const odo = (await sim.read("sim.world", ["odometer_cm"]))[0]!.value as number;
    expect(odo).toBeGreaterThanOrEqual(travelled - 0.1);
    expect(odo).toBeLessThan(travelled + 4);
    // The runtime's job, done by hand here: on sim's onDevicesChanged, re-read devices() of every provider.
    // Ev3Provider.devices() re-detects the ports (99 05), so the new port map shows up with no special case.
    let kinds: Record<string, string> = {};
    const refreshed: Promise<void>[] = [];
    sim.onDevicesChanged(() => {
      refreshed.push(
        ev3.devices().then((devs) => {
          kinds = Object.fromEntries(devs.map((d) => [d.id, d.kind]));
        }),
      );
    });
    await sim.command("sim.world", "load_world", { world: "walls-maze" }, idle());
    expect(refreshed.length).toBe(1);
    await refreshed[0];
    expect(kinds["ev3.S4"]).toBe("infrared");
    expect(await value(ev3, "ev3.S4", "proximity_pct")).toBe(100);
    expectClean(brick);
  });
});
