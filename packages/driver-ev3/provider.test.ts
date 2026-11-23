import { describe, expect, test } from "bun:test";
import { RuntimeError } from "../protocol/types";
import type { CommandSpec, DeviceSpec, LoopRead } from "../protocol/types";
import * as E from "./encode";
import { EmulatedClock, FakeEV3 } from "./fake";
import {
  EXAMPLE_EV3_HARDWARE,
  Ev3Provider,
  LED_PATTERNS,
  MAX_MOTION_MS,
  MODE_SWITCH_REQUIRED,
  type Ev3ProviderOptions,
} from "./provider";

const RATE = 1000; // deg/s at 100 %, same in the fake and in the provider's calibration
const LIMITS = {
  max_speed_pct: 100,
  max_command_ms: 20000,
  max_program_ms: 60000,
};
const CONFIG: Ev3ProviderOptions = {
  limits: LIMITS,
  hardware: EXAMPLE_EV3_HARDWARE,
  pair: { left: "B", right: "C" },
};
function rig(opts: { fake?: ConstructorParameters<typeof FakeEV3>[0]; provider?: Partial<Ev3ProviderOptions> } = {}) {
  const fake = new FakeEV3({ degPerSecAt100: RATE, ...opts.fake });
  const ev3 = new Ev3Provider(fake, { ...CONFIG, degPerSecAt100: RATE, pollMs: 2, timeoutMs: 200, ...opts.provider });
  return { fake, ev3 };
}
const never = () => new AbortController().signal;
/** One tick of a stock brick's host loop that only reads. */
const hostTick = (ev3: Ev3Provider, reads: LoopRead[], hold_ms: number) => {
  if (ev3.loop.runs_on !== "host") throw new Error("a stock brick runs its loops on the host");
  return ev3.loop.tick([], reads, hold_ms);
};
const code = (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e) => (e instanceof RuntimeError ? e.code : `not a RuntimeError: ${e}`),
  );
const opcodesSent = (fake: FakeEV3) => fake.sent.flatMap((s) => s.opcodes);
/** What a packet does: its first opcode that is not the tacho read (B3) a start travels behind. */
const act = (s: { opcodes: number[] }) => s.opcodes.find((o) => o !== E.OP.OUTPUT_GET_COUNT) ?? s.opcodes[0];
const motionOps = (fake: FakeEV3) =>
  fake.sent.filter((s) => [0xac, 0xad, 0xae, 0xaf, 0xb0, 0xb1, 0xa4, 0xa5, 0xa6].includes(act(s)));
const value = async (ev3: Ev3Provider, device: string, channel: string) => (await ev3.read(device, [channel]))[0].value;
/** Decodes the constants of the opcode a packet acts with (see act), after opcode and layer. */
function params(packet: Uint8Array): number[] {
  const b = E.decodeCommand(packet).bytecodes;
  const out: number[] = [];
  let at = 0;
  while (b[at] === E.OP.OUTPUT_GET_COUNT) at += 4; // B3, layer, index, GV0
  for (at += 2; at < b.length;) {
    if (b[at] === E.OP.OUTPUT_GET_COUNT || b[at] === E.OP.OUTPUT_TEST) break; // the reads behind an early stop
    const r = E.readParam(b, at);
    out.push(r.param.value as number);
    at = r.next;
  }
  return out;
}
function expectSafe(fake: FakeEV3) {
  expect(fake.overlaps).toBe(0);
  expect(fake.unboundedMoves).toBe(0);
  expect(fake.errors).toEqual([]);
  for (const s of fake.sent) {
    expect(s.type).toBe(E.TYPE_DIRECT_REPLY); // never 0x01/0x81 (system, where 0xA0 is firmware update) nor 0x80
    for (const banned of [
      0xaa,
      0xa0,
      E.OP.OUTPUT_START,
      E.OP.OUTPUT_STEP_SPEED,
      E.OP.OUTPUT_STEP_SYNC,
      E.OP.OUTPUT_STEP_POWER,
    ])
      expect(s.opcodes).not.toContain(banned);
  }
  // every motion is bounded by time on the brick, at most 250 ms
  for (const s of motionOps(fake)) {
    expect([E.OP.OUTPUT_TIME_SPEED, E.OP.OUTPUT_TIME_SYNC]).toContain(act(s) as 0xaf);
    const p = params(s.packet);
    const ms = act(s) === E.OP.OUTPUT_TIME_SPEED ? p[2] + p[3] + p[4] : p[3];
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(MAX_MOTION_MS);
  }
}

const mk = (o: unknown) => () => new Ev3Provider(new FakeEV3(), o as Ev3ProviderOptions);

const codeOf = (f: () => unknown) => {
  try {
    f();
    return "constructed";
  } catch (e) {
    return (e as RuntimeError).code;
  }
};

describe("config", () => {
  test("limits and hardware are required; nothing is built in", () => {
    expect(codeOf(mk(undefined))).toBe("misconfigured");
    expect(codeOf(mk({}))).toBe("misconfigured");
    expect(codeOf(mk({ limits: LIMITS }))).toBe("misconfigured");
    expect(codeOf(mk({ hardware: EXAMPLE_EV3_HARDWARE }))).toBe("misconfigured");
    for (const k of ["max_speed_pct", "max_command_ms"] as const) {
      const limits: Record<string, number> = { ...LIMITS };
      delete limits[k];
      expect(mk({ ...CONFIG, limits })).toThrow(new RegExp(k));
      expect(codeOf(mk({ ...CONFIG, limits: { ...LIMITS, [k]: 0 } }))).toBe("misconfigured");
    }
    for (const k of ["low_battery_v", "max_tone_ms", "tone_volume_pct"] as const) {
      const hardware: Record<string, number> = { ...EXAMPLE_EV3_HARDWARE };
      delete hardware[k];
      expect(mk({ ...CONFIG, hardware })).toThrow(new RegExp(k));
    }
    expect(codeOf(mk({ ...CONFIG, limits: { ...LIMITS, max_speed_pct: 101 } }))).toBe("misconfigured");
    expect(codeOf(mk({ ...CONFIG, hardware: { ...EXAMPLE_EV3_HARDWARE, tone_volume_pct: 101 } }))).toBe(
      "misconfigured",
    );
    expect(codeOf(mk({ ...CONFIG, hardware: { ...EXAMPLE_EV3_HARDWARE, max_tone_ms: 40000 } }))).toBe("misconfigured");
    expect(codeOf(mk({ ...CONFIG, pair: { left: "B", right: "B" } }))).toBe("misconfigured");
    expect(codeOf(mk({ ...CONFIG, pair: { left: "B" } as never }))).toBe("misconfigured");
    expect(codeOf(mk({ ...CONFIG, pair: undefined }))).toBe("constructed");
    expect(codeOf(mk(CONFIG))).toBe("constructed");
    expect(EXAMPLE_EV3_HARDWARE).toEqual({ low_battery_v: 6.5, max_tone_ms: 5000, tone_volume_pct: 50 });
  });
  test("stop_worst_ms is the sum of its parts", () => {
    expect(new Ev3Provider(new FakeEV3(), CONFIG).stop_worst_ms).toBe(1000 + 300 + 300 + 10 + 300);
    expect(
      new Ev3Provider(new FakeEV3(), {
        ...CONFIG,
        timeoutMs: 100,
        modeSwitchTimeoutMs: 50,
        stopSettleMs: 200,
        pollMs: 5,
      }).stop_worst_ms,
    ).toBe(100 + 100 + 200 + 5 + 100);
  });
});

async function full() {
  const { fake, ev3 } = rig({
    provider: { roles: { left_wheel: "ev3.B", claw: "ev3.A", eyes: "ev3.S4", drive: "ev3.pair" } },
  });
  fake.motors[0].type = 8;
  fake.setSensor(1, 16, 0);
  fake.setSensor(2, 32, 0);
  fake.setSensor(3, 29, 0);
  fake.setSensor(4, 30, 0);
  return { fake, ev3, specs: await ev3.devices() };
}

