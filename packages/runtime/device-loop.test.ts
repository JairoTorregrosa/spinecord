// The runtime's side of a loop that runs on a device (CONTRACT §4, §5a), over a provider whose device is scripted,
// on virtual time: planning hands the plan to the device, the report is built from its telemetry, and every end
// (the device's, a stop's, a refused start, a device that never answers) is the first cause and is bounded.
import { describe, expect, test } from "bun:test";
import type {
  DeviceSpec,
  LoopEnd,
  LoopEvent,
  LoopPlan,
  LoopSpec,
  LoopTelemetry,
  Provider,
  ProviderLoop,
  RobotProfile,
} from "../protocol/types";
import { RuntimeError } from "../protocol/types";
import { FakeClock } from "./clock";
import { createRuntime } from "./runtime";

const motor: DeviceSpec = {
  id: "d.m",
  provider: "d",
  kind: "motor",
  roles: [],
  description: "a motor whose loops run on its device",
  channels: [{ name: "position_deg", type: "number", unit: "deg", description: "encoder" }],
  commands: [
    {
      name: "power",
      description: "timed power",
      moves: true,
      bound: { kind: "ms", params: ["ms"], max: 250 },
      params: {
        type: "object",
        properties: { power_pct: { type: "number", minimum: -100, maximum: 100 }, ms: { type: "number" } },
        required: ["power_pct", "ms"],
      },
      drives: { arg: "power_pct", max_hold_ms: 250 },
    },
  ],
};

/** A device provider whose device is the test: it records what it was handed and answers as told. */
class DeviceProvider implements Provider {
  readonly id = "d";
  readonly backend = "ev3dev";
  readonly stop_worst_ms = 100;
  plans: LoopPlan[] = [];
  on: ((ev: LoopEvent) => void) | null = null;
  ends = 0;
  sets: { params: Record<string, number>; ramp_ms: number }[] = [];
  refuse: Error | null = null;
  refusePlan: RuntimeError | null = null;
  answersEnd = true;
  private finish: ((e: LoopEnd) => void) | null = null;
  readonly loop: ProviderLoop = {
    runs_on: "device",
    max_rate_hz: 50,
    check: () => {
      if (this.refusePlan) throw this.refusePlan;
    },
    start: async (plan, on) => {
      if (this.refuse) throw this.refuse;
      this.plans.push(plan);
      this.on = on;
      const ended = new Promise<LoopEnd>((resolve) => (this.finish = resolve));
      return {
        set: async (params, ramp_ms) => void this.sets.push({ params, ramp_ms }),
        end: async () => {
          this.ends++;
          if (this.answersEnd) this.endWith({ reason: "preempted" });
        },
        ended,
      };
    },
  };
  /** The device says how its loop ended. */
  endWith(end: LoopEnd, extra: Omit<Extract<LoopEvent, { t: "end" }>, "t" | "end"> = {}): void {
    this.on?.({ t: "end", end, ...extra });
    this.finish?.(end);
  }
  async devices() {
    return [structuredClone(motor)];
  }
  async read() {
    return [];
  }
  async command(): Promise<never> {
    throw new Error("not used");
  }
  async stop() {
    return { motors_stopped: true };
  }
}

const PROFILE: RobotProfile = {
  id: "d1",
  roles: {},
  notes: [],
  limits: { max_speed_pct: 80, max_command_ms: 10000, max_program_ms: 20000, max_loop_ms: 60000 },
};
async function rig(extra: (clock: FakeClock) => Provider[] = () => []) {
  const clock = new FakeClock();
  const device = new DeviceProvider();
  const rt = createRuntime({ profile: PROFILE, providers: [device, ...extra(clock)], clock });
  await rt.ready();
  return { clock, device, rt };
}
const spec = (over: Partial<LoopSpec> = {}): LoopSpec => ({
  rate_hz: 50,
  duration_ms: 10_000,
  signals: { a: { device: "d.m", channel: "position_deg" } },
  params: { k: 2 },
  outputs: [{ device: "d.m", command: "power", terms: [{ signal: "a", gain: "k" }] }],
  ...over,
});
const line = (over: Partial<LoopTelemetry> = {}): LoopTelemetry => ({
  ticks: 20,
  overruns: 0,
  age_ms: 380,
  periods: Array.from({ length: 19 }, () => 20),
  signals: [{ n: 20, min: -1, max: 3, sum: 20, last: 3, integral: 0.5, derivative: 1 }],
  outputs: [{ n: 20, min: -2, max: 6, sum: 40, last: 6, cut: 5 }],
  trace: { t_ms: [0, 100, 200, 300], a: [-1, 0, 1, 3], out0: [-2, 0, 2, 6] },
  params: { k: 2 },
  ...over,
});

