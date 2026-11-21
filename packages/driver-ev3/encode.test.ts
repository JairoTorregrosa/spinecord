import { describe, expect, test } from "bun:test";
import golden from "./fixtures/openmindstorms-golden.json";
import * as E from "./encode";

const hex = (b: ArrayLike<number>) => E.toHex(b).replace(/ /g, "").toUpperCase();
const om = (name: string) =>
  (golden.cases as Record<string, { hex: string; globals: number; counter: number; reply: boolean }>)[name];
function sameAsOM(name: string, bytecodes: number[]) {
  const c = om(name);
  expect(E.toHex(E.frame(bytecodes, { counter: c.counter, globals: c.globals, reply: c.reply }))).toBe(c.hex);
}

describe("LEGO Communication Developer Kit hex examples", () => {
  // The PDF prints the counter as "xxxx"; 0x0000 is used here.
  test("4.2.5 tone 1 kHz, level 2, 1 s (no reply)", () => {
    const p = E.frame(E.soundTone(2, 1000, 1000), { counter: 0, reply: false });
    expect(hex(p)).toBe(["0F00", "0000", "8000009401810282E80382E803"].join(""));
    expect(hex(p.subarray(7))).toBe("9401810282E80382E803");
  });
  test("READY_SI on sensor port 3, mode 0, 4 global bytes", () => {
    expect(hex(E.frame(E.inputReadySi(2, 0, 0, 1, 0), { counter: 0, globals: 4 }))).toBe(
      ["0D00", "0000", "000400991D000200000160"].join(""),
    );
  });
  test("READY_SI on sensor port 1, mode 2 (PDF header reserves 4 bytes; its prose says 1)", () => {
    expect(hex(E.frame(E.inputReadySi(0, 0, 2, 1, 0), { counter: 0, globals: 4 }))).toBe(
      ["0D00", "0000", "000400991D000000020160"].join(""),
    );
  });
  test("step example: AE on B+C, speed 50, 0/900/180 degrees, brake", () => {
    // PDF errata: the prose says "MOTOR_A + MOTOR_B" and "21 bytes"; the hex has mask 06 (B+C)
    // and length 0x12 = 18. The opcode AE is OUTPUT_STEP_SPEED, not step-power (AC).
    const p = E.frame(E.outputStepSpeed(E.OUTPUT_MASK.B | E.OUTPUT_MASK.C, 50, 0, 900, 180, true), {
      counter: 0,
      reply: false,
    });
    expect(hex(p)).toBe(["1200", "0000", "800000AE000681320082840382B40001"].join(""));
    expect(p[0]).toBe(18);
  });
});

describe("byte-for-byte against OpenMindstorms encoders", () => {
  const BC = 6;
  const cases: Record<string, number[]> = {
    tone_1000hz_1000ms_vol2: E.soundTone(2, 1000, 1000),
    stop_all_brake: E.outputStop(15, true),
    "power_B_-40": E.outputPower(2, -40),
    speed_BC_75: E.outputSpeed(BC, 75),
    start_BC: E.outputStart(BC),
    step_speed_BC_50_0_900_180_brake: E.outputStepSpeed(BC, 50, 0, 900, 180, true),
    "step_speed_A_-30_0_45_0_coast": E.outputStepSpeed(1, -30, 0, 45, 0, false),
    time_speed_D_20_0_250_0_brake: E.outputTimeSpeed(8, 20, 0, 250, 0, true),
    step_sync_BC_50_0_360_brake: E.outputStepSync(BC, 50, 0, 360, true),
    "step_sync_BC_-30_200_100000_coast": E.outputStepSync(BC, -30, 200, 100000, false),
    "step_sync_BC_30_-200_131_brake": E.outputStepSync(BC, 30, -200, 131, true),
    time_sync_BC_40_0_250_brake: E.outputTimeSync(BC, 40, 0, 250, true),
    read_B: E.outputRead(1, 4, 0),
    get_count_C: E.outputGetCount(2, 0),
    clr_count_BC: E.outputClearCount(BC),
    test_busy_all: E.outputTest(15, 0),
    ready_si_port3_mode0: E.inputReadySi(2, 0, 0, 1, 0),
    ready_si_port1_mode4_x3: E.inputReadySi(0, 0, 4, 3, 0),
    ready_raw_port2_type29_mode2: E.inputReadyRaw(1, 29, 2, 1, 0),
    get_typemode_all8: [0, 1, 2, 3, 16, 17, 18, 19].flatMap((no, i) => E.inputGetTypeMode(no, i * 2, i * 2 + 1)),
    input_stop_all: E.inputStopAll(),
    battery_v_and_pct: [...E.uiBatteryVolts(0), ...E.uiBatteryPct(4)],
    led_orange_pulse: E.uiLed(9),
    button_enter_pressed: E.uiButtonPressed(2, 0),
    fill_window_white: E.drawFillWindow(0, 0, 0),
    text_hola_2_14: E.drawText(1, 2, 14, "Hola"),
    text_far_x100_y110: E.drawText(1, 100, 110, "ev3"),
    update: E.drawUpdate(),
    gv1_index40: E.outputGetCount(0, 40),
    counter_wrap: E.drawUpdate(),
  };
  test("the fixture and this table cover the same cases", () => {
    expect(new Set(Object.keys(cases))).toEqual(new Set(Object.keys(golden.cases)));
  });
  for (const [name, bc] of Object.entries(cases)) test(name, () => sameAsOM(name, bc));
});

