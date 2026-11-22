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
import { checkRemotePath, closeDetail, sshArgs } from "../src/ssh";
import { FAKE_HAS_LEDS, FakeBrick, findPython } from "./fake-brick";

// The bridge only ever runs on the brick (Linux): on Windows a file that is open cannot be replaced, so the fake
// sysfs tree cannot behave like sysfs there. The tests that run the bridge are skipped on win32.
const BRIDGE_RUNS_HERE = process.platform !== "win32";
const python = BRIDGE_RUNS_HERE ? findPython() : null;
if (BRIDGE_RUNS_HERE && !python)
  console.warn(
    "SKIPPED: the fake-brick tests run bridge/ev3dev_bridge.py with a local Python 3, and neither `python3` nor `python` works on this machine.",
  );
const brickTest = test.skipIf(!BRIDGE_RUNS_HERE || !python);

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
    // the beacon channels read null with no beacon in view: their manifest says that null is an answer
    expect(
      byId(specs, "ev3.S4")
        .channels.filter((c) => c.null_when_absent)
        .map((c) => c.name),
    ).toEqual(["beacon_heading", "beacon_distance_pct"]);
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

  brickTest(
    "beacon_heading is counter-clockwise-positive: the native value, negative to the left, is negated",
    async () => {
      const { provider, brick } = setup();
      const heading = async () =>
        (await provider.read("ev3.S4", ["beacon_heading", "beacon_distance_pct"], { allow_mode_switch: true })).map(
          (r) => r.value,
        );
      brick.setSensor(2, "value0", -7);
      brick.setSensor(2, "value1", 33);
      expect(await heading()).toEqual([7, 33]);
      expect(brick.sensor(2, "mode")).toBe("IR-SEEK");
      brick.setSensor(2, "value0", 12);
      expect(await heading()).toEqual([-12, 33]);
      brick.setSensor(2, "value0", 0);
      expect(Object.is((await heading())[0], 0)).toBe(true);
      brick.setSensor(2, "value1", -128);
      expect(await heading()).toEqual([null, null]);
      const none = await provider.read("ev3.S4", ["beacon_heading", "beacon_distance_pct"]);
      expect(none.map((r) => r.absent)).toEqual([true, true]); // the sensor's answer, not a failed read
      expect((await provider.read("ev3.S4", ["proximity_pct"]))[0]!.absent).toBeUndefined(); // mode_switch_required
    },
  );

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
          bounds: { max_speed_pct: 60, max_op_ms: 250, low_battery_v: 6.5, max_tone_ms: 1000, speech_volume_pct: 100 },
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

  brickTest("guard: a bridge killed outright mid-move leaves no motor pushing", async () => {
    // No motor is played: the wheel never arrives, as against a wall. Only a write of stop ends the kernel's move.
    const brick = new FakeBrick({ motors: [{ port: "B" }, { port: "C" }], sensors: [] });
    open.push({ brick });
    const bridge = spawn(python!, ["-u", BRIDGE_FILE, "--root", brick.root], {
      env: { ...process.env, ...brick.env() },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => bridge.on("exit", () => resolve()));
    try {
      const lines: Record<string, unknown>[] = [];
      let buf = "";
      bridge.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) lines.push(JSON.parse(line) as Record<string, unknown>);
        }
      });
      const bounds = {
        max_speed_pct: 60,
        max_op_ms: PATIENT_OP_MS,
        low_battery_v: 6.5,
        max_tone_ms: 1000,
        speech_volume_pct: 100,
      };
      const send = (msg: Record<string, unknown>) => bridge.stdin.write(`${JSON.stringify(msg)}\n`);
      send({ op: "hello", id: 1, config: { bounds, pair: { left: "B", right: "C" } } });
      expect(await until(() => lines.some((l) => l.id === 1), 5000)).toBe(true);
      expect(lines.find((l) => l.id === 1)).toMatchObject({ ok: true, guard: true, no_guard: null });
      const args = { left_deg: 720, right_deg: 720, speed_pct: 30, brake: false };
      send({ op: "command", id: 2, device: "pair", command: "run_pair", args });
      expect(await until(() => brick.motor(1, "command") === "run-to-abs-pos", 900)).toBe(true);
      expect([brick.motor(0, "command"), brick.motor(0, "stop_action")]).toEqual(["run-to-abs-pos", "coast"]);
      bridge.kill("SIGKILL"); // no handler runs: the bridge's own watchdog and time cap die with it
      await exited;
      expect(lines.some((l) => l.id === 2)).toBe(false); // the operation was still in flight
      expect(
        await until(() => brick.motor(0, "command") === "stop" && brick.motor(1, "command") === "stop", 5000),
      ).toBe(true);
      expect([brick.motor(0, "stop_action"), brick.motor(1, "stop_action")]).toEqual(["brake", "brake"]);
    } finally {
      bridge.kill("SIGKILL");
      await exited;
    }
  });

  brickTest(
    "guard lost: when the guard dies and the bridge lives, the bridge brakes every motor and ends",
    async () => {
      const brick = new FakeBrick({ motors: [{ port: "B" }, { port: "C" }], sensors: [] });
      open.push({ brick });
      const bridge = spawn(python!, ["-u", BRIDGE_FILE, "--root", brick.root], {
        env: { ...process.env, ...brick.env() },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let gone = false;
      let exitCode: number | null = null;
      const exited = new Promise<void>((resolve) =>
        bridge.on("exit", (code) => {
          gone = true;
          exitCode = code;
          resolve();
        }),
      );
      const beat = setInterval(() => !gone && bridge.stdin.write('{"op":"hb"}\n'), 200); // the watchdog stays quiet
      try {
        const lines: Record<string, unknown>[] = [];
        let buf = "";
        let stderr = "";
        bridge.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
        bridge.stdout.on("data", (d: Buffer) => {
          buf += d.toString("utf8");
          for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) lines.push(JSON.parse(line) as Record<string, unknown>);
          }
        });
        const bounds = {
          max_speed_pct: 60,
          max_op_ms: PATIENT_OP_MS,
          low_battery_v: 6.5,
          max_tone_ms: 1000,
          speech_volume_pct: 100,
        };
        const send = (msg: Record<string, unknown>) => bridge.stdin.write(`${JSON.stringify(msg)}\n`);
        send({ op: "hello", id: 1, config: { bounds, pair: { left: "B", right: "C" } } });
        expect(await until(() => lines.some((l) => l.id === 1), 5000)).toBe(true);
        const hello = lines.find((l) => l.id === 1)!;
        expect(hello).toMatchObject({ ok: true, guard: true });
        expect(typeof hello.guard_pid).toBe("number");
        const args = { left_deg: 720, right_deg: 720, speed_pct: 30, brake: false };
        send({ op: "command", id: 2, device: "pair", command: "run_pair", args });
        expect(await until(() => brick.motor(1, "command") === "run-to-abs-pos", 900)).toBe(true);
        process.kill(hello.guard_pid as number, "SIGKILL"); // the guard writes nothing when it is killed
        expect(await until(() => gone, 3000)).toBe(true);
        expect([brick.motor(0, "command"), brick.motor(1, "command")]).toEqual(["stop", "stop"]);
        expect([brick.motor(0, "stop_action"), brick.motor(1, "stop_action")]).toEqual(["brake", "brake"]);
        expect(lines.some((l) => l.ev === "guard_lost")).toBe(true);
        expect(stderr).toContain("the guard process ended");
        // the bridge leaves with its own code and its own words: no abort of the interpreter, on any Python
        expect(exitCode as number | null).toBe(3);
        expect(stderr).not.toContain("Fatal Python error");
        expect(stderr).not.toContain("Traceback");
        expect(stderr.trim().split("\n").length).toBe(1);
      } finally {
        clearInterval(beat);
        bridge.kill("SIGKILL");
        await exited;
      }
    },
  );

  test("the reason a link closed carries the bridge's own words, not an interpreter's dump", () => {
    const own = "ev3dev_bridge: the guard process ended (exit -9); braked every motor and ending";
    const dump = [
      "Fatal Python error: _enter_buffered_busy: could not acquire lock for <_io.BufferedReader name='<stdin>'>",
      "Python runtime state: finalizing (tstate=0x0000000100f1c9d0)",
      "",
      "Current thread 0x00000001f4e3a080 (most recent call first):",
      "  <no Python frame>",
    ].join("\n");
    expect(closeDetail(`${own}\n${dump}\n`)).toBe(own);
    expect(closeDetail(dump)).toBe("");
    expect(closeDetail("ssh: connect to host brick port 22: Connection refused\n")).toBe(
      "ssh: connect to host brick port 22: Connection refused",
    );
    expect(closeDetail('Traceback (most recent call last):\n  File "x.py", line 1\nValueError: x\n')).toBe("");
    expect(closeDetail("")).toBe("");
  });

  brickTest("closing the link brakes every motor", async () => {
    const { provider, brick } = setup();
    await provider.devices();
    await provider.close();
    expect([brick.motor(0, "command"), brick.motor(1, "command")]).toEqual(["stop", "stop"]);
    expect(await code(provider.stop())).toBe("robot_offline");
  });

  brickTest("a closed provider opens no link again: every call answers robot_offline", async () => {
    const { provider } = setup();
    await provider.devices();
    await provider.close();
    expect(await code(provider.command("ev3.pair", "brake", {}, new AbortController().signal))).toBe("robot_offline");
    expect(await code(provider.read("ev3.S4"))).toBe("robot_offline");
    // the message says why the link is down and where to look, in words a model can act on
    await expect(provider.devices()).rejects.toThrow(
      "the link to the brick was closed on this side; this call ended with it. list_robots shows",
    );
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

  /** The provider on a transport that keeps every request line it sends (heartbeats left out). */
  function tapped(wrap: (t: LineTransport) => LineTransport = (t) => t) {
    const { brick } = setup();
    const inner = wrap(brick.transport(python!));
    const sent: { op: string; id?: number; reads?: { device: string; channels: string[] }[] }[] = [];
    const got: { id?: number; mode?: string }[] = [];
    const transport: LineTransport = {
      open: () => inner.open(),
      close: () => inner.close(),
      onLine: (cb) =>
        inner.onLine((line) => {
          try {
            got.push(JSON.parse(line) as (typeof got)[number]);
          } catch {
            /* not a JSON line */
          }
          cb(line);
        }),
      onClose: (cb) => inner.onClose(cb),
      send(line) {
        const msg = JSON.parse(line) as (typeof sent)[number];
        if (msg.op !== "hb") sent.push(msg);
        inner.send(line);
      },
    };
    const provider = new Ev3devProvider(transport, OPTS);
    open.push({ brick, provider });
    return { brick, provider, sent, got };
  }

  brickTest("a read made right before a command reaches the bridge before it", async () => {
    const { provider, sent } = tapped();
    const pair = (await provider.devices()).find((d) => d.kind === "motor_pair")!;
    await provider.read(pair.id);
    sent.length = 0;
    const read = provider.read(pair.id);
    const op = provider.command(pair.id, "brake", {}, new AbortController().signal);
    await Promise.all([read, op]);
    expect(sent.map((m) => m.op)).toEqual(["read", "command"]);
  });

  brickTest("a read of every device is one request line, answered as the same reads one by one", async () => {
    const { provider, brick, sent } = tapped();
    const specs = await provider.devices();
    brick.setMotor(1, "position", 123);
    brick.setButtons([28]);
    const alone = [];
    for (const d of specs) alone.push(await provider.read(d.id));
    sent.length = 0;
    const together = await Promise.all(specs.map((d) => provider.read(d.id)));
    expect(sent.map((m) => m.op)).toEqual(["read_many"]);
    // devices without channels (speaker, display, led, the unknown sensor) are not asked about
    expect(sent[0]!.reads!.map((r) => r.device)).toEqual(["B", "C", "pair", "S2", "S3", "S4", "buttons", "battery"]);
    const plain = (rs: typeof together) => rs.map((r) => r.map(({ ts: _ts, ...rest }) => rest));
    expect(plain(together)).toEqual(plain(alone));
    const flat = together.flat();
    expect(flat.find((r) => r.channel === "right_deg")!.value).toBe(123);
    expect(flat.find((r) => r.channel === "distance_cm")!.value).toBe(255);
    expect(flat.find((r) => r.device === "ev3.buttons")!.value).toEqual(["enter"]);
    expect(flat.find((r) => r.channel === "beacon_heading")!.error).toBe("mode_switch_required");
    // one read by itself is still the plain request
    sent.length = 0;
    await provider.read("ev3.S3");
    expect(sent.map((m) => m.op)).toEqual(["read"]);
  });

  brickTest("inside a shared read, a device that cannot be read fails alone and no mode is switched", async () => {
    const { provider, brick, sent, got } = tapped();
    await provider.devices();
    brick.setSensor(1, "value0", "garbage"); // the ultrasonic's driver is broken
    let changed = 0;
    provider.onDevicesChanged(() => changed++);
    sent.length = 0;
    const [us, ir, battery, switching] = await Promise.all([
      provider.read("ev3.S3"),
      provider.read("ev3.S4", ["remote_buttons"]),
      provider.read("ev3.battery"),
      provider.read("ev3.S2", ["rate_deg_s"], { allow_mode_switch: true }),
    ]);
    // the read that may switch a mode travels alone; the other three share a line
    expect(sent.map((m) => m.op).sort()).toEqual(["read", "read_many"]);
    expect(sent.find((m) => m.op === "read_many")!.reads!.length).toBe(3);
    expect(us![0]).toMatchObject({ value: null });
    expect(us![0]!.error).toContain("garbage");
    expect(ir![0]!.error).toBe("mode_switch_required");
    expect(brick.sensor(2, "mode")).toBe("IR-PROX");
    expect(battery!.map((r) => r.value)).toEqual([7.65, false]);
    expect(switching![0]!.error).toBeUndefined();
    expect(brick.sensor(0, "mode")).toBe("GYRO-RATE");
    expect(changed).toBe(1);
    // The switching read left first and waited for its sensor while the shared read was answered: each answer
    // names the mode of its own sensor, whatever was read in between.
    expect(sent.map((m) => m.op)).toEqual(["read", "read_many"]);
    expect(got.find((l) => l.id === sent[0]!.id)!.mode).toBe("GYRO-RATE");
    const s2 = (await provider.read("ev3.S2")).map((r) => [r.channel, r.error ?? "read"]);
    expect(s2).toEqual([
      ["angle_deg", "mode_switch_required"],
      ["rate_deg_s", "read"],
    ]);
    expect(changed).toBe(1); // the provider already knew the gyro's new mode: nothing changed again
  });

  brickTest(
    "read_many on the bridge: each read is answered as alone, errors included, and never switches",
    async () => {
      const brick = new FakeBrick({
        motors: [{ port: "B" }],
        sensors: [{ port: 4, driver: "lego-ev3-ir", mode: "IR-PROX", modes: IR_MODES, values: [50] }],
        battery_uv: 7000000,
      });
      const transport = brick.transport(python!);
      open.push({ brick, transport });
      const lines: Record<string, unknown>[] = [];
      transport.onLine((l) => lines.push(JSON.parse(l) as Record<string, unknown>));
      transport.onClose(() => {});
      await transport.open();
      const ask = async (msg: Record<string, unknown>) => {
        transport.send(JSON.stringify(msg));
        expect(await until(() => lines.some((l) => l.id === msg.id), 5000)).toBe(true);
        return lines.find((l) => l.id === msg.id)!;
      };
      const bounds = {
        max_speed_pct: 60,
        max_op_ms: 250,
        low_battery_v: 6.5,
        max_tone_ms: 5000,
        speech_volume_pct: 80,
      };
      const hello = await ask({ op: "hello", id: 1, config: { bounds, pair: { left: "B", right: "C" } } });
      expect(Number(hello.bridge)).toBeGreaterThanOrEqual(3);
      const reply = await ask({
        op: "read_many",
        id: 2,
        reads: [
          { device: "B", channels: ["position_deg"] },
          { device: "nope" },
          { device: "S4", channels: ["remote_buttons"], allow_mode_switch: true },
          { device: "S4", channels: ["bogus"] },
          { device: "battery" },
          "not an object",
        ],
      });
      expect(reply.ok).toBe(true);
      expect(reply.results).toEqual([
        { ok: true, readings: [{ channel: "position_deg", value: 0 }] },
        { ok: false, code: "unknown_device", message: expect.stringContaining('unknown device "nope"') },
        {
          ok: true,
          mode: "IR-PROX",
          readings: [{ channel: "remote_buttons", value: null, error: "mode_switch_required" }],
        },
        { ok: false, code: "unknown_channel", message: expect.stringContaining("bogus") },
        {
          ok: true,
          readings: [
            { channel: "voltage_v", value: 7 },
            { channel: "low", value: false },
          ],
        },
        { ok: false, code: "invalid_argument", message: expect.stringContaining("each read is an object") },
      ]);
      expect(brick.sensor(0, "mode")).toBe("IR-PROX");
      expect((await ask({ op: "read_many", id: 3, reads: "B" })).code).toBe("invalid_argument");
      // the bridge still answers plain reads afterwards
      expect(((await ask({ op: "read", id: 4, device: "S4" })).readings as { value: unknown }[])[0]!.value).toBe(50);
    },
  );

  brickTest("a read-only transport lets a shared read through", async () => {
    const { provider, sent } = tapped(readOnlyTransport);
    await provider.devices();
    sent.length = 0;
    const [us, ir] = await Promise.all([provider.read("ev3.S3"), provider.read("ev3.S4", ["proximity_pct"])]);
    expect(sent.map((m) => m.op)).toEqual(["read_many"]);
    expect([us![0]!.value, ir![0]!.value]).toEqual([255, 37]);
  });

  brickTest("a running motor is looked at when it matters: half the time left, between 2 ms and the tick", () => {
    const r = spawnSync(python!, [join(import.meta.dir, "next_look_check.py"), BRIDGE_FILE], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout) as Record<string, number>;
    expect(out.tick).toBe(0.01);
    expect(out.motion_tick).toBe(0.002);
    expect(out.far).toBe(out.tick!);
    expect(out.near).toBeCloseTo(0.005, 9);
    expect(out.pair).toBeCloseTo(0.005, 9);
    expect(out.arrived).toBe(out.motion_tick!);
    expect(out.no_travel).toBe(out.motion_tick!);
    expect(out.timed_long).toBe(out.tick!);
    expect(out.timed_short).toBeCloseTo(0.004, 9);
    expect(out.timed_over).toBe(out.motion_tick!);
  });
});

