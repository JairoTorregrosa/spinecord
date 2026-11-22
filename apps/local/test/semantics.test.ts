// What a result means, on the twin behind stdio: reasons and clamps, conditions refused before a move, the
// smallest move, `changed` on sensors with noise, program steps, the instructions about a twin, and the call log.
// Every envelope here passed the outputSchema the server listed (client.ts checks each one).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, until, wheelSpeeds, type TestServer } from "./client";

const R = "r1-sim";
let s: TestServer;
beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  expect(await s.closeStdin()).toBe(0);
});

const call = async (tool: string, args: Record<string, unknown> = {}) =>
  (await s.tool(tool, { robot_id: R, ...args })).envelope;
/** The middle of the room, heading 0: 60 cm of free floor on every side. */
const home = async () => {
  const world = { device: "sim.world", command: "reset", args: { x_cm: 60, y_cm: 60, heading_deg: 0 } };
  expect((await call("command_device", world)).ok).toBe(true);
};
const wheels = async (): Promise<number[]> => {
  const pair = await call("read_device", { device: "ev3.pair" });
  if (!pair.ok) throw new Error(pair.error.message);
  return pair.data.readings.map((r: { value: number }) => r.value);
};

describe("reasons and clamps", () => {
  test("a drive at a speed over the limit drives the whole distance: reason completed, clamped true", async () => {
    await home();
    const d = await call("drive", { distance_cm: 10, speed_pct: 100 });
    expect(d).toMatchObject({
      ok: true,
      data: {
        requested: { distance_cm: 10, speed_pct: 100 },
        applied: { distance_cm: 10 },
        clamped: true,
        clamps: [{ arg: "speed_pct", requested: 100, target: false }],
        reason: "completed",
      },
    });
    expect(d.ok && Math.abs(d.data.measured.distance_cm - 10)).toBeLessThan(1);
  });
  test("a turn past max_turn_deg turns to the limit: reason clamped, the target marked", async () => {
    const limits = await call("describe_robot");
    const max = limits.ok ? limits.data.limits.max_turn_deg : 0;
    const t = await call("turn", { angle_deg: max + 100, speed_pct: 60 });
    expect(t).toMatchObject({
      ok: true,
      data: {
        clamped: true,
        clamps: [{ arg: "angle_deg", requested: max + 100, applied: max, target: true }],
        reason: "clamped",
      },
    });
  }, 30_000);
  test("a program's steps carry what each call measured", async () => {
    await home();
    const p = await call("run_program", {
      body: {
        seq: [
          { call: { tool: "drive", args: { distance_cm: 8, speed_pct: 100 } } },
          { call: { tool: "turn", args: { angle_deg: -45 } } },
        ],
      },
    });
    expect(p).toMatchObject({
      ok: true,
      data: {
        outcome: "succeeded",
        steps: [
          { tool: "drive", ok: true, reason: "completed", clamped: true },
          { tool: "turn", ok: true, reason: "completed" },
        ],
      },
    });
    const [drive, turn] = p.ok ? p.data.steps : [];
    expect(Math.abs(drive.measured.distance_cm - 8)).toBeLessThan(1);
    expect(Math.abs(turn.measured.heading_change_deg + 45)).toBeLessThan(5);
  });
});

