import { test, expect, describe } from "bun:test";
import * as E from "../driver-ev3/encode";
import {
  SimBrick,
  VirtualClock,
  TYPE_LARGE_MOTOR,
  TYPE_MEDIUM_MOTOR,
  LARGE_DEG_S,
  COAST_MS_AT_100,
  drivetrainFromProfile,
} from "./brick";
import { World, parseWorld } from "../sim-world/world";
import { EXAMPLES, config, quietWorld } from "../sim-world/testkit";
import { rig, DRIVETRAIN } from "./testkit";
import { DRIVE } from "../sim-world/testkit";

const BC = E.OUTPUT_MASK.B | E.OUTPUT_MASK.C;
const DEG_PER_CM = 360 / (Math.PI * 5.6);
const never = (p: Promise<unknown>, ms = 30): Promise<boolean> =>
  Promise.race([p.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), ms))]);

describe("LEGO Communication Developer Kit example packets", () => {
  // The PDF prints the counter as "xxxx"; real counters are used here.
  test("play a 1 kHz tone for 1 s (type 0x80: executed, nothing comes back)", async () => {
    const { brick } = rig();
    const reply = await brick.send(E.fromHex(["0F00", "0700", "8000009401810282E80382E803"].join("")));
    expect(reply.length).toBe(0);
    expect(brick.tones).toEqual([{ hz: 1000, ms: 1000, volume: 2 }]);
  });
  test("READY_SI on sensor port 3: reply is [len 7][counter][0x02][float32 LE]", async () => {
    const { brick, world } = rig();
    const reply = await brick.send(E.fromHex(["0D00", "2A00", "000400991D000200000160"].join("")));
    expect(E.toHex(reply.subarray(0, 5)).replace(/\s/g, "").toUpperCase()).toBe("07002A0002");
    expect(reply.length).toBe(9);
    expect(new DataView(reply.buffer, reply.byteOffset).getFloat32(5, true)).toBe(world.senseReflect()); // port 3 = color, mode 0 = reflected %
  });
  test("start motors B+C at speed 50 for 0 + 900 + 180 degrees with brake", async () => {
    const { brick, world, run } = rig();
    await brick.send(E.fromHex(["1200", "0100", "800000AE000681320082840382B40001"].join("")));
    expect(brick.busy(BC)).toBe(true);
    run(5000);
    expect(brick.busy()).toBe(false);
    expect(brick.tacho("B")).toBe(1080);
    expect(brick.tacho("C")).toBe(1080);
    expect(brick.tacho("A")).toBe(0);
    expect(world.pose.x - 43).toBeCloseTo(1080 / DEG_PER_CM, 4);
  });
});

