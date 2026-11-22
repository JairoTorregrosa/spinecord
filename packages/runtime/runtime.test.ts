import { describe, expect, test } from "bun:test";
import { RuntimeError } from "../protocol/types";
import type { DeviceSpec, Limits, Provider, RobotProfile, RobotTool, RuntimeResult } from "../protocol/types";
import { FakeClock } from "./clock";
import { MockProvider } from "./mock";
import { createRuntime, LINK_FRESH_MS, MAX_CHUNK_MS, UNTIL_POLL_MS } from "./runtime";

const LIMITS = {
  max_speed_pct: 80,
  max_command_ms: 10000,
  max_drive_cm: 100,
  max_turn_deg: 360,
  max_program_ms: 20000,
};
function setup(
  o: {
    latency_ms?: number;
    op_ms?: number;
    deg_s_per_pct?: number;
    backend?: "sim" | "organ";
    drivetrain?: boolean;
    forward_sign?: 1 | -1;
    gyro?: boolean;
    gyro_sign?: 1 | -1;
    limits?: Partial<typeof LIMITS>;
    extra?: DeviceSpec[];
  } = {},
) {
  const clock = new FakeClock();
  const mock = new MockProvider({
    clock,
    extra: o.extra,
    latency_ms: o.latency_ms,
    op_ms: o.op_ms,
    deg_s_per_pct: o.deg_s_per_pct,
    backend: o.backend,
    ...(o.gyro ? { gyro: { heading_per_wheel_deg: 5.6 / 12, sign: o.gyro_sign } } : {}),
  });
  const profile: RobotProfile = {
    id: "r1",
    roles: { floor_color: "mock.color", horn: "mock.speaker" },
    notes: ["test robot"],
    limits: { ...LIMITS, ...o.limits },
    ...(o.drivetrain === false
      ? {}
      : {
          drivetrain: {
            type: "differential",
            pair_device: "mock.pair",
            wheel_diameter_cm: 5.6,
            axle_track_cm: 12,
            forward_sign: o.forward_sign ?? 1,
          },
        }),
  };
  const rt = createRuntime({ profile, providers: [mock], clock });
  const call = async (
    tool: RobotTool,
    args: Record<string, unknown> = {},
    signal = new AbortController().signal,
  ): Promise<any> => (await rt.call(tool, args, signal)).data;
  return { clock, mock, rt, call, profile };
}
async function fails(p: Promise<unknown>, code: string): Promise<RuntimeError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RuntimeError);
    expect((e as RuntimeError).code).toBe(code as never);
    return e as RuntimeError;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}
const pairLog = (m: MockProvider) => m.log.filter((x) => x.command === "run_pair");
const DEG_PER_CM = 360 / (Math.PI * 5.6);

describe("discovery", () => {
  test("describe_robot lists devices, roles, drivetrain, limits, notes", async () => {
    const { call } = setup();
    const d = await call("describe_robot", { robot_id: "r1" });
    expect(d.devices.map((x: any) => x.id)).toEqual([
      "mock.pair",
      "mock.arm",
      "mock.color",
      "mock.speaker",
      "mock.camera",
      "mock.gas",
    ]);
    expect(d.devices.find((x: any) => x.id === "mock.color")).toMatchObject({
      kind: "color",
      roles: ["floor_color"],
      channels: ["reflected_pct", "ambient_pct", "color", "rgb"],
      commands: [],
    });
    expect(d.roles).toEqual({ floor_color: "mock.color", horn: "mock.speaker" });
    expect(d.drivetrain.wheel_diameter_cm).toBe(5.6);
    expect(d.limits).toEqual(LIMITS);
    expect(d.notes).toEqual(["test robot"]);
    expect((await setup({ drivetrain: false }).call("describe_robot")).drivetrain).toBeNull();
  });
  test("describe_device by role returns the full spec", async () => {
    const d = await setup().call("describe_device", { device: "horn" });
    expect(d.id).toBe("mock.speaker");
    expect(d.commands[0]).toMatchObject({
      name: "tone",
      bound: { kind: "ms", params: ["duration_ms"], max: 2000 },
      moves: false,
    });
  });
  test("unknown device lists valid ids and roles", async () => {
    const e = await fails(setup().call("describe_device", { device: "ev3.S9" }), "unknown_device");
    expect(e.message).toContain("mock.pair, mock.arm, mock.color, mock.speaker, mock.camera, mock.gas");
    expect(e.message).toContain("floor_color");
    expect(e.retryable).toBe(false);
  });
  test("unknown tool and bad args are invalid_argument naming the rule", async () => {
    const s = setup();
    expect((await fails(s.call("fly" as RobotTool), "invalid_argument")).message).toContain("describe_robot");
    expect((await fails(s.call("drive", { distance_cm: "far" }), "invalid_argument")).message).toContain(
      "args.distance_cm must be of type number",
    );
    expect((await fails(s.call("drive", { distance_cm: 5, speed_pct: 500 }), "invalid_argument")).message).toContain(
      "<= 100",
    );
    expect((await fails(s.call("drive", { distance_cm: 5, sped: 1 }), "invalid_argument")).message).toContain(
      "args.sped unknown field",
    );
  });
  test("remote providers come and go at runtime", async () => {
    const { rt, call, clock } = setup();
    await rt.ready();
    const organ = new MockProvider({ id: "mcu1", clock });
    await rt.setRemoteProviders([organ]);
    expect((await call("read_device", { device: "mcu1.gas" }))[0]).toMatchObject({
      device: "mcu1.gas",
      channel: "ppm",
      value: 412,
    });
    expect(rt.localDevices().length).toBe(6);
    expect(rt.devices().length).toBe(12);
    await rt.setRemoteProviders([]);
    await fails(call("read_device", { device: "mcu1.gas" }), "unknown_device");
  });
});

describe("hot-plug", () => {
  const TOF = {
    id: "mock.tof",
    provider: "mock",
    kind: "distance",
    roles: [],
    description: "Distance.",
    commands: [],
    channels: [{ name: "distance_cm", type: "number" as const, unit: "cm", description: "Distance." }],
  };
  test("a provider's device change updates the registry and notifies listeners", async () => {
    const s = setup();
    await s.rt.ready();
    let notified = 0;
    const off = s.rt.onLocalDevicesChanged(() => notified++);
    s.mock.values.set("mock.tof.distance_cm", 33);
    s.mock.plug(TOF);
    await s.clock.sleep(0);
    expect(notified).toBe(1);
    expect((await s.call("read_device", { device: "mock.tof" }))[0]).toMatchObject({ value: 33, unit: "cm" });
    s.mock.unplug("mock.color");
    await s.clock.sleep(0);
    expect(notified).toBe(2);
    expect((await fails(s.call("read_device", { device: "floor_color" }), "unknown_device")).message).toContain(
      'Role "floor_color" points to mock.color, which is not attached',
    );
    off();
    s.mock.unplug("mock.tof");
    await s.clock.sleep(0);
    expect(notified).toBe(2);
    expect(s.rt.devices().map((d) => d.id)).not.toContain("mock.tof");
    expect(s.mock.subscribers).toBe(1);
    s.rt.dispose();
    expect(s.mock.subscribers).toBe(0);
  });
  test("unplugging the drivetrain pair makes drive unsupported", async () => {
    const s = setup();
    await s.rt.ready();
    s.mock.unplug("mock.pair");
    await s.clock.sleep(0);
    expect((await fails(s.call("drive", { distance_cm: 5 }), "unsupported")).message).toContain(
      '"mock.pair" is not attached',
    );
  });
});

describe("reads have no side effects", () => {
  test("default reads cover active channels only; a mode switch needs the channel named, while idle", async () => {
    const s = setup();
    expect((await s.call("read_device", { device: "mock.color" })).map((r: any) => r.channel)).toEqual([
      "reflected_pct",
      "color",
      "rgb",
    ]);
    expect((await s.call("read_all")).readings.map((r: any) => r.channel)).not.toContain("ambient_pct");
    expect(s.mock.switchReads).toBe(0);
    expect((await s.call("read_device", { device: "mock.color", channels: ["ambient_pct"] }))[0]).toMatchObject({
      channel: "ambient_pct",
      value: 12,
    });
    expect(s.mock.modeSwitches).toBe(1);
    await s.call("read_device", { device: "mock.color", channels: ["reflected_pct"] }); // an active channel never asks for a switch
    expect(s.mock.switchReads).toBe(1);
  });
  test("a mode-switching read is refused with busy while the robot is not idle", async () => {
    const s = setup();
    const driving = s.call("drive", { distance_cm: 40 });
    await s.clock.sleep(300);
    const e = await fails(s.call("read_device", { device: "mock.color", channels: ["ambient_pct"] }), "busy");
    expect(e.retryable).toBe(true);
    expect(e.message).toContain("mock.color.ambient_pct");
    expect((await s.call("read_device", { device: "mock.color" })).length).toBe(3); // active channels still readable
    await driving;
    await fails(
      s.rt.call("read_device", { device: "mock.color", channels: ["ambient_pct"] }, new AbortController().signal, {
        activity: "running_program",
      }),
      "busy",
    );
    expect(s.mock.modeSwitches).toBe(0);
    await s.rt.call("read_device", { device: "mock.color", channels: ["ambient_pct"] }, new AbortController().signal, {
      activity: "idle",
    });
    expect(s.mock.modeSwitches).toBe(1);
  });
  test("conditions and sampling never switch a mode: an inactive channel is an error that says what to do", async () => {
    const s = setup();
    const cond = { device: "mock.color", channel: "ambient_pct", op: "lt", value: 5 };
    expect(
      (await fails(s.call("wait_until", { condition: cond, timeout_ms: 100 }), "invalid_argument")).message,
    ).toContain("read_device");
    await fails(s.call("drive", { distance_cm: 10, until: cond }), "invalid_argument");
    await fails(
      s.call("sample_device", { device: "mock.color", channel: "ambient_pct", duration_ms: 100 }),
      "invalid_argument",
    );
    expect(s.mock.log.length).toBe(0);
    expect(s.mock.switchReads).toBe(0);
  });
});