describe("devices(): detection and specs per CONTRACT.md 2.3", () => {
  const TABLE: Record<string, { channels: string[]; commands: string[] }> = {
    motor: {
      channels: ["position_deg", "speed_deg_s", "stalled", "power_pct"],
      commands: ["run_degrees", "run_time", "power", "run_to_position", "brake", "reset_position"],
    },
    motor_pair: { channels: ["left_deg", "right_deg"], commands: ["run_pair", "brake"] },
    touch: { channels: ["pressed", "presses"], commands: [] },
    color: { channels: ["reflected_pct", "ambient_pct", "color", "rgb"], commands: [] },
    ultrasonic: { channels: ["distance_cm"], commands: [] },
    gyro: { channels: ["angle_deg", "rate_deg_s"], commands: ["reset"] },
    infrared: { channels: ["proximity_pct", "beacon_heading", "beacon_distance_pct", "remote_buttons"], commands: [] },
    speaker: { channels: [], commands: ["tone", "beep"] },
    display: { channels: [], commands: ["text", "clear"] },
    led: { channels: [], commands: ["set"] },
    buttons: { channels: ["pressed"], commands: [] },
    battery: { channels: ["voltage_v", "low"], commands: [] },
  };
  const PARAMS: Record<string, string[]> = {
    run_degrees: ["degrees", "speed_pct", "brake"],
    run_time: ["ms", "speed_pct", "brake"],
    power: ["power_pct", "ms"],
    run_to_position: ["position_deg", "speed_pct", "brake"],
    brake: [],
    reset_position: [],
    run_pair: ["left_deg", "right_deg", "speed_pct", "brake"],
    reset: [],
    tone: ["frequency_hz", "duration_ms"],
    beep: [],
    text: ["lines"],
    clear: [],
    set: ["pattern"],
  };
  const MOVES = ["run_degrees", "run_time", "power", "run_to_position", "run_pair"];

  test("ids, kinds and roles; detection changes nothing on the brick", async () => {
    const { ev3, specs, fake } = await full();
    expect(ev3.id).toBe("ev3");
    expect(ev3.backend).toBe("ev3-stock");
    expect(specs.map((d) => [d.id, d.kind])).toEqual([
      ["ev3.A", "motor"],
      ["ev3.B", "motor"],
      ["ev3.C", "motor"],
      ["ev3.pair", "motor_pair"],
      ["ev3.S1", "touch"],
      ["ev3.S2", "gyro"],
      ["ev3.S3", "color"],
      ["ev3.S4", "ultrasonic"],
      ["ev3.speaker", "speaker"],
      ["ev3.display", "display"],
      ["ev3.led", "led"],
      ["ev3.buttons", "buttons"],
      ["ev3.battery", "battery"],
    ]);
    const by = Object.fromEntries(specs.map((d) => [d.id, d]));
    expect(by["ev3.B"].roles).toEqual(["left_wheel"]);
    expect(by["ev3.A"].roles).toEqual(["claw"]);
    expect(by["ev3.S4"].roles).toEqual(["eyes"]);
    expect(by["ev3.pair"].roles).toEqual(["drive"]);
    expect(by["ev3.C"].roles).toEqual([]);
    expect(by["ev3.A"].description).toContain("medium");
    for (const d of specs) expect(d.provider).toBe("ev3");
    expect(fake.sent.length).toBe(1);
    expect(fake.sent[0].opcodes.every((o) => o === E.OP.INPUT_DEVICE)).toBe(true);
    expect(fake.modeSwitches).toBe(0);
  });

  test("every kind has exactly the table's channels and commands, fully specified", async () => {
    const { specs } = await full();
    const { fake, ev3 } = rig();
    fake.setSensor(1, 33, 0);
    const all: DeviceSpec[] = [...specs, ...(await ev3.devices()).filter((d) => d.kind === "infrared")];
    expect(new Set(all.map((d) => d.kind))).toEqual(new Set(Object.keys(TABLE)));
    for (const d of all) {
      expect(d.channels.map((c) => c.name)).toEqual(TABLE[d.kind].channels);
      expect(d.commands.map((c) => c.name)).toEqual(TABLE[d.kind].commands);
      expect(d.description.length).toBeGreaterThan(10);
      const sensor = /\.S\d$/.test(d.id);
      for (const c of d.channels) {
        expect(["number", "boolean", "string", "vector", "image"]).toContain(c.type);
        expect(c.description.length).toBeGreaterThan(10);
        expect(c.max_rate_hz).toBeGreaterThan(0);
        if (c.type === "number" && !["position_deg", "left_deg", "right_deg"].includes(c.name))
          expect(c.range).toHaveLength(2);
        // sensor channels share the port's mode group and say whether they are readable now
        expect(c.mode_group ?? null).toBe(sensor ? d.id.slice(4) : null);
        expect(typeof c.active).toBe(sensor ? "boolean" : "undefined");
      }
      for (const c of d.commands as CommandSpec[]) {
        expect(c.params.type).toBe("object");
        expect(c.params.additionalProperties).toBe(false);
        expect(Object.keys(c.params.properties)).toEqual(PARAMS[c.name]);
        for (const p of c.bound.params ?? []) expect(c.params.properties).toHaveProperty(p);
        const pairBrake = d.kind === "motor_pair" && c.name === "brake";
        expect(c.moves).toBe(MOVES.includes(c.name) || pairBrake);
        if (pairBrake) expect(c.bound).toEqual({ kind: "instant", max: 0 });
        else if (c.moves) {
          expect(c.bound.kind).toBe("ms"); // motion is bounded by time, never by degrees
          expect(c.bound.max).toBe(MAX_MOTION_MS);
          // unregulated power brakes at its end; every regulated motion chooses
          if (c.name === "power") expect(c.params.required).toEqual(["power_pct", "ms"]);
          else {
            expect(c.params.properties.brake).toMatchObject({ type: "boolean", default: true });
            expect(c.params.required).toContain("speed_pct");
          }
        }
        // a loop refreshes the timed commands, each refresh bounded on the brick (CONTRACT §2, Loop outputs)
        expect(c.drives).toEqual(
          c.name === "run_time"
            ? { arg: "speed_pct", max_hold_ms: MAX_MOTION_MS }
            : c.name === "power"
              ? { arg: "power_pct", max_hold_ms: MAX_MOTION_MS }
              : undefined,
        );
        expect(c.description.length).toBeGreaterThan(10);
      }
    }
    const ch = (kind: string, name: string) => all.find((d) => d.kind === kind)!.channels.find((c) => c.name === name)!;
    const cmd = (kind: string, name: string) =>
      all.find((d) => d.kind === kind)!.commands.find((c) => c.name === name)!;
    expect(cmd("motor", "run_time").bound).toEqual({ kind: "ms", params: ["ms"], max: 250 });
    expect(cmd("motor", "run_degrees").bound).toEqual({ kind: "ms", max: 250 });
    expect(cmd("motor_pair", "run_pair").bound).toEqual({ kind: "ms", max: 250 });
    expect(cmd("speaker", "tone").bound).toEqual({ kind: "ms", params: ["duration_ms"], max: 5000 });
    expect(ch("ultrasonic", "distance_cm")).toMatchObject({ unit: "cm", type: "number", active: true });
    expect(ch("infrared", "proximity_pct").approx).toContain("0.7 cm");
    expect(ch("color", "rgb")).toMatchObject({ type: "vector", length: 3, active: false, mode_group: "S3" });
    expect(ch("color", "reflected_pct")).toMatchObject({ active: true, mode_group: "S3" });
    expect(ch("gyro", "angle_deg").unit).toBe("deg");
    for (const n of ["angle_deg", "rate_deg_s"]) expect(ch("gyro", n).description).toContain("counter-clockwise");
    expect(ch("motor", "position_deg").description).toContain("Positive =");
    expect(ch("motor_pair", "left_deg").description).toContain("Positive =");
    expect(ch("battery", "voltage_v").unit).toBe("v");
    expect(ch("battery", "low").description).toContain("6.5 V");
    expect(ch("touch", "pressed").type).toBe("boolean");
  });

  test("limits shape the specs: speed maximum and a motion bound never above max_command_ms", async () => {
    const { ev3 } = rig({ provider: { limits: { max_speed_pct: 60, max_command_ms: 120 } } });
    const b = (await ev3.devices()).find((d) => d.id === "ev3.B")!;
    const c = (n: string) => b.commands.find((x) => x.name === n)!;
    expect(c("run_degrees").params.properties.speed_pct).toMatchObject({ minimum: 1, maximum: 60 });
    expect(c("run_time").params.properties.speed_pct).toMatchObject({ minimum: -60, maximum: 60 });
    expect(c("run_time").bound).toEqual({ kind: "ms", params: ["ms"], max: 120 });
  });

  test("`active` follows the sensor's current mode as the brick reports it", async () => {
    const { fake, ev3 } = rig();
    fake.setSensor(3, 29, 0);
    fake.setSensor(3, 29, 4, 2);
    fake.sensors[2]!.mode = 2; // left in color mode by whoever used the brick before
    const s3 = (await ev3.devices()).find((d) => d.id === "ev3.S3")!;
    expect(s3.channels.map((c) => [c.name, c.active])).toEqual([
      ["reflected_pct", false],
      ["ambient_pct", false],
      ["color", true],
      ["rgb", false],
    ]);
  });

  test("only what is plugged in is listed; unsupported types are shown as kind unknown, never skipped", async () => {
    const a = rig();
    expect((await a.ev3.devices()).map((d) => d.id)).toEqual([
      "ev3.B",
      "ev3.C",
      "ev3.pair",
      "ev3.speaker",
      "ev3.display",
      "ev3.led",
      "ev3.buttons",
      "ev3.battery",
    ]);
    a.fake.motors[2].type = 126;
    expect((await a.ev3.devices()).map((d) => d.id)).not.toContain("ev3.pair");
    const b = rig();
    b.fake.setSensor(2, 127, 0); // a port error
    b.fake.setSensor(4, 125, 0); // the brick itself does not know it
    b.fake.motors[3].type = 14; // not a motor this provider drives
    const specs = await b.ev3.devices();
    const unknown = specs.filter((d) => d.kind === "unknown");
    expect(unknown.map((d) => d.id)).toEqual(["ev3.D", "ev3.S2", "ev3.S4"]);
    for (const d of unknown) {
      expect(d.channels).toEqual([]);
      expect(d.commands).toEqual([]);
    }
    expect(unknown[0].description).toContain("type id 14");
    expect(unknown[0].description).toContain("output port D");
    expect(unknown[1].description).toContain("type id 127");
    expect(unknown[1].description).toContain("input port 2");
    expect(unknown[2].description).toContain("type id 125");
    expect(await b.ev3.read("ev3.S2")).toEqual([]);
    expect(await code(b.ev3.read("ev3.S2", ["distance_cm"]))).toBe("unknown_channel");
    expect(await code(b.ev3.command("ev3.D", "run_time", { ms: 10, speed_pct: 10 }, never()))).toBe("unknown_command");
  });

  test("a robot that declares no pair has no pair device: motors on B and C are two motors", async () => {
    // on emulated time: the travel past the target is the provider's, whatever the load on this machine
    const clock = new EmulatedClock();
    const b = rig({ fake: { now: clock.now }, provider: { pair: undefined, now: clock.now, sleep: clock.sleep } });
    const devices = await b.ev3.devices();
    expect(devices.filter((d) => d.kind === "motor").map((d) => d.id)).toEqual(["ev3.B", "ev3.C"]);
    expect(devices.some((d) => d.kind === "motor_pair")).toBe(false);
    expect(await code(b.ev3.read("ev3.pair"))).toBe("unknown_device");
    const args = { left_deg: 60, right_deg: 60, speed_pct: 40 };
    expect(await code(b.ev3.command("ev3.pair", "run_pair", args, never()))).toBe("unknown_device");
    expect(await code(b.ev3.command("ev3.pair", "brake", {}, never()))).toBe("unknown_device");
    expect(motionOps(b.fake)).toEqual([]);
    // each motor moves by itself, and stop() still brakes and verifies every port
    for (const port of ["B", "C"] as const) {
      const r = await b.ev3.command(`ev3.${port}`, "run_degrees", { degrees: 60, speed_pct: 40 }, never());
      expect(r.reason).toBe("completed");
      // in emulated time the overshoot is at most one 2 ms poll of travel at 40 %: 0.8 degrees
      expect(Math.abs(b.fake.tacho(port) - 60)).toBeLessThanOrEqual(1);
    }
    expect(await b.ev3.stop()).toEqual({ motors_stopped: true });
    expectSafe(b.fake);
  });

  test("the pair is configurable", async () => {
    const clock = new EmulatedClock();
    const b = rig({
      fake: { now: clock.now },
      provider: { id: "r7", pair: { left: "A", right: "D" }, now: clock.now, sleep: clock.sleep },
    });
    b.fake.motors[0].type = 7;
    b.fake.motors[3].type = 7;
    const pair = (await b.ev3.devices()).find((d) => d.kind === "motor_pair")!;
    expect(pair.id).toBe("r7.pair");
    expect(pair.description).toContain("left = port A, right = port D");
    await b.ev3.command("r7.pair", "run_pair", { left_deg: 60, right_deg: 60, speed_pct: 40 }, never());
    expect(Math.abs(b.fake.tacho("A") - 60)).toBeLessThanOrEqual(1); // one 2 ms poll of travel, in emulated time
    expect(b.fake.tacho("A")).toBe(b.fake.tacho("D"));
    expect(b.fake.tacho("B")).toBe(0);
  });
});

