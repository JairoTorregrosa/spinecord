// A host loop on a stock brick (CONTRACT §4, §5a): one tick is one direct command that refreshes every output with a
// timed operation and then reads every input. Against the byte-level emulator, on emulated time.
import { describe, expect, test } from "bun:test";
import type { LoopRead, LoopWrite } from "../protocol/types";
import * as E from "./encode";
import { EmulatedClock, FakeEV3 } from "./fake";
import { EV3_USB_LOOP_RATE_HZ, EXAMPLE_EV3_HARDWARE, Ev3Provider } from "./provider";
import type { Transport } from "./transport";

const B = 1,
  C = 2;
function rig(transport?: (fake: FakeEV3) => Transport) {
  const clock = new EmulatedClock();
  const fake = new FakeEV3({ now: clock.now });
  fake.setSensor(3, E.SENSOR_TYPE.color, 40); // reflected light 40 % in mode 0
  const ev3 = new Ev3Provider(transport ? transport(fake) : fake, {
    limits: { max_speed_pct: 60, max_command_ms: 10000 },
    hardware: EXAMPLE_EV3_HARDWARE,
    now: clock.now,
    sleep: clock.sleep,
  });
  const loop = ev3.loop;
  if (loop.runs_on !== "host") throw new Error("a stock brick runs its loops on the host");
  return { clock, fake, ev3, loop };
}
const wheel = (speed_pct: number): LoopWrite => ({ device: "ev3.B", command: "run_time", args: { speed_pct } });
const encoder: LoopRead = { device: "ev3.B", channel: "position_deg" };

