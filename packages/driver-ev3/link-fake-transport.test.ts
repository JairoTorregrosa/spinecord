import { describe, expect, test } from "bun:test";
import * as E from "./encode";
import { FakeEV3 } from "./fake";
import { Ev3Error, Ev3Link } from "./link";
import { WebHIDTransport, outputReportSize, type HidDeviceLike } from "./transport";

const code = (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e) => (e as Ev3Error).code,
  );

describe("link: one command at a time, fail loud", () => {
  test("a dropped reply rejects with no_reply after the timeout", async () => {
    const fake = new FakeEV3();
    const link = new Ev3Link(fake, { timeoutMs: 50 });
    fake.dropNext(1);
    const t0 = performance.now();
    expect(await code(link.command(E.uiBatteryPct(0), 1))).toBe("no_reply");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(45);
    expect((await link.command(E.uiBatteryPct(0), 1))[0]).toBe(85);
  });
  test("a late reply to a timed-out command is not taken for the next one", async () => {
    const fake = new FakeEV3();
    const link = new Ev3Link(fake, { timeoutMs: 40 });
    fake.replyDelayMs = 80;
    expect(await code(link.command(E.uiBatteryPct(0), 1))).toBe("no_reply");
    await new Promise((r) => setTimeout(r, 60));
    fake.replyDelayMs = 0;
    fake.batteryPct = 33;
    expect((await link.command(E.uiBatteryPct(0), 1))[0]).toBe(33);
  });
  test("an error reply (0x04), a wrong counter, a short reply and a broken transport reject", async () => {
    const fake = new FakeEV3();
    const link = new Ev3Link(fake, { timeoutMs: 100 });
    expect(await code(link.command([0xfe], 0))).toBe("brick_error");
    const liar = new Ev3Link(
      { send: async (b) => E.encodeReply(((b[2] | (b[3] << 8)) + 1) & 0xffff, true) },
      { timeoutMs: 100 },
    );
    expect(await code(liar.command(E.drawUpdate()))).toBe("bad_reply");
    const short = new Ev3Link({ send: async (b) => E.encodeReply(b[2] | (b[3] << 8), true, [1]) }, { timeoutMs: 100 });
    expect(await code(short.command(E.uiBatteryVolts(0), 4))).toBe("bad_reply");
    const broken = new Ev3Link(
      {
        send: async () => {
          throw new Error("unplugged");
        },
      },
      { timeoutMs: 100 },
    );
    expect(await code(broken.command(E.drawUpdate()))).toBe("transport");
  });
  test("30 concurrent calls never overlap on the wire, counters increase", async () => {
    const fake = new FakeEV3();
    fake.replyDelayMs = 1;
    const link = new Ev3Link(fake, { timeoutMs: 500 });
    await Promise.all(Array.from({ length: 30 }, () => link.command(E.uiBatteryPct(0), 1)));
    expect(fake.overlaps).toBe(0);
    expect(fake.sent.map((s) => s.counter)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });
  test("urgent commands overtake queued ones; droppable ones are rejected by dropQueued", async () => {
    const fake = new FakeEV3();
    fake.replyDelayMs = 5;
    const link = new Ev3Link(fake, { timeoutMs: 500 });
    const a = link.command(E.uiBatteryPct(0), 1);
    const b = link.command(E.outputStepSync(6, 20, 0, 10), 0, { droppable: true });
    const c = link.command(E.uiLed(1));
    expect(link.dropQueued()).toBe(1);
    const d = link.command(E.outputStop(15), 0, { urgent: true });
    expect(await code(b)).toBe("stopped");
    await Promise.all([a, c, d]);
    expect(fake.sent.map((s) => s.opcodes[0])).toEqual([E.OP.UI_READ, E.OP.OUTPUT_STOP, E.OP.UI_WRITE]);
  });
});

describe("link: hold and urgent drop", () => {
  test("while held only urgent commands go out; release sends the rest; dropQueued(true) drops urgent ones too", async () => {
    const fake = new FakeEV3();
    fake.replyDelayMs = 2;
    const link = new Ev3Link(fake, { timeoutMs: 500 });
    const release = link.hold();
    const normal = link.command(E.uiLed(1));
    await link.command(E.outputStop(15), 0, { urgent: true });
    await link.command(E.outputTest(15, 0), 1, { urgent: true });
    expect(fake.sent.map((s) => s.opcodes[0])).toEqual([E.OP.OUTPUT_STOP, E.OP.OUTPUT_TEST]);
    release();
    release();
    await normal;
    expect(fake.sent.length).toBe(3);
    const a = link.command(E.uiBatteryPct(0), 1);
    const u = link.command(E.outputStop(2), 0, { urgent: true });
    const d = link.command(E.outputTimeSpeed(2, 10, 0, 10, 0), 0, { droppable: true });
    const keep = link.command(E.uiLed(2));
    expect(link.dropQueued(true)).toBe(2);
    expect(await code(u)).toBe("stopped");
    expect(await code(d)).toBe("stopped");
    await Promise.all([a, keep]);
  });
});

describe("fake: refuses what must never be sent, simulates sensors", () => {
  test("system commands (0xA0 ENTERFWUPDATE lives there) and no-reply commands are refused", async () => {
    const fake = new FakeEV3();
    const fw = Uint8Array.from([0x04, 0x00, 0x01, 0x00, 0x81, 0xa0]);
    await expect(fake.send(fw)).rejects.toThrow(/system command/);
    await expect(fake.send(E.frame(E.drawUpdate(), { counter: 1, reply: false }))).rejects.toThrow(/without reply/);
  });
  test("sensor values per mode, type/mode report, empty port NaN, buttons, battery", async () => {
    const fake = new FakeEV3();
    const link = new Ev3Link(fake, { timeoutMs: 100 });
    fake.setSensor(3, 29, 42);
    fake.setSensor(3, 29, [10, 20, 30], 4);
    let g = await link.command(E.inputReadySi(2, 29, 0, 1, 0), 4);
    expect(E.readF32(g, 0)).toBe(42);
    g = await link.command(E.inputReadySi(2, 29, 4, 3, 0), 12);
    expect([0, 4, 8].map((o) => E.readF32(g, o))).toEqual([10, 20, 30]);
    expect(fake.modeSwitches).toBe(1);
    g = await link.command(
      [...E.inputGetTypeMode(2, 0, 1), ...E.inputGetTypeMode(0, 2, 3), ...E.inputGetTypeMode(17, 4, 5)],
      6,
    );
    expect(Array.from(g)).toEqual([29, 4, 126, 0, 7, 0]);
    expect(Number.isNaN(E.readF32(await link.command(E.inputReadySi(0, 0, 0, 1, 0), 4), 0))).toBe(true);
    fake.buttonsDown.add(2);
    g = await link.command([...E.uiButtonPressed(1, 0), ...E.uiButtonPressed(2, 1), ...E.uiButtonPressed(7, 2)], 3);
    expect(Array.from(g)).toEqual([0, 1, 1]);
    g = await link.command([...E.uiBatteryVolts(0), ...E.uiBatteryPct(4)], 5);
    expect(E.readF32(g, 0)).toBeCloseTo(7.9, 5);
    expect(g[4]).toBe(85);
  });
});

function clocked() {
  let t = 0;
  const fake = new FakeEV3({ now: () => t, degPerSecAt100: 1000 });
  const link = new Ev3Link(fake, { timeoutMs: 100 });
  return {
    fake,
    link,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

const runSync = async (turn: number) => {
  const { fake, link, tick } = clocked();
  await link.command(E.outputStepSync(6, 50, turn, 100));
  tick(100);
  expect(fake.busy(6)).toBe(true);
  tick(2000);
  expect(fake.busy(6)).toBe(false);
  return [fake.tacho("B"), fake.tacho("C")];
};

describe("fake motors follow the firmware's sync rules", () => {
  test("step sync: straight, one wheel stopped (turn 100), spin (turn 200), mirrored for negative turn", async () => {
    expect(await runSync(0)).toEqual([100, 100]);
    expect(await runSync(100)).toEqual([100, 0]);
    expect(await runSync(200)).toEqual([100, -100]);
    expect(await runSync(50)).toEqual([100, 50]);
    expect(await runSync(-100)).toEqual([0, 100]);
    expect(await runSync(-200)).toEqual([-100, 100]);
  });
  test("tacho advances with time at speed x rate, busy clears at the target, A8/B3/B2 agree", async () => {
    const { fake, link, tick } = clocked();
    await link.command(E.outputStepSpeed(1, -40, 0, 200, 0));
    tick(250); // 400 deg/s for 0.25 s
    let g = await link.command([...E.outputRead(0, 4, 0), ...E.outputTest(1, 5)], 6);
    expect(E.readI32(g, 0)).toBe(-100);
    expect(E.readI8(g, 4)).toBe(-40);
    expect(g[5]).toBe(1);
    tick(1000);
    g = await link.command([...E.outputGetCount(0, 0), ...E.outputTest(1, 4)], 5);
    expect(E.readI32(g, 0)).toBe(-200);
    expect(g[4]).toBe(0);
    await link.command(E.outputClearCount(1));
    expect(fake.tacho("A")).toBe(0);
  });
  test("time-bounded moves stop on time; brake stops at once", async () => {
    const { fake, link, tick } = clocked();
    await link.command(E.outputTimeSync(6, 20, 0, 250));
    tick(100);
    expect(fake.tacho("B")).toBe(20);
    tick(500);
    expect(fake.tacho("B")).toBe(50);
    expect(fake.busy()).toBe(false);
    await link.command(E.outputStepSync(6, 100, 0, 5000));
    tick(100);
    await link.command(E.outputStop(15));
    tick(1000);
    expect(fake.tacho("C")).toBe(150);
    expect(fake.unboundedMoves).toBe(0);
  });
  test("a command sent while another is in flight is ignored, like the brick does", async () => {
    const fake = new FakeEV3();
    fake.replyDelayMs = 20;
    const first = fake.send(E.frame(E.uiBatteryPct(0), { counter: 1, globals: 1 }));
    const second = fake.send(E.frame(E.uiBatteryPct(0), { counter: 2, globals: 1 }));
    const winner = await Promise.race([second.then(() => "second"), first.then(() => "first")]);
    expect(winner).toBe("first");
    expect(fake.overlaps).toBe(1);
  });
});

function device(reportBytes: number) {
  const listeners: ((ev: { data: DataView }) => void)[] = [];
  const reports: { id: number; data: Uint8Array }[] = [];
  const dev: HidDeviceLike = {
    opened: false,
    vendorId: 0x0694,
    productId: 0x0005,
    collections: [{ outputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: reportBytes }] }] }],
    open: async () => {
      dev.opened = true;
    },
    close: async () => {
      dev.opened = false;
    },
    sendReport: async (id, data) => {
      reports.push({ id, data: data.slice() });
    },
    addEventListener: (_t, l) => {
      listeners.push(l);
    },
    removeEventListener: (_t, l) => {
      listeners.splice(listeners.indexOf(l), 1);
    },
  };
  const input = (bytes: number[]) => {
    const buf = new Uint8Array(reportBytes);
    buf.set(bytes);
    for (const l of listeners) l({ data: new DataView(buf.buffer) });
  };
  return { dev, reports, input, listeners };
}