const need = (r: { value: unknown; error?: string }) => (r.value === null ? r.error : r.value);

describe("read(): no side effects", () => {
  test("motor, pair, battery, buttons", async () => {
    const { fake, ev3 } = rig();
    fake.motors[1].pos = 123;
    fake.motors[2].pos = -45;
    const ts0 = Date.now();
    const m = await ev3.read("ev3.B");
    expect(m.map((r) => [r.device, r.channel, r.value, r.unit])).toEqual([
      ["ev3.B", "position_deg", 123, "deg"],
      ["ev3.B", "speed_deg_s", 0, "deg_s"],
      ["ev3.B", "stalled", false, undefined],
      ["ev3.B", "power_pct", 0, "pct"],
    ]);
    expect(m[0].ts).toBeGreaterThanOrEqual(ts0);
    expect(m[0]).not.toHaveProperty("error");
    expect((await ev3.read("ev3.pair")).map((r) => r.value)).toEqual([123, -45]);
    expect((await ev3.read("ev3.battery")).map((r) => r.value)).toEqual([7.9, false]);
    fake.batteryV = 6.2;
    expect((await ev3.read("ev3.battery")).map((r) => r.value)).toEqual([6.2, true]);
    expect(await value(ev3, "ev3.buttons", "pressed")).toEqual([]);
    fake.buttonsDown.add(2);
    fake.buttonsDown.add(6);
    expect(await value(ev3, "ev3.buttons", "pressed")).toEqual(["enter", "back"]);
    expectSafe(fake);
  });

  test("low battery threshold comes from hardware config", async () => {
    const { fake, ev3 } = rig({ provider: { hardware: { ...EXAMPLE_EV3_HARDWARE, low_battery_v: 7.5 } } });
    fake.batteryV = 7.2;
    expect((await ev3.read("ev3.battery")).map((r) => r.value)).toEqual([7.2, true]);
    fake.batteryV = 7.6;
    expect(await value(ev3, "ev3.battery", "low")).toBe(false);
  });

  test("a default read returns only the active channels and never switches the sensor mode", async () => {
    const { fake, ev3 } = rig();
    fake.setSensor(1, 16, 1);
    fake.setSensor(1, 16, 7, 1);
    fake.setSensor(2, 32, -90);
    fake.setSensor(2, 32, 12.4, 1);
    fake.setSensor(3, 29, 37.4);
    fake.setSensor(3, 29, 8, 1);
    fake.setSensor(3, 29, 5, 2);
    fake.setSensor(3, 29, [120.2, 80, 40], 4);
    fake.setSensor(4, 30, 25.52);
    expect((await ev3.read("ev3.S1")).map(need)).toEqual([true, MODE_SWITCH_REQUIRED]);
    // the EV3 gyro is clockwise-positive; the provider reports counter-clockwise-positive
    expect((await ev3.read("ev3.S2")).map(need)).toEqual([90, MODE_SWITCH_REQUIRED]);
    expect((await ev3.read("ev3.S3")).map(need)).toEqual([
      37,
      MODE_SWITCH_REQUIRED,
      MODE_SWITCH_REQUIRED,
      MODE_SWITCH_REQUIRED,
    ]);
    expect(await ev3.read("ev3.S4")).toEqual([
      { device: "ev3.S4", channel: "distance_cm", value: 25.5, unit: "cm", ts: expect.any(Number) },
    ]);
    // naming an inactive channel is still not enough without allow_mode_switch
    expect((await ev3.read("ev3.S3", ["color"])).map(need)).toEqual([MODE_SWITCH_REQUIRED]);
    expect((await ev3.read("ev3.S2", ["rate_deg_s"])).map(need)).toEqual([MODE_SWITCH_REQUIRED]);
    // allow_mode_switch without naming the channel is not enough either
    expect((await ev3.read("ev3.S3", undefined, { allow_mode_switch: true })).map(need)).toEqual([
      37,
      MODE_SWITCH_REQUIRED,
      MODE_SWITCH_REQUIRED,
      MODE_SWITCH_REQUIRED,
    ]);
    expect(fake.modeSwitches).toBe(0);
    expect(fake.sensors.map((s) => s!.mode)).toEqual([0, 0, 0, 0]);
    // the read keeps type and mode on the wire: READY_SI with type 0 and mode -1
    const last = E.decodeCommand(fake.sent[fake.sent.length - 1].packet).bytecodes;
    expect(Array.from(last.subarray(0, 6))).toEqual([0x99, 0x1d, 0x00, 0x02, 0x00, 0x3f]);
    expectSafe(fake);
  });

  test("gyro zero is 0, never -0", async () => {
    const { fake, ev3 } = rig();
    fake.setSensor(2, 32, 35.6);
    expect(Object.is(await value(ev3, "ev3.S2", "angle_deg"), -36)).toBe(true);
    fake.setSensor(2, 32, 0);
    expect(Object.is(await value(ev3, "ev3.S2", "angle_deg"), 0)).toBe(true);
  });

  test("an explicit channel with allow_mode_switch switches, reads, and updates `active` and the listeners", async () => {
    const { fake, ev3 } = rig();
    fake.setSensor(3, 29, 37);
    fake.setSensor(3, 29, 5, 2);
    fake.setSensor(3, 29, [120.2, 80, 40], 4);
    await ev3.devices();
    let notified = 0;
    const off = ev3.onDevicesChanged(() => {
      notified++;
    });
    expect(await ev3.read("ev3.S3", ["color"], { allow_mode_switch: true })).toEqual([
      { device: "ev3.S3", channel: "color", value: 5, ts: expect.any(Number) },
    ]);
    expect(fake.modeSwitches).toBe(1);
    expect(fake.sensors[2]!.mode).toBe(2);
    expect(notified).toBe(1);
    // the switch went out as READY_SI with the sensor's type and the new mode
    const sw = fake.sent
      .map((s) => E.decodeCommand(s.packet).bytecodes)
      .find((b) => b[0] === 0x99 && b[1] === 0x1d && b[5] === 0x02)!;
    expect(Array.from(sw.subarray(0, 7))).toEqual([0x99, 0x1d, 0x00, 0x02, 29, 0x02, 0x01]);
    // now color is the active one, and reflected needs a switch
    const s3 = (await ev3.devices()).find((d) => d.id === "ev3.S3")!;
    expect(s3.channels.filter((c) => c.active).map((c) => c.name)).toEqual(["color"]);
    const all = await ev3.read("ev3.S3");
    expect(all.map((r) => r.value)).toEqual([null, null, 5, null]);
    expect(all[0].error).toBe(MODE_SWITCH_REQUIRED);
    expect(fake.modeSwitches).toBe(1);
    // several modes in one explicit request: one switch each, in order; the last one stays
    const many = await ev3.read("ev3.S3", ["rgb", "reflected_pct"], { allow_mode_switch: true });
    expect(many.map((r) => r.value)).toEqual([[120, 80, 40], 37]);
    expect(fake.sensors[2]!.mode).toBe(0);
    expect(fake.modeSwitches).toBe(3);
    expect(notified).toBe(2); // one notification per read that switched
    off();
    await ev3.read("ev3.S3", ["color"], { allow_mode_switch: true });
    expect(notified).toBe(2);
  });

  test("a mode changed behind the provider's back is noticed, not misread", async () => {
    const { fake, ev3 } = rig();
    fake.setSensor(3, 29, 37);
    fake.setSensor(3, 29, 5, 2);
    await ev3.devices();
    fake.sensors[2]!.mode = 2; // e.g. switched from the brick's own menu
    let notified = 0;
    ev3.onDevicesChanged(() => {
      notified++;
    });
    const r = await ev3.read("ev3.S3", ["reflected_pct", "color"]);
    expect(r.map((x) => x.value)).toEqual([null, 5]); // 5 is a color id, never reported as reflected_pct
    expect(r[0].error).toBe(MODE_SWITCH_REQUIRED);
    expect(notified).toBe(1);
    expect(fake.modeSwitches).toBe(0);
  });

  test("infrared: proximity by default; beacon and remote on request (null when no beacon)", async () => {
    const { fake, ev3 } = rig();
    fake.setSensor(4, 33, 48);
    fake.setSensor(4, 33, [-7, 33], 1);
    fake.setSensor(4, 33, 3, 2);
    expect((await ev3.read("ev3.S4")).map((r) => r.value)).toEqual([48, null, null, null]);
    expect(
      (await ev3.read("ev3.S4", ["beacon_heading", "beacon_distance_pct"], { allow_mode_switch: true })).map(
        (r) => r.value,
      ),
    ).toEqual([7, 33]); // native -7 = to the left; the contract is counter-clockwise-positive
    expect(fake.modeSwitches).toBe(1);
    const s4 = (await ev3.devices()).find((d) => d.id === "ev3.S4")!;
    expect(s4.channels.filter((c) => c.null_when_absent).map((c) => c.name)).toEqual([
      "beacon_heading",
      "beacon_distance_pct",
    ]);
    fake.setSensor(4, 33, [12, 40], 1);
    expect((await ev3.read("ev3.S4", ["beacon_heading"]))[0].value).toBe(-12);
    fake.setSensor(4, 33, [0, 40], 1);
    expect(Object.is((await ev3.read("ev3.S4", ["beacon_heading"]))[0].value, 0)).toBe(true);
    fake.setSensor(4, 33, [0, -128], 1);
    const r = await ev3.read("ev3.S4", ["beacon_heading", "beacon_distance_pct"]);
    expect(r.map((x) => x.value)).toEqual([null, null]);
    expect(r[0].error).toContain("no beacon");
    expect(r.map((x) => x.absent)).toEqual([true, true]); // the sensor's answer, not a failed read
    fake.unplugSensor(4);
    const dead = await ev3.read("ev3.S4", ["beacon_heading", "beacon_distance_pct"]);
    expect(dead.map((x) => [x.value, x.absent])).toEqual([
      [null, undefined],
      [null, undefined],
    ]);
    fake.setSensor(4, 33, 48);
    fake.setSensor(4, 33, [0, -128], 1);
    fake.setSensor(4, 33, 3, 2);
    await ev3.devices();
    expect((await ev3.read("ev3.S4", ["remote_buttons"], { allow_mode_switch: true }))[0].value).toBe(3);
  });

  test("failures are null with an error, never a default", async () => {
    const { fake, ev3 } = rig();
    fake.setSensor(4, 30, 30);
    await ev3.devices();
    let notified = 0;
    ev3.onDevicesChanged(() => {
      notified++;
    });
    fake.unplugSensor(4);
    let r = await ev3.read("ev3.S4");
    expect(r[0].value).toBeNull();
    expect(r[0].error).toContain("changed");
    expect(notified).toBe(1);
    fake.dropNext(1); // lost reply
    r = await ev3.read("ev3.B");
    expect(r.map((x) => x.value)).toEqual([null, null, null, null]);
    for (const x of r) expect(x.error).toContain("timeout");
    expect((await ev3.read("ev3.B"))[0].value).toBe(0);
  });

  test("unknown device or channel is an error that lists the valid ones; roles resolve", async () => {
    const { ev3 } = rig({ provider: { roles: { left_wheel: "ev3.B" } } });
    expect(await code(ev3.read("ev3.S1"))).toBe("unknown_device");
    expect(await code(ev3.read("ev3.B", ["rpm"]))).toBe("unknown_channel");
    await expect(ev3.read("ev3.Z")).rejects.toThrow(/ev3\.B, ev3\.C, ev3\.pair/);
    await expect(ev3.read("ev3.B", ["rpm"])).rejects.toThrow(/position_deg, speed_deg_s, stalled/);
    expect((await ev3.read("left_wheel", ["position_deg"]))[0].device).toBe("ev3.B");
  });
});