describe("sensing", () => {
  test("read_device: all non-image channels, role resolves to the canonical id", async () => {
    const r = await setup().call("read_device", { device: "floor_color" });
    expect(r.map((x: any) => [x.device, x.channel, x.value, x.unit])).toEqual([
      ["mock.color", "reflected_pct", 50, "pct"],
      ["mock.color", "color", 6, undefined],
      ["mock.color", "rgb", [10, 20, 30], undefined],
    ]);
    expect(typeof r[0].ts).toBe("number");
  });
  test("a device of an unknown kind is readable with no code for it", async () => {
    expect(await setup().call("read_device", { device: "mock.gas", channels: ["ppm"] })).toMatchObject([
      { device: "mock.gas", channel: "ppm", value: 412, unit: "ppm" },
    ]);
  });
  test("unknown channel lists valid channels", async () => {
    expect(
      (await fails(setup().call("read_device", { device: "mock.color", channels: ["hue"] }), "unknown_channel"))
        .message,
    ).toContain("reflected_pct (number), ambient_pct (number), color (number), rgb (vector)");
  });
  test("a missing value is null with an error string", async () => {
    const s = setup();
    s.mock.values.set("mock.gas.ppm", null);
    expect((await s.call("read_device", { device: "mock.gas" }))[0]).toMatchObject({ value: null, error: "no value" });
  });
  test("image channel returns an ImagePayload with age_ms", async () => {
    const s = setup();
    await s.rt.ready();
    await s.clock.sleep(400);
    const r: RuntimeResult = await s.rt.call(
      "read_device",
      { device: "mock.camera", channels: ["frame", "fps"] },
      new AbortController().signal,
    );
    expect(r.image).toEqual({ mime: "image/jpeg", b64: "/9j/AAAA", age_ms: 400 });
    expect(r.data).toMatchObject([
      { channel: "frame", image: true, age_ms: 400 },
      { channel: "fps", value: 15 },
    ]);
    // without channels, the image is not read
    expect(
      (await s.rt.call("read_device", { device: "mock.camera" }, new AbortController().signal)).image,
    ).toBeUndefined();
  });
  test("a frame older than 1500 ms fails with stale_image", async () => {
    const s = setup();
    await s.clock.sleep(1501);
    const e = await fails(s.call("read_device", { device: "mock.camera", channels: ["frame"] }), "stale_image");
    expect(e.retryable).toBe(true);
    expect(e.message).toContain("1501 ms old");
    s.mock.frameTs = s.clock.now() - 1500;
    expect(
      (await s.rt.call("read_device", { device: "mock.camera", channels: ["frame"] }, new AbortController().signal))
        .image?.age_ms,
    ).toBe(1500);
  });
  test("read_all reads every non-image channel; a failing device becomes null + error", async () => {
    const s = setup();
    s.mock.failRead = "mock.gas";
    const d = await s.call("read_all");
    expect(d.readings.map((r: any) => `${r.device}.${r.channel}`)).toEqual([
      "mock.pair.left_deg",
      "mock.pair.right_deg",
      "mock.arm.position_deg",
      "mock.color.reflected_pct",
      "mock.color.color",
      "mock.color.rgb",
      "mock.camera.fps",
      "mock.gas.ppm",
    ]);
    expect(d.readings.at(-1)).toMatchObject({ value: null, error: "read failed: mock: mock.gas unplugged" });
    expect(typeof d.ms).toBe("number");
  });
  test("sample_device caps the rate at the channel's max_rate_hz and at 50 Hz", async () => {
    const s = setup();
    s.mock.values.set("mock.color.reflected_pct", () => (s.clock.now() % 1000) / 10);
    const d = await s.call("sample_device", {
      device: "floor_color",
      channel: "reflected_pct",
      rate_hz: 50,
      duration_ms: 1000,
    });
    expect(d.rate_hz).toBe(20);
    expect(d.samples.length).toBe(21);
    expect(d.samples[1][0]).toBe(50);
    expect(d.min).toBe(Math.min(...d.samples.map((x: number[]) => x[1])));
    expect(d.last).toBe(d.samples.at(-1)[1]);
    expect(d.mean).toBeGreaterThan(d.min);
    const g = await s.call("sample_device", { device: "mock.gas", channel: "ppm", rate_hz: 50, duration_ms: 100 });
    expect(g.rate_hz).toBe(50);
    expect(g.samples.length).toBe(6);
    await fails(
      s.call("sample_device", { device: "mock.color", channel: "rgb", duration_ms: 100 }),
      "invalid_argument",
    );
    await fails(s.call("sample_device", { device: "mock.gas", channel: "ppm", duration_ms: 9000 }), "invalid_argument");
  });
});

describe("conditions and wait_until", () => {
  test("wait_until returns met with the deciding readings, or met:false at the timeout", async () => {
    const s = setup();
    const t0 = s.clock.now();
    s.mock.values.set("mock.gas.ppm", () => (s.clock.now() - t0 >= 300 ? 900 : 400));
    const a = await s.call("wait_until", {
      condition: { device: "mock.gas", channel: "ppm", op: "gt", value: 800 },
      timeout_ms: 2000,
    });
    expect(a.met).toBe(true);
    expect(a.after_ms).toBe(300);
    expect(a.readings[0]).toMatchObject({ device: "mock.gas", channel: "ppm", value: 900 });
    const b = await s.call("wait_until", {
      condition: { device: "mock.gas", channel: "ppm", op: "lt", value: 100 },
      timeout_ms: 500,
    });
    expect(b).toMatchObject({ met: false, after_ms: 500 });
  });
  test("every operator, any/all/not, roles", async () => {
    const s = setup();
    const met = async (condition: unknown) => (await s.call("wait_until", { condition, timeout_ms: 50 })).met;
    const leaf = (op: string, value?: unknown, channel = "reflected_pct") => ({
      device: "floor_color",
      channel,
      op,
      ...(value === undefined ? {} : { value }),
    });
    expect(await met(leaf("lt", 51))).toBe(true);
    expect(await met(leaf("lt", 50))).toBe(false);
    expect(await met(leaf("lte", 50))).toBe(true);
    expect(await met(leaf("gt", 49))).toBe(true);
    expect(await met(leaf("gte", 51))).toBe(false);
    expect(await met(leaf("eq", 6, "color"))).toBe(true);
    expect(await met(leaf("neq", 6, "color"))).toBe(false);
    expect(await met({ any: [leaf("lt", 1), leaf("eq", 6, "color")] })).toBe(true);
    expect(await met({ all: [leaf("lt", 1), leaf("eq", 6, "color")] })).toBe(false);
    expect(await met({ not: leaf("lt", 1) })).toBe(true);
    expect(await met(leaf("changed"))).toBe(false);
    const t0 = s.clock.now();
    s.mock.values.set("mock.color.rgb", () => (s.clock.now() - t0 >= 100 ? [1, 2, 3] : [10, 20, 30]));
    expect(
      await s.call("wait_until", { condition: leaf("changed", undefined, "rgb"), timeout_ms: 1000 }),
    ).toMatchObject({ met: true, after_ms: 100 });
  });
  test("contains: a vector channel includes the value", async () => {
    const buttons: DeviceSpec = {
      id: "mock.buttons",
      provider: "mock",
      kind: "buttons",
      roles: [],
      description: "Buttons.",
      commands: [],
      channels: [{ name: "pressed", type: "vector", description: "Names of the buttons held down." }],
    };
    const s = setup({ extra: [buttons] });
    const t0 = s.clock.now();
    s.mock.values.set("mock.buttons.pressed", () => (s.clock.now() - t0 >= 200 ? ["up", "enter"] : ["up"]));
    const cond = (value: unknown) => ({ device: "mock.buttons", channel: "pressed", op: "contains", value });
    expect(await s.call("wait_until", { condition: cond("enter"), timeout_ms: 1000 })).toMatchObject({
      met: true,
      after_ms: 200,
    });
    expect((await s.call("wait_until", { condition: { not: cond("back") }, timeout_ms: 50 })).met).toBe(true);
    expect(
      (
        await s.call("wait_until", { condition: cond(2), timeout_ms: 50 }).then(
          (r) => r,
          (e) => e,
        )
      ).met,
    ).toBe(false);
    s.mock.values.set("mock.color.rgb", [10, 20, 30]);
    expect(
      (
        await s.call("wait_until", {
          condition: { device: "mock.color", channel: "rgb", op: "contains", value: 20 },
          timeout_ms: 50,
        })
      ).met,
    ).toBe(true);
    await fails(
      s.call("wait_until", {
        condition: { device: "mock.gas", channel: "ppm", op: "contains", value: 4 },
        timeout_ms: 50,
      }),
      "invalid_argument",
    );
    await fails(
      s.call("wait_until", {
        condition: { device: "mock.color", channel: "rgb", op: "eq", value: 20 },
        timeout_ms: 50,
      }),
      "invalid_argument",
    );
  });
  test("an unreadable channel never satisfies a condition, even under not", async () => {
    const s = setup();
    s.mock.values.set("mock.gas.ppm", null);
    expect(
      (
        await s.call("wait_until", {
          condition: { not: { device: "mock.gas", channel: "ppm", op: "gt", value: 1 } },
          timeout_ms: 50,
        })
      ).met,
    ).toBe(false);
  });
  test("bad conditions fail before waiting", async () => {
    const s = setup();
    const w = (condition: unknown) => s.call("wait_until", { condition, timeout_ms: 50 });
    await fails(w({ device: "nope", channel: "x", op: "lt", value: 1 }), "unknown_device");
    await fails(w({ device: "mock.gas", channel: "x", op: "lt", value: 1 }), "unknown_channel");
    expect(
      (await fails(w({ device: "mock.gas", channel: "ppm", op: "near", value: 1 }), "invalid_argument")).message,
    ).toContain("lt, lte, gt, gte, eq, neq, changed, contains");
    await fails(w({ device: "mock.gas", channel: "ppm", op: "lt" }), "invalid_argument");
    await fails(w({ device: "mock.gas", channel: "ppm", op: "lt", value: "high" }), "invalid_argument");
    await fails(w({ device: "mock.camera", channel: "frame", op: "changed" }), "invalid_argument");
    await fails(w({ any: [] }), "invalid_argument");
  });
});