describe("parameters", () => {
  test("LC0 / LC1 / LC2 / LC4 / LCS / GV", () => {
    expect(E.lc0(31)).toEqual([0x1f]);
    expect(E.lc0(-1)).toEqual([0x3f]);
    expect(E.lc0(-32)).toEqual([0x20]);
    expect(() => E.lc0(32)).toThrow();
    expect(E.lc1(-1)).toEqual([0x81, 0xff]);
    expect(E.lc2(1000)).toEqual([0x82, 0xe8, 0x03]);
    expect(E.lc4(-2)).toEqual([0x83, 0xfe, 0xff, 0xff, 0xff]);
    expect(E.lcs("A")).toEqual([0x84, 0x41, 0x00]);
    expect(() => E.lcs("ñ")).toThrow();
    expect(E.gv(0)).toEqual([0x60]);
    expect(E.gv(31)).toEqual([0x7f]);
    expect(E.gv(32)).toEqual([0xe1, 32]);
    expect(E.lc(32)).toEqual([0x81, 32]);
    expect(E.lc(128)).toEqual([0x82, 128, 0]);
    expect(E.lc(40000)).toEqual([0x83, 0x40, 0x9c, 0, 0]);
    expect(() => E.lc(1.5)).toThrow();
  });
  test("readParam round-trips every encoding", () => {
    for (const v of [
      0, 1, -1, 31, -32, 32, -33, 127, -128, 128, 900, -900, 32767, -32768, 40000, -40000, 2147483647, -2147483648,
    ]) {
      const b = Uint8Array.from(E.lc(v));
      expect(E.readParam(b, 0)).toEqual({ param: { kind: "const", value: v }, next: b.length });
    }
    expect(E.readParam(Uint8Array.from(E.lcs("hola")), 0).param).toEqual({ kind: "string", value: "hola" });
    for (const i of [0, 5, 31, 32, 255, 256, 1018])
      expect(E.readParam(Uint8Array.from(E.gv(i)), 0).param).toEqual({ kind: "global", value: i });
    expect(() => E.readParam(Uint8Array.from([0x82, 1]), 0)).toThrow();
  });
});

describe("framing", () => {
  test("header packs globals in the low 10 bits and locals in the high 6", () => {
    const p = E.frame([0x01], { counter: 0x1234, globals: 1019, locals: 63 });
    expect(Array.from(p)).toEqual([6, 0, 0x34, 0x12, 0x00, 0xfb, 0xff, 0x01]);
    const d = E.decodeCommand(p);
    expect(d).toMatchObject({ counter: 0x1234, type: 0, globals: 1019, locals: 63 });
    expect(Array.from(d.bytecodes)).toEqual([1]);
  });
  test("limits are enforced", () => {
    expect(() => E.frame([], { counter: 1, globals: 1020 })).toThrow();
    expect(() => E.frame([], { counter: 1, locals: 64 })).toThrow();
    expect(() => E.frame([], { counter: 65536 })).toThrow();
    expect(() =>
      E.frame(
        Array.from({ length: 1018 }, () => 1),
        { counter: 1 },
      ),
    ).toThrow();
  });
  test("decodeReply cuts a padded HID report to 2+len and reads status", () => {
    const report = new Uint8Array(1024);
    report.set([0x07, 0x00, 0x2a, 0x00, 0x02, 0x00, 0x00, 0x20, 0x41, 0xee, 0xee]);
    const r = E.decodeReply(report);
    expect(r).toMatchObject({ counter: 42, ok: true });
    expect(r.globals.length).toBe(4);
    expect(E.readF32(r.globals, 0)).toBe(10);
    expect(E.decodeReply(Uint8Array.from([3, 0, 1, 0, 4])).ok).toBe(false);
    expect(() => E.decodeReply(Uint8Array.from([3, 0, 1, 0, 3]))).toThrow();
    expect(() => E.decodeReply(Uint8Array.from([9, 0, 1, 0, 2]))).toThrow();
    expect(Array.from(E.encodeReply(42, true, [1, 2]))).toEqual([5, 0, 42, 0, 2, 1, 2]);
  });
});

describe("safety of the encoders", () => {
  test("no motion encoder accepts an unbounded step or time", () => {
    expect(() => E.outputStepSync(6, 50, 0, 0)).toThrow();
    expect(() => E.outputTimeSync(6, 50, 0, 0)).toThrow();
    expect(() => E.outputStepSpeed(2, 50, 0, 0, 0)).toThrow();
    expect(() => E.outputTimeSpeed(2, 50, 0, 0, 0)).toThrow();
    expect(() => E.outputStepSync(6, 101, 0, 10)).toThrow();
    expect(() => E.outputStepSync(6, 50, 201, 10)).toThrow();
    expect(() => E.outputStop(16)).toThrow();
    expect(() => E.outputGetCount(4, 0)).toThrow();
  });
  test("the module has no system-command encoder and never frames type 0x01/0x81", () => {
    const names = Object.keys(E);
    expect(
      names.filter(
        (n) => /system|firmware|download|upload/i.test(n) && typeof (E as Record<string, unknown>)[n] === "function",
      ),
    ).toEqual([]);
    expect(Object.values(E.OP)).not.toContain(0xaa); // OUTPUT_READY blocks the brick
    expect(Object.values(E.OP)).not.toContain(0xa0);
    for (const reply of [true, false]) {
      const type = E.frame([0x01], { counter: 1, reply })[4];
      expect([E.TYPE_DIRECT_REPLY, E.TYPE_DIRECT_NO_REPLY]).toContain(type);
    }
  });
});
