import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { BRIDGE_FILE } from "../src/ssh";
import { RuntimeError } from "../../protocol/types";
import type { DeviceSpec } from "../../protocol/types";
import {
  BRICK_WATCHDOG_MS,
  Ev3devProvider,
  EXAMPLE_EV3DEV_HARDWARE,
  readOnlyTransport,
  type Ev3devProviderOptions,
  type LineTransport,
} from "../src/provider";
import { checkRemotePath, sshArgs } from "../src/ssh";
import { FAKE_HAS_LEDS, FakeBrick, findPython } from "./fake-brick";

const python = findPython();
if (!python)
  console.warn(
    "SKIPPED: the fake-brick tests run bridge/ev3dev_bridge.py with a local Python 3, and neither `python3` nor `python` works on this machine.",
  );
const brickTest = python ? test : test.skip;

const OP_MS = 250; // the tests run with a short time bound; the default is MAX_MOTION_MS (3000)
/**
 * Time bound for a test whose operation must still be running, or must end by itself, while the test does other
 * things: the bridge's bound is real time, so the short one would race the test's own timers and round trips.
 */
const PATIENT_OP_MS = 3000;
const OPTS: Ev3devProviderOptions = {
  maxOpMs: OP_MS,
  limits: { max_speed_pct: 60, max_command_ms: 15000 },
  hardware: EXAMPLE_EV3DEV_HARDWARE,
};
const IR_MODES = ["IR-PROX", "IR-SEEK", "IR-REMOTE", "IR-REM-A", "IR-S-ALT", "IR-CAL"];
const GYRO_MODES = ["GYRO-ANG", "GYRO-RATE", "GYRO-FAS", "GYRO-G&A", "GYRO-CAL"];
const never = new AbortController().signal;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms: number) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(5);
  }
  return true;
};

const open: { brick: FakeBrick; provider?: Ev3devProvider; transport?: LineTransport; stop?: () => void }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    o.stop?.();
    await o.provider?.close().catch(() => {});
    await o.transport?.close().catch(() => {});
    o.brick.dispose();
  }
});

/** Motors B (motor0) and C (motor1); gyro on port 2 (sensor0), ultrasonic on 3 (sensor1), infrared on 4 (sensor2), an unmapped sensor on 1 (sensor3). */
function setup(opts: Partial<Ev3devProviderOptions> = {}) {
  const brick = new FakeBrick({
    motors: [{ port: "B" }, { port: "C" }],
    sensors: [
      { port: 2, driver: "lego-ev3-gyro", mode: "GYRO-ANG", modes: GYRO_MODES, values: [90] },
      {
        port: 3,
        driver: "lego-ev3-us",
        mode: "US-DIST-CM",
        modes: ["US-DIST-CM", "US-DIST-IN"],
        values: [2550],
        decimals: 1,
      },
      { port: 4, driver: "lego-ev3-ir", mode: "IR-PROX", modes: IR_MODES, values: [37] },
      { port: 1, driver: "lego-nxt-sound", mode: "DB", modes: ["DB", "DBA"], values: [5] },
    ],
    battery_uv: 7654321,
  });
  const provider = new Ev3devProvider(brick.transport(python!), { ...OPTS, ...opts });
  const entry: (typeof open)[number] = { brick, provider };
  open.push(entry);
  return {
    brick,
    provider,
    play: (i: number, ms?: number, overshoot = 0) => {
      const stop = brick.playMotor(i, ms, 50, overshoot);
      const prev = entry.stop;
      entry.stop = () => {
        prev?.();
        stop();
      };
    },
  };
}
const byId = (specs: DeviceSpec[], id: string) => specs.find((s) => s.id === id)!;
async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof RuntimeError ? e.code : `not a RuntimeError: ${e}`;
  }
  return "resolved";
}