describe("drivetrain", () => {
  test("drive: measured distance from encoders, chunks of at most 250 ms", async () => {
    const s = setup();
    const d = await s.call("drive", { distance_cm: 20, request_id: "a" });
    expect(d.requested).toEqual({ distance_cm: 20, speed_pct: 30 });
    expect(d.measured.distance_cm).toBeCloseTo(20, 0);
    expect(d.measured.heading_change_deg).toBe(0);
    expect(d.measured.source).toBe("encoders");
    expect(d).toMatchObject({ clamped: false, reason: "completed" });
    expect(s.mock.left).toBeCloseTo(20 * DEG_PER_CM, 0);
    const log = pairLog(s.mock);
    expect(log.length).toBeGreaterThan(3);
    expect(d.chunks).toBe(log.length);
    for (const c of log) expect(c.ms).toBeLessThanOrEqual(MAX_CHUNK_MS);
    expect(Math.abs(d.ms - log.reduce((a, c) => a + c.ms, 0))).toBeLessThan(log.length);
  });
  test("drive backwards, and forward_sign -1 flips the motors but not the report", async () => {
    const a = setup();
    expect((await a.call("drive", { distance_cm: -10 })).measured.distance_cm).toBeCloseTo(-10, 0);
    expect(a.mock.left).toBeLessThan(0);
    const b = setup({ forward_sign: -1 });
    expect((await b.call("drive", { distance_cm: 10 })).measured.distance_cm).toBeCloseTo(10, 0);
    expect(b.mock.left).toBeCloseTo(-10 * DEG_PER_CM, 0);
    const t = await b.call("turn", { angle_deg: 90 });
    expect(t.measured.angle_deg).toBeCloseTo(90, 0);
  });
  test("measured values are not the request when wheels slip", async () => {
    const s = setup();
    s.mock.slip = 0;
    const d = await s.call("drive", { distance_cm: 10 });
    expect(d.reason).toBe("stalled");
    expect(d.measured.distance_cm).toBe(0);
    expect(pairLog(s.mock).length).toBe(3);
    expect(s.mock.brakes).toEqual(["mock.pair"]); // the last chunk coasted, so the runtime braked the pair
    expect(s.mock.stops).toBe(0);
  });
  test("until stops the drive early, overrunning at most one chunk", async () => {
    const s = setup();
    s.mock.values.set("mock.color.reflected_pct", () => (s.mock.left >= 300 ? 8 : 50));
    const d = await s.call("drive", {
      distance_cm: 60,
      until: { device: "floor_color", channel: "reflected_pct", op: "lt", value: 20 },
    });
    expect(d.reason).toBe("condition_met");
    expect(d.measured.distance_cm).toBeLessThan(60);
    const biggest = Math.max(...pairLog(s.mock).map((c) => Number(c.args.left_deg)));
    expect(s.mock.left).toBeGreaterThanOrEqual(300);
    expect(s.mock.left - 300).toBeLessThan(biggest);
  });
  test("until is watched while an operation runs: the move ends within one poll of the condition, not at the chunk's end", async () => {
    const s = setup();
    const t0 = s.clock.now();
    const AT = 137; // inside the second operation (the 20 degree probe ends at 67 ms)
    s.mock.values.set("mock.color.reflected_pct", () => (s.clock.now() - t0 >= AT ? 8 : 50));
    const d = await s.call("drive", {
      distance_cm: 60,
      until: { device: "floor_color", channel: "reflected_pct", op: "lt", value: 20 },
    });
    expect(d.reason).toBe("condition_met");
    expect(d.chunks).toBe(2);
    expect(d.ms).toBeGreaterThanOrEqual(AT);
    expect(d.ms).toBeLessThanOrEqual(AT + UNTIL_POLL_MS);
    const last = pairLog(s.mock).at(-1)!;
    expect(last.reason).toBe("preempted"); // the operation in flight was aborted, which ends its motion
    expect(last.ms).toBeLessThan(100); // it was asked about 200 ms of motion
    expect(s.mock.left).toBeLessThan((300 * (AT + UNTIL_POLL_MS)) / 1000 + 0.01); // 300 deg/s: nothing rolled past the abort
    expect(s.mock.log.at(-1)).toMatchObject({ device: "mock.pair", command: "brake" }); // it was coasting
    expect(s.mock.stops).toBe(0); // the end of a move, not a stop of the robot
    // a single operation is watched the same way
    const m = setup();
    const m0 = m.clock.now();
    m.mock.values.set("mock.gas.ppm", () => (m.clock.now() - m0 >= 33 ? 900 : 400));
    const e = await m.call("command_device", {
      device: "mock.arm",
      command: "run_to_position",
      args: { position_deg: 400, speed_pct: 20 },
      until: { device: "mock.gas", channel: "ppm", op: "gt", value: 500 },
    });
    expect(e.reason).toBe("condition_met");
    expect(e.ms).toBeLessThanOrEqual(33 + UNTIL_POLL_MS);
  });
  test("on a slow link the watch reads as often as one read takes, and the abort still cuts the operation", async () => {
    const s = setup({ latency_ms: 100, limits: { max_command_ms: 20000 } });
    const t0 = s.clock.now();
    const AT = 620;
    s.mock.values.set("mock.color.reflected_pct", () => (s.clock.now() - t0 >= AT ? 8 : 50));
    const d = await s.call("drive", {
      distance_cm: 60,
      speed_pct: 10,
      until: { device: "floor_color", channel: "reflected_pct", op: "lt", value: 20 },
    });
    expect(d.reason).toBe("condition_met");
    // seen by a read that reaches the sensor at most one read later, known one half round trip after that
    expect(d.ms).toBeLessThanOrEqual(AT + 100 + 50 + 100 + 100); // + the abort's way there and the final reading
    const polls = s.mock.reads.filter((r) => r === "mock.color").length;
    expect(polls).toBeLessThanOrEqual(Math.ceil(d.ms / 100) + 1); // back to back, never piled up
    expect(pairLog(s.mock).every((c) => c.args.brake === true)).toBe(true); // 100 ms is too slow to coast
  });
  test("until that is already true moves nothing", async () => {
    const s = setup();
    const d = await s.call("drive", {
      distance_cm: 30,
      until: { device: "floor_color", channel: "color", op: "eq", value: 6 },
    });
    expect(d).toMatchObject({ reason: "condition_met", chunks: 0 });
    expect(s.mock.log.length).toBe(0);
  });
  test("distance and speed are clamped to the profile and reported", async () => {
    const s = setup();
    const d = await s.call("drive", { distance_cm: 500, speed_pct: 100 });
    expect(d).toMatchObject({
      requested: { distance_cm: 500, speed_pct: 100 },
      applied: { distance_cm: 100, speed_pct: 80 },
      clamped: true,
      reason: "clamped",
    });
    expect(d.measured.distance_cm).toBeCloseTo(100, 0);
    expect(new Set(pairLog(s.mock).map((c) => c.args.speed_pct))).toEqual(new Set([80]));
  });
  test("turn: positive is counter-clockwise, measured from encoders or the gyro", async () => {
    const s = setup();
    const d = await s.call("turn", { angle_deg: 90 });
    expect(d.requested.angle_deg).toBe(90);
    expect(d.measured).toMatchObject({ source: "encoders" });
    expect(d.measured.angle_deg).toBeCloseTo(90, 0);
    expect(s.mock.left).toBeLessThan(0);
    expect(s.mock.right).toBeCloseTo((90 * 12) / 5.6, 0);
    const g = setup({ gyro: true });
    const dg = await g.call("turn", { angle_deg: -45 });
    expect(dg.measured.source).toBe("gyro");
    expect(dg.measured.angle_deg).toBeCloseTo(-45, 0);
    const odd = setup({ gyro: true, gyro_sign: -1 }); // the gyro is trusted as reported: providers normalize the sign
    expect((await odd.call("turn", { angle_deg: 90 })).measured.angle_deg).toBeCloseTo(-90, 0);
    const big = await setup({ limits: { max_turn_deg: 180 } }).call("turn", { angle_deg: 720 });
    expect(big).toMatchObject({ clamped: true, reason: "clamped", applied: { angle_deg: 180 } });
  });
  test("arc: radius to the center, angle sign = heading change, direction = which way it travels", async () => {
    const run = async (angle_deg: number, direction?: "forward" | "backward") => {
      const s = setup();
      const d = await s.call("arc", { radius_cm: 20, angle_deg, ...(direction ? { direction } : {}) });
      expect(d.reason).toBe("completed");
      return { d, left: s.mock.left, right: s.mock.right };
    };
    const quarter = (20 * Math.PI) / 2;
    const fl = await run(90); // forward, curving left: both wheels forward, right is the outer one
    expect(fl.d.measured.distance_cm).toBeCloseTo(quarter, 0);
    expect(fl.d.measured.heading_change_deg).toBeCloseTo(90, 0);
    expect(fl.left).toBeGreaterThan(0);
    expect(fl.right).toBeGreaterThan(fl.left);
    expect(fl.left / fl.right).toBeCloseTo(14 / 26, 1);
    const fr = await run(-90, "forward"); // forward, curving right: left is the outer one
    expect(fr.d.measured.distance_cm).toBeCloseTo(quarter, 0);
    expect(fr.d.measured.heading_change_deg).toBeCloseTo(-90, 0);
    expect(fr.right).toBeGreaterThan(0);
    expect(fr.left).toBeGreaterThan(fr.right);
    const bl = await run(90, "backward"); // backward, heading still turns left: both wheels backward, left travels farther
    expect(bl.d.measured.distance_cm).toBeCloseTo(-quarter, 0);
    expect(bl.d.measured.heading_change_deg).toBeCloseTo(90, 0);
    expect(bl.right).toBeLessThan(0);
    expect(bl.left).toBeLessThan(bl.right);
    const br = await run(-90, "backward"); // backward, heading turns right
    expect(br.d.measured.distance_cm).toBeCloseTo(-quarter, 0);
    expect(br.d.measured.heading_change_deg).toBeCloseTo(-90, 0);
    expect(br.left).toBeLessThan(0);
    expect(br.right).toBeLessThan(br.left);
    expect(br.d.requested).toMatchObject({ radius_cm: 20, angle_deg: -90, direction: "backward" });
  });
  test("arc: radius must be positive; a long arc is capped at max_drive_cm", async () => {
    expect((await fails(setup().call("arc", { radius_cm: -20, angle_deg: 90 }), "invalid_argument")).message).toContain(
      "args.radius_cm must be > 0",
    );
    await fails(setup().call("arc", { radius_cm: 20, angle_deg: 90, direction: "sideways" }), "invalid_argument");
    const long = await setup().call("arc", { radius_cm: 200, angle_deg: 90 }); // 314 cm of path
    expect(long.clamped).toBe(true);
    expect(long.measured.distance_cm).toBeCloseTo(100, 0);
  });
  test("the runtime is the only chunker: intermediate chunks coast, the last one brakes", async () => {
    const s = setup();
    await s.call("drive", { distance_cm: 30 });
    const brakes = pairLog(s.mock).map((c) => c.args.brake);
    expect(brakes.length).toBeGreaterThan(3);
    expect(brakes.slice(0, -1).every((b) => b === false)).toBe(true);
    expect(brakes.at(-1)).toBe(true);
    expect(s.mock.brakes).toEqual([]);
    expect(s.mock.stops).toBe(0);
    for (const c of pairLog(s.mock)) expect(c.ms).toBeLessThanOrEqual(MAX_CHUNK_MS);
    // an early end after a coasting chunk brakes the pair with its own brake{}, never provider.stop()
    const u = setup();
    u.mock.values.set("mock.color.reflected_pct", () => (u.mock.left >= 300 ? 8 : 50));
    await u.call("drive", {
      distance_cm: 60,
      until: { device: "floor_color", channel: "reflected_pct", op: "lt", value: 20 },
    });
    expect(pairLog(u.mock).at(-1)!.args.brake).toBe(false);
    expect(u.mock.brakes).toEqual(["mock.pair"]);
    expect(u.mock.log.at(-1)).toMatchObject({ device: "mock.pair", command: "brake" });
    expect(u.mock.stops).toBe(0);
    // a single motor ends the same way, with its own brake{}
    const m = setup();
    m.mock.values.set("mock.gas.ppm", () => (m.mock.arm >= 100 ? 900 : 400));
    await m.call("command_device", {
      device: "mock.arm",
      command: "run_degrees",
      args: { degrees: 600, speed_pct: 20 },
      until: { device: "mock.gas", channel: "ppm", op: "gt", value: 500 },
    });
    expect(m.mock.brakes).toEqual(["mock.arm"]);
    expect(m.mock.stops).toBe(0);
  });
  test("a motor_pair without brake{} is refused at registration", async () => {
    const clock = new FakeClock();
    const rt = createRuntime({
      profile: setup().profile,
      clock,
      providers: [new MockProvider({ clock, pair_brake: false })],
    });
    const e = await rt.ready().then(
      () => undefined,
      (err) => err,
    );
    expect(e).toBeInstanceOf(RuntimeError);
    expect(e.code).toBe("misconfigured");
    expect(e.message).toContain("motor_pair mock.pair has no brake{} command");
    await fails(rt.call("read_all", {}, new AbortController().signal), "misconfigured");
  });
  // Regression tests from the first hardware run: a driver with a ~600 ms round trip per operation,
  // drive {distance_cm: 5, speed_pct: 25} on 5.6 cm wheels (about 102 wheel degrees).
  describe("slow transport (first hardware trace)", () => {
    test("a long declared time bound on a slow link: drive 15 cm is one braking operation, no reversal", async () => {
      const s = setup({ latency_ms: 600, op_ms: 2000, limits: { max_command_ms: 8000 } });
      s.mock.coastDeg = 16; // would roll on if the runtime coasted; it must not on this link
      const d = await s.call("drive", { distance_cm: 15, speed_pct: 25 });
      const ops = pairLog(s.mock);
      expect(ops.length).toBe(1);
      expect(Number(ops[0]!.args.left_deg)).toBeCloseTo(15 * DEG_PER_CM, 1);
      expect(ops[0]!.args.brake).toBe(true);
      expect(d).toMatchObject({ reason: "completed", chunks: 1 });
      expect(d.problem).toBeUndefined();
      expect(d.measured.distance_cm).toBeCloseTo(15, 0);
      expect(s.mock.brakes).toEqual([]);
      expect(d.ms).toBeLessThan(600 * 3 + 1300 + 50); // one read, one operation (1228 ms of motion), one read
    });
    test("a slow link never coasts: every operation brakes and asks for all that is left", async () => {
      const s = setup({ latency_ms: 600, limits: { max_command_ms: 20000 } }); // the device cuts each operation at 250 ms
      const d = await s.call("drive", { distance_cm: 15, speed_pct: 25 });
      const ops = pairLog(s.mock);
      expect(ops.length).toBeGreaterThan(2);
      expect(ops.every((c) => c.args.brake === true)).toBe(true);
      expect(d.reason).toBe("completed");
      expect(d.measured.distance_cm).toBeCloseTo(15, 0);
      expect(s.mock.brakes).toEqual([]);
    });
    test("with `until`, chunks are short even under a long declared bound", async () => {
      const s = setup({ op_ms: 2000 });
      s.mock.values.set("mock.color.reflected_pct", () => (s.mock.left >= 150 ? 8 : 50));
      const until = { device: "floor_color", channel: "reflected_pct", op: "lt", value: 20 };
      const d = await s.call("drive", { distance_cm: 30, speed_pct: 25, until });
      expect(d.reason).toBe("condition_met");
      for (const c of pairLog(s.mock)) expect(c.ms).toBeLessThanOrEqual(MAX_CHUNK_MS);
      expect(s.mock.left).toBeLessThan(150 + 60);
      const free = setup({ op_ms: 2000 }); // same robot without until: operations grow toward the declared bound
      const e = await free.call("drive", { distance_cm: 30, speed_pct: 25 });
      expect(e.reason).toBe("completed");
      expect(Math.max(...pairLog(free.mock).map((c) => c.ms))).toBeGreaterThan(1000);
    });
    // Review finding: under `until` only the degree target was small. At speed_pct 1 the 20 degree probe is
    // 2000 ms of motion, and a device with a long declared bound runs all of it before the condition is read.
    test("with `until`, every operation has a time deadline: a slow probe is cut, not run to its degrees", async () => {
      const s = setup({ op_ms: 3000 });
      const t0 = s.clock.now();
      s.mock.values.set("mock.color.reflected_pct", () => (s.clock.now() - t0 >= 100 ? 8 : 50));
      const until = { device: "floor_color", channel: "reflected_pct", op: "lt", value: 20 };
      const d = await s.call("drive", { distance_cm: 30, speed_pct: 1, until });
      expect(d.reason).toBe("condition_met");
      expect(d.chunks).toBe(1); // true at 100 ms: the move ends with the chunk that was running
      expect(pairLog(s.mock)[0]!.ms).toBeLessThanOrEqual(MAX_CHUNK_MS);
      expect(d.ms).toBeLessThanOrEqual(MAX_CHUNK_MS + 10);
      expect(s.mock.left).toBeLessThanOrEqual(2.5); // 10 deg/s for one chunk, not the 20 degrees asked
      expect(s.mock.stops).toBe(0); // a chunk end, not a stop of the robot
    });
    test("with `until`, deadline cuts are chunk ends: a slow move goes on in short operations to its target", async () => {
      const s = setup({ op_ms: 3000, limits: { max_command_ms: 60000 } });
      const until = { device: "floor_color", channel: "reflected_pct", op: "lt", value: 20 }; // never true
      s.mock.values.set("mock.color.reflected_pct", 50);
      const d = await s.call("drive", { distance_cm: 1, speed_pct: 1, until }); // 20.5 degrees at 10 deg/s
      expect(d.reason).toBe("completed");
      expect(d.measured.distance_cm).toBeCloseTo(1, 1);
      expect(pairLog(s.mock).length).toBeGreaterThan(5);
      for (const c of pairLog(s.mock)) expect(c.ms).toBeLessThanOrEqual(MAX_CHUNK_MS);
      // a motor that gains less than the stall tolerance per cut operation is slow, not stalled
      const crawl = setup({ op_ms: 3000, deg_s_per_pct: 1, limits: { max_command_ms: 60000 } });
      crawl.mock.values.set("mock.color.reflected_pct", 50);
      const c = await crawl.call("drive", { distance_cm: 0.2, speed_pct: 1, until }); // 4 degrees at 1 deg/s
      expect(c.reason).toBe("completed");
      expect(crawl.mock.left).toBeCloseTo(0.2 * DEG_PER_CM, 0);
      // on a slow link the abort arrives as late as the request did: each operation still moves for one chunk
      const slow = setup({ op_ms: 3000, latency_ms: 600, limits: { max_command_ms: 60000 } });
      slow.mock.values.set("mock.color.reflected_pct", () => (slow.mock.left >= 10 ? 8 : 50));
      const e = await slow.call("drive", { distance_cm: 30, speed_pct: 1, until });
      expect(e.reason).toBe("condition_met");
      expect(slow.mock.left).toBeLessThan(10 + 3);
      expect(pairLog(slow.mock).length).toBeGreaterThanOrEqual(4); // 2.5 degrees of motion each, never the 5.5 of a late cut
      for (const c of pairLog(slow.mock)) expect(c.ms).toBeLessThanOrEqual(600 + MAX_CHUNK_MS);
    });
    test("a remote organ is never cut by abort (it would not reach it): its own declared bound applies", async () => {
      const s = setup({ op_ms: 3000, backend: "organ" });
      s.mock.values.set("mock.color.reflected_pct", 50);
      const until = { device: "floor_color", channel: "reflected_pct", op: "lt", value: 20 };
      const d = await s.call("drive", { distance_cm: 1, speed_pct: 1, until });
      expect(d.reason).toBe("completed");
      expect(pairLog(s.mock).every((c) => c.reason !== "preempted")).toBe(true);
      expect(pairLog(s.mock)[0]!.ms).toBe(2000); // the 20 degree probe ran whole
    });
    test("no provider call is made only to measure: readings travel with the operations", async () => {
      const s = setup({ latency_ms: 600, gyro: true, limits: { max_command_ms: 20000 } });
      await s.call("drive", { distance_cm: 2, speed_pct: 25 }); // the first move of a session times the link
      s.mock.log.length = 0;
      s.mock.reads.length = 0;
      const d = await s.call("drive", { distance_cm: 15, speed_pct: 25 });
      const ops = pairLog(s.mock);
      expect(d.reason).toBe("completed");
      expect(d.measured.distance_cm).toBeCloseTo(15, 0);
      expect(d.measured.source).toBe("gyro");
      // one reading of the wheels per operation, one of the gyro before, and one of each at the end
      expect(s.mock.reads.filter((r) => r === "mock.pair").length).toBe(ops.length + 1);
      expect(s.mock.reads.filter((r) => r === "mock.gyro").length).toBe(2);
      // and none of them is waited for by itself except the last: one round trip per operation plus one
      const motion = ops.reduce((a, c) => a + c.ms - 600, 0);
      expect(d.ms).toBeLessThanOrEqual((ops.length + 1) * 600 + motion + 5);
      expect(s.mock.reads[0]).toBe("mock.pair"); // made before the first operation was sent, not after
    });
    test("a link that got slower since the last move is found out before anything coasts", async () => {
      const s = setup({ limits: { max_command_ms: 20000 } });
      await s.call("drive", { distance_cm: 10, speed_pct: 25 });
      expect(pairLog(s.mock).some((c) => c.args.brake === false)).toBe(true); // fast link: chunks coast
      s.mock.log.length = 0;
      s.mock.latency = 600;
      s.mock.coastDeg = 16; // would roll on if the runtime coasted on what it measured during the last move
      await s.clock.sleep(LINK_FRESH_MS + 1);
      const d = await s.call("drive", { distance_cm: 10, speed_pct: 25 });
      expect(d.reason).toBe("completed");
      expect(pairLog(s.mock).every((c) => c.args.brake === true)).toBe(true);
      expect(s.mock.brakes).toEqual([]);
      expect(d.measured.distance_cm).toBeCloseTo(10, 0);
      // a move sent right behind another trusts what that one just measured: if the link changed in between,
      // one 20 degree probe coasts before the reading that travels with it says so, and no more
      const q = setup({ limits: { max_command_ms: 20000 } });
      await q.call("drive", { distance_cm: 10, speed_pct: 25 });
      q.mock.log.length = 0;
      q.mock.latency = 600;
      const e = await q.call("drive", { distance_cm: 10, speed_pct: 25 });
      const sent = pairLog(q.mock);
      expect(e.reason).toBe("completed");
      expect(sent[0]!.args).toMatchObject({ brake: false, left_deg: 20 });
      expect(sent.slice(1).every((c) => c.args.brake === true)).toBe(true);
      // and back: the readings that travel with the braking operations show the link is fast again
      s.mock.log.length = 0;
      s.mock.latency = 0;
      s.mock.coastDeg = 0;
      await s.call("drive", { distance_cm: 20, speed_pct: 25 });
      const brakes = pairLog(s.mock).map((c) => c.args.brake);
      expect(brakes[0]).toBe(true); // last seen slow: the first operation brakes
      expect(brakes.slice(1, -1).some((b) => b === false)).toBe(true);
    });
    test("what the wheels roll between coasting chunks is expected, so the last chunk does not overshoot", async () => {
      const s = setup();
      s.mock.coastDeg = 8; // every brake:false operation rolls on 8 degrees that its `measured` does not show
      const d = await s.call("drive", { distance_cm: 30, speed_pct: 30 });
      expect(d.reason).toBe("completed");
      expect(Math.abs(s.mock.left - 30 * DEG_PER_CM)).toBeLessThan(2); // within 0.1 cm, not one roll (8 degrees) past
      expect(d.measured.left_deg).toBeCloseTo(s.mock.left, 0); // and the report is a reading, not a sum
    });
    test("a move is not done because the wheels were expected to roll the rest: the reading decides", async () => {
      const s = setup({ latency_ms: 30 }); // fast enough to coast; the mock does not roll on by itself
      const d = await s.call("drive", { distance_cm: 1.4 }); // 28.6 degrees: the 20 degree probe and a rest
      expect(d.reason).toBe("completed");
      expect(s.mock.left).toBeCloseTo(1.4 * DEG_PER_CM, 0);
      expect(d.measured.distance_cm).toBeCloseTo(1.4, 1);
    });
    test("a reading that fails mid-move ends the move with an error and leaves nothing rolling", async () => {
      const s = setup();
      s.mock.values.set("mock.pair.left_deg", () => {
        if (pairLog(s.mock).length >= 2) s.mock.failRead = "mock.pair"; // unplugged from the third reading on
        return s.mock.left;
      });
      const e = await fails(s.call("drive", { distance_cm: 30 }), "internal");
      expect(e.message).toContain("mock.pair unplugged");
      expect(s.mock.log.at(-1)).toMatchObject({ device: "mock.pair", command: "brake" });
    });
    test("an operation is judged by a reading of the wheels, not by its own word", async () => {
      // one long braking operation per move, and a driver whose `measured` repeats the request
      const s = setup({ latency_ms: 600, op_ms: 2000, limits: { max_command_ms: 60000 } });
      s.mock.echo = true;
      s.mock.slip = 0; // the wheels do not turn
      const d = await s.call("drive", { distance_cm: 15, speed_pct: 25 });
      expect(d.reason).toBe("stalled");
      expect(pairLog(s.mock).length).toBe(3); // three operations without progress, not until max_command_ms
      expect(d.measured.distance_cm).toBe(0);
      // a driver that overstates is not a reversal: the wheels only went forward, so the move goes on to its target
      const h = setup();
      h.mock.echo = true;
      h.mock.slip = 0.5;
      const g = await h.call("drive", { distance_cm: 30 });
      expect(g.reason).toBe("completed");
      expect(g.problem).toBeUndefined();
      expect(h.mock.left).toBeCloseTo(30 * DEG_PER_CM, -1);
      const r = setup({ latency_ms: 600, op_ms: 2000, limits: { max_command_ms: 60000 } });
      r.mock.echo = true;
      r.mock.reverseFromOp = 1; // and one that drives the wrong way
      const e = await r.call("drive", { distance_cm: 15, speed_pct: 25 });
      expect(e.reason).toBe("stalled");
      expect(e.problem).toContain("reversed");
      expect(pairLog(r.mock).length).toBe(1);
    });
    test("a remote organ's condition is read before each of its operations: once met, nothing more is sent", async () => {
      const s = setup({ op_ms: 3000, backend: "organ", latency_ms: 40 });
      const t0 = s.clock.now();
      // true from 2050 ms on, while the reply of the first operation (the 20 degree probe, 2000 ms) is on its way
      s.mock.values.set("mock.color.reflected_pct", () => (s.clock.now() - t0 >= 2050 ? 8 : 50));
      const until = { device: "floor_color", channel: "reflected_pct", op: "lt", value: 20 };
      const d = await s.call("drive", { distance_cm: 30, speed_pct: 1, until });
      expect(d.reason).toBe("condition_met");
      expect(pairLog(s.mock).length).toBe(1);
    });
    test("when max_command_ms runs out mid-move the result is timeout and nothing is left rolling", async () => {
      const s = setup({ latency_ms: 600, limits: { max_command_ms: 3000 } });
      const d = await s.call("drive", { distance_cm: 40, speed_pct: 25 });
      expect(d.reason).toBe("timeout");
      expect(d.measured.distance_cm).toBeGreaterThan(0);
      expect(pairLog(s.mock).every((c) => c.args.brake === true)).toBe(true); // slow link: each operation braked itself
      const fast = setup({ limits: { max_command_ms: 1000 } }); // fast link: the last chunk coasted, so brake{} follows
      expect((await fast.call("drive", { distance_cm: 90, speed_pct: 10 })).reason).toBe("timeout");
      expect(fast.mock.log.at(-1)).toMatchObject({ device: "mock.pair", command: "brake" });
      expect(fast.mock.stops).toBe(0);
    });
    test("a chunk that moves the wrong way ends the move at once, naming the reversal", async () => {
      const s = setup({ latency_ms: 600, limits: { max_command_ms: 20000 } });
      s.mock.reverseFromOp = 2; // the driver bug seen on the robot: the second operation ran backwards
      const d = await s.call("drive", { distance_cm: 20, speed_pct: 25 });
      expect(d.reason).toBe("stalled");
      expect(d.problem).toContain("reversed");
      expect(d.problem).toContain("mock.pair");
      expect(d.chunks).toBe(2);
      expect(pairLog(s.mock).length).toBe(2); // nothing more was sent
      expect(d.measured.left_deg).toBeLessThan(62.5); // reported as measured, not summed away
      const p = setup();
      p.mock.reverseFromOp = 2;
      const r = await p.call("run_program", { body: { call: { tool: "drive", args: { distance_cm: 20 } } } });
      expect(r).toMatchObject({ outcome: "failed", steps: [{ ok: false, reason: "stalled" }] });
      expect(p.mock.log.at(-1)).toMatchObject({ command: "brake" }); // fast link: it was coasting, so it is braked
    });
    test("a coasting operation that the condition ends midway is still braked when the move ends there", async () => {
      const s = setup();
      s.mock.coastDeg = 60;
      const d = await s.call("drive", {
        distance_cm: 60,
        until: { device: "mock.pair", channel: "left_deg", op: "gte", value: 150 },
      });
      const ops = pairLog(s.mock);
      expect(ops.at(-1)).toMatchObject({ reason: "preempted", args: { brake: false } });
      expect(d.reason).toBe("condition_met");
      expect(s.mock.log.at(-1)).toMatchObject({ device: "mock.pair", command: "brake" });
      expect(s.mock.brakes).toEqual(["mock.pair"]);
    });
  });
  test("forward_sign -1: forward is negative wheel degrees, and the report stays in robot terms", async () => {
    const s = setup({ forward_sign: -1 });
    const d = await s.call("drive", { distance_cm: 5, speed_pct: 25 });
    for (const c of pairLog(s.mock)) {
      expect(Number(c.args.left_deg)).toBeLessThan(0);
      expect(Number(c.args.right_deg)).toBeLessThan(0);
    }
    expect(s.mock.left).toBeCloseTo(-5 * DEG_PER_CM, 0);
    expect(d.reason).toBe("completed");
    expect(d.measured.distance_cm).toBeCloseTo(5, 0); // positive: the robot went forward
    expect(d.measured.left_deg).toBeLessThan(0); // raw encoder change, as the motors report it
    const back = await s.call("drive", { distance_cm: -5 });
    expect(Number(pairLog(s.mock).at(-1)!.args.left_deg)).toBeGreaterThan(0);
    expect(back.measured.distance_cm).toBeCloseTo(-5, 0);
    // a reversal between chunks is caught on this robot too (commanded negative, wheels went positive)
    const r = setup({ forward_sign: -1 });
    r.mock.reverseFromOp = 2;
    const bad = await r.call("drive", { distance_cm: 20, speed_pct: 25 });
    expect(bad).toMatchObject({ reason: "stalled", chunks: 2 });
    expect(bad.problem).toContain("reversed");
    expect(r.mock.log.at(-1)).toMatchObject({ command: "brake" });
  });
  test("measuring during a move never switches a sensor mode", async () => {
    const s = setup({ gyro: true });
    await s.call("drive", {
      distance_cm: 30,
      until: { device: "floor_color", channel: "reflected_pct", op: "lt", value: 1 },
    });
    await s.call("turn", { angle_deg: 90 });
    expect(s.mock.switchReads).toBe(0);
    expect(s.mock.modeSwitches).toBe(0);
  });
  test("no drivetrain → unsupported", async () => {
    const s = setup({ drivetrain: false });
    for (const [tool, args] of [
      ["drive", { distance_cm: 5 }],
      ["turn", { angle_deg: 5 }],
      ["arc", { radius_cm: 5, angle_deg: 5 }],
    ] as const) {
      expect((await fails(s.call(tool, args), "unsupported")).message).toContain("no drivetrain");
    }
    expect(s.mock.log.length).toBe(0);
  });
  test("a stalled motor ends the move with reason stalled", async () => {
    const s = setup();
    s.mock.stalled = true;
    expect((await s.call("drive", { distance_cm: 10 })).reason).toBe("stalled");
  });
  test("max_command_ms ends a move with reason timeout", async () => {
    const s = setup({ limits: { max_command_ms: 1000 } });
    const d = await s.call("drive", { distance_cm: 90, speed_pct: 10 });
    expect(d.reason).toBe("timeout");
    expect(d.ms).toBeLessThanOrEqual(1000 + MAX_CHUNK_MS);
  });
  test("abort → preempted, with what was really driven", async () => {
    const s = setup();
    const ctl = new AbortController();
    const p = s.call("drive", { distance_cm: 80 }, ctl.signal);
    await s.clock.sleep(700);
    ctl.abort();
    const d = await p;
    expect(d.reason).toBe("preempted");
    expect(d.measured.distance_cm).toBeGreaterThan(1);
    expect(d.measured.distance_cm).toBeLessThan(80);
    const n = s.mock.log.length;
    await s.clock.sleep(1000);
    expect(s.mock.log.length).toBe(n);
  });
});