describe("framing and errors", () => {
  test("ping (no opcodes) answers ok with the counter and the reserved globals zeroed", async () => {
    const { brick } = rig();
    const raw = await brick.send(E.frame([], { counter: 513, globals: 3 }));
    expect([...raw]).toEqual([6, 0, 1, 2, E.REPLY_OK, 0, 0, 0]);
  });
  test("an opcode that is not emulated answers 0x04, never a fake success", async () => {
    const { brick, call } = rig();
    const r = await call([0xaa, 0, 0x0f]); // OUTPUT_READY
    expect(r.ok).toBe(false);
    expect(r.status).toBe(E.REPLY_ERROR);
    expect(r.globals.length).toBe(0);
    expect(brick.errors[0]).toMatch(/opcode 0xaa is not emulated/);
    expect((await call([E.OP.SOUND, 0x02])).ok).toBe(false); // SOUND PLAY
    expect((await call([E.OP.INPUT_DEVICE, 0x15, 0, 0])).ok).toBe(false); // GET_NAME
    expect((await call([E.OP.UI_READ, 0x03, ...E.gv(0)], 4)).ok).toBe(false); // GET_IBATT
  });
  test("bad parameters answer 0x04: global outside the reserved bytes, layer 1, speed 120, 3-motor sync", async () => {
    const { call, brick } = rig();
    expect((await call(E.outputGetCount(1, 0), 2)).ok).toBe(false);
    expect((await call([E.OP.OUTPUT_STOP, 1, 0x0f, 1])).ok).toBe(false);
    expect((await call([E.OP.OUTPUT_STEP_SPEED, 0, 2, ...E.lc(120), 0, ...E.lc(90), 0, 1])).ok).toBe(false);
    expect((await call([E.OP.OUTPUT_STEP_SYNC, 0, 7, ...E.lc(30), ...E.lc(0), ...E.lc(90), 1])).ok).toBe(false);
    expect(brick.busy()).toBe(false);
    expect(brick.errors.length).toBe(4);
  });
  test("system commands are refused with a system error reply", async () => {
    const { brick } = rig();
    const raw = await brick.send(new Uint8Array([4, 0, 9, 0, E.TYPE_SYSTEM_REPLY, 0x99, 0]));
    expect([...raw]).toEqual([5, 0, 9, 0, 0x05, 0x99, 0x0a]);
  });
  test("a command arriving while the previous one is in flight is ignored: no reply, no effect", async () => {
    const { brick } = rig();
    const first = brick.send(E.frame(E.uiLed(1), { counter: 1 }));
    const second = brick.send(E.frame(E.outputStepSync(BC, 50, 0, 360), { counter: 2 }));
    expect(E.decodeReply(await first).ok).toBe(true);
    expect(await never(second)).toBe(true);
    expect(brick.overlaps).toBe(1);
    expect(brick.busy()).toBe(false);
    expect(brick.led).toBe(1);
    // After the reply left, the brick listens again.
    expect(E.decodeReply(await brick.send(E.frame(E.uiLed(2), { counter: 3 }))).ok).toBe(true);
    expect(brick.led).toBe(2);
  });
  test("with a reply delay the in-flight window is real time", async () => {
    const { brick } = rig();
    brick.replyDelayMs = 300;
    const first = brick.send(E.frame(E.uiLed(3), { counter: 1 }));
    await new Promise((r) => setTimeout(r, 5));
    expect(await never(brick.send(E.frame(E.uiLed(4), { counter: 2 })), 20)).toBe(true);
    await first;
    expect(brick.led).toBe(3);
  });
});