describe("config", () => {
  const dead: LineTransport = { open: async () => {}, send() {}, onLine() {}, onClose() {}, close: async () => {} };
  test("missing limits or hardware fails loud with misconfigured", () => {
    for (const bad of [
      undefined,
      {},
      { limits: OPTS.limits },
      { hardware: OPTS.hardware },
      { ...OPTS, limits: { max_speed_pct: 0, max_command_ms: 1 } },
      { ...OPTS, hardware: { low_battery_v: 6.5 } },
      { ...OPTS, heartbeatMs: 900 },
    ]) {
      let thrown: unknown;
      try {
        void new Ev3devProvider(dead, bad as Ev3devProviderOptions).id;
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(RuntimeError);
      expect((thrown as RuntimeError).code).toBe("misconfigured");
    }
    expect(new Ev3devProvider(dead, OPTS).stop_worst_ms).toBeGreaterThan(800);
  });
  test("ssh arguments are an array with no shell text, and unsafe values are rejected", () => {
    expect(sshArgs({ host: "10.0.0.7", user: "robot", port: 2222, identityFile: "C:\\keys\\id" })).toEqual([
      "-T",
      "-p",
      "2222",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=2",
      "-o",
      "ServerAliveCountMax=2",
      "-o",
      "BatchMode=yes",
      "-i",
      "C:\\keys\\id",
      "robot@10.0.0.7",
    ]);
    expect(() => sshArgs({ host: "-oProxyCommand=x", user: "robot" })).toThrow();
    expect(() => sshArgs({ host: "h", user: "a b" })).toThrow();
    expect(() => sshArgs({ host: "h", user: "u", port: 0 })).toThrow();
    expect(checkRemotePath("~/spinecord/ev3dev_bridge.py")).toBe("~/spinecord/ev3dev_bridge.py");
    for (const p of ["a; rm -rf x", "$(x)", "a b", "../x", "dir/"]) expect(() => checkRemotePath(p)).toThrow();
  });
});

describe("fake brick", () => {
  brickTest("a motor still coasting at op start is never commanded backward", () => {
    // Seen on hardware: chunk 2 of a coasting move read its start while the motor was still rolling; by the
    // time the absolute target was commanded the motor had passed it, and the kernel drove it back.
    const brick = new FakeBrick({ motors: [{ port: "B" }, { port: "C" }], sensors: [] });
    open.push({ brick });
    const r = spawnSync(python!, [join(import.meta.dir, "coasting_check.py"), BRIDGE_FILE, brick.root], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout) as Record<
      "passed" | "ahead",
      {
        command: string;
        position_sp: string;
        reply: { ok: boolean; result: { reason: string; measured: { degrees: number } } };
      }
    >;
    // Already past the target and still rolling the commanded way: no run command at all, the travel counts.
    expect(out.passed.command).toBe("");
    expect(out.passed.reply.result.reason).toBe("completed");
    expect(out.passed.reply.result.measured.degrees).toBe(-40); // from the read taken right before the target was written
    // Target still ahead: one absolute move to (position read just before the write) + delta.
    expect(out.ahead).toMatchObject({ command: "run-to-abs-pos", position_sp: "-67" });
    expect(out.ahead.reply.result).toMatchObject({ reason: "completed", measured: { degrees: -27 } });
  });

  brickTest("inventory becomes DeviceSpecs with the contract's kinds, ids and bounds", async () => {
    const { provider } = setup({ roles: { left_wheel: "ev3.B" } });
    const specs = await provider.devices();
    expect(specs.map((s) => `${s.id}:${s.kind}`)).toEqual([
      "ev3.B:motor",
      "ev3.C:motor",
      "ev3.pair:motor_pair",
      "ev3.S1:unknown",
      "ev3.S2:gyro",
      "ev3.S3:ultrasonic",
      "ev3.S4:infrared",
      "ev3.speaker:speaker",
      "ev3.display:display",
      "ev3.led:led",
      "ev3.buttons:buttons",
      "ev3.battery:battery",
    ]);
    expect(byId(specs, "ev3.B").roles).toEqual(["left_wheel"]);
    expect(byId(specs, "ev3.B").channels.map((c) => c.name)).toEqual(["position_deg", "speed_deg_s", "stalled"]);
    expect(byId(specs, "ev3.B").commands.map((c) => c.name)).toEqual([
      "run_degrees",
      "run_time",
      "run_to_position",
      "brake",
      "reset_position",
    ]);
    expect(byId(specs, "ev3.pair").commands.map((c) => c.name)).toEqual(["run_pair", "brake"]);
    expect(byId(specs, "ev3.S4").channels.map((c) => `${c.name}:${c.mode_group}:${c.active}`)).toEqual([
      "proximity_pct:S4:true",
      "beacon_heading:S4:false",
      "beacon_distance_pct:S4:false",
      "remote_buttons:S4:false",
    ]);
    expect(byId(specs, "ev3.S1").description).toContain("lego-nxt-sound");
    expect(byId(specs, "ev3.S1").channels).toEqual([]);
    for (const s of specs)
      for (const c of s.commands) {
        expect(c.bound.max).toBeGreaterThanOrEqual(0);
        if (c.moves && c.name !== "brake") {
          expect(c.bound).toMatchObject({ kind: "ms", max: OP_MS });
          expect("brake" in c.params.properties).toBe(true);
        }
      }
    expect(provider.inventory()!.sensors.map((s) => s.driver_name)).toEqual([
      "lego-ev3-gyro",
      "lego-ev3-us",
      "lego-ev3-ir",
    ]);
  });

  brickTest("reads: IR proximity, ultrasonic scaling, battery, buttons, motor", async () => {
    const { provider, brick } = setup();
    expect(await provider.read("ev3.S4", ["proximity_pct"])).toMatchObject([
      { device: "ev3.S4", channel: "proximity_pct", value: 37, unit: "pct" },
    ]);
    expect((await provider.read("ev3.S3"))[0]).toMatchObject({ channel: "distance_cm", value: 255, unit: "cm" });
    expect((await provider.read("ev3.battery")).map((r) => r.value)).toEqual([7.65, false]);
    brick.setButtons([28, 105]);
    expect((await provider.read("ev3.buttons"))[0]!.value).toEqual(["enter", "left"]);
    brick.setMotor(1, "position", 123);
    brick.setMotor(0, "speed", -525);
    expect((await provider.read("ev3.B")).map((r) => r.value)).toEqual([0, -525, false]);
    expect((await provider.read("ev3.pair")).map((r) => r.value)).toEqual([0, 123]);
  });

  brickTest("the gyro is negated to counter-clockwise-positive", async () => {
    const { provider, brick } = setup();
    expect((await provider.read("ev3.S2", ["angle_deg"]))[0]).toMatchObject({ value: -90, unit: "deg" });
    brick.setSensor(0, "value0", -15);
    expect((await provider.read("ev3.S2", ["angle_deg"]))[0]!.value).toBe(15);
  });

  brickTest("a read never switches a sensor mode unless the channel is named with allow_mode_switch", async () => {
    const { provider, brick } = setup();
    let changed = 0;
    provider.onDevicesChanged(() => {
      changed++;
    });
    const all = await provider.read("ev3.S4");
    expect(all.map((r) => r.value)).toEqual([37, null, null, null]);
    expect(all[1]!.error).toBe("mode_switch_required");
    expect((await provider.read("ev3.S4", ["remote_buttons"]))[0]!.error).toBe("mode_switch_required");
    expect((await provider.read("ev3.S4", undefined, { allow_mode_switch: true }))[3]!.error).toBe(
      "mode_switch_required",
    );
    expect(brick.sensor(2, "mode")).toBe("IR-PROX");
    expect(changed).toBe(0);
    brick.setSensor(2, "value0", 9);
    expect((await provider.read("ev3.S4", ["remote_buttons"], { allow_mode_switch: true }))[0]!.value).toBe(9);
    expect(brick.sensor(2, "mode")).toBe("IR-REMOTE");
    expect(changed).toBe(1);
    const s4 = byId(await provider.devices(), "ev3.S4");
    expect(s4.channels.filter((c) => c.active).map((c) => c.name)).toEqual(["remote_buttons"]);
  });

  brickTest("run_degrees is one bounded run-to-abs-pos with position_sp, speed_sp and the stop action", async () => {
    const { provider, brick, play } = setup({ maxOpMs: PATIENT_OP_MS });
    play(0);
    const res = await provider.command("ev3.B", "run_degrees", { degrees: 90, speed_pct: 30 }, never);
    expect(res).toMatchObject({ reason: "completed", clamped: false, measured: { degrees: 90 } });
    expect(brick.motor(0, "command")).toBe("done:run-to-abs-pos");
    expect(brick.motor(0, "position_sp")).toBe("90");
    expect(brick.motor(0, "speed_sp")).toBe("315");
    expect(brick.motor(0, "stop_action")).toBe("brake");
    expect(brick.motor(1, "command")).toBe("");
    const coast = await provider.command("ev3.B", "run_degrees", { degrees: -40, speed_pct: 100, brake: false }, never);
    expect(coast).toMatchObject({
      reason: "clamped",
      clamped: true,
      measured: { degrees: -40, applied_speed_pct: 60 },
    });
    expect(brick.motor(0, "position_sp")).toBe("50"); // absolute: it was at 90
    expect(brick.motor(0, "speed_sp")).toBe("630");
    expect(brick.motor(0, "stop_action")).toBe("coast");
  });

  brickTest(
    "a target that needs longer than the time bound is braked on the brick and reported as timeout",
    async () => {
      const { provider, brick } = setup();
      brick.setMotor(0, "state", "running"); // the motor keeps running and creeps
      const moving = setInterval(() => brick.setMotor(0, "position", Number(brick.motor(0, "position") || 0) + 2), 20);
      const res = await provider
        .command("ev3.B", "run_degrees", { degrees: 3000, speed_pct: 50 }, never)
        .finally(() => clearInterval(moving));
      expect(res.reason).toBe("timeout");
      expect(res.measured.time_limited).toBe(true);
      expect(res.ms).toBeGreaterThanOrEqual(OP_MS); // measured on the brick; this side's clock proves nothing
      expect(brick.motor(0, "command")).toBe("stop");
      expect(brick.motor(0, "stop_action")).toBe("brake");
      // The kernel never got the 3000 degrees: only what fits in the time bound at 525 deg/s, plus margin,
      // counted from the position the bridge read at the start. The fake only creeps forward, so that
      // position is at most where the motor is now, however long the bridge took to start.
      const reach = Math.ceil(525 * (OP_MS / 1000) * 1.2) + 4;
      expect(Number(brick.motor(0, "position_sp"))).toBeLessThanOrEqual(Number(brick.motor(0, "position")) + reach);
      expect(Number(brick.motor(0, "position_sp"))).toBeGreaterThan(100);
    },
  );

  brickTest("after a coasting overshoot the next operation still goes forward from where the motors are", async () => {
    // Seen on hardware: 20 deg coasting ended 16 deg past its target; the next +15 deg operation, sent as a
    // relative move, was measured from the old target and drove the robot backward.
    const { provider, brick, play } = setup({ maxOpMs: PATIENT_OP_MS });
    play(0, 40, 16);
    play(1, 40, 17);
    const first = await provider.command(
      "ev3.pair",
      "run_pair",
      { left_deg: 20, right_deg: 20, speed_pct: 25, brake: false },
      never,
    );
    expect(first).toMatchObject({ reason: "completed", measured: { left_deg: 36, right_deg: 37 } }); // measured from the start position, overshoot included
    const second = await provider.command(
      "ev3.pair",
      "run_pair",
      { left_deg: 15.33, right_deg: 15.33, speed_pct: 25, brake: false },
      never,
    );
    expect([brick.motor(0, "command"), brick.motor(1, "command")]).toEqual([
      "done:run-to-abs-pos",
      "done:run-to-abs-pos",
    ]);
    expect([brick.motor(0, "position_sp"), brick.motor(1, "position_sp")]).toEqual(["51", "52"]); // 36 + 15, 37 + 15
    expect(second.reason).toBe("completed");
    expect(second.measured.left_deg as number).toBeGreaterThan(0);
    expect(second.measured.right_deg as number).toBeGreaterThan(0);
    expect((await provider.read("ev3.pair")).map((r) => r.value)).toEqual([67, 69]); // 36 + 15 + 16, 37 + 15 + 17: never backward
    // A single motor behaves the same way, in reverse too.
    const back = await provider.command("ev3.B", "run_degrees", { degrees: -10, speed_pct: 25, brake: true }, never);
    expect(brick.motor(0, "position_sp")).toBe("57");
    expect(back).toMatchObject({ reason: "completed", measured: { degrees: -10 } });
  });

  brickTest("a device re-scan during an operation does not leave the motor busy", async () => {
    const { provider, brick, play } = setup({ maxOpMs: PATIENT_OP_MS });
    play(0, 150);
    const running = provider.command("ev3.B", "run_degrees", { degrees: 30, speed_pct: 30 }, never);
    expect(await until(() => brick.motor(0, "state") === "running", 4000)).toBe(true);
    await provider.devices();
    expect((await running).reason).toBe("completed");
    expect((await provider.command("ev3.B", "run_degrees", { degrees: 30, speed_pct: 30 }, never)).reason).toBe(
      "completed",
    );
  });

  brickTest("a motor that never turns is reported as stalled, not completed", async () => {
    const { provider } = setup();
    const res = await provider.command("ev3.B", "run_degrees", { degrees: 90, speed_pct: 30 }, never);
    expect(res).toMatchObject({ reason: "stalled", measured: { degrees: 0 } });
    expect((await provider.read("ev3.B", ["stalled"]))[0]!.value).toBe(true);
  });

  brickTest("run_time is cut to the time bound; run_pair starts both motors with proportional speeds", async () => {
    const { provider, brick, play } = setup();
    play(0);
    play(1);
    const timed = await provider.command("ev3.B", "run_time", { ms: 5000, speed_pct: -20 }, never);
    expect(timed).toMatchObject({
      reason: "clamped",
      clamped: true,
      measured: { applied_ms: OP_MS, degrees: -50 },
    });
    expect(brick.motor(0, "time_sp")).toBe(String(OP_MS));
    expect(brick.motor(0, "speed_sp")).toBe("-210");
    const pair = await provider.command(
      "ev3.pair",
      "run_pair",
      { left_deg: 100, right_deg: -50, speed_pct: 40 },
      never,
    );
    expect(pair).toMatchObject({ reason: "completed", measured: { left_deg: 100, right_deg: -50 } });
    expect([brick.motor(0, "position_sp"), brick.motor(1, "position_sp")]).toEqual(["50", "-50"]); // absolute: B was at -50, C at 0
    expect([brick.motor(0, "speed_sp"), brick.motor(1, "speed_sp")]).toEqual(["420", "210"]);
  });

  brickTest("abort preempts a running operation and brakes; a second command on a busy motor is refused", async () => {
    // the operation is long, so it is still running when the second command and the abort arrive
    const { provider, brick } = setup({ maxOpMs: PATIENT_OP_MS });
    brick.setMotor(0, "state", "running");
    const ac = new AbortController();
    const running = provider.command("ev3.B", "run_time", { ms: PATIENT_OP_MS, speed_pct: 30 }, ac.signal);
    expect(await until(() => brick.motor(0, "command") === "run-timed", 4000)).toBe(true);
    expect(await code(provider.command("ev3.B", "run_degrees", { degrees: 10, speed_pct: 30 }, never))).toBe("busy");
    ac.abort();
    expect((await running).reason).toBe("preempted");
    expect(brick.motor(0, "command")).toBe("stop");
    expect(await provider.command("ev3.B", "run_time", { ms: 100, speed_pct: 30 }, ac.signal)).toMatchObject({
      reason: "preempted",
      ms: 0,
    });
  });

  brickTest("stop is verified by reading speed 0, and says so when a motor still moves", async () => {
    const { provider, brick } = setup();
    await provider.devices();
    expect(await provider.stop()).toEqual({ motors_stopped: true });
    expect([brick.motor(0, "command"), brick.motor(1, "command")]).toEqual(["stop", "stop"]);
    expect(brick.motor(0, "stop_action")).toBe("brake");
    brick.setMotor(1, "speed", 40);
    expect(await provider.stop()).toEqual({ motors_stopped: false });
  });

  brickTest("pair brake touches only the pair and is verified", async () => {
    const { provider, brick } = setup({ pair: { left: "B", right: "C" } });
    expect((await provider.command("ev3.pair", "brake", {}, never)).reason).toBe("completed");
    expect([brick.motor(0, "command"), brick.motor(1, "command")]).toEqual(["stop", "stop"]);
    brick.setMotor(0, "command", "");
    expect((await provider.command("ev3.C", "brake", {}, never)).reason).toBe("completed");
    expect([brick.motor(0, "command"), brick.motor(1, "command")]).toEqual(["", "stop"]);
    brick.setMotor(1, "speed", 12);
    expect(await code(provider.command("ev3.pair", "brake", {}, never))).toBe("stop_unverified");
  });

  brickTest("an attribute that holds no number is a typed error that names it, and the motor is braked", async () => {
    // A brick's sysfs never reads empty; if a driver ever does, the caller gets the attribute, not a Python traceback.
    const { provider, brick } = setup();
    await provider.devices();
    brick.setMotor(0, "position", "");
    const failed = await provider.command("ev3.B", "run_degrees", { degrees: 90, speed_pct: 30 }, never).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failed).toBeInstanceOf(RuntimeError);
    expect((failed as RuntimeError).code).toBe("internal");
    expect((failed as RuntimeError).message).toMatch(/sysfs attribute \S*position reads '', expected an integer/);
    expect((failed as RuntimeError).message).not.toContain("ValueError");
    expect([brick.motor(0, "command"), brick.motor(0, "stop_action")]).toEqual(["stop", "brake"]);
    // a read reports it per channel, and the motor is free again once the attribute is sane
    const read = await provider.read("ev3.B", ["position_deg"]);
    expect(read[0]).toMatchObject({ value: null, error: expect.stringContaining("expected an integer") });
    brick.setMotor(0, "position", 7);
    expect((await provider.read("ev3.B", ["position_deg"]))[0]!.value).toBe(7);
  });

  brickTest(
    "the fake replaces an attribute in one step: a reader in another process never finds it empty or missing",
    async () => {
      const brick = new FakeBrick({ motors: [{ port: "B" }], sensors: [] });
      open.push({ brick });
      const reader = spawn(
        python!,
        [join(import.meta.dir, "attr_reader.py"), BRIDGE_FILE, join(brick.motorDir(0), "position"), "1000"],
        { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      let stdout = "";
      let stderr = "";
      reader.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      reader.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      let exited = false;
      const closed = new Promise<void>((resolve) =>
        reader.on("close", () => {
          exited = true;
          resolve();
        }),
      );
      // the reader stops once the value has grown by 1000 since its first read: at least 1000 writes race its reads
      let writes = 0;
      while (!exited) {
        brick.setMotor(0, "position", ++writes);
        await new Promise((r) => setImmediate(r));
      }
      await closed;
      expect(stderr).toBe("");
      const seen = JSON.parse(stdout) as { reads: number; failed: number; errors: string[]; timed_out: boolean };
      expect(seen.errors).toEqual([]);
      expect(seen).toMatchObject({ failed: 0, timed_out: false });
      expect(seen.reads).toBeGreaterThan(1);
      expect(writes).toBeGreaterThanOrEqual(1000);
    },
    30_000,
  );

  brickTest("unknown device, channel, command and argument are typed errors", async () => {
    const { provider } = setup();
    expect(await code(provider.read("ev3.Z"))).toBe("unknown_device");
    expect(await code(provider.read("ev3.A"))).toBe("unknown_device"); // nothing on port A
    expect(await code(provider.read("ev3.S4", ["nope"]))).toBe("unknown_channel");
    expect(await code(provider.command("ev3.B", "fly", {}, never))).toBe("unknown_command");
    expect(await code(provider.command("ev3.B", "run_degrees", { degrees: 10 }, never))).toBe("invalid_argument");
    expect(await code(provider.command("ev3.B", "run_degrees", { degrees: 10, speed_pct: 30, turbo: 1 }, never))).toBe(
      "invalid_argument",
    );
    expect(await code(provider.command("ev3.display", "text", { lines: ["hi"] }, never))).toBe("unsupported");
  });

  brickTest("gyro reset and led set", async () => {
    const { provider, brick } = setup();
    brick.setSensor(0, "value0", 0);
    expect(await provider.command("ev3.S2", "reset", {}, never)).toMatchObject({
      reason: "completed",
      measured: { angle_deg: 0 },
    });
    expect(brick.sensor(0, "mode")).toBe("GYRO-ANG");
    if (!FAKE_HAS_LEDS) return;
    expect((await provider.command("ev3.led", "set", { pattern: "orange_flash" }, never)).reason).toBe("completed");
    expect([
      brick.led(0, "red", "brightness"),
      brick.led(1, "green", "brightness"),
      brick.led(0, "red", "trigger"),
      brick.led(0, "red", "delay_on"),
    ]).toEqual(["255", "128", "timer", "500"]);
    await provider.command("ev3.led", "set", { pattern: "green" }, never);
    expect([
      brick.led(0, "red", "brightness"),
      brick.led(0, "green", "brightness"),
      brick.led(0, "green", "trigger"),
    ]).toEqual(["0", "255", "none"]);
  });

  brickTest("heartbeats keep the brick watchdog quiet while the provider is alive", async () => {
    const { provider, brick } = setup();
    await provider.devices();
    await sleep(BRICK_WATCHDOG_MS + 500);
    expect(brick.motor(0, "command")).toBe("");
  });

  brickTest("brick watchdog: 1 s of silence brakes every motor", async () => {
    const brick = new FakeBrick({ motors: [{ port: "B" }, { port: "C" }], sensors: [] });
    const transport = brick.transport(python!);
    open.push({ brick, transport });
    const lines: Record<string, unknown>[] = [];
    transport.onLine((l) => lines.push(JSON.parse(l) as Record<string, unknown>));
    await transport.open();
    const t0 = Date.now(); // before the last message: the bridge counts its silence from a later moment
    transport.send(
      JSON.stringify({
        op: "hello",
        id: 1,
        config: {
          bounds: { max_speed_pct: 60, max_op_ms: 250, low_battery_v: 6.5, max_tone_ms: 1000 },
          pair: { left: "B", right: "C" },
        },
      }),
    );
    expect(await until(() => lines.some((l) => l.id === 1), 5000)).toBe(true);
    expect(lines.find((l) => l.id === 1)).toMatchObject({ ok: true, watchdog_ms: BRICK_WATCHDOG_MS });
    brick.setMotor(0, "command", "");
    brick.setMotor(1, "command", "");
    // nothing is sent from here on
    expect(await until(() => brick.motor(1, "command") === "stop", BRICK_WATCHDOG_MS + 3000)).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(BRICK_WATCHDOG_MS - 20); // two clocks: Date here, monotonic there
    expect([brick.motor(0, "command"), brick.motor(0, "stop_action"), brick.motor(1, "stop_action")]).toEqual([
      "stop",
      "brake",
      "brake",
    ]);
    expect(await until(() => lines.some((l) => l.ev === "watchdog"), 1000)).toBe(true);
  });

  brickTest("closing the link brakes every motor", async () => {
    const { provider, brick } = setup();
    await provider.devices();
    await provider.close();
    expect([brick.motor(0, "command"), brick.motor(1, "command")]).toEqual(["stop", "stop"]);
    expect(await code(provider.stop())).toBe("robot_offline");
  });

  brickTest("a read-only transport refuses every command and stop before it is sent", async () => {
    const brick = new FakeBrick({
      motors: [{ port: "B" }],
      sensors: [{ port: 4, driver: "lego-ev3-ir", mode: "IR-PROX", modes: IR_MODES, values: [50] }],
    });
    const provider = new Ev3devProvider(readOnlyTransport(brick.transport(python!)), OPTS);
    open.push({ brick, provider });
    expect((await provider.read("ev3.S4", ["proximity_pct"]))[0]!.value).toBe(50);
    expect(await code(provider.command("ev3.B", "run_degrees", { degrees: 90, speed_pct: 30 }, never))).toBe(
      "robot_offline",
    );
    expect(await code(provider.stop())).toBe("robot_offline");
    expect(await code(provider.read("ev3.S4", ["remote_buttons"], { allow_mode_switch: true }))).toBe("robot_offline");
    expect(brick.motor(0, "command")).toBe("");
    expect(brick.sensor(0, "mode")).toBe("IR-PROX");
  });
});
