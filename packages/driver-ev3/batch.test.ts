// Round trips: reads that travel together, and how often a running operation is asked about.
import { describe, expect, test } from "bun:test";
import * as E from "./encode";
import { EmulatedClock, FakeEV3 } from "./fake";
import { Ev3Link, type Ev3Error } from "./link";
import { EXAMPLE_EV3_HARDWARE, Ev3Provider, type Ev3ProviderOptions } from "./provider";
import {
  APPROACH_SEEN,
  APPROACH_UNSEEN,
  END_SLACK_MS,
  MIN_RATE_WINDOW_MS,
  nextPollDelay,
  observedRate,
} from "./schedule";

const RATE = 1000;
const CONFIG: Ev3ProviderOptions = {
  limits: { max_speed_pct: 100, max_command_ms: 20000 },
  hardware: EXAMPLE_EV3_HARDWARE,
  pair: { left: "B", right: "C" },
  degPerSecAt100: RATE,
  pollMs: 2,
  timeoutMs: 200,
};
const never = () => new AbortController().signal;
const code = (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e) => (e as Ev3Error).code,
  );
const bytecodes = (fake: FakeEV3, i: number) => E.toHex(E.decodeCommand(fake.sent[i].packet).bytecodes);

describe("link.read: reads queued together are one direct command", () => {
  test("each read gets its own slice of the reply", async () => {
    const fake = new FakeEV3({ batteryV: 7.5, batteryPct: 61 });
    fake.motors[1].pos = 1234;
    const link = new Ev3Link(fake, { timeoutMs: 100 });
    const [volts, pct, count] = await Promise.all([
      link.read(E.uiBatteryVolts, 4),
      link.read(E.uiBatteryPct, 1),
      link.read((b) => E.outputGetCount(1, b), 4),
    ]);
    expect(fake.sent.length).toBe(1);
    expect(link.packets).toBe(1);
    // 81 01 GV0(0) | 81 12 GV0(4) | B3 00 01 GV0(5), 9 reply bytes
    expect(bytecodes(fake, 0)).toBe("81 01 60 81 12 64 b3 00 01 65");
    expect(E.decodeCommand(fake.sent[0].packet).globals).toBe(9);
    expect(E.readF32(volts, 0)).toBeCloseTo(7.5, 5);
    expect([...pct]).toEqual([61]);
    expect(E.readI32(count, 0)).toBe(1234);
  });

  test("reads that arrive while a packet is in flight share the next one", async () => {
    const fake = new FakeEV3();
    fake.replyDelayMs = 10;
    const link = new Ev3Link(fake, { timeoutMs: 200 });
    const first = link.read(E.uiBatteryPct, 1);
    await new Promise((r) => setTimeout(r, 2));
    const late = [link.read(E.uiBatteryPct, 1), link.read(E.uiBatteryPct, 1), link.read(E.uiBatteryPct, 1)];
    for (const g of await Promise.all([first, ...late])) expect(g[0]).toBe(85);
    expect(fake.sent.map((s) => s.opcodes.length)).toEqual([1, 3]);
    expect(fake.overlaps).toBe(0);
  });

  test("a command keeps its place: reads on either side of it do not merge across it", async () => {
    const fake = new FakeEV3();
    const link = new Ev3Link(fake, { timeoutMs: 100 });
    await Promise.all([
      link.read(E.uiBatteryPct, 1),
      link.read(E.uiBatteryPct, 1),
      link.command(E.uiLed(2)),
      link.read(E.uiBatteryPct, 1),
    ]);
    expect(fake.sent.map((s) => s.opcodes)).toEqual([[E.OP.UI_READ, E.OP.UI_READ], [E.OP.UI_WRITE], [E.OP.UI_READ]]);
  });

  test("the brick rejects a shared packet: each read goes again alone, and only the one at fault fails", async () => {
    const fake = new FakeEV3();
    const link = new Ev3Link(fake, { timeoutMs: 100 });
    const results = await Promise.all([
      code(link.read(E.uiBatteryPct, 1).then((g) => expect(g[0]).toBe(85))),
      code(link.read(() => [0xfe], 0)),
      code(link.read(E.uiBatteryPct, 1).then((g) => expect(g[0]).toBe(85))),
    ]);
    expect(results).toEqual(["resolved", "brick_error", "resolved"]);
    expect(fake.sent.length).toBe(4); // together, then one by one
    expect(fake.overlaps).toBe(0);
  });

  test("a lost reply fails every read of the packet and is not sent again", async () => {
    const fake = new FakeEV3();
    const link = new Ev3Link(fake, { timeoutMs: 40 });
    fake.dropNext(1);
    expect(await Promise.all([code(link.read(E.uiBatteryPct, 1)), code(link.read(E.uiBatteryPct, 1))])).toEqual([
      "no_reply",
      "no_reply",
    ]);
    expect(fake.sent.length).toBe(1);
  });

  test("more reads than one direct command holds are split at the firmware's limits", async () => {
    const fake = new FakeEV3({ batteryV: 8.25 });
    const link = new Ev3Link(fake, { timeoutMs: 200 });
    const n = 600; // 2400 reply bytes: over the 1019 a reply holds, and over 1024 bytes of bytecodes
    const all = await Promise.all(Array.from({ length: n }, () => link.read(E.uiBatteryVolts, 4)));
    for (const g of all) expect(E.readF32(g, 0)).toBeCloseTo(8.25, 5);
    expect(fake.sent.length).toBeGreaterThan(2);
    expect(fake.sent.reduce((sum, s) => sum + s.opcodes.length, 0)).toBe(n);
    for (const s of fake.sent) {
      expect(s.packet.length).toBeLessThanOrEqual(E.MAX_MESSAGE);
      expect(E.decodeCommand(s.packet).globals).toBeLessThanOrEqual(E.MAX_GLOBALS);
    }
    expect(fake.errors).toEqual([]);
  });

  test("the reply buffer is the limit when the bytecodes are short", async () => {
    const fake = new FakeEV3();
    const link = new Ev3Link(fake, { timeoutMs: 200 });
    // 3 reads of 400 reply bytes each: two fit in 1019, the third opens a second packet
    const all = await Promise.all([0, 1, 2].map(() => link.read((b) => E.uiBatteryPct(b + 399), 400)));
    for (const g of all) expect(g[399]).toBe(85);
    expect(fake.sent.map((s) => E.decodeCommand(s.packet).globals)).toEqual([800, 400]);
  });

  test("a read too large for any packet fails by itself with bad_param", async () => {
    const fake = new FakeEV3();
    const link = new Ev3Link(fake, { timeoutMs: 100 });
    expect(await code(link.read(E.uiBatteryPct, E.MAX_GLOBALS + 1))).toBe("bad_param");
    expect(fake.sent.length).toBe(0);
    expect((await link.read(E.uiBatteryPct, 1))[0]).toBe(85);
  });

  test("an urgent command goes ahead of waiting reads; held, reads wait", async () => {
    const fake = new FakeEV3();
    const link = new Ev3Link(fake, { timeoutMs: 100 });
    const release = link.hold();
    const read = link.read(E.uiBatteryPct, 1);
    await link.command(E.outputStop(0x0f, true), 0, { urgent: true });
    expect(fake.sent.map((s) => s.opcodes[0])).toEqual([E.OP.OUTPUT_STOP]);
    release();
    expect((await read)[0]).toBe(85);
  });
});