describe("a condition that cannot work is refused before the robot moves", () => {
  test("a gyro in rate mode: until on angle_deg moves nothing, says why, and next starts with the read that fixes it", async () => {
    await home();
    expect((await call("read_device", { device: "gyro", channels: ["rate_deg_s"] })).ok).toBe(true);
    const before = await wheels();
    const until = { device: "gyro", channel: "angle_deg", op: "lt", value: -45 };
    const refused = await call("turn", { angle_deg: -90, until });
    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_argument", retryable: false } });
    expect(refused.next.slice(0, 2)).toEqual(["read_device", "turn"]);
    const message = refused.ok ? "" : refused.error.message;
    expect(message).toContain("nothing was sent and nothing moved");
    expect(message).toContain("ev3.S2.angle_deg is not active");
    expect(message).toContain("(active: rate_deg_s)");
    expect(message).not.toContain("braked");
    expect(!refused.ok && refused.error.measured).toBeUndefined();
    expect(await wheels()).toEqual(before);
    const waited = await call("wait_until", { condition: until, timeout_ms: 200 });
    expect(waited.next[0]).toBe("read_device");
    // the read the message names switches the mode, and the same call then runs
    expect((await call("read_device", { device: "ev3.S2", channels: ["angle_deg"] })).ok).toBe(true);
    const turned = await call("turn", { angle_deg: -90, until });
    expect(turned).toMatchObject({ ok: true, data: { reason: "condition_met" } });
  });
  test("a threshold outside the channel's range: invalid_argument naming the range, on a move, a wait and a program", async () => {
    const before = await wheels();
    const never = { device: "distance", channel: "distance_cm", op: "lt", value: 2 };
    const drive = await call("drive", { distance_cm: 20, until: never });
    expect(drive).toMatchObject({ ok: false, error: { code: "invalid_argument" }, next: ["drive"] });
    expect(!drive.ok && drive.error.message).toContain('"distance_cm" lt 2 can never be true');
    expect(!drive.ok && drive.error.message).toContain("[3, 255] cm");
    expect((await call("wait_until", { condition: never, timeout_ms: 100 })).ok).toBe(false);
    const body = { call: { tool: "drive", args: { distance_cm: 20, until: never } } };
    expect(await call("run_program", { body })).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(await call("run_program", { body: { wait_ms: 1 }, success: never })).toMatchObject({ ok: false });
    expect(await wheels()).toEqual(before);
    expect(await wheelSpeeds(s, R)).toEqual([0, 0, 0]);
  });
  test("a target under the drivetrain's smallest move is done with a note that names the minimum; nothing moves", async () => {
    const before = await wheels();
    for (const angle_deg of [0.2, -0.2]) {
      const t = await call("turn", { angle_deg });
      expect(t).toMatchObject({
        ok: true,
        data: { reason: "completed", applied: { angle_deg: 0 }, measured: { heading_change_deg: 0 }, chunks: 0 },
      });
      expect(t.ok && t.data.note).toContain("0.47 deg");
    }
    const d = await call("drive", { distance_cm: 0.02 });
    expect(d).toMatchObject({ ok: true, data: { reason: "completed", measured: { distance_cm: 0 } } });
    expect(d.ok && d.data.note).toContain("0.05 cm");
    const a = await call("arc", { radius_cm: 20, angle_deg: 0.05 });
    expect(a.ok && a.data.note).toContain("below the smallest move");
    const body = { call: { tool: "turn", args: { angle_deg: 0.2 } } };
    const p = await call("run_program", { body });
    expect(p).toMatchObject({ ok: true, data: { outcome: "succeeded", steps: [{ ok: true, reason: "completed" }] } });
    expect(p.ok && p.data.steps[0].note).toContain("0.47 deg");
    expect(await wheels()).toEqual(before);
    expect(await call("turn", { angle_deg: 0 })).toMatchObject({ ok: true, data: { reason: "completed", chunks: 0 } });
    expect(await wheels()).toEqual(before);
  });
});