describe("command_device", () => {
  test("happy path on a non-moving device, by role", async () => {
    const s = setup();
    const d = await s.call("command_device", {
      device: "horn",
      command: "tone",
      args: { frequency_hz: 440, duration_ms: 200 },
      request_id: "x",
    });
    expect(d).toMatchObject({
      requested: { frequency_hz: 440, duration_ms: 200 },
      clamped: false,
      reason: "completed",
    });
    expect(s.mock.log[0]).toMatchObject({ device: "mock.speaker", command: "tone" });
    expect((await s.call("command_device", { device: "horn", command: "beep" })).reason).toBe("completed");
  });
  test("a command that does not move may block for its own declared time bound, past max_command_ms", async () => {
    // A speaker saying a text: moves false, bound in ms, answers when the speech ends.
    const clock = new FakeClock();
    const said: { ms: number; reason: string }[] = [];
    const talker: Provider = {
      id: "tts",
      backend: "organ",
      stop_worst_ms: 100,
      devices: async () => [
        {
          id: "tts.speaker",
          provider: "tts",
          kind: "speaker",
          roles: [],
          channels: [],
          description: "A speaker that talks.",
          commands: [
            {
              name: "speak",
              description: "Says the text; returns when the speech ends.",
              moves: false,
              bound: { kind: "ms", max: 15000 },
              params: {
                type: "object",
                properties: { text: { type: "string", maxLength: 200 }, lasts_ms: { type: "number" } },
                required: ["text"],
                additionalProperties: false,
              },
            },
          ],
        },
      ],
      read: async () => [],
      command: async (_device, _command, args, signal) => {
        const t0 = clock.now();
        await clock.sleep(args.lasts_ms as number, signal);
        const reason = signal.aborted ? "preempted" : "completed";
        said.push({ ms: clock.now() - t0, reason });
        return { requested: args, measured: { spoken: !signal.aborted }, clamped: false, reason, ms: clock.now() - t0 };
      },
      stop: async () => ({ motors_stopped: true }),
    };
    const rt = createRuntime({
      profile: { id: "r1", roles: {}, notes: [], limits: { ...LIMITS, max_command_ms: 3000 } },
      providers: [talker],
      clock,
    });
    const speak = async (lasts_ms: number, signal = new AbortController().signal) =>
      (
        await rt.call(
          "command_device",
          { device: "tts.speaker", command: "speak", args: { text: "hola", lasts_ms } },
          signal,
        )
      ).data as { reason: string; measured: { spoken: boolean } };
    // 12 s of speech with max_command_ms 3 s: not cut
    expect(await speak(12000)).toMatchObject({ reason: "completed", measured: { spoken: true } });
    // a device that never answers is still cut, at the declared bound
    expect(await speak(60000)).toMatchObject({ reason: "timeout", measured: { spoken: false } });
    expect(said).toEqual([
      { ms: 12000, reason: "completed" },
      { ms: 15000 + MAX_CHUNK_MS, reason: "preempted" },
    ]);
    // stop aborts it
    const pending = speak(12000);
    await clock.sleep(1000);
    await rt.stop();
    expect(await pending).toMatchObject({ reason: "preempted" });
    expect(said[2]).toEqual({ ms: 1000, reason: "preempted" });
  });
  test("args are clamped to the command bound and the profile limits, and it says so", async () => {
    const s = setup({ limits: { max_command_ms: 3000 } });
    const a = await s.call("command_device", {
      device: "horn",
      command: "tone",
      args: { frequency_hz: 440, duration_ms: 5000 },
    });
    expect(a).toMatchObject({
      requested: { duration_ms: 5000 },
      applied: { duration_ms: 2000 },
      clamped: true,
      reason: "clamped",
    });
    expect(s.mock.log[0]!.args.duration_ms).toBe(2000);
    const b = await s.call("command_device", {
      device: "mock.arm",
      command: "run_degrees",
      args: { degrees: -2000, speed_pct: 100 },
    });
    expect(b).toMatchObject({ applied: { degrees: -720, speed_pct: 80 }, clamped: true });
    expect(b.measured.degrees).toBe(-720);
    const c = await s.call("command_device", {
      device: "mock.arm",
      command: "run_time",
      args: { ms: 9000, speed_pct: 20 },
    });
    expect(c).toMatchObject({ applied: { ms: 3000 }, clamped: true });
  });
  test("every param listed in the bound is clamped, each on its own", async () => {
    const s = setup();
    const d = await s.call("command_device", {
      device: "mock.pair",
      command: "run_pair",
      args: { left_deg: 9000, right_deg: -4000, speed_pct: 100 },
    });
    expect(d).toMatchObject({
      applied: { left_deg: 3600, right_deg: -3600, speed_pct: 80 },
      clamped: true,
      reason: "clamped",
    });
    expect(s.mock.left).toBeCloseTo(3600, 0);
    expect(s.mock.right).toBeCloseTo(-3600, 0);
    expect(pairLog(s.mock).length).toBeGreaterThan(10); // chunked by the runtime, not by the provider
  });
  test("a driver that cuts a target at its time bound gets the rest in further operations", async () => {
    const s = setup();
    const d = await s.call("command_device", {
      device: "mock.arm",
      command: "run_to_position",
      args: { position_deg: 600, speed_pct: 20 },
    });
    expect(d).toMatchObject({ reason: "completed", clamped: false, measured: { degrees: 600 } });
    expect(s.mock.arm).toBeCloseTo(600, 5);
    expect(d.chunks).toBe(12); // 200 deg/s × 250 ms = 50 degrees per operation
    for (const c of s.mock.log) expect(c.ms).toBeLessThanOrEqual(MAX_CHUNK_MS);
    const slow = setup({ limits: { max_command_ms: 1000 } });
    const t = await slow.call("command_device", {
      device: "mock.arm",
      command: "run_to_position",
      args: { position_deg: 600, speed_pct: 20 },
    });
    expect(t.reason).toBe("timeout");
    expect(slow.mock.arm).toBeCloseTo(200, 5);
  });
  test("invalid args name the field and the range; unknown command lists valid ones", async () => {
    const s = setup();
    const e = await fails(
      s.call("command_device", { device: "horn", command: "tone", args: { frequency_hz: 5, duration_ms: 100 } }),
      "invalid_argument",
    );
    expect(e.message).toContain("args.frequency_hz must be >= 100 (minimum), got 5");
    expect(
      (
        await fails(
          s.call("command_device", { device: "horn", command: "tone", args: { frequency_hz: 440 } }),
          "invalid_argument",
        )
      ).message,
    ).toContain("args.duration_ms is required");
    expect(
      (await fails(s.call("command_device", { device: "horn", command: "sing" }), "unknown_command")).message,
    ).toContain("tone, beep");
    expect(
      (await fails(s.call("command_device", { device: "mock.gas", command: "x" }), "unknown_command")).message,
    ).toContain("read-only");
    expect(s.mock.log.length).toBe(0);
  });
  test("until stops a moving command early; it is rejected on commands that do not move", async () => {
    const s = setup();
    const d = await s.call("command_device", {
      device: "mock.arm",
      command: "run_degrees",
      args: { degrees: 600, speed_pct: 20 },
      until: { device: "mock.gas", channel: "ppm", op: "gt", value: 500 },
    });
    expect(d.reason).toBe("completed"); // condition never true: runs to the end
    s.mock.arm = 0;
    const t0 = s.clock.now();
    s.mock.values.set("mock.gas.ppm", () => (s.clock.now() - t0 >= 1000 ? 900 : 400));
    const e = await s.call("command_device", {
      device: "mock.arm",
      command: "run_degrees",
      args: { degrees: 600, speed_pct: 20 },
      until: { device: "mock.gas", channel: "ppm", op: "gt", value: 500 },
    });
    expect(e.reason).toBe("condition_met");
    expect(e.measured.degrees).toBeGreaterThanOrEqual(200);
    expect(e.measured.degrees).toBeLessThan(260);
    expect(e.ms).toBeLessThan(1000 + MAX_CHUNK_MS);
    await fails(
      s.call("command_device", {
        device: "horn",
        command: "beep",
        until: { device: "mock.gas", channel: "ppm", op: "gt", value: 1 },
      }),
      "invalid_argument",
    );
  });
  test("a single motor's link is timed on every call: slow brakes every operation, fast again coasts again", async () => {
    const s = setup({ latency_ms: 600, limits: { max_command_ms: 60000 } });
    const run = { device: "mock.arm", command: "run_degrees", args: { degrees: 300, speed_pct: 20 } };
    const armLog = () => s.mock.log.filter((x) => x.command === "run_degrees");
    expect((await s.call("command_device", run)).reason).toBe("completed");
    expect(armLog().every((c) => c.args.brake === true)).toBe(true);
    s.mock.log.length = 0;
    s.mock.latency = 0;
    expect((await s.call("command_device", run)).reason).toBe("completed");
    expect(armLog().some((c) => c.args.brake === false)).toBe(true);
  });
  test("abort → preempted", async () => {
    const s = setup();
    const ctl = new AbortController();
    const p = s.call(
      "command_device",
      { device: "mock.arm", command: "run_time", args: { ms: 5000, speed_pct: 50 } },
      ctl.signal,
    );
    await s.clock.sleep(1000);
    ctl.abort();
    expect(await p).toMatchObject({ reason: "preempted", ms: 1000 });
  });
});