describe("Ev3Provider: a read of every device is one packet", () => {
  function rig() {
    const fake = new FakeEV3({ degPerSecAt100: RATE, batteryV: 7.5 });
    fake.setSensor(1, 16, 1);
    fake.setSensor(4, 30, 42.5);
    fake.motors[1].pos = 100;
    fake.motors[2].pos = -7;
    fake.buttonsDown.add(2);
    return { fake, ev3: new Ev3Provider(fake, CONFIG) };
  }

  test("golden bytes of the shared command, and every reading decoded from its own slice", async () => {
    const { fake, ev3 } = rig();
    const specs = await ev3.devices();
    const before = fake.sent.length;
    const all = (await Promise.all(specs.map((d) => ev3.read(d.id)))).flat();
    expect(fake.sent.length - before).toBe(1);
    const cmd = E.decodeCommand(fake.sent[before].packet);
    expect(cmd.globals).toBe(40);
    expect(E.toHex(cmd.bytecodes)).toBe(
      [
        "a8 00 01 64 60", // B: speed at 4, tacho at 0
        "a8 00 02 69 65", // C: speed at 9, tacho at 5
        "b3 00 01 6a b3 00 02 6e", // pair: tachos at 10 and 14
        "99 1d 00 00 00 3f 01 72 99 05 00 00 76 77", // S1: one SI value at 18 (type, mode kept), type/mode at 22, 23
        "99 1d 00 03 00 3f 01 78 99 05 00 03 7c 7d", // S4: value at 24, type/mode at 28, 29
        "83 09 01 7e 83 09 02 7f 83 09 03 e1 20 83 09 04 e1 21 83 09 05 e1 22 83 09 06 e1 23", // buttons at 30..35
        "81 01 e1 24", // battery volts at 36
      ].join(" "),
    );
    const got = Object.fromEntries(all.map((r) => [`${r.device}.${r.channel}`, r.value]));
    expect(got).toEqual({
      "ev3.B.position_deg": 100,
      "ev3.B.speed_deg_s": 0,
      "ev3.B.stalled": false,
      "ev3.B.power_pct": 0,
      "ev3.C.position_deg": -7,
      "ev3.C.speed_deg_s": 0,
      "ev3.C.stalled": false,
      "ev3.C.power_pct": 0,
      "ev3.pair.left_deg": 100,
      "ev3.pair.right_deg": -7,
      "ev3.S1.pressed": true,
      "ev3.S1.presses": null, // another mode: not read, nothing switched
      "ev3.S4.distance_cm": 42.5,
      "ev3.buttons.pressed": ["enter"],
      "ev3.battery.voltage_v": 7.5,
      "ev3.battery.low": false,
    });
    expect(fake.modeSwitches).toBe(0);
    expect(fake.errors).toEqual([]);
  });

  test("a sensor swapped since the scan is reported on its own device; the others read", async () => {
    const { fake, ev3 } = rig();
    const specs = await ev3.devices();
    fake.unplugSensor(4);
    fake.setSensor(4, 29, 33);
    const all = (await Promise.all(specs.map((d) => ev3.read(d.id)))).flat();
    const s4 = all.filter((r) => r.device === "ev3.S4");
    expect(s4.length).toBeGreaterThan(0);
    expect(s4.every((r) => r.value === null && /changed/.test(r.error!))).toBe(true);
    expect(all.find((r) => r.channel === "voltage_v")!.value).toBe(7.5);
    expect(all.find((r) => r.device === "ev3.S1" && r.channel === "pressed")!.value).toBe(true);
  });
});