describe("changed on a sensor with noise", () => {
  test("a still robot never meets it; a robot that moves does", async () => {
    await home();
    for (const [device, channel] of [
      ["distance", "distance_cm"],
      ["color", "reflected_pct"],
      ["gyro", "angle_deg"],
    ]) {
      const spec = await call("describe_device", { device });
      expect(spec.ok && spec.data.channels.find((c: { name: string }) => c.name === channel).noise).toBeGreaterThan(0);
      const still = await call("wait_until", { condition: { device, channel, op: "changed" }, timeout_ms: 1500 });
      expect(still).toMatchObject({ ok: true, data: { met: false, reason: "timeout" } });
    }
    // a wait is a read: it runs while the robot drives toward the wall
    const move = call("drive", { distance_cm: 25, speed_pct: 30 });
    const seen = await call("wait_until", {
      condition: { device: "distance", channel: "distance_cm", op: "changed" },
      timeout_ms: 5000,
    });
    expect(seen).toMatchObject({ ok: true, data: { met: true, reason: "condition_met" } });
    expect((await move).ok).toBe(true);
    // a move guarded by it on a still sensor runs to its end
    const guarded = await call("turn", {
      angle_deg: 20,
      until: { device: "color", channel: "reflected_pct", op: "changed" },
    });
    expect(guarded).toMatchObject({ ok: true, data: { reason: "completed" } });
  }, 30_000);
});

describe("the instructions about a twin", () => {
  test("they name the devices only a twin has, and say a stock brick has no camera and no speak", async () => {
    const text = s.init.instructions as string;
    for (const word of ["sim.world", "sim.camera", "sim.speaker", "no camera", "no speak", "world file"])
      expect(text).toContain(word);
    expect(text).not.toContain("the same devices as the hardware robot");
    // and they match what this twin really has
    const robot = await call("describe_robot");
    const devices: { id: string; commands: string[] }[] = robot.ok ? robot.data.devices : [];
    expect(
      devices
        .filter((d) => d.id.startsWith("sim."))
        .map((d) => d.id)
        .sort(),
    ).toEqual(["sim.camera", "sim.speaker", "sim.world"]);
    expect(devices.find((d) => d.id === "sim.speaker")!.commands).toContain("speak");
    expect(devices.find((d) => d.id === "ev3.speaker")!.commands).not.toContain("speak");
  });
  test("they say that a gyro's angle is cumulative, and turn says what to use", () => {
    expect(s.init.instructions).toContain("cumulative since its last reset");
    const turn = (s.listed as unknown as { name: string; description: string }[]).find((t) => t.name === "turn")!;
    expect(turn.description).toContain("cumulative angle since the gyro's last reset");
    expect(turn.description).toContain("reset command first");
  });
});

describe("the call log on stderr", () => {
  test("every call leaves one line: tool, robot, outcome, time, whether it moved, and none of its arguments", async () => {
    // a server of its own: its stderr holds these five calls and no other
    const own = await startServer();
    await own.tool("drive", { robot_id: R, distance_cm: 3, request_id: "a-label-not-for-the-log" });
    await own.tool("read_device", { robot_id: R, device: "sim.camera", channels: ["frame"] });
    await own.tool("turn", { robot_id: R, angle_deg: 0.3 });
    const never = { device: "distance", channel: "distance_cm", op: "lt", value: 2 };
    await own.tool("drive", { robot_id: R, distance_cm: 5, until: never });
    await own.tool("read_all", { robot_id: "nobody" });
    // stderr and stdout are two pipes: an answer can be read before the line about it
    await until("five call lines", () => own.events("call").length === 5);
    expect(await own.closeStdin()).toBe(0);
    const lines = own.events("call");
    expect(own.stderr.join("\n")).not.toContain("a-label-not-for-the-log");
    expect(lines.map((l) => [l.tool, l.robot_id, l.ok, l.code, l.reason, l.moved])).toEqual([
      ["drive", R, true, null, "completed", true],
      ["read_device", R, true, null, null, false],
      ["turn", R, true, null, "completed", false],
      ["drive", R, false, "invalid_argument", null, false],
      ["read_all", "nobody", false, "unknown_robot", null, false],
    ]);
    for (const l of lines) {
      expect(Object.keys(l)).toEqual([
        "ev",
        "ts",
        "tool",
        "robot_id",
        "ok",
        "code",
        "reason",
        "ms",
        "trace_id",
        "moved",
      ]);
      expect(l.trace_id).toBeNull();
      expect(typeof l.ms).toBe("number");
      expect(JSON.stringify(l).length).toBeLessThan(300); // no arguments, no data, no image
    }
  });
});