describe("stop and reset_fault", () => {
  test("stop aborts what is running, stops every provider and reports verification", async () => {
    const s = setup();
    const p = s.call("drive", { distance_cm: 80 });
    await s.clock.sleep(500);
    expect(await s.rt.stop()).toEqual({ motors_stopped: true });
    expect((await p).reason).toBe("preempted");
    expect(s.mock.stops).toBe(1);
    s.mock.stopVerified = false;
    expect(await s.rt.stop()).toEqual({ motors_stopped: false });
  });
  test("a provider whose stop throws means not stopped, never an exception", async () => {
    const s = setup();
    s.mock.stop = async (): Promise<{ motors_stopped: boolean }> => {
      throw new Error("usb gone");
    };
    expect(await s.rt.stop()).toEqual({ motors_stopped: false });
  });
  test("stop is bounded by each provider's stop_worst_ms; a slower stop is not verified", async () => {
    const s = setup();
    expect(s.rt.stop_worst_ms).toBe(150); // slowest provider (100) + runtime overhead
    s.mock.stopDelayMs = 60;
    expect(await s.rt.stop()).toEqual({ motors_stopped: true });
    s.mock.stopDelayMs = 5000;
    const t0 = s.clock.now();
    expect(await s.rt.stop()).toEqual({ motors_stopped: false });
    expect(s.clock.now() - t0).toBe(100);
  });
  test("reset_fault verifies the stop", async () => {
    const s = setup();
    expect(await s.call("reset_fault", { request_id: "r" })).toEqual({ activity: "idle" });
    s.mock.stopVerified = false;
    await fails(s.call("reset_fault", {}), "stop_unverified");
  });
});