describe("bridge version", () => {
  test("a bridge older than read_many fails loud at hello and names the fix", async () => {
    let onLine: (line: string) => void = () => {};
    const sent: string[] = [];
    const old: LineTransport = {
      open: async () => {},
      close: async () => {},
      onLine: (cb) => {
        onLine = cb;
      },
      onClose: () => {},
      send(line) {
        const msg = JSON.parse(line) as { op: string; id?: number };
        sent.push(msg.op);
        if (msg.op !== "hello") return;
        const hello = {
          id: msg.id,
          ok: true,
          bridge: "2",
          watchdog_ms: BRICK_WATCHDOG_MS,
          motors: [],
          sensors: [],
          unknown: [],
          capabilities: {},
          speech: null,
        };
        queueMicrotask(() => onLine(JSON.stringify(hello)));
      },
    };
    const provider = new Ev3devProvider(old, OPTS);
    const e = await provider.devices().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RuntimeError);
    expect((e as RuntimeError).code).toBe("misconfigured");
    expect((e as RuntimeError).message).toContain("installBridge");
    expect((e as RuntimeError).message).toContain("--install-bridge");
    expect((e as RuntimeError).message).toContain('"install_bridge": true');
    expect(sent.filter((op) => op !== "hb")).toEqual(["hello"]);
    await provider.close();
  });
});