describe("sensors from discovery (G7, G8, G9)", () => {
  test("an NXT light sensor (type 2) is read through its entry", async () => {
    const { fake, ev3 } = rig();
    fake.setSensor(1, E.SENSOR_TYPE.nxt_light, 37);
    fake.setSensor(1, E.SENSOR_TYPE.nxt_light, 12, 1);
    const s1 = (await ev3.devices()).find((d) => d.id === "ev3.S1")!;
    expect(s1.kind).toBe("light");
    expect(s1.channels.map((c) => [c.name, c.unit, c.active])).toEqual([
      ["reflected_pct", "pct", true],
      ["ambient_pct", "pct", false],
    ]);
    expect(fake.sent.length).toBe(1); // a sensor with an entry costs no question beyond the scan
    expect((await ev3.read("ev3.S1")).map((r) => r.value)).toEqual([37, null]);
    expect((await ev3.read("ev3.S1", ["ambient_pct"], { allow_mode_switch: true }))[0].value).toBe(12);
    expect(fake.modeSwitches).toBe(1);
  });

  test("the other NXT sensors have entries: touch, sound, ultrasonic, temperature", async () => {
    const { fake, ev3 } = rig();
    fake.setSensor(1, E.SENSOR_TYPE.nxt_touch, 1);
    fake.setSensor(2, E.SENSOR_TYPE.nxt_sound, 64);
    fake.setSensor(3, E.SENSOR_TYPE.nxt_ultrasonic, 42);
    fake.setSensor(4, E.SENSOR_TYPE.nxt_temperature, 21.5);
    const specs = await ev3.devices();
    expect(specs.filter((d) => /\.S\d$/.test(d.id)).map((d) => [d.id, d.kind])).toEqual([
      ["ev3.S1", "touch"],
      ["ev3.S2", "sound"],
      ["ev3.S3", "ultrasonic"],
      ["ev3.S4", "temperature"],
    ]);
    expect(specs.find((d) => d.id === "ev3.S3")!.description).toContain("NXT");
    const first = async (id: string) => (await ev3.read(id))[0].value;
    expect([await first("ev3.S1"), await first("ev3.S2"), await first("ev3.S3"), await first("ev3.S4")]).toEqual([
      true,
      64,
      42,
      21.5,
    ]);
  });

  test("a type without an entry gets the generic manifest of the modes the firmware reports", async () => {
    const { fake, ev3 } = rig();
    fake.setSensor(2, 99, 7.4); // the energy meter: no entry in this provider
    fake.setSensor(2, 99, [7.4, 0.12, 7.3, 0.1, 40, 0.9, 0.7], 7);
    fake.describeSensor(2, [
      { name: "ES-IN-VOLT", symbol: "V", decimals: 1 },
      { name: "ES-IN-AMP", symbol: "A", decimals: 3 },
      { name: "ES-OUT-VOLT", symbol: "V", decimals: 1 },
      { name: "ES-OUT-AMP", symbol: "A", decimals: 3 },
      { name: "ES-JOULE", symbol: "J" },
      { name: "ES-IN-WATT", symbol: "W", decimals: 3 },
      { name: "ES-OUT-WATT", symbol: "W", decimals: 3 },
      { name: "ES-ALL", symbol: "_", decimals: 3 },
    ]);
    const s2 = (await ev3.devices()).find((d) => d.id === "ev3.S2")!;
    expect(s2.kind).toBe("sensor");
    expect(s2.description).toContain("type id 99");
    expect(s2.channels.map((c) => [c.name, c.type, c.length, c.unit, c.active])).toEqual([
      ["values", "vector", 1, "v", true],
      ["mode", "string", undefined, undefined, true],
    ]);
    expect(s2.commands.map((c) => c.name)).toEqual(["set_mode"]);
    const setMode = s2.commands[0]!;
    expect(setMode).toMatchObject({ moves: false, bound: { kind: "instant", max: 0 } });
    expect((setMode.params.properties.mode as { enum: string[] }).enum).toEqual([
      "ES-IN-VOLT",
      "ES-IN-AMP",
      "ES-OUT-VOLT",
      "ES-OUT-AMP",
      "ES-JOULE",
      "ES-IN-WATT",
      "ES-OUT-WATT",
      "ES-ALL",
    ]);
    const asked = fake.sent.length;
    await ev3.devices();
    expect(fake.sent.length).toBe(asked + 1); // described once per type and mode: the next scan asks nothing more
    expect((await ev3.read("ev3.S2")).map((r) => [r.value, r.unit])).toEqual([
      [[7.4], "v"],
      ["ES-IN-VOLT", undefined],
    ]);
    let told = 0;
    ev3.onDevicesChanged(() => told++);
    const r = await ev3.command("ev3.S2", "set_mode", { mode: "ES-ALL" }, never());
    expect(r).toMatchObject({ reason: "completed", measured: { mode: "ES-ALL" } });
    expect(told).toBe(1);
    expect(fake.sensors[1]!.mode).toBe(7);
    const after = (await ev3.devices()).find((d) => d.id === "ev3.S2")!;
    const values = after.channels.find((c) => c.name === "values")!;
    expect([values.length, values.unit]).toEqual([7, undefined]);
    expect((await ev3.read("ev3.S2")).map((x) => x.value)).toEqual([[7.4, 0.12, 7.3, 0.1, 40, 0.9, 0.7], "ES-ALL"]);
    // one value of a generic vector is a loop input, read in the tick's packet
    expect(await hostTick(ev3, [{ device: "ev3.S2", channel: "values", index: 4 }], 60)).toEqual([40]);
    expect(await code(ev3.command("ev3.S2", "set_mode", { mode: "ES-NOPE" }, never()))).toBe("invalid_argument");
    // a mode switched behind the provider's back: the read carries the new mode's values and unit
    fake.setSensor(2, 99, 0.25, 1);
    fake.sensors[1]!.mode = 1;
    expect((await ev3.read("ev3.S2")).map((x) => [x.value, x.unit])).toEqual([
      [[0.25], "a"],
      ["ES-IN-AMP", undefined],
    ]);
    expect(fake.errors).toEqual([]);
  });

  test("a sensor the firmware will not describe is unknown with the reason; the scan still succeeds", async () => {
    const fake = new FakeEV3({ degPerSecAt100: RATE });
    let refuse = true;
    const transport = {
      send: (bytes: Uint8Array) => {
        const cmd = E.decodeCommand(bytes);
        const describes = cmd.bytecodes.some(
          (b, i) => b === E.OP.INPUT_DEVICE && cmd.bytecodes[i + 1] === E.SUB.INPUT_GET_FORMAT,
        );
        return refuse && describes ? Promise.resolve(E.encodeReply(cmd.counter, false)) : fake.send(bytes);
      },
    };
    const ev3 = new Ev3Provider(transport, { ...CONFIG, degPerSecAt100: RATE, pollMs: 2, timeoutMs: 200 });
    fake.setSensor(3, 4, 30); // NXT color: no entry
    const s3 = (await ev3.devices()).find((d) => d.id === "ev3.S3")!;
    expect(s3.kind).toBe("unknown");
    expect(s3.description).toContain("did not describe it");
    refuse = false;
    const again = (await ev3.devices()).find((d) => d.id === "ev3.S3")!;
    expect(again.kind).toBe("sensor");
    expect(again.channels.find((c) => c.name === "mode")!).toBeDefined();
    expect((await ev3.read("ev3.S3"))[1].value).toBe("MODE-0"); // a mode the firmware gives no name
  });

  test("the infrared remote and beacon are read on the robot file's channel", async () => {
    const { fake, ev3 } = rig({ provider: { hardware: { ...EXAMPLE_EV3_HARDWARE, ir_channel: 3 } } });
    fake.setSensor(4, 33, 48);
    // IR-SEEK: heading and distance of channels 1-4 in turn; channel 1 sees a beacon, channel 3 another
    fake.setSensor(4, 33, [-7, 33, 0, -128, 5, 60, 0, -128], 1);
    fake.setSensor(4, 33, [1, 0, 4, 0], 2); // IR-REMOTE: one button code per channel
    const s4 = (await ev3.devices()).find((d) => d.id === "ev3.S4")!;
    expect(s4.description).toContain("channel 3");
    expect(s4.channels.find((c) => c.name === "remote_buttons")!.description).toContain("channel 3");
    const beacon = await ev3.read("ev3.S4", ["beacon_heading", "beacon_distance_pct"], { allow_mode_switch: true });
    expect(beacon.map((r) => r.value)).toEqual([-5, 60]);
    expect((await ev3.read("ev3.S4", ["remote_buttons"], { allow_mode_switch: true }))[0].value).toBe(4);
    fake.setSensor(4, 33, [-7, 33, 0, -128, 0, -128, 0, -128], 1);
    const none = await ev3.read("ev3.S4", ["beacon_heading"], { allow_mode_switch: true });
    expect([none[0].value, none[0].absent, none[0].error]).toEqual([null, true, "no beacon in view on channel 3"]);
    // a loop reads the same channel
    await ev3.read("ev3.S4", ["remote_buttons"], { allow_mode_switch: true });
    expect(await hostTick(ev3, [{ device: "ev3.S4", channel: "remote_buttons" }], 60)).toEqual([4]);
    for (const bad of [0, 5, 1.5])
      expect(() => rig({ provider: { hardware: { ...EXAMPLE_EV3_HARDWARE, ir_channel: bad as 1 } } })).toThrow(
        "ir_channel must be 1, 2, 3 or 4",
      );
  });
});