describe("motors drive the world", () => {
  test("B0 step sync straight: the robot moves the expected cm (±5 %) with default noise", async () => {
    const world = new World(config(), 11, DRIVE);
    const { call, run, brick } = rig(world);
    const cm = 40,
      deg = Math.round(cm * DEG_PER_CM);
    expect((await call(E.outputStepSync(BC, 40, 0, deg, true))).ok).toBe(true);
    run(10_000);
    const moved = Math.hypot(world.pose.x - 43, world.pose.y - 25);
    expect(moved).toBeGreaterThan(cm * 0.95);
    expect(moved).toBeLessThan(cm * 1.05);
    expect(brick.tacho("B")).toBe(deg);
    expect(brick.tacho("C")).toBe(deg);
  });
  test("B0 backwards with a negative speed", async () => {
    const { call, run, world } = rig();
    await call(E.outputStepSync(BC, -30, 0, Math.round(10 * DEG_PER_CM), true));
    run(5000);
    expect(world.pose.x).toBeCloseTo(33, 1);
  });
  test("the move takes real (clock) time: half way after half the time, and busy until done", async () => {
    const { call, run, brick } = rig();
    const rate = LARGE_DEG_S; // deg/s at 100 %
    await call(E.outputStepSync(BC, 50, 0, 720, true));
    const total = (720 / (rate * 0.5)) * 1000;
    run(total / 2);
    expect(brick.tacho("B")).toBeGreaterThan(350);
    expect(brick.tacho("B")).toBeLessThan(370);
    expect((await call(E.outputTest(BC, 0), 1)).globals[0]).toBe(1);
    run(total / 2 + 30);
    expect((await call(E.outputTest(BC, 0), 1)).globals[0]).toBe(0);
    expect(brick.tacho("B")).toBe(720);
  });
  test("B0 with turn 200 spins in place; the gyro (99 1D) counts clockwise as positive like the real sensor", async () => {
    const { call, run, world } = rig();
    const wheelDeg = Math.round((Math.PI / 2) * 6 * DEG_PER_CM);
    await call(E.outputStepSync(BC, -30, 200, wheelDeg, true)); // lower port (B = left) backwards, C forwards: left turn
    run(5000);
    const heading = (world.pose.th * 180) / Math.PI;
    expect(heading).toBeGreaterThan(90 * 0.95);
    expect(heading).toBeLessThan(90 * 1.05);
    expect(Math.hypot(world.pose.x - 43, world.pose.y - 25)).toBeLessThan(0.01);
    const gyro = E.readF32((await call(E.inputReadySi(1, E.SENSOR_TYPE.gyro, 0, 1, 0), 4)).globals, 0);
    expect(gyro).toBe(-Math.round(heading));
  });
  test("B0 with turn 50: the higher port does half the speed and half the degrees (an arc)", async () => {
    const { call, run, brick, world } = rig();
    await call(E.outputStepSync(BC, 40, 50, 400, true));
    run(8000);
    expect(brick.tacho("B")).toBe(400);
    expect(brick.tacho("C")).toBe(200);
    expect(world.pose.th).toBeLessThan(-0.5); // right wheel slower: curves right
  });
  test("A8 reads speed and tacho, B3 the tacho, B2 clears it", async () => {
    const { call, run } = rig();
    await call(E.outputStepSync(BC, 40, 0, 3000, true));
    run(500);
    let g = (await call(E.outputRead(1, 0, 1), 5)).globals;
    expect(E.readI8(g, 0)).toBe(40);
    expect(E.readI32(g, 1)).toBeGreaterThan(190);
    await call(E.outputStop(BC, true));
    const count = E.readI32((await call(E.outputGetCount(2, 0), 4)).globals, 0);
    expect(count).toBe(E.readI32(g, 1));
    await call(E.outputClearCount(E.OUTPUT_MASK.C));
    expect(E.readI32((await call(E.outputGetCount(2, 0), 4)).globals, 0)).toBe(0);
    g = (await call(E.outputRead(1, 0, 1), 5)).globals;
    expect(E.readI8(g, 0)).toBe(0);
    expect(E.readI32(g, 1)).toBe(count);
  });
  test("A3 stops a running move at once", async () => {
    const { call, run, brick, world } = rig();
    await call(E.outputStepSync(BC, 50, 0, 2000, true));
    run(400);
    await call(E.outputStop(E.ALL_OUTPUTS, true));
    const x = world.pose.x;
    run(2000);
    expect(world.pose.x).toBe(x);
    expect(brick.busy()).toBe(false);
  });
  test("AF runs for a time and then stops; AE on port A turns the medium motor without moving the robot", async () => {
    const { call, run, brick, world } = rig();
    await call(E.outputTimeSpeed(E.OUTPUT_MASK.B | E.OUTPUT_MASK.C, 20, 0, 250, 0, true));
    run(240);
    expect(brick.busy(BC)).toBe(true);
    run(20);
    expect(brick.busy(BC)).toBe(false);
    expect(brick.tacho("B")).toBeCloseTo(0.2 * 1020 * 0.25, -1);
    const pose = { ...world.pose };
    await call(E.outputStepSpeed(E.OUTPUT_MASK.A, -30, 0, 45, 0, true));
    run(1000);
    expect(brick.tacho("A")).toBe(-45);
    expect(world.pose).toEqual(pose);
  });
  test("A5 + A6 start an unbounded run that only A3 ends; the brick counts it", async () => {
    const { call, run, brick } = rig();
    await call([...E.outputSpeed(E.OUTPUT_MASK.A, 50), ...E.outputStart(E.OUTPUT_MASK.A)]);
    run(3000);
    expect(brick.busy(E.OUTPUT_MASK.A)).toBe(true);
    expect(brick.unboundedMoves).toBe(1);
    expect(brick.tacho("A")).toBeCloseTo(0.5 * 1560 * 3, -1);
    await call(E.outputStop(E.OUTPUT_MASK.A, false));
    expect(brick.busy()).toBe(false);
  });
  test("against a wall the wheels block: tacho frozen, speed reads 0, the motors stay busy", async () => {
    const { call, run, brick, world } = rig();
    await call(E.outputStepSync(BC, 50, 0, Math.round(150 * DEG_PER_CM), true));
    run(6000);
    expect(world.pose.x).toBeGreaterThan(110);
    expect(world.pose.x).toBeLessThanOrEqual(112);
    const tacho = brick.tacho("B");
    run(2000);
    expect(brick.tacho("B")).toBe(tacho);
    expect(tacho).toBeLessThan(150 * DEG_PER_CM - 100);
    const g = (await call([...E.outputRead(1, 0, 1), ...E.outputTest(BC, 5)], 6)).globals;
    expect(E.readI8(g, 0)).toBe(0);
    expect(g[5]).toBe(1);
    // Touch: pressed (mode 0) and one bump counted (mode 1).
    expect(E.readF32((await call(E.inputReadySi(0, E.SENSOR_TYPE.touch, 0, 1, 0), 4)).globals, 0)).toBe(1);
    expect(E.readF32((await call(E.inputReadySi(0, E.SENSOR_TYPE.touch, 1, 1, 0), 4)).globals, 0)).toBe(1);
  });
  test("nothing moves while the clock stands still", async () => {
    const { call, brick, world } = rig();
    await call(E.outputStepSync(BC, 50, 0, 360, true));
    brick.tick();
    expect(world.pose.x).toBe(43);
  });
});