describe("WebHID transport", () => {
  for (const size of [1024, 64]) {
    test(`pads to the ${size}-byte output report on report id 0 and cuts the reply to 2+len`, async () => {
      const { dev, reports, input } = device(size);
      const t = await WebHIDTransport.open(dev);
      expect(dev.opened).toBe(true);
      expect(t.reportSize).toBe(size);
      const packet = E.frame(E.uiBatteryPct(0), { counter: 9, globals: 1 });
      const reply = t.send(packet);
      await Promise.resolve();
      expect(reports.length).toBe(1);
      expect(reports[0].id).toBe(0);
      expect(reports[0].data.length).toBe(size);
      expect(Array.from(reports[0].data.subarray(0, packet.length))).toEqual(Array.from(packet));
      expect(reports[0].data.subarray(packet.length).every((b) => b === 0)).toBe(true);
      input([4, 0, 8, 0, 2, 99]); // stale reply from an earlier, timed-out command: ignored
      input([4, 0, 9, 0, 2, 77, 0xee, 0xee]);
      expect(Array.from(await reply)).toEqual([4, 0, 9, 0, 2, 77]);
    });
  }
  test("works under the link end to end, and a silent device times out", async () => {
    const { dev, reports, input } = device(1024);
    const t = await WebHIDTransport.open(dev);
    const link = new Ev3Link(t, { timeoutMs: 40 });
    const p = link.command(E.uiBatteryPct(0), 1);
    await new Promise((r) => setTimeout(r, 5));
    input([4, 0, reports[0].data[2], reports[0].data[3], 2, 61]);
    expect((await p)[0]).toBe(61);
    expect(await code(link.command(E.uiBatteryPct(0), 1))).toBe("no_reply");
  });
  test("fails loud on a wrong device, a missing descriptor or an oversized packet", async () => {
    const { dev } = device(64);
    await expect(WebHIDTransport.open({ ...dev, productId: 0x0006 })).rejects.toThrow(/not an EV3/);
    expect(() => outputReportSize({ ...dev, collections: [] })).toThrow(/report size/);
    const t = await WebHIDTransport.open(dev);
    await expect(t.send(new Uint8Array(65))).rejects.toThrow(/does not fit/);
    await expect(
      WebHIDTransport.request({ requestDevice: async () => [], getDevices: async () => [] }),
    ).rejects.toThrow(/no EV3/);
  });
});