describe("command(): one time-bounded operation each", () => {
  test("run_degrees: a single AF, braked early at the encoder target", async () => {
    const { fake, ev3 } = rig();
    const r = await ev3.command("ev3.B", "run_degrees", { degrees: 60, speed_pct: 50 }, never());
    expect(r.reason).toBe("completed");
    expect(r.clamped).toBe(false);
    expect(r.requested).toEqual({ degrees: 60, speed_pct: 50 });
    expect(r.measured.time_limited).toBe(false);
    expect(r.measured.degrees).toBe(fake.tacho("B"));
    expect(r.measured.degrees as number).toBeGreaterThanOrEqual(60);
    expect(r.measured.degrees as number).toBeLessThanOrEqual(80); // a poll or two of overshoot at 500 deg/s, with room for timer jitter
    expect(fake.tacho("C")).toBe(0);
    expect(fake.busy()).toBe(false);
    const ops = motionOps(fake);
    expect(ops.length).toBe(1);
    expect(act(ops[0])).toBe(E.OP.OUTPUT_TIME_SPEED);
    const [mask, speed, t1, t2, t3, brake] = params(ops[0].packet);
    expect([mask, speed, t1, t3, brake]).toEqual([2, 50, 0, 0, 1]);
    expect(t2).toBe(Math.ceil((60 / 500) * 1000 * 1.2) + 30); // estimate with margin, well under the bound
    // the early stop is an A3 on that port
    expect(fake.sent.some((s) => s.opcodes[0] === E.OP.OUTPUT_STOP && params(s.packet)[0] === 2)).toBe(true);
    const back = await ev3.command("ev3.B", "run_degrees", { degrees: -40, speed_pct: 30 }, never());
    expect(back.reason).toBe("completed");
    expect(back.measured.degrees as number).toBeLessThanOrEqual(-40);
    expect(back.measured.degrees as number).toBeGreaterThanOrEqual(-55);
    expectSafe(fake);
  });

  test("a target that needs more than 250 ms is not chunked: one op, stops at the time bound, reason timeout", async () => {
    const { fake, ev3 } = rig();
    const t0 = performance.now();
    const r = await ev3.command("ev3.B", "run_degrees", { degrees: 3600, speed_pct: 50 }, never());
    const took = performance.now() - t0;
    expect(r.reason).toBe("timeout");
    expect(r.measured.time_limited).toBe(true);
    expect(Math.abs((r.measured.degrees as number) - 125)).toBeLessThanOrEqual(2); // 500 deg/s for 250 ms
    expect(took).toBeGreaterThanOrEqual(245);
    expect(took).toBeLessThan(400);
    expect(motionOps(fake).length).toBe(1);
    expect(params(motionOps(fake)[0].packet)[3]).toBe(250);
    expect(fake.busy()).toBe(false);
    expectSafe(fake);
  });

  test("zero degrees completes without sending a motion", async () => {
    const { fake, ev3 } = rig();
    const r = await ev3.command("ev3.B", "run_degrees", { degrees: 0, speed_pct: 50 }, never());
    expect(r).toMatchObject({ reason: "completed", measured: { degrees: 0, time_limited: false } });
    expect(motionOps(fake)).toEqual([]);
  });

  test("run_to_position aims at the absolute encoder position", async () => {
    const { fake, ev3 } = rig();
    fake.motors[1].pos = 300;
    const r = await ev3.command("ev3.B", "run_to_position", { position_deg: 250, speed_pct: 40 }, never());
    expect(r.reason).toBe("completed");
    expect(r.measured.position_deg).toBe(fake.tacho("B"));
    expect(r.measured.position_deg as number).toBeLessThanOrEqual(250);
    expect(r.measured.position_deg as number).toBeGreaterThanOrEqual(235);
    expect(r.measured.degrees).toBe((r.measured.position_deg as number) - 300);
    expect(motionOps(fake).length).toBe(1);
    expectSafe(fake);
  });

  test("run_time: one AF for exactly the asked time, signed speed; over 250 ms is cut and reported", async () => {
    const { fake, ev3 } = rig();
    const t0 = performance.now();
    const r = await ev3.command("ev3.C", "run_time", { ms: 120, speed_pct: -50 }, never());
    const took = performance.now() - t0;
    expect(r.reason).toBe("completed");
    expect(r.clamped).toBe(false);
    expect(took).toBeGreaterThanOrEqual(115);
    expect(took).toBeLessThan(320);
    expect(Math.abs((r.measured.degrees as number) + 60)).toBeLessThanOrEqual(2);
    expect(params(motionOps(fake)[0].packet)).toEqual([4, -50, 0, 120, 0, 1]);
    const long = await ev3.command("ev3.C", "run_time", { ms: 5000, speed_pct: 20 }, never());
    expect(long).toMatchObject({ clamped: true, reason: "clamped", measured: { applied_ms: 250 } });
    expect(Math.abs((long.measured.degrees as number) - 50)).toBeLessThanOrEqual(2);
    expect(motionOps(fake).length).toBe(2);
    expect(params(motionOps(fake)[1].packet)[3]).toBe(250);
    expect(await code(ev3.command("ev3.C", "run_time", { ms: 100, speed_pct: 0 }, never()))).toBe("invalid_argument");
    expectSafe(fake);
  });

  test("brake:false coasts: the brake flag is 0 in the operation and in the early stop", async () => {
    const { fake, ev3 } = rig();
    await ev3.command("ev3.B", "run_degrees", { degrees: 50, speed_pct: 50, brake: false }, never());
    expect(params(motionOps(fake)[0].packet)[5]).toBe(0);
    const early = fake.sent.filter((s) => s.opcodes[0] === E.OP.OUTPUT_STOP);
    expect(early.length).toBe(1);
    expect(params(early[0].packet)).toEqual([2, 0]);
    expect(fake.motors[1].holdBrake).toBe(false);
    await ev3.command("ev3.B", "run_time", { ms: 30, speed_pct: 50, brake: false }, never());
    expect(params(motionOps(fake)[1].packet)[5]).toBe(0);
    await ev3.command("ev3.pair", "run_pair", { left_deg: 40, right_deg: 40, speed_pct: 50, brake: false }, never());
    expect(params(motionOps(fake)[2].packet)[4]).toBe(0);
    await ev3.command("ev3.pair", "run_pair", { left_deg: 40, right_deg: 40, speed_pct: 50 }, never());
    expect(params(motionOps(fake)[3].packet)[4]).toBe(1);
    expect(fake.motors[1].holdBrake).toBe(true);
    expect(await code(ev3.command("ev3.B", "run_degrees", { degrees: 5, speed_pct: 5, brake: "no" }, never()))).toBe(
      "invalid_argument",
    );
    expectSafe(fake);
  });

  test("speed above limits.max_speed_pct is cut and reported", async () => {
    const { fake, ev3 } = rig({ provider: { limits: { max_speed_pct: 40, max_command_ms: 20000 } } });
    const r = await ev3.command("ev3.B", "run_degrees", { degrees: 30, speed_pct: 90 }, never());
    expect(r).toMatchObject({ clamped: true, reason: "clamped", measured: { applied_speed_pct: 40 } });
    expect(params(motionOps(fake)[0].packet)[1]).toBe(40);
    const t = await ev3.command("ev3.B", "run_time", { ms: 20, speed_pct: -90 }, never());
    expect(t).toMatchObject({ clamped: true, reason: "clamped", measured: { applied_speed_pct: -40 } });
  });

  test("brake command and reset_position", async () => {
    const { fake, ev3 } = rig();
    const running = ev3.command("ev3.B", "run_time", { ms: 250, speed_pct: 50 }, never());
    await new Promise((r) => setTimeout(r, 60));
    expect(await code(ev3.command("ev3.B", "reset_position", {}, never()))).toBe("busy");
    const b = await ev3.command("ev3.B", "brake", {}, never());
    expect(b.reason).toBe("completed");
    const r = await running;
    expect(r.reason).toBe("preempted");
    expect(fake.busy()).toBe(false);
    expect(r.measured.degrees as number).toBeGreaterThan(15);
    expect(r.measured.degrees as number).toBeLessThan(120);
    await ev3.command("ev3.B", "reset_position", {}, never());
    expect(fake.tacho("B")).toBe(0);
    expectSafe(fake);
  });
});