describe("sensors on ports come from the world", () => {
  test("99 05 reports what is plugged where (sensors 0..3, motors 16..19)", async () => {
    const { call } = rig();
    const bc = [0, 1, 2, 3, 16, 17, 18, 19].flatMap((p, i) => E.inputGetTypeMode(p, i * 2, i * 2 + 1));
    const g = (await call(bc, 16)).globals;
    expect([g[0], g[2], g[4], g[6]]).toEqual([
      E.SENSOR_TYPE.touch,
      E.SENSOR_TYPE.gyro,
      E.SENSOR_TYPE.color,
      E.SENSOR_TYPE.ultrasonic,
    ]);
    expect([g[8], g[10], g[12], g[14]]).toEqual([TYPE_MEDIUM_MOTOR, TYPE_LARGE_MOTOR, TYPE_LARGE_MOTOR, E.TYPE_NONE]);
  });
  test("99 1D on all four ports in one packet matches the world's sensor model", async () => {
    const { call, world } = rig();
    world.setPose({ x: 30, y: 45, th: 0 });
    const types = [E.SENSOR_TYPE.touch, E.SENSOR_TYPE.gyro, E.SENSOR_TYPE.color, E.SENSOR_TYPE.ultrasonic];
    const g = (
      await call(
        types.flatMap((t, i) => E.inputReadySi(i, t, 0, 1, i * 4)),
        16,
      )
    ).globals;
    expect(E.readF32(g, 0)).toBe(0);
    expect(E.readF32(g, 4)).toBe(0);
    expect(E.readF32(g, 8)).toBe(world.senseReflect());
    expect(E.readF32(g, 12)).toBeCloseTo(17, 4); // 55 (obstacle) - 38 (sensor)
  });
  test("color modes: reflected (0), colour id (2), and the id follows the floor", async () => {
    const { call, world } = rig();
    const read = async (mode: number) =>
      E.readF32((await call(E.inputReadySi(2, E.SENSOR_TYPE.color, mode, 1, 0), 4)).globals, 0);
    expect(await read(2)).toBe(1); // black line under the sensor at the start
    expect(await read(0)).toBe(6);
    world.setPose({ x: 15, y: 60, th: Math.PI / 2 }); // zone A, red
    expect(await read(2)).toBe(5);
    expect(await read(0)).toBe(62);
    world.setPose({ x: 60, y: 15, th: 0 });
    expect(await read(2)).toBe(6); // white
  });
  test("the mode sticks (99 05 shows it), -1 keeps it, an unknown mode and a wrong type answer 0x04", async () => {
    const { call } = rig();
    await call(E.inputReadySi(2, E.SENSOR_TYPE.color, 2, 1, 0), 4);
    expect((await call(E.inputGetTypeMode(2, 0, 1), 2)).globals[1]).toBe(2);
    expect(E.readF32((await call(E.inputReadySi(2, 0, -1, 1, 0), 4)).globals, 0)).toBe(1);
    expect((await call(E.inputReadySi(2, E.SENSOR_TYPE.color, 5, 1, 0), 4)).ok).toBe(false);
    expect((await call(E.inputReadySi(2, E.SENSOR_TYPE.gyro, 0, 1, 0), 4)).ok).toBe(false);
  });
  test("99 1C gives the raw integer; an empty port gives NaN (SI) and 0 (raw)", async () => {
    const world = quietWorld(EXAMPLES.lineOval, {
      extensions: { ev3: { motors: { B: "large", C: "large" }, sensors: { "4": "ultrasonic" } } },
    });
    const { call } = rig(world);
    expect(E.readI32((await call(E.inputReadyRaw(3, 0, 0, 1, 0), 4)).globals, 0)).toBe(69);
    expect(E.readF32((await call(E.inputReadySi(0, 0, 0, 1, 0), 4)).globals, 0)).toBeNaN();
    expect(E.readI32((await call(E.inputReadyRaw(0, 0, 0, 1, 0), 4)).globals, 0)).toBe(0);
    expect((await call(E.inputGetTypeMode(0, 0, 1), 2)).globals[0]).toBe(E.TYPE_NONE);
    expect((await call(E.inputGetTypeMode(16, 0, 1), 2)).globals[0]).toBe(E.TYPE_NONE); // nothing on motor port A
  });
  test("IR on port 4 in the other example world reads proximity %", async () => {
    const world = quietWorld(EXAMPLES.wallsMaze);
    const { call } = rig(world);
    const v = E.readF32((await call(E.inputReadySi(3, E.SENSOR_TYPE.ir, 0, 1, 0), 4)).globals, 0);
    expect(v).toBe(world.senseIrProximity());
    expect(v).toBe(100); // 77 cm of free space ahead: beyond the 70 cm full scale
  });
  test("99 0A clears sensor state: the gyro angle goes back to 0", async () => {
    const { call, run } = rig();
    await call(E.outputStepSync(BC, 30, 200, 100, true));
    run(3000);
    const read = async () => E.readF32((await call(E.inputReadySi(1, 0, 0, 1, 0), 4)).globals, 0);
    expect(await read()).toBeGreaterThan(20); // right turn: clockwise is positive
    expect((await call([E.OP.INPUT_DEVICE, 0x0a, 0])).ok).toBe(true);
    expect(await read()).toBe(0);
    expect((await call(E.inputStopAll())).ok).toBe(true);
  });
  test("gyro rate (mode 1) is non-zero only while turning", async () => {
    const { call, run } = rig();
    const rate = async () => E.readF32((await call(E.inputReadySi(1, 0, 1, 1, 0), 4)).globals, 0);
    expect(await rate()).toBe(0);
    await call(E.outputStepSync(BC, 30, 200, 300, true));
    run(200);
    expect(await rate()).toBeGreaterThan(100);
    run(5000);
    expect(await rate()).toBe(0);
  });
});