describe("a loop on a device", () => {
  test("describe_robot and planning: the device's rate, its check, and every device of the loop on that provider", async () => {
    const { device, rt } = await rig();
    expect(rt.loopInfo()).toEqual({ runs_on: "device", max_rate_hz: 50 });
    expect(() => rt.planLoop(spec({ rate_hz: 60 }))).toThrow("above the maximum of 50 Hz");
    device.refusePlan = new RuntimeError("misconfigured", "the device's executor is too old");
    expect(() => rt.planLoop(spec())).toThrow("too old");
    device.refusePlan = null;
    const planned = rt.planLoop(spec());
    expect(planned.device as Provider | undefined).toBe(device);
    expect(planned.parts).toEqual([]);
    expect(device.plans).toEqual([]); // planning sends nothing
  });

  test("a loop that names a device of another provider beside the device's is refused with unsupported", async () => {
    const host: Provider = {
      id: "h",
      backend: "sim",
      stop_worst_ms: 100,
      devices: async () => [
        {
          id: "h.s",
          provider: "h",
          kind: "sensor",
          roles: [],
          description: "a sensor read on the host",
          channels: [{ name: "x", type: "number", description: "a value" }],
          commands: [],
        },
      ],
      read: async () => [],
      command: async () => {
        throw new Error("not used");
      },
      stop: async () => ({ motors_stopped: true }),
      loop: { runs_on: "host", max_rate_hz: 100, tick: async () => [], end: async () => {} },
    };
    const { device, rt } = await rig(() => [host]);
    let e: unknown;
    try {
      rt.planLoop(spec({ signals: { a: { device: "h.s", channel: "x" } } }));
    } catch (x) {
      e = x;
    }
    expect((e as RuntimeError).code).toBe("unsupported");
    expect((e as RuntimeError).message).toContain("provider d runs loops on its device");
    expect((e as RuntimeError).message).toContain("provider h");
    expect(device.plans).toEqual([]);
  });

  test("the report is built from the device's telemetry: windows add up, the trace is the device's, run_loop's start is its 20th tick", async () => {
    const { clock, device, rt } = await rig();
    const loop = rt.startLoop(rt.planLoop(spec()));
    await loop.accepted;
    expect(device.plans[0]).toMatchObject({ rate_hz: 50, outputs: [{ device: "d.m", arg: "power_pct" }] });
    let started = false;
    void loop.started.then(() => (started = true));
    device.on!({ t: "telemetry", telemetry: line({ ticks: 11, periods: [20] }) });
    await Promise.resolve();
    expect(started).toBe(false);
    device.on!({ t: "telemetry", telemetry: line() });
    await loop.started;
    await clock.sleep(100);
    const r = loop.report();
    expect(r).toMatchObject({ state: "running", runs_on: "device", rate_hz: 50, ticks: 20, overruns: 0, age_ms: 480 });
    expect(r.signals.a).toEqual({ last: 3, min: -1, max: 3, mean: 1, integral: 0.5, derivative: 1 });
    expect(r.outputs[0]).toEqual({
      device: "d.m",
      command: "power",
      last: 6,
      min: -2,
      max: 6,
      mean_abs: 2,
      saturated_pct: 25,
    });
    expect(r.trace.t_ms).toEqual([0, 100, 200, 300, 0, 100, 200, 300]);
    expect(r.period_ms).toEqual({ p50: 20, p95: 20, max: 20 });
    // a report with no telemetry since the previous one repeats the latest values
    const again = loop.report();
    expect(again.signals.a).toEqual({ last: 3, min: 3, max: 3, mean: 3, integral: 0.5, derivative: 1 });
    expect(again.trace.t_ms).toEqual([]);
    // params: refused at once by the law's rules, else handed to the device
    expect(() => (loop as { set: (p: Record<string, number>, r: number) => unknown }).set({ nope: 1 }, 0)).toThrow(
      'no param "nope"',
    );
    await loop.set({ k: 3 }, 0);
    expect(device.sets).toEqual([{ params: { k: 3 }, ramp_ms: 0 }]);
    expect(loop.report().params).toEqual({ k: 3 });
    // the device ends it by a guard: the final report has its last line, and stays as it is
    device.endWith(
      { reason: "guard", guard: "fallen" },
      { telemetry: line({ ticks: 31, age_ms: 600, params: { k: 3 } }) },
    );
    expect(await loop.ended).toEqual({ reason: "guard", guard: "fallen" });
    const last = loop.report();
    expect(last).toMatchObject({
      state: "ended",
      reason: "guard",
      guard: "fallen",
      ticks: 31,
      remaining_ms: 0,
      age_ms: 600,
    });
    expect(loop.report()).toEqual(last);
    expect(loop.counts()).toEqual({ ticks: 31, overruns: 0, ms: 600 });
  });

  test("stop asks the device to end it and keeps its own reason; a device that never answers is a failed brake at stop_worst_ms", async () => {
    const { clock, device, rt } = await rig();
    const loop = rt.startLoop(rt.planLoop(spec()));
    await loop.accepted;
    await loop.stop({ reason: "unattended" });
    expect(device.ends).toBe(1);
    expect(await loop.ended).toEqual({ reason: "unattended" });
    expect(loop.brakeFailed).toBeNull();

    const silent = await rig();
    silent.device.answersEnd = false;
    const l2 = silent.rt.startLoop(silent.rt.planLoop(spec()));
    await l2.accepted;
    const t0 = silent.clock.now();
    const stopping = l2.stop({ reason: "preempted" });
    await stopping;
    expect(silent.clock.now() - t0).toBe(silent.rt.stop_worst_ms);
    expect(l2.brakeFailed).toContain("no answer from the device");
    expect(l2.report().notes!.join(" ")).toContain("the brake at the end of the loop failed");
    void clock;
  });

  test("a device that refuses the loop at its start: accepted rejects with its error, and the loop has ended", async () => {
    const { device, rt } = await rig();
    device.refuse = new RuntimeError("invalid_argument", "a channel is not active on the device");
    const loop = rt.startLoop(rt.planLoop(spec()));
    const e = await loop.accepted.catch((x: unknown) => x);
    expect((e as RuntimeError).code).toBe("invalid_argument");
    expect(await loop.ended).toEqual({ reason: "input_lost" });
    expect(loop.report().notes!.join(" ")).toContain("the device refused the loop");
    // the brake and the end of a failed brake belong to the device: a link that closes ends it the same way
    const other = await rig();
    const l2 = other.rt.startLoop(other.rt.planLoop(spec()));
    await l2.accepted;
    other.device.endWith({ reason: "input_lost" }, { failure: "the link to the brick closed" });
    expect(await l2.ended).toEqual({ reason: "input_lost" });
    expect(l2.report().notes!.join(" ")).toContain("the link to the brick closed");
  });
});