describe("how often a running operation is asked about", () => {
  test("a time operation is asked once, right after the brick ends it", () => {
    expect(nextPollDelay({ pollMs: 10, rttMs: 0, endInMs: 200 })).toBe(200 + END_SLACK_MS);
    // the question is answered one round trip later: it leaves that much earlier
    expect(nextPollDelay({ pollMs: 10, rttMs: 4, endInMs: 200 })).toBe(200 + END_SLACK_MS - 4);
    // the end was missed (the brick is late): back to the fixed tick
    expect(nextPollDelay({ pollMs: 10, rttMs: 4, endInMs: -3 })).toBe(10);
    expect(nextPollDelay({ pollMs: 10, rttMs: 300, endInMs: 200 })).toBe(10);
  });

  test("a degree target: half the way on the calibration alone, close once the encoder showed the speed", () => {
    const base = { pollMs: 10, rttMs: 0, endInMs: 250, remainingDeg: 60, rateDegS: 300 }; // 200 ms to go
    expect(nextPollDelay(base)).toBeCloseTo(200 * APPROACH_UNSEEN, 9);
    expect(nextPollDelay({ ...base, rateSeen: true })).toBeCloseTo(200 * APPROACH_SEEN, 9);
    expect(nextPollDelay({ ...base, rateSeen: true, rttMs: 30 })).toBeCloseTo(200 * APPROACH_SEEN - 30, 9);
    // near the target: the fixed tick
    expect(nextPollDelay({ ...base, rateSeen: true, remainingDeg: 2 })).toBe(10);
    expect(nextPollDelay({ ...base, rateSeen: true, remainingDeg: -5 })).toBe(10);
    // a target the motor cannot reach in the time bound: the end of the operation comes first
    expect(nextPollDelay({ ...base, rateSeen: true, remainingDeg: 9000, endInMs: 120 })).toBe(120 + END_SLACK_MS);
    expect(() => nextPollDelay({ ...base, rateDegS: 0 })).toThrow(RangeError);
  });

  test("the whole approach to a target takes a handful of questions, and the last ones are a tick apart", () => {
    // a motor exactly as fast as configured, asked at the moments the schedule gives
    const rate = 300,
      target = 60,
      pollMs = 10;
    let t = 0,
      seen = false,
      asked = 0;
    const at = () => (rate * t) / 1000;
    while (at() < target) {
      const wait = nextPollDelay({
        pollMs,
        rttMs: 0,
        endInMs: 250 - t,
        remainingDeg: target - at(),
        rateDegS: rate,
        rateSeen: seen,
      });
      seen ||= observedRate((rate * wait) / 1000, wait) !== null;
      t += wait;
      asked++;
    }
    expect(asked).toBeLessThanOrEqual(4); // far fewer than the 20 questions of one per 10 ms tick
    expect(at() - target).toBeLessThanOrEqual((rate * pollMs) / 1000); // no later than one tick past the target
  });

  test("a speed is only read off the encoder over a window long enough to mean something", () => {
    expect(observedRate(3, MIN_RATE_WINDOW_MS - 1)).toBeNull();
    expect(observedRate(30, 100)).toBe(300);
    expect(observedRate(-4, 100)).toBe(0);
  });

  const packets = (fake: FakeEV3, from: number) => fake.sent.slice(from).map((s) => s.opcodes);
  const B3 = E.OP.OUTPUT_GET_COUNT,
    A9 = E.OP.OUTPUT_TEST;

  test("run_time: the start travels with the tacho read, then a question at the end, then the rest position", async () => {
    const fake = new FakeEV3({ degPerSecAt100: RATE });
    const ev3 = new Ev3Provider(fake, { ...CONFIG, pollMs: 10 });
    await ev3.devices();
    const from = fake.sent.length;
    const r = await ev3.command("ev3.B", "run_time", { ms: 150, speed_pct: 40 }, never());
    expect(r.reason).toBe("completed");
    expect(Math.abs((r.measured.degrees as number) - 60)).toBeLessThanOrEqual(2);
    const sent = packets(fake, from);
    expect(sent[0]).toEqual([B3, E.OP.OUTPUT_TIME_SPEED]);
    for (const p of sent.slice(1)) expect(p).toEqual([B3, A9]);
    expect(sent.length).toBeLessThanOrEqual(4); // one question per tick would be about 18
    expect(fake.errors).toEqual([]);
  });

  test("run_pair coasting to a degree target: few questions, the stop carries the last read", async () => {
    const fake = new FakeEV3({ degPerSecAt100: RATE });
    const ev3 = new Ev3Provider(fake, CONFIG);
    await ev3.devices();
    const from = fake.sent.length;
    const r = await ev3.command(
      "ev3.pair",
      "run_pair",
      { left_deg: 60, right_deg: 60, speed_pct: 30, brake: false },
      never(),
    );
    expect(r.reason).toBe("completed");
    expect(r.measured.left_deg as number).toBeGreaterThanOrEqual(60);
    expect(r.measured.left_deg as number).toBeLessThanOrEqual(60 + 12);
    const sent = packets(fake, from);
    expect(sent[0]).toEqual([B3, B3, E.OP.OUTPUT_TIME_SYNC]);
    expect(sent.at(-1)).toEqual([E.OP.OUTPUT_STOP, B3, B3, A9]);
    expect(sent.length).toBeLessThanOrEqual(8); // one question per 2 ms tick of this test would be about 100
    expect(fake.errors).toEqual([]);
  });

  test("a motor half again as fast as its calibration is still braked at the target, not at the time bound", async () => {
    const fake = new FakeEV3({ degPerSecAt100: RATE * 1.5 });
    const ev3 = new Ev3Provider(fake, CONFIG);
    await ev3.devices();
    const r = await ev3.command("ev3.B", "run_degrees", { degrees: 60, speed_pct: 40 }, never());
    expect(r.reason).toBe("completed");
    // unwatched it would run its whole time bound: 210 ms at 600 deg/s = 126 degrees
    expect(r.measured.degrees as number).toBeLessThanOrEqual(60 + 30);
  });

  test("a preempted motion never begins: aborted while its start waits in the queue, the packet carries the read alone", async () => {
    for (const [device, command, args] of [
      ["ev3.pair", "run_pair", { left_deg: 90, right_deg: 90, speed_pct: 30 }],
      ["ev3.B", "run_time", { ms: 200, speed_pct: 40 }],
      ["ev3.B", "run_degrees", { degrees: 90, speed_pct: 40 }],
    ] as const) {
      const fake = new FakeEV3({ degPerSecAt100: RATE });
      const ev3 = new Ev3Provider(fake, CONFIG);
      await ev3.devices();
      fake.replyDelayMs = 30; // the packet ahead stays in flight this long
      const from = fake.sent.length;
      const ahead = ev3.link.command(E.uiBatteryPct(0), 1); // on the wire at once
      const ac = new AbortController();
      const run = ev3.command(device, command, args, ac.signal);
      await new Promise((r) => setTimeout(r, 5));
      expect(packets(fake, from)).toEqual([[E.OP.UI_READ]]); // only the read ahead is on the wire; the start is queued
      ac.abort();
      const r = await run;
      await ahead;
      expect(r.reason).toBe("preempted");
      expect(r.measured).toEqual({});
      const sent = packets(fake, from);
      // what went out for the operation: the tacho read, and no output opcode at all (no start, no stop)
      expect(sent.slice(1)).toEqual([device === "ev3.pair" ? [B3, B3] : [B3]]);
      for (const p of sent) for (const o of p) expect(o >= 0xa3 && o <= 0xb2).toBe(false);
      expect(fake.busy()).toBe(false);
      expect([fake.tacho("B"), fake.tacho("C")]).toEqual([0, 0]);
      expect(fake.unboundedMoves).toBe(0);
      // the ports are free again
      fake.replyDelayMs = 0;
      expect((await ev3.command("ev3.B", "run_time", { ms: 20, speed_pct: 40 }, never())).reason).toBe("completed");
    }
  });

  test("an abort after the start is on the wire takes the brake path", async () => {
    // On emulated time, with the start's reply held by the test: the abort lands while that reply is on its way,
    // and the travel is what the provider allowed, whatever the load on this machine.
    const clock = new EmulatedClock();
    const fake = new FakeEV3({ degPerSecAt100: RATE, now: clock.now });
    const ev3 = new Ev3Provider(fake, { ...CONFIG, now: clock.now, sleep: clock.sleep });
    await ev3.devices();
    const from = fake.sent.length;
    const send = fake.send.bind(fake);
    let arrived: () => void = () => {};
    const startArrived = new Promise<void>((r) => (arrived = r));
    let release: () => void = () => {};
    const released = new Promise<void>((r) => (release = r));
    fake.send = (bytes) => {
      const reply = send(bytes);
      if (!fake.sent.at(-1)!.opcodes.includes(E.OP.OUTPUT_TIME_SPEED)) return reply;
      arrived();
      return released.then(() => reply);
    };
    const ac = new AbortController();
    const run = ev3.command("ev3.B", "run_time", { ms: 250, speed_pct: 40 }, ac.signal);
    await startArrived;
    expect(packets(fake, from)).toEqual([[B3, E.OP.OUTPUT_TIME_SPEED]]); // already sent, reply still on its way
    clock.advance(20); // the reply's flight: 8 degrees at 400 deg/s
    ac.abort();
    release();
    const r = await run;
    expect(r.reason).toBe("preempted");
    expect(packets(fake, from).some((p) => p[0] === E.OP.OUTPUT_STOP)).toBe(true);
    expect(fake.busy()).toBe(false);
    expect(r.measured.degrees as number).toBeGreaterThanOrEqual(8); // it did move: the start ran
    expect(r.measured.degrees as number).toBeLessThan(40); // 250 ms unwatched would be 100 degrees
  });

  test("an abort does not wait for the next question", async () => {
    const fake = new FakeEV3({ degPerSecAt100: RATE });
    const ev3 = new Ev3Provider(fake, { ...CONFIG, pollMs: 10 });
    await ev3.devices();
    const ac = new AbortController();
    const t0 = performance.now();
    const run = ev3.command("ev3.B", "run_time", { ms: 250, speed_pct: 40 }, ac.signal);
    setTimeout(() => ac.abort(), 30);
    const r = await run;
    expect(r.reason).toBe("preempted");
    expect(performance.now() - t0).toBeLessThan(200); // the operation itself lasts 250 ms
    expect(fake.busy()).toBe(false);
  });
});