describe("brick UI", () => {
  test("battery (81 01 float volts, 81 12 percent), LED, buttons, text, tone", async () => {
    const { call, brick } = rig();
    const g = (await call([...E.uiBatteryVolts(0), ...E.uiBatteryPct(4)], 5)).globals;
    expect(E.readF32(g, 0)).toBeCloseTo(7.9, 5);
    expect(g[4]).toBe(85);
    await call(E.uiLed(5));
    expect(brick.led).toBe(5);
    expect((await call(E.uiButtonPressed(2, 0), 1)).globals[0]).toBe(0);
    brick.pressButton(2);
    expect((await call(E.uiButtonPressed(2, 0), 1)).globals[0]).toBe(1);
    await call([
      ...E.drawFillWindow(0, 0, 0),
      ...E.drawSelectFont(1),
      ...E.drawText(1, 0, 10, "hello"),
      ...E.drawText(1, 0, 30, "world"),
      ...E.drawUpdate(),
    ]);
    expect(brick.lcd).toEqual(["hello", "world"]);
    await call(E.soundTone(10, 440, 200));
    expect(brick.tones).toEqual([{ hz: 440, ms: 200, volume: 10 }]);
  });
});

describe("real time by default", () => {
  test("without a virtual clock the motors follow performance.now()", async () => {
    const world = quietWorld();
    const brick = new SimBrick({ world, drivetrain: DRIVETRAIN });
    const t0 = performance.now();
    await brick.send(E.frame(E.outputStepSync(BC, 50, 0, 3600, true), { counter: 1 }));
    await new Promise((r) => setTimeout(r, 60));
    const deg = brick.tacho("B"),
      elapsed = performance.now() - t0; // 510 deg/s at 50 %
    expect(deg).toBeGreaterThan(15);
    expect(deg).toBeLessThanOrEqual(Math.ceil(0.51 * elapsed) + 1);
    expect(new VirtualClock().now()).toBe(0);
  });
  test("setWorld re-plugs: motors stop, tachos reset, sensors follow the new port map", async () => {
    const { call, run, brick } = rig();
    await call(E.outputStepSync(BC, 50, 0, 3600, true));
    run(300);
    brick.setWorld(quietWorld(EXAMPLES.wallsMaze));
    expect(brick.busy()).toBe(false);
    expect(brick.tacho("B")).toBe(0);
    expect((await call(E.inputGetTypeMode(3, 0, 1), 2)).globals[0]).toBe(E.SENSOR_TYPE.ir);
  });
});