describe("programs", () => {
  const drive = (distance_cm: number, extra: object = {}) => ({
    call: { tool: "drive", args: { distance_cm, ...extra } },
  });
  test("runs node by node and returns per-step results", async () => {
    const s = setup();
    const body = {
      seq: [
        drive(5),
        { repeat: { times: 2, body: { call: { tool: "turn", args: { angle_deg: 10 } } } } },
        {
          if: {
            cond: { device: "floor_color", channel: "color", op: "eq", value: 6 },
            then: { call: { tool: "command_device", args: { device: "horn", command: "beep" } } },
            else: { fail: "not white" },
          },
        },
        { wait_ms: 100 },
        {
          call: {
            tool: "wait_until",
            args: { condition: { device: "mock.gas", channel: "ppm", op: "gt", value: 1 }, timeout_ms: 500 },
          },
        },
      ],
    };
    const r = await s.call("run_program", { body });
    expect(r.outcome).toBe("succeeded");
    expect(r.steps.map((x: any) => [x.path, x.tool, x.ok, x.reason])).toEqual([
      ["body.seq[0]", "drive", true, "completed"],
      ["body.seq[1].repeat[0]", "turn", true, "completed"],
      ["body.seq[1].repeat[1]", "turn", true, "completed"],
      ["body.seq[2].if.then", "command_device", true, "completed"],
      ["body.seq[3]", "wait_ms", true, "completed"],
      ["body.seq[4]", "wait_until", true, "condition_met"],
    ]);
    expect(r.steps[3].ms).toBe(0);
    expect(r.steps[4].ms).toBe(100);
    expect(Math.abs(r.ms - r.steps.reduce((a: number, x: any) => a + x.ms, 0))).toBeLessThan(r.steps.length);
  });
  test("while loops until its condition is false or max_iterations", async () => {
    const s = setup();
    const body = {
      while: {
        cond: { device: "mock.pair", channel: "left_deg", op: "lt", value: 150 },
        max_iterations: 20,
        body: drive(2),
      },
    };
    const r = await s.call("run_program", { body });
    expect(r.outcome).toBe("succeeded");
    expect(r.steps.length).toBe(Math.ceil(150 / (2 * DEG_PER_CM)));
    const capped = await setup().call("run_program", {
      body: {
        while: {
          cond: { device: "mock.gas", channel: "ppm", op: "gt", value: 1 },
          max_iterations: 3,
          body: { wait_ms: 10 },
        },
      },
    });
    expect(capped.steps.length).toBe(3);
  });
  test("fail, succeed and the success condition decide the outcome", async () => {
    const s = setup();
    expect(await s.call("run_program", { body: { seq: [{ fail: "nope" }, drive(5)] } })).toMatchObject({
      outcome: "failed",
      reason: "nope",
      steps: [],
    });
    expect(await s.call("run_program", { body: { seq: [{ succeed: "early" }, drive(5)] } })).toMatchObject({
      outcome: "succeeded",
      reason: "early",
      steps: [],
    });
    const success = { device: "mock.gas", channel: "ppm", op: "gt", value: 1000 };
    expect((await s.call("run_program", { body: drive(2), success })).outcome).toBe("failed");
    s.mock.values.set("mock.gas.ppm", 2000);
    expect((await s.call("run_program", { program: { body: drive(2), success } })).outcome).toBe("succeeded");
  });
  test("a failing step ends the program with the step's error", async () => {
    const s = setup();
    s.mock.stalled = true;
    const r = await s.call("run_program", { body: { seq: [drive(5), drive(5)] } });
    expect(r.outcome).toBe("failed");
    expect(r.steps).toMatchObject([{ path: "body.seq[0]", tool: "drive", ok: false, reason: "stalled" }]);
    const t = setup();
    t.mock.command = async () => {
      throw new RuntimeError("timeout", "brick did not answer", true);
    };
    const r2 = await t.call("run_program", { body: drive(5) });
    expect(r2.steps[0]).toMatchObject({ ok: false, error: { code: "timeout", message: "brick did not answer" } });
    expect(r2.outcome).toBe("failed");
  });
  test("caps: nodes, repeat, while, wait_ms, tools; nothing runs when validation fails", async () => {
    const s = setup();
    const bad = async (body: unknown, text: string) =>
      expect((await fails(s.call("run_program", { body }), "invalid_argument")).message).toContain(text);
    await bad({ repeat: { times: 51, body: drive(1) } }, "1..50");
    await bad(
      {
        while: {
          cond: { device: "mock.gas", channel: "ppm", op: "gt", value: 1 },
          max_iterations: 201,
          body: drive(1),
        },
      },
      "1..200",
    );
    await bad({ wait_ms: 10001 }, "0..10000");
    await bad({ seq: Array.from({ length: 500 }, () => ({ wait_ms: 1 })) }, "more than 500 nodes");
    await bad({ call: { tool: "read_all", args: {} } }, "drive, turn, arc, command_device, wait_until");
    await bad({ jump: 1 }, 'unknown node "jump"');
    await bad({ seq: [drive(5), { call: { tool: "drive", args: { distance_cm: "x" } } }] }, "body.seq[1]");
    await bad(undefined, "node must be an object");
    expect(
      (
        await fails(
          s.call("run_program", {
            body: { seq: [drive(5), { call: { tool: "command_device", args: { device: "ghost", command: "x" } } }] },
          }),
          "unknown_device",
        )
      ).message,
    ).toContain("mock.pair");
    await fails(
      s.call("run_program", {
        body: { if: { cond: { device: "ghost", channel: "x", op: "changed" }, then: drive(1) } },
      }),
      "unknown_device",
    );
    expect(s.mock.log.length).toBe(0);
    expect(
      (await s.call("run_program", { body: { seq: Array.from({ length: 499 }, () => ({ wait_ms: 1 })) } })).outcome,
    ).toBe("succeeded");
  });
  test("abort → outcome aborted; max_program_ms → outcome timeout", async () => {
    const s = setup();
    const ctl = new AbortController();
    const p = s.call("run_program", { body: { repeat: { times: 50, body: drive(50) } } }, ctl.signal);
    await s.clock.sleep(1500);
    ctl.abort();
    const r = await p;
    expect(r.outcome).toBe("aborted");
    expect(r.steps.at(-1)).toMatchObject({ ok: false, reason: "preempted" });
    const t = setup({ limits: { max_program_ms: 2000 } });
    const r2 = await t.call("run_program", { body: { repeat: { times: 50, body: { wait_ms: 900 } } } });
    expect(r2).toMatchObject({ outcome: "timeout", ms: 2000 });
    expect(r2.steps.length).toBe(3);
    const viaStop = setup();
    const p3 = viaStop.call("run_program", { body: { repeat: { times: 50, body: drive(50) } } });
    await viaStop.clock.sleep(800);
    await viaStop.rt.stop();
    expect((await p3).outcome).toBe("aborted");
  });
});