describe("Ev3Provider.loop: one packet per tick", () => {
  test("declares a host loop at the conservative USB rate", () => {
    const { loop } = rig();
    expect(loop).toMatchObject({ runs_on: "host", max_rate_hz: EV3_USB_LOOP_RATE_HZ });
    expect(EV3_USB_LOOP_RATE_HZ).toBe(50);
  });

  test("golden bytes of a tick: the refreshes, then the reads, in one direct command", async () => {
    const { fake, ev3, loop } = rig();
    await ev3.devices();
    fake.motors[B]!.pos = 123;
    const sent0 = fake.sent.length;
    const values = await loop.tick(
      [wheel(20), { device: "ev3.C", command: "power", args: { power_pct: -15 } }],
      [encoder, { device: "ev3.S3", channel: "reflected_pct" }],
      60,
    );
    expect(fake.sent.length - sent0).toBe(1);
    const cmd = E.decodeCommand(fake.sent[sent0]!.packet);
    expect(cmd.type).toBe(E.TYPE_DIRECT_REPLY);
    expect(cmd.globals).toBe(10);
    expect(E.toHex(cmd.bytecodes)).toBe(
      [
        "af 00 02 14 00 81 3c 00 01", // AF time-speed: port B, speed 20, ramp-up 0, 60 ms, ramp-down 0, brake
        "ad 00 04 31 00 81 3c 00 01", // AD time-power: port C, power -15, ramp-up 0, 60 ms, ramp-down 0, brake
        "b3 00 01 60", // B3 tacho of B (index 1) at global 0
        "99 1d 00 02 00 3f 01 64", // READY_SI port 3 (index 2), type and mode kept, one value at global 4
        "99 05 00 02 68 69", // GET_TYPEMODE port 3 at globals 8 and 9: the value was read in the mode planned
      ].join(" "),
    );
    expect(values).toEqual([123, 40]);
    expect(fake.motors[B]).toMatchObject({ speedPct: 20 });
    expect(fake.motors[C]).toMatchObject({ speedPct: -15 });
    // the power being applied is what the refresh set, while it lasts
    expect((await ev3.read("ev3.C", ["power_pct"]))[0]!.value).toBe(-15);
    await loop.end(["ev3.B", "ev3.C"]);
    expect((await ev3.read("ev3.C", ["power_pct"]))[0]!.value).toBe(0);
  });

  test("a refresh supersedes the one in flight, and the motion ends hold_ms after the latest refresh", async () => {
    const { clock, fake, ev3, loop } = rig();
    await ev3.devices();
    await loop.tick([wheel(50)], [encoder], 60);
    await clock.sleep(20);
    await loop.tick([wheel(-30)], [encoder], 60); // at 20 ms: the first refresh would have run until 60 ms
    await clock.sleep(59); // 79 ms: 59 ms after the latest refresh
    expect(fake.busy(1 << B)).toBe(true);
    expect(fake.motors[B]!.speedPct).toBe(-30);
    await clock.sleep(1); // 80 ms: hold_ms after the latest refresh, and no tick since
    expect(fake.busy(1 << B)).toBe(false);
    // ticks every 20 ms, then none: the brick ends the motion by itself 60 ms after the last one
    for (let i = 0; i < 5; i++) {
      await loop.tick([wheel(40)], [encoder], 60);
      await clock.sleep(20);
    }
    const last = clock.now() - 20;
    await clock.sleep(last + 59 - clock.now());
    expect(fake.busy(1 << B)).toBe(true);
    await clock.sleep(1);
    expect(fake.busy(1 << B)).toBe(false);
    expect(fake.unboundedMoves).toBe(0);
    await loop.end([]);
  });

  test("hold_ms is cut to the command's max_hold_ms; a value that rounds to 0 brakes the port", async () => {
    const { clock, fake, ev3, loop } = rig();
    await ev3.devices();
    await loop.tick([wheel(30)], [encoder], 1000);
    await clock.sleep(249);
    expect(fake.busy(1 << B)).toBe(true);
    await clock.sleep(1);
    expect(fake.busy(1 << B)).toBe(false);
    await loop.tick([wheel(30)], [encoder], 60);
    const sent0 = fake.sent.length;
    await loop.tick([wheel(0.4)], [encoder], 60);
    expect(E.toHex(E.decodeCommand(fake.sent[sent0]!.packet).bytecodes)).toStartWith("a3 00 02 01"); // A3 brake B
    expect(fake.busy(1 << B)).toBe(false);
    await loop.end([]);
  });

  test("loop.end brakes: the driven port is at rest the moment it resolves", async () => {
    const { fake, ev3, loop } = rig();
    await ev3.devices();
    await loop.tick([wheel(30), { device: "ev3.C", command: "power", args: { power_pct: 20 } }], [encoder], 250);
    expect(fake.busy((1 << B) | (1 << C))).toBe(true);
    await loop.end([]);
    expect(fake.busy((1 << B) | (1 << C))).toBe(false);
  });

  test("loop.end with a device the scan no longer has still brakes every refreshed port and releases them", async () => {
    const { fake, ev3, loop } = rig();
    await ev3.devices();
    await loop.tick([wheel(30)], [encoder], 250);
    await loop.end(["ev3.B", "ev3.D9"]);
    expect(fake.busy(1 << B)).toBe(false);
    const free = await ev3.command(
      "ev3.B",
      "run_degrees",
      { degrees: 10, speed_pct: 20 },
      new AbortController().signal,
    );
    expect(free.reason).toBe("completed");
    expect(await loop.tick([wheel(10)], [encoder], 60)).toHaveLength(1);
    await loop.end([]);
  });

  test("a driven port is claimed until the loop ends: a command on it answers busy", async () => {
    const { ev3, loop } = rig();
    await ev3.devices();
    await loop.tick([wheel(30)], [encoder], 60);
    const busy = ev3.command("ev3.B", "run_degrees", { degrees: 30, speed_pct: 20 }, new AbortController().signal);
    await expect(busy).rejects.toMatchObject({ code: "busy" });
    await loop.end([]);
    const free = await ev3.command(
      "ev3.B",
      "run_degrees",
      { degrees: 10, speed_pct: 20 },
      new AbortController().signal,
    );
    expect(free.reason).toBe("completed");
  });

  test("a stop overtakes a queued tick: the tick carries no refresh, and later ticks are refused until the end", async () => {
    const { fake, ev3, loop } = rig();
    await ev3.devices();
    await loop.tick([wheel(30)], [encoder], 60);
    fake.replyDelayMs = 0;
    const queued = loop.tick([wheel(50)], [encoder], 60);
    const stopped = ev3.stop();
    await queued.catch(() => {});
    expect(await stopped).toEqual({ motors_stopped: true });
    expect(fake.busy()).toBe(false);
    // the only refresh that reached the brick is the first tick's
    expect(fake.sent.filter((p) => p.opcodes.includes(E.OP.OUTPUT_TIME_SPEED))).toHaveLength(1);
    await expect(loop.tick([wheel(50)], [encoder], 60)).rejects.toMatchObject({ code: "busy" });
    await loop.end(["ev3.B"]);
    expect(fake.busy()).toBe(false);
    expect(await loop.tick([wheel(10)], [encoder], 60)).toHaveLength(1);
    await loop.end([]);
  });

  test("the end of a loop overtakes a tick queued behind a read: the brake is the last word, and loop.end brakes", async () => {
    const { fake, ev3, loop } = rig();
    await ev3.devices();
    await loop.tick([wheel(30)], [encoder], 60);
    expect(fake.busy(1 << B)).toBe(true);
    const sent0 = fake.sent.length;
    const read = ev3.read("ev3.B", ["position_deg"]); // in flight: the next tick waits behind it
    const queued = loop.tick([wheel(50)], [encoder], 60);
    await loop.end(["ev3.B"]);
    expect(fake.busy(1 << B)).toBe(false); // braked the moment end resolves
    await read;
    await queued.catch(() => {});
    expect(fake.busy(1 << B)).toBe(false);
    const after = fake.sent.slice(sent0);
    expect(after.filter((p) => p.opcodes.includes(E.OP.OUTPUT_TIME_SPEED))).toHaveLength(0);
    expect(after.some((p) => p.opcodes.includes(E.OP.OUTPUT_STOP))).toBe(true);
    // the next loop ticks again
    expect(await loop.tick([wheel(10)], [encoder], 60)).toHaveLength(1);
    await loop.end([]);
  });

  test("a sensor in another mode than planned reads no value, and the scan learns of it", async () => {
    const { fake, ev3, loop } = rig();
    await ev3.devices();
    let changed = 0;
    ev3.onDevicesChanged(() => changed++);
    const light = { device: "ev3.S3", channel: "reflected_pct" };
    expect(await loop.tick([], [light], 60)).toEqual([40]);
    fake.sensors[2]!.mode = 1; // something else switched it to ambient light
    expect(await loop.tick([], [light], 60)).toEqual([null]);
    expect(changed).toBe(1);
  });

  test("the transport closes mid-loop: the tick fails, and the brick ends the motion hold_ms after its last refresh", async () => {
    let closed = false;
    const { clock, fake, ev3, loop } = rig((f) => ({
      send: (bytes) => (closed ? Promise.reject(new Error("the socket closed")) : f.send(bytes)),
    }));
    await ev3.devices();
    await loop.tick([wheel(40)], [encoder], 60);
    const at = clock.now();
    closed = true;
    await clock.sleep(10);
    await expect(loop.tick([wheel(40)], [encoder], 60)).rejects.toMatchObject({ code: "robot_offline" });
    await expect(loop.end(["ev3.B"])).rejects.toMatchObject({ code: "robot_offline" });
    await clock.sleep(at + 59 - clock.now());
    expect(fake.busy(1 << B)).toBe(true);
    await clock.sleep(1);
    expect(fake.busy(1 << B)).toBe(false);
  });
});