const mk = (ev3: unknown, drivetrain = DRIVETRAIN as typeof DRIVETRAIN | null) =>
  new SimBrick({
    world: quietWorld(EXAMPLES.lineOval, { extensions: ev3 === undefined ? {} : { ev3 } }),
    drivetrain,
  });
describe("port map (extensions.ev3 of the world file)", () => {
  test("a world without a valid port map cannot host a brick, and says which field is wrong", () => {
    expect(() => mk(undefined)).toThrow(/extensions\.ev3 must be an object/);
    expect(() => mk({ motors: { B: "left", C: "right" } })).toThrow(
      /must be the motor type, large or medium.*robot profile/,
    );
    expect(() => mk({ motors: { B: "large", C: "large" }, sensors: { "5": "touch" } })).toThrow(/sensors\.5/);
    expect(() => mk({ motors: { B: "large", C: "large", E: "medium" } })).toThrow(/motors\.E/);
    expect(() => mk({ motors: { B: "large", C: "large" }, sensors: { "1": "lidar" } })).toThrow(/sensors\.1 must be/);
    expect(() => mk({ motors: { B: "large", C: "large" }, wheels: 2 })).toThrow(/\.wheels is not a known field/);
    // The profile's drive wheels need a motor on their ports; a robot with no drivetrain needs no motor at all.
    expect(() => mk({ motors: { B: "large" } })).toThrow(
      /plugs no motor into port C, which the robot profile uses as its right wheel/,
    );
    expect(mk({ sensors: { "1": "touch" } }, null).busy()).toBe(false);
  });
  test("setWorld to a world without a port map fails and leaves the brick as it was", async () => {
    const { brick, world } = rig();
    expect(() => brick.setWorld(new World({ ...parseWorld(EXAMPLES.wallsMaze), extensions: {} }, 1))).toThrow(
      /extensions\.ev3/,
    );
    expect(brick.world).toBe(world);
    expect(brick.ports.sensors["4"]).toBe("ultrasonic");
  });
});

describe("firmware quirks", () => {
  test("B0 with a negative step runs in the direction of the speed, like the firmware (the step sign is flipped)", async () => {
    const { call, run, brick, world } = rig();
    const r = await call([E.OP.OUTPUT_STEP_SYNC, 0, BC, ...E.lc(30), ...E.lc(0), ...E.lc(-180), 1]);
    expect(r.ok).toBe(true);
    run(3000);
    expect(brick.tacho("B")).toBe(180);
    expect(brick.tacho("C")).toBe(180);
    expect(world.pose.x).toBeGreaterThan(43);
  });
});