describe("a blocked motor ends at the time bound", () => {
  test("FakeEV3: a stalled motor's busy flag clears at the time bound without any host command", async () => {
    let t = 0;
    const fake = new FakeEV3({ now: () => t, degPerSecAt100: RATE });
    fake.stall("B");
    await fake.send(E.frame(E.outputTimeSpeed(2, 50, 0, 250, 0, true), { counter: 1 }));
    t = 249;
    expect(fake.busy(2)).toBe(true);
    t = 250;
    expect(fake.busy(2)).toBe(false);
    expect(fake.tacho("B")).toBe(0);
    // the same holds for a synced pair with one wheel blocked
    await fake.send(E.frame(E.outputTimeSync(6, 50, 0, 200, true), { counter: 2 }));
    t = 449;
    expect(fake.busy(6)).toBe(true);
    t = 450;
    expect(fake.busy(6)).toBe(false);
    expect([fake.tacho("B"), fake.tacho("C")]).toEqual([0, 100]);
    // which is exactly what a degree opcode would not do
    await fake.send(E.frame(E.outputStepSpeed(2, 50, 0, 90, 0, true), { counter: 3 }));
    t = 60000;
    expect(fake.busy(2)).toBe(true);
  });

  test("provider: run_degrees on a blocked motor returns stalled at the bound, with no brake needed to free it", async () => {
    const { fake, ev3 } = rig();
    fake.stall("B");
    const t0 = performance.now();
    const r = await ev3.command("ev3.B", "run_degrees", { degrees: 720, speed_pct: 50 }, never());
    const took = performance.now() - t0;
    expect(r.reason).toBe("stalled");
    expect(r.measured.degrees).toBe(0);
    expect(took).toBeGreaterThanOrEqual(245);
    expect(took).toBeLessThan(400);
    expect(fake.busy()).toBe(false);
    expect(opcodesSent(fake)).not.toContain(E.OP.OUTPUT_STOP); // the brick ended it on its own clock
    expect(await value(ev3, "ev3.B", "stalled")).toBe(true);
    fake.stall("B", false);
    expect((await ev3.command("ev3.B", "run_degrees", { degrees: 40, speed_pct: 50 }, never())).reason).toBe(
      "completed",
    );
    expect(await value(ev3, "ev3.B", "stalled")).toBe(false);
    expectSafe(fake);
  });

  test("provider: run_pair with both wheels blocked returns stalled at the bound", async () => {
    const { fake, ev3 } = rig();
    fake.stall("B");
    fake.stall("C");
    const t0 = performance.now();
    const r = await ev3.command("ev3.pair", "run_pair", { left_deg: 500, right_deg: 500, speed_pct: 40 }, never());
    expect(r.reason).toBe("stalled");
    expect(r.measured).toMatchObject({ left_deg: 0, right_deg: 0 });
    expect(performance.now() - t0).toBeLessThan(400);
    expect(fake.busy()).toBe(false);
    expect((await ev3.command("ev3.B", "run_time", { ms: 200, speed_pct: 50 }, never())).reason).toBe("stalled");
    // a window under 100 ms is too short to call a stall: a real motor may not have left rest yet
    expect((await ev3.command("ev3.B", "run_time", { ms: 60, speed_pct: 50 }, never())).reason).toBe("completed");
    const short = await ev3.command("ev3.B", "run_degrees", { degrees: 10, speed_pct: 50 }, never());
    expect(short).toMatchObject({ reason: "timeout", measured: { degrees: 0, time_limited: true } });
    expectSafe(fake);
  });
});

async function runPair(left_deg: number, right_deg: number, speed_pct = 40) {
  const { fake, ev3 } = rig();
  const r = await ev3.command("ev3.pair", "run_pair", { left_deg, right_deg, speed_pct }, never());
  expectSafe(fake);
  expect(motionOps(fake).length).toBe(left_deg === 0 && right_deg === 0 ? 0 : 1);
  return { r, fake, got: [fake.tacho("B"), fake.tacho("C")] };
}

const lead = (want: number[]) => (Math.abs(want[0]) >= Math.abs(want[1]) ? 0 : 1);

// overshoot is one poll of travel; the tolerance leaves room for timer jitter on a loaded machine
const near = (got: number[], want: number[], tol = 15) =>
  got.every((g, i) =>
    want[i] === 0
      ? g === 0
      : Math.sign(g) === Math.sign(want[i]) &&
        Math.abs(g) >= Math.abs(want[i]) * (i === lead(want) ? 1 : 0.8) - 1 &&
        Math.abs(g - want[i]) <= tol,
  );

describe("command(): motor_pair.run_pair", () => {
  test("straight, backwards, spin both ways, pivot, arc: each wheel goes its own way, in one B1", async () => {
    for (const want of [
      [80, 80],
      [-60, -60],
      [-70, 70],
      [70, -70],
      [0, 60],
      [60, 0],
      [0, -60],
      [40, 80],
      [-80, -20],
      [60, -20],
    ]) {
      const { got } = await runPair(want[0], want[1]);
      expect([want, got, near(got, want)]).toEqual([want, got, true]);
    }
  });
  test("the single operation is a synced B1 with the turn ratio; measured comes from the encoders", async () => {
    const { r, fake } = await runPair(80, 40, 50);
    expect(r.reason).toBe("completed");
    expect(r.clamped).toBe(false);
    expect(r.requested).toEqual({ left_deg: 80, right_deg: 40, speed_pct: 50 });
    expect(r.measured).toEqual({ left_deg: fake.tacho("B"), right_deg: fake.tacho("C"), time_limited: false });
    const op = motionOps(fake)[0];
    expect(act(op)).toBe(E.OP.OUTPUT_TIME_SYNC);
    const [mask, speed, turn, ms, brake] = params(op.packet);
    expect([mask, speed, turn, brake]).toEqual([6, 50, 50, 1]);
    expect(ms).toBe(Math.ceil((80 / 500) * 1000 * 1.2) + 30);
    // the early stop brakes both
    expect(fake.sent.some((s) => s.opcodes[0] === E.OP.OUTPUT_STOP && params(s.packet)[0] === 6)).toBe(true);
  });
  test("spin left is turn -200 with the right motor as master", async () => {
    const { fake } = await runPair(-70, 70, 30);
    expect(params(motionOps(fake)[0].packet).slice(0, 3)).toEqual([6, -30, 200]);
    const b = await runPair(70, -70, 30);
    expect(params(motionOps(b.fake)[0].packet).slice(0, 3)).toEqual([6, 30, 200]);
  });
  test("a long pair target stops at 250 ms with reason timeout", async () => {
    const { r, fake } = await runPair(5000, 5000, 40);
    // 400 deg/s for 250 ms
    expect(r.reason).toBe("timeout");
    expect(r.measured.time_limited).toBe(true);
    expect(Math.abs((r.measured.left_deg as number) - 100)).toBeLessThanOrEqual(2);
    expect(params(motionOps(fake)[0].packet)[3]).toBe(250);
  });
  test("zero for both wheels completes without moving", async () => {
    const { r } = await runPair(0, 0);
    expect(r.reason).toBe("completed");
  });
  test("a motor of the pair cannot be commanded while the pair runs; other ports are free", async () => {
    const { fake, ev3 } = rig();
    fake.motors[0].type = 7;
    const ac = new AbortController();
    const p = ev3.command("ev3.pair", "run_pair", { left_deg: 2000, right_deg: 2000, speed_pct: 30 }, ac.signal);
    expect(await code(ev3.command("ev3.B", "run_degrees", { degrees: 10, speed_pct: 20 }, never()))).toBe("busy");
    expect(
      await code(ev3.command("ev3.pair", "run_pair", { left_deg: 10, right_deg: 10, speed_pct: 20 }, never())),
    ).toBe("busy");
    const a = await ev3.command("ev3.A", "run_degrees", { degrees: 30, speed_pct: 30 }, never());
    expect(a.reason).toBe("completed");
    ac.abort();
    expect((await p).reason).toBe("preempted");
    expect((await ev3.command("ev3.B", "run_degrees", { degrees: 10, speed_pct: 20 }, never())).reason).toBe(
      "completed",
    );
    expectSafe(fake);
  });
});