describe("errors", () => {
  test("a provider crash surfaces as internal with a trace id, never as data", async () => {
    const s = setup();
    s.mock.failRead = "mock.gas";
    const e = await fails(s.call("read_device", { device: "mock.gas" }), "internal");
    expect(e.message).toMatch(/trace_id [a-z0-9]+/);
  });
  test("limits come from the profile and are handed to provider factories", async () => {
    const clock = new FakeClock();
    let seen: Limits | undefined;
    const rt = createRuntime({
      profile: setup().profile,
      clock,
      providers: [
        (limits) => {
          seen = limits;
          return new MockProvider({ clock });
        },
      ],
    });
    await rt.ready();
    expect(seen).toEqual(LIMITS);
    expect(rt.devices().length).toBe(6);
  });
  test("an organ that cannot list its devices is reported, and the others still work", async () => {
    const s = setup();
    await s.rt.ready();
    const good = new MockProvider({ id: "mcu1", clock: s.clock });
    const broken = new MockProvider({ id: "cam1", clock: s.clock });
    broken.devices = async () => {
      throw new Error("cam1 did not answer");
    };
    const e = await fails(s.rt.setRemoteProviders([good, broken]), "provider_stale");
    expect(e.message).toContain("cam1 (cam1 did not answer)");
    expect((await s.call("describe_robot")).provider_errors).toEqual([
      { provider: "cam1", error: "cam1 did not answer" },
    ]);
    expect((await s.call("read_device", { device: "mcu1.gas" }))[0].value).toBe(412);
    await s.rt.setRemoteProviders([good]);
    expect((await s.call("describe_robot")).provider_errors).toBeUndefined();
  });
  test("a broken setup fails loud", async () => {
    const clock = new FakeClock();
    const base = setup().profile;
    expect(() => createRuntime({ profile: base, providers: [], clock })).toThrow(RuntimeError);
    expect(() =>
      createRuntime({
        profile: { ...base, limits: { ...LIMITS, max_drive_cm: 0 } },
        providers: [new MockProvider({ clock })],
        clock,
      }),
    ).toThrow(/max_drive_cm/);
    const twins: Provider[] = [new MockProvider({ clock, id: "a" }), new MockProvider({ clock, id: "a" })];
    expect(() => createRuntime({ profile: base, providers: twins, clock })).toThrow(/duplicate provider/);
  });
});