const profile = (drivetrain?: { wheel_diameter_cm: number; axle_track_cm: number; forward_sign: 1 | -1 }) => ({
  id: "t",
  roles: {},
  notes: [],
  limits: { max_speed_pct: 60, max_command_ms: 15000, max_program_ms: 60000, max_loop_ms: 60000 },
  ...(drivetrain
    ? {
        drivetrain: {
          type: "differential" as const,
          pair_device: "ev3.pair",
          max_drive_cm: 100,
          max_turn_deg: 360,
          ...drivetrain,
        },
      }
    : {}),
});
describe("the robot's geometry comes from the profile, not from the world", () => {
  test("SimBrick refuses to be built without the drivetrain decision", () => {
    expect(() => new SimBrick({ world: quietWorld() } as never)).toThrow(/needs `drivetrain` from the robot profile/);
    expect(() => new SimBrick({ world: quietWorld(), drivetrain: { ...DRIVETRAIN, right: "B" } })).toThrow(
      /two different motor ports/,
    );
    expect(() => new SimBrick({ world: quietWorld(), drivetrain: { ...DRIVETRAIN, wheel_diameter_cm: 0 } })).toThrow(
      /wheel_diameter_cm and axle_track_cm > 0/,
    );
  });
  test("a bigger wheel in the profile rolls further for the same packet; a wider axle turns less", async () => {
    const big = rig(
      quietWorld(),
      drivetrainFromProfile(profile({ wheel_diameter_cm: 8.4, axle_track_cm: 12, forward_sign: 1 }), {
        left: "B",
        right: "C",
      }),
    );
    await big.call(E.outputStepSync(BC, 40, 0, 360, true));
    big.run(3000);
    expect(big.world.pose.x - 43).toBeCloseTo(Math.PI * 8.4, 4);
    const wide = rig(quietWorld(), { ...DRIVETRAIN, axle_track_cm: 24 });
    await wide.call(E.outputStepSync(BC, -30, 200, Math.round((Math.PI / 2) * 6 * DEG_PER_CM), true));
    wide.run(3000);
    expect((wide.world.pose.th * 180) / Math.PI).toBeCloseTo(45, 0);
    expect(wide.world.drive).toEqual({ axle_track_cm: 24 });
  });
  test("forward_sign -1: positive motor rotation drives the robot backwards", async () => {
    const { call, run, world, brick } = rig(quietWorld(), { ...DRIVETRAIN, forward_sign: -1 });
    await call(E.outputStepSync(BC, 40, 0, 205, true));
    run(3000);
    expect(brick.tacho("B")).toBe(205);
    expect(world.pose.x).toBeCloseTo(43 - 205 / DEG_PER_CM, 4);
  });
  test("the wheels can be on any ports: here A (left) and D (right)", async () => {
    const world = quietWorld(EXAMPLES.lineOval, {
      extensions: { ev3: { motors: { A: "large", D: "large", C: "medium" } } },
    });
    const { call, run, brick } = rig(world, { ...DRIVETRAIN, left: "A", right: "D" });
    await call(E.outputStepSync(E.OUTPUT_MASK.A | E.OUTPUT_MASK.D, 40, 0, 205, true));
    await call(E.outputStepSpeed(E.OUTPUT_MASK.C, 50, 0, 90, 0, true));
    run(3000);
    expect(world.pose.x).toBeCloseTo(43 + 205 / DEG_PER_CM, 4);
    expect(brick.tacho("C")).toBe(90); // the free motor turned and moved nothing
  });
  test("a profile without a drivetrain gives a twin whose motors just turn", async () => {
    const dt = drivetrainFromProfile(profile(), { left: "B", right: "C" });
    expect(dt).toBeNull();
    // and a robot without a pair has no wheels to roll on, whatever its profile says
    expect(
      drivetrainFromProfile(profile({ wheel_diameter_cm: 5.6, axle_track_cm: 12, forward_sign: 1 }), undefined),
    ).toBeNull();
    const { call, run, world, brick } = rig(quietWorld(), dt);
    await call(E.outputStepSync(BC, 50, 0, 720, true));
    run(3000);
    expect([brick.tacho("B"), brick.tacho("C")]).toEqual([720, 720]);
    expect(world.pose).toEqual({ x: 43, y: 25, th: 0 });
    expect(world.drive).toBeNull();
    expect(world.t_ms).toBeCloseTo(3000, 6); // simulated time still passes
  });
});