describe("motor_pair.brake", () => {
  test("ends a coasting move: A3 on the pair's ports only, verified by speed 0", async () => {
    const { fake, ev3 } = rig();
    fake.motors[0].type = 7;
    const other = ev3.command("ev3.A", "run_time", { ms: 250, speed_pct: 30 }, never());
    await ev3.command("ev3.pair", "run_pair", { left_deg: 60, right_deg: 60, speed_pct: 40, brake: false }, never());
    expect(fake.motors[1].holdBrake).toBe(false);
    const before = fake.sent.length;
    const r = await ev3.command("ev3.pair", "brake", {}, never());
    expect(r).toMatchObject({ reason: "completed", clamped: false });
    expect(Object.keys(r.measured)).toEqual(["left_deg", "right_deg"]);
    expect([fake.motors[1].holdBrake, fake.motors[2].holdBrake]).toEqual([true, true]);
    const stops = fake.sent.slice(before).filter((s) => s.opcodes[0] === E.OP.OUTPUT_STOP);
    expect(stops.map((s) => params(s.packet))).toEqual([[6, 1]]);
    const check = fake.sent.slice(before).find((s) => s.opcodes[0] === E.OP.OUTPUT_READ)!;
    expect(check.opcodes).toEqual([E.OP.OUTPUT_READ, E.OP.OUTPUT_READ, E.OP.OUTPUT_TEST]);
    expect(fake.busy(1)).toBe(true); // the motor on A keeps running
    expect((await other).reason).toBe("completed");
    expectSafe(fake);
  });
  test("preempts an operation running on the pair", async () => {
    const { fake, ev3 } = rig();
    const run = ev3.command("ev3.pair", "run_pair", { left_deg: 6000, right_deg: 6000, speed_pct: 30 }, never());
    await new Promise((r) => setTimeout(r, 60));
    const t0 = performance.now();
    expect((await ev3.command("ev3.pair", "brake", {}, never())).reason).toBe("completed");
    expect(performance.now() - t0).toBeLessThan(250);
    expect((await run).reason).toBe("preempted");
    expect(fake.busy()).toBe(false);
    expectSafe(fake);
  });
  test("waits for speed 0; a motor that keeps turning is stop_unverified", async () => {
    const a = rig();
    a.fake.brakeLagMs = 50;
    const run = a.ev3.command("ev3.pair", "run_pair", { left_deg: 6000, right_deg: 6000, speed_pct: 30 }, never());
    await new Promise((r) => setTimeout(r, 40));
    const t0 = performance.now();
    await a.ev3.command("ev3.pair", "brake", {}, never());
    expect(performance.now() - t0).toBeGreaterThanOrEqual(45);
    await run;
    const b = rig({ provider: { stopSettleMs: 60 } });
    b.fake.brakeLagMs = 5000;
    const run2 = b.ev3.command("ev3.pair", "run_pair", { left_deg: 6000, right_deg: 6000, speed_pct: 30 }, never());
    await new Promise((r) => setTimeout(r, 40));
    expect(await code(b.ev3.command("ev3.pair", "brake", {}, never()))).toBe("stop_unverified");
    await run2;
  });
});

describe("arguments", () => {
  test("bad arguments are invalid_argument and nothing is sent", async () => {
    const { fake, ev3 } = rig();
    await ev3.devices();
    const n = fake.sent.length;
    const bad: [string, string, Record<string, unknown>][] = [
      ["ev3.B", "run_degrees", {}],
      ["ev3.B", "run_degrees", { degrees: 90 }],
      ["ev3.B", "run_degrees", { degrees: "90", speed_pct: 20 }],
      ["ev3.B", "run_degrees", { degrees: NaN, speed_pct: 20 }],
      ["ev3.B", "run_degrees", { degrees: 90, speed_pct: 0 }],
      ["ev3.B", "run_degrees", { degrees: 90, speed_pct: -20 }],
      ["ev3.B", "run_degrees", { degrees: 90, speed_pct: 20, power: 3 }],
      ["ev3.B", "run_time", { ms: 0, speed_pct: 20 }],
      ["ev3.pair", "run_pair", { left_deg: 90, speed_pct: 20 }],
      ["ev3.led", "set", { pattern: "purple" }],
      ["ev3.display", "text", { lines: "abc" }],
      ["ev3.display", "text", { lines: ["12345678901234567890123"] }],
      ["ev3.display", "text", { lines: Array.from({ length: 11 }, () => "x") }],
      ["ev3.speaker", "tone", { frequency_hz: 440 }],
    ];
    for (const [d, c, a] of bad)
      expect([d, c, await code(ev3.command(d, c, a as never, never()))]).toEqual([d, c, "invalid_argument"]);
    expect(await code(ev3.command("ev3.B", "fly", {}, never()))).toBe("unknown_command");
    expect(await code(ev3.command("ev3.X", "run_degrees", { degrees: 1, speed_pct: 1 }, never()))).toBe(
      "unknown_device",
    );
    await expect(ev3.command("ev3.B", "fly", {}, never())).rejects.toThrow(/run_degrees, run_time/);
    expect(fake.sent.length).toBe(n);
  });
});

describe("abort and stop", () => {
  test("abort mid-operation: resolves preempted at once, motors braked", async () => {
    const { fake, ev3 } = rig();
    const ac = new AbortController();
    const run = ev3.command("ev3.pair", "run_pair", { left_deg: 6000, right_deg: 6000, speed_pct: 30 }, ac.signal);
    await new Promise((r) => setTimeout(r, 80));
    expect(fake.busy()).toBe(true);
    const t0 = performance.now();
    ac.abort();
    const r = await run;
    expect(performance.now() - t0).toBeLessThan(250);
    expect(r.reason).toBe("preempted");
    expect(fake.busy()).toBe(false);
    expect(r.measured.left_deg as number).toBeGreaterThan(10);
    expect(r.measured.left_deg as number).toBeLessThan(110);
    expect(r.measured.left_deg).toBe(fake.tacho("B"));
    expect(fake.motors[1].holdBrake).toBe(true);
    expectSafe(fake);
  });

  test("an already-aborted signal moves nothing", async () => {
    const { fake, ev3 } = rig();
    await ev3.devices();
    const n = fake.sent.length;
    for (const [d, c, a] of [
      ["ev3.B", "run_degrees", { degrees: 360, speed_pct: 30 }],
      ["ev3.B", "run_time", { ms: 100, speed_pct: 30 }],
      ["ev3.B", "run_to_position", { position_deg: 90, speed_pct: 30 }],
      ["ev3.pair", "run_pair", { left_deg: 90, right_deg: 90, speed_pct: 30 }],
      ["ev3.speaker", "beep", {}],
      ["ev3.led", "set", { pattern: "red" }],
    ] as const) {
      expect((await ev3.command(d, c, a as never, AbortSignal.abort())).reason).toBe("preempted");
    }
    expect(fake.sent.length).toBe(n);
    expect((await ev3.command("ev3.B", "run_degrees", { degrees: 20, speed_pct: 30 }, never())).reason).toBe(
      "completed",
    ); // ports were released
  });

  test("stop() mid-operation: brake first, verified by speed 0 on every motor, well inside stop_worst_ms", async () => {
    const { fake, ev3 } = rig();
    const run = ev3.command("ev3.pair", "run_pair", { left_deg: 6000, right_deg: 6000, speed_pct: 30 }, never());
    await new Promise((r) => setTimeout(r, 80));
    const before = fake.sent.length;
    const t0 = performance.now();
    const s = await ev3.stop();
    const took = performance.now() - t0;
    expect(s).toEqual({ motors_stopped: true });
    expect(took).toBeLessThan(250);
    expect(took).toBeLessThan(ev3.stop_worst_ms);
    expect(fake.busy()).toBe(false);
    expect((await run).reason).toBe("preempted");
    // at most the one in-flight command precedes A3 on all four ports; its check follows directly:
    // A8 on each of the four outputs, then A9
    const after = fake.sent.slice(before);
    const i = after.findIndex((x) => x.opcodes[0] === E.OP.OUTPUT_STOP && params(x.packet)[0] === 0x0f);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThanOrEqual(1);
    expect(after[i + 1].opcodes).toEqual([
      E.OP.OUTPUT_READ,
      E.OP.OUTPUT_READ,
      E.OP.OUTPUT_READ,
      E.OP.OUTPUT_READ,
      E.OP.OUTPUT_TEST,
    ]);
    const at = fake.tacho("B");
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.tacho("B")).toBe(at); // nothing restarted the motors
    expect((await ev3.command("ev3.B", "run_degrees", { degrees: 30, speed_pct: 30 }, never())).reason).toBe(
      "completed",
    );
    expectSafe(fake);
  });

  test("stop waits for the shafts to read speed 0, not just for busy to clear", async () => {
    const { fake, ev3 } = rig({ provider: { stopSettleMs: 300 } });
    fake.brakeLagMs = 60; // busy is 0 right after the brake, but the motor still turns for 60 ms
    const run = ev3.command("ev3.B", "run_time", { ms: 250, speed_pct: 50 }, never());
    await new Promise((r) => setTimeout(r, 50));
    const t0 = performance.now();
    const s = await ev3.stop();
    const took = performance.now() - t0;
    expect(s).toEqual({ motors_stopped: true });
    expect(took).toBeGreaterThanOrEqual(55);
    expect(took).toBeLessThan(200);
    expect(fake.sent.filter((x) => x.opcodes[0] === E.OP.OUTPUT_READ && x.opcodes.length === 5).length).toBeGreaterThan(
      1,
    );
    await run;
  });

  test("a motor that never reads 0 gives motors_stopped false within stop_worst_ms", async () => {
    const { fake, ev3 } = rig({ provider: { stopSettleMs: 80 } });
    fake.brakeLagMs = 5000;
    const run = ev3.command("ev3.B", "run_time", { ms: 250, speed_pct: 50 }, never());
    await new Promise((r) => setTimeout(r, 50));
    const t0 = performance.now();
    expect(await ev3.stop()).toEqual({ motors_stopped: false });
    const took = performance.now() - t0;
    expect(took).toBeGreaterThanOrEqual(75);
    expect(took).toBeLessThan(ev3.stop_worst_ms);
    await run;
  });

  test("stop_worst_ms holds in the worst case: a slow in-flight reply, slow brake, motor that never settles", async () => {
    const { fake, ev3 } = rig({ provider: { timeoutMs: 100, modeSwitchTimeoutMs: 100, stopSettleMs: 100, pollMs: 5 } });
    await ev3.devices();
    fake.brakeLagMs = 5000;
    fake.replyDelayMs = 60; // every reply is slow, yet inside the 100 ms timeout
    const run = ev3.command("ev3.B", "run_time", { ms: 250, speed_pct: 50 }, never()).catch((e) => e);
    await new Promise((r) => setTimeout(r, 120)); // a command of the operation is in flight now
    const t0 = performance.now();
    const s = await ev3.stop();
    const took = performance.now() - t0;
    expect(s).toEqual({ motors_stopped: false });
    expect(took).toBeLessThanOrEqual(ev3.stop_worst_ms);
    fake.replyDelayMs = 0;
    await run;
  });

  test("stop verifies against a brick whose clock only advances with timers (no busy loop)", async () => {
    let t = 0;
    const tick = setInterval(() => {
      t += 5;
    }, 5);
    try {
      const fake = new FakeEV3({ now: () => t, degPerSecAt100: RATE });
      const ev3 = new Ev3Provider(fake, { ...CONFIG, degPerSecAt100: RATE, pollMs: 2, timeoutMs: 200, now: () => t });
      fake.brakeLagMs = 40;
      const run = ev3.command("ev3.B", "run_time", { ms: 250, speed_pct: 50 }, never());
      await new Promise((r) => setTimeout(r, 40));
      expect(await ev3.stop()).toEqual({ motors_stopped: true });
      expect((await run).reason).toBe("preempted");
    } finally {
      clearInterval(tick);
    }
  });

  test("while stop verifies, other commands wait; urgent commands queued before it are dropped", async () => {
    const { fake, ev3 } = rig({ provider: { stopSettleMs: 200 } });
    fake.motors[0].type = 7;
    await ev3.devices();
    fake.brakeLagMs = 60;
    fake.replyDelayMs = 3;
    const run = ev3.command("ev3.B", "run_time", { ms: 250, speed_pct: 50 }, never());
    await new Promise((r) => setTimeout(r, 40));
    const before = fake.sent.length;
    const stopping = ev3.stop();
    const reads = [ev3.read("ev3.A"), ev3.read("ev3.battery"), ev3.read("ev3.buttons")];
    expect(await stopping).toEqual({ motors_stopped: true });
    const stopIdx = fake.sent.findIndex((x, i) => i >= before && x.opcodes[0] === E.OP.OUTPUT_STOP);
    const during = fake.sent.slice(stopIdx + 1).map((x) => x.opcodes);
    const lastCheck = during.map((o) => o.length === 5 && o[0] === E.OP.OUTPUT_READ).lastIndexOf(true);
    expect(lastCheck).toBeGreaterThan(1); // several checks while the shaft slowed down
    for (const o of during.slice(0, lastCheck))
      expect(o).toEqual([E.OP.OUTPUT_READ, E.OP.OUTPUT_READ, E.OP.OUTPUT_READ, E.OP.OUTPUT_READ, E.OP.OUTPUT_TEST]);
    for (const r of await Promise.all(reads)) expect(r[0].value).not.toBeNull(); // the reads ran afterwards
    expect((await run).reason).toBe("preempted");
    expectSafe(fake);
  });

  test("stop with nothing running still brakes and verifies", async () => {
    const { fake, ev3 } = rig();
    expect(await ev3.stop()).toEqual({ motors_stopped: true });
    expect(fake.sent.map((s) => s.opcodes[0])).toEqual([E.OP.OUTPUT_STOP, E.OP.OUTPUT_READ]);
  });
});