describe("time-bounded motion and the end flag (brake or coast)", () => {
  test("B1 time sync runs both wheels for the time and brakes dead; with turn 200 it spins", async () => {
    const { call, run, brick, world } = rig();
    await call(E.outputTimeSync(BC, 50, 0, 250, true));
    run(249);
    expect(brick.busy(BC)).toBe(true);
    run(2);
    expect(brick.busy(BC)).toBe(false);
    const deg = brick.tacho("B");
    expect(Math.abs(deg - 0.5 * LARGE_DEG_S * 0.25)).toBeLessThanOrEqual(1);
    expect(brick.tacho("C")).toBe(deg);
    run(1000);
    expect(brick.tacho("B")).toBe(deg); // brake: not one degree more
    await call(E.outputTimeSync(BC, -30, 200, 250, true));
    run(300);
    expect(world.pose.th).toBeGreaterThan(0.5); // B back, C forward: a left spin
    expect(Math.abs(brick.tacho("B") - deg + (brick.tacho("C") - deg))).toBeLessThanOrEqual(1); // equal and opposite
  });
  test("coast (brake = 0): the motor runs down after the bound, is not busy meanwhile, and A8 shows the falling speed", async () => {
    const { call, run, brick } = rig();
    await call(E.outputTimeSync(BC, 50, 0, 250, false));
    run(250);
    const atBound = brick.tacho("B");
    expect((await call(E.outputTest(BC, 0), 1)).globals[0]).toBe(0);
    const coastMs = COAST_MS_AT_100 * 0.5;
    run(coastMs / 2);
    const speed = E.readI8((await call(E.outputRead(1, 0, 1), 5)).globals, 0);
    expect(speed).toBeGreaterThan(15);
    expect(speed).toBeLessThan(35);
    await call(E.outputStop(BC, false)); // releasing a motor that is already running down does not stop it dead
    run(coastMs);
    const extra = brick.tacho("B") - atBound;
    expect(Math.abs(extra - (0.5 * LARGE_DEG_S * (coastMs / 1000)) / 2)).toBeLessThanOrEqual(1.5); // triangle under a linear run-down
    run(1000);
    expect(brick.tacho("B") - atBound).toBe(extra);
    expect(E.readI8((await call(E.outputRead(1, 0, 1), 5)).globals, 0)).toBe(0);
  });
  test("chained chunks: a new command during the run-down takes over with no jump; A3 with brake cuts a coast short", async () => {
    const { call, run, brick } = rig();
    await call(E.outputTimeSync(BC, 50, 0, 250, false));
    run(250);
    await call(E.outputTimeSync(BC, 50, 0, 250, true));
    run(250);
    expect(Math.abs(brick.tacho("B") - 0.5 * LARGE_DEG_S * 0.5)).toBeLessThanOrEqual(1); // as one 500 ms move
    run(500);
    expect(brick.busy()).toBe(false);
    await call(E.outputTimeSync(BC, 50, 0, 100, false));
    run(110);
    const t = brick.tacho("B");
    await call(E.outputStop(BC, true));
    run(500);
    expect(Math.abs(brick.tacho("B") - t)).toBeLessThanOrEqual(1);
    // A3 without brake on a running motor lets it run down too.
    await call(E.outputTimeSync(BC, 50, 0, 2000, true));
    run(100);
    const before = brick.tacho("B");
    await call(E.outputStop(BC, false));
    run(500);
    expect(brick.tacho("B") - before).toBeGreaterThan(5);
  });
  test("a blocked wheel ends at the time bound: not busy any more, tacho where the wall stopped it", async () => {
    const { call, run, brick, world } = rig();
    world.setPose({ x: 109, y: 20, th: 0 }); // 3 cm of room
    await call(E.outputTimeSync(BC, 50, 0, 250, false));
    run(200);
    expect(brick.busy(BC)).toBe(true);
    const g = (await call(E.outputRead(1, 0, 1), 5)).globals;
    expect(E.readI8(g, 0)).toBe(0); // against the wall
    run(60);
    expect(brick.busy(BC)).toBe(false);
    const deg = brick.tacho("B");
    expect(deg).toBeLessThan(3.1 * DEG_PER_CM);
    expect(deg).toBeGreaterThan(2 * DEG_PER_CM);
    run(1000);
    expect(brick.tacho("B")).toBe(deg); // and a blocked motor does not coast
    expect(world.pose.x).toBeLessThanOrEqual(112);
  });
  test("AF on one wheel only pivots the robot about the other wheel", async () => {
    const { call, run, world } = rig();
    await call(E.outputTimeSpeed(E.OUTPUT_MASK.C, 40, 0, 200, 0, true));
    run(300);
    expect(world.pose.th).toBeGreaterThan(0.3);
    expect(world.pose.x).toBeGreaterThan(43);
  });
});

describe("sensor mode switches behave like the real sensors", () => {
  test("switching the gyro's mode zeroes its angle; reading in the same mode never does", async () => {
    const { call, run } = rig();
    await call(E.outputStepSync(BC, 30, 200, 100, true));
    run(3000);
    const read = async (mode: number) =>
      E.readF32((await call(E.inputReadySi(1, E.SENSOR_TYPE.gyro, mode, 1, 0), 4)).globals, 0);
    const angle = await read(0);
    expect(angle).toBeGreaterThan(20);
    expect(await read(0)).toBe(angle); // same mode: no side effect
    expect(await read(-1)).toBe(angle); // "keep the mode": no side effect
    expect(await read(1)).toBe(0); // rate mode: a switch
    expect(await read(0)).toBe(0); // back to angle: it restarted from zero
    expect((await call(E.inputGetTypeMode(1, 0, 1), 2)).globals[1]).toBe(0);
  });
  test("switching other sensors' modes keeps their state: the touch bump count survives", async () => {
    const { call, run } = rig();
    await call(E.outputStepSync(BC, 50, 0, Math.round(150 * DEG_PER_CM), true));
    run(6000);
    const read = async (mode: number) =>
      E.readF32((await call(E.inputReadySi(0, E.SENSOR_TYPE.touch, mode, 1, 0), 4)).globals, 0);
    expect(await read(1)).toBe(1);
    expect(await read(0)).toBe(1);
    expect(await read(1)).toBe(1);
  });
});