describe("fail loud: link errors become contract error codes", () => {
  test("a lost reply during an operation rejects with RuntimeError timeout (retryable), never a result", async () => {
    const { fake, ev3 } = rig();
    await ev3.devices();
    fake.dropNext(1, (ops) => ops.includes(E.OP.OUTPUT_TIME_SYNC));
    const outcome = await ev3
      .command("ev3.pair", "run_pair", { left_deg: 300, right_deg: 300, speed_pct: 30 }, never())
      .then(
        (r) => ({ ok: r }),
        (e) => ({ err: e }),
      );
    expect("err" in outcome).toBe(true);
    const err = (outcome as { err: RuntimeError }).err;
    expect(err).toBeInstanceOf(RuntimeError);
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("no_reply");
    // the ports are released, stop still goes out, and the brick ended the motion on its own clock
    expect(await ev3.stop()).toEqual({ motors_stopped: true });
    expect((await ev3.command("ev3.B", "run_degrees", { degrees: 30, speed_pct: 30 }, never())).reason).toBe(
      "completed",
    );
  });
  test("lost replies on devices(), stop() and instant commands reject with timeout", async () => {
    const { fake, ev3 } = rig();
    fake.dropNext(1);
    expect(await code(ev3.devices())).toBe("timeout");
    await ev3.devices();
    fake.dropNext(1);
    expect(await code(ev3.stop())).toBe("timeout");
    fake.dropNext(1);
    expect(await code(ev3.command("ev3.speaker", "beep", {}, never()))).toBe("timeout");
  });
  test("brick error -> internal, broken transport -> robot_offline, bad reply -> internal", async () => {
    const refuses = new Ev3Provider(
      { send: async (b) => E.encodeReply(b[2] | (b[3] << 8), false) },
      { ...CONFIG, timeoutMs: 100 },
    );
    expect(await code(refuses.devices())).toBe("internal");
    const unplugged = new Ev3Provider(
      {
        send: async () => {
          throw new Error("device disconnected");
        },
      },
      { ...CONFIG, timeoutMs: 100 },
    );
    expect(await code(unplugged.devices())).toBe("robot_offline");
    expect(await code(unplugged.stop())).toBe("robot_offline");
    const liar = new Ev3Provider(
      {
        send: async () =>
          E.encodeReply(
            9999,
            true,
            Array.from({ length: 16 }, () => 0),
          ),
      },
      { ...CONFIG, timeoutMs: 100 },
    );
    expect(await code(liar.devices())).toBe("internal");
  });
});

describe("command(): sensors, speaker, display, led", () => {
  test("gyro reset is the one explicit way the gyro mode is touched; angle is active afterwards", async () => {
    const { fake, ev3 } = rig();
    fake.setSensor(2, 32, 0);
    fake.setSensor(2, 32, 0, 1);
    await ev3.devices();
    let notified = 0;
    ev3.onDevicesChanged(() => {
      notified++;
    });
    const r = await ev3.command("ev3.S2", "reset", {}, never());
    expect(r).toMatchObject({ reason: "completed", measured: { angle_deg: 0 } });
    expect(fake.sensors[1]!.mode).toBe(0);
    expect(fake.modeSwitches).toBe(2);
    expect(notified).toBe(1);
    expect((await ev3.read("ev3.S2")).map((x) => x.value)).toEqual([0, null]);
    expect(fake.modeSwitches).toBe(2);
  });
  test("tone (cap and volume from hardware config), beep, display, led", async () => {
    const { fake, ev3 } = rig({
      provider: { hardware: { low_battery_v: 6.5, max_tone_ms: 900, tone_volume_pct: 10 } },
    });
    expect((await ev3.command("ev3.speaker", "tone", { frequency_hz: 440, duration_ms: 300 }, never())).reason).toBe(
      "completed",
    );
    await ev3.command("ev3.speaker", "beep", {}, never());
    const t = await ev3.command("ev3.speaker", "tone", { frequency_hz: 20, duration_ms: 60000 }, never());
    expect(t).toMatchObject({ clamped: true, reason: "clamped", measured: { frequency_hz: 250, duration_ms: 900 } });
    expect(fake.tones).toEqual([
      { hz: 440, ms: 300, volume: 10 },
      { hz: 1000, ms: 200, volume: 10 },
      { hz: 250, ms: 900, volume: 10 },
    ]);
    expect((await ev3.devices()).find((d) => d.id === "ev3.speaker")!.commands.map((c) => c.bound)).toEqual([
      { kind: "ms", params: ["duration_ms"], max: 900 },
      { kind: "ms", max: 200 },
    ]);
    await ev3.command("ev3.display", "text", { lines: ["¡Señal añadida!", "", "línea número 3"] }, never());
    expect(fake.lcd).toEqual(["?Senal anadida!", "linea numero 3"]);
    await ev3.command("ev3.display", "clear", {}, never());
    expect(fake.lcd).toEqual([]);
    for (const p of ["orange_pulse", "off"] as const) {
      await ev3.command("ev3.led", "set", { pattern: p }, never());
      expect(fake.led).toBe(LED_PATTERNS.indexOf(p));
    }
    expectSafe(fake);
  });
});

describe("a whole session stays inside the safe command set", () => {
  test("no system command, no 0x80, no AA/A6, no degree-bounded motion, nothing over 250 ms, nothing overlapping", async () => {
    const { fake, ev3 } = rig();
    fake.motors[0].type = 8;
    fake.setSensor(1, 16, 0);
    fake.setSensor(2, 32, 12);
    fake.setSensor(3, 29, 40);
    fake.setSensor(4, 33, 55);
    const specs = await ev3.devices();
    await Promise.all(specs.map((d) => ev3.read(d.id)));
    await Promise.all([
      ev3.command("ev3.pair", "run_pair", { left_deg: 60, right_deg: -60, speed_pct: 40 }, never()),
      ev3.command("ev3.A", "run_time", { ms: 60, speed_pct: -30 }, never()),
      ev3.read("ev3.S4"),
      ev3.command("ev3.speaker", "beep", {}, never()),
    ]);
    await ev3.command("ev3.pair", "run_pair", { left_deg: 9000, right_deg: 9000, speed_pct: 100 }, never());
    await ev3.command("ev3.A", "run_to_position", { position_deg: 0, speed_pct: 30 }, never());
    await ev3.read("ev3.S3", ["rgb"], { allow_mode_switch: true });
    await ev3.command("ev3.S2", "reset", {}, never());
    await ev3.command("ev3.display", "text", { lines: ["abc"] }, never());
    await ev3.stop();
    expect(fake.sent.length).toBeGreaterThan(20);
    expect(motionOps(fake).length).toBe(4);
    expectSafe(fake);
  });
});
