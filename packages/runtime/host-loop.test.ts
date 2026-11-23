// The runtime's host executor of a loop (CONTRACT §4, §5a) over a provider whose tick is scripted, on virtual time.
import { describe, expect, test } from "bun:test";
import type {
  DeviceSpec,
  LoopRead,
  LoopSpec,
  LoopWrite,
  Provider,
  ProviderLoop,
  RobotProfile,
} from "../protocol/types";
import { FakeClock, type Clock } from "./clock";
import { MockProvider } from "./mock";
import { createRuntime } from "./runtime";

const motor: DeviceSpec = {
  id: "h.m",
  provider: "h",
  kind: "motor",
  roles: [],
  description: "a motor a loop can drive",
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
    {
      name: "spin",
      description: "no loop can refresh it",
      moves: true,
      bound: { kind: "ms", max: 250 },
      params: { type: "object", properties: { pct: { type: "number", minimum: -100, maximum: 100 } } },
    },
  ],
};
const sensor: DeviceSpec = {
  id: "h.s",
  provider: "h",
  kind: "sensor",
  roles: [],
  description: "a sensor",
  channels: [
    { name: "x", type: "number", description: "a value", mode_group: "s", active: true },
    { name: "y", type: "number", description: "another mode", mode_group: "s", active: false },
  ],
  commands: [],
};

/** A host provider: each tick takes `tickMs` of virtual time and reads what `value` says. */
class HostProvider implements Provider {
  readonly id = "h";
  readonly backend = "sim" as const;
  readonly stop_worst_ms = 100;
  tickMs: (n: number) => number = () => 0;
  value: (read: LoopRead, n: number) => number | null = () => 1;
  readonly writes: LoopWrite[][] = [];
  readonly ends: string[][] = [];
  stops = 0;
  specs: DeviceSpec[] = [motor, sensor];
  private changed = new Set<() => void>();
  readonly loop: ProviderLoop;
  constructor(
    private readonly clock: Clock,
    max_rate_hz = 100,
  ) {
    this.loop = {
      runs_on: "host",
      max_rate_hz,
      tick: async (writes, reads) => {
        const n = this.writes.length;
        this.writes.push(writes);
        const ms = this.tickMs(n);
        if (ms > 0) await this.clock.sleep(ms);
        return reads.map((r) => this.value(r, n));
      },
      end: async (devices) => void this.ends.push(devices),
    };
  }
  async devices() {
    return structuredClone(this.specs);
  }
  onDevicesChanged(cb: () => void) {
    this.changed.add(cb);
    return () => void this.changed.delete(cb);
  }
  unplug(id: string) {
    this.specs = this.specs.filter((d) => d.id !== id);
    for (const cb of this.changed) cb();
  }
  async read() {
    return [];
  }
  async command(): Promise<never> {
    throw new Error("not used");
  }
  async stop() {
    this.stops++;
    return { motors_stopped: true };
  }
}

const PROFILE: RobotProfile = {
  id: "h1",
  roles: { wheel: "h.m" },
  notes: [],
  limits: { max_speed_pct: 80, max_command_ms: 10000, max_program_ms: 20000, max_loop_ms: 5000 },
};
async function rig(o: { rate?: number; extra?: Provider[] } = {}) {
  const clock = new FakeClock();
  const host = new HostProvider(clock, o.rate);
  const rt = createRuntime({ profile: PROFILE, providers: [host, ...(o.extra ?? [])], clock });
  await rt.ready();
  return { clock, host, rt };
}
const spec = (over: Partial<LoopSpec> = {}): LoopSpec => ({
  rate_hz: 100,
  duration_ms: 1000,
  signals: { x: { device: "h.s", channel: "x" } },
  params: { k: 2 },
  outputs: [{ device: "wheel", command: "power", terms: [{ signal: "x", gain: "k" }] }],
  ...over,
});

describe("the host executor", () => {
  test("ticks at the planned rate on absolute deadlines and ends at duration_ms, braking what it drove", async () => {
    const { clock, host, rt } = await rig();
    const t0 = clock.now();
    const loop = rt.startLoop(rt.planLoop(spec()));
    await loop.started;
    expect(host.writes).toHaveLength(20);
    // tick n refreshes what the law computed on tick n-1: 0 first, then k × x
    expect(host.writes[0]).toEqual([{ device: "h.m", command: "power", args: { power_pct: 0 } }]);
    expect(host.writes[1]).toEqual([{ device: "h.m", command: "power", args: { power_pct: 2 } }]);
    expect(await loop.ended).toEqual({ reason: "completed" });
    expect(clock.now() - t0).toBe(1000);
    expect(host.writes).toHaveLength(100);
    expect(host.ends).toEqual([["h.m"]]);
    const r = loop.report();
    expect(r).toMatchObject({ state: "ended", reason: "completed", runs_on: "host", ticks: 100, overruns: 0 });
    expect(r.period_ms).toEqual({ p50: 10, p95: 10, max: 10 });
    expect(r.remaining_ms).toBe(0);
    expect(r.age_ms).toBe(1000);
    // the final report stays as it is, trace and periods included, however often it is asked for
    expect(r.trace.t_ms.length).toBeGreaterThan(0);
    expect(loop.report()).toEqual(r);
  });

  test("a tick of 30 ms at 100 Hz: three ticks in a row later than a period end the loop with overrun", async () => {
    const { host, rt } = await rig();
    host.tickMs = () => 30;
    const loop = rt.startLoop(rt.planLoop(spec()));
    expect(await loop.ended).toEqual({ reason: "overrun" });
    const r = loop.report();
    expect(r.overruns).toBe(3);
    expect(r.ticks).toBe(3);
    expect(host.ends).toHaveLength(1);
  });

  test("more than 5 % of the ticks of a second late is an overrun; fewer is not", async () => {
    // at 50 Hz a 45 ms tick makes the next one late by 25 ms, more than a period
    const run = async (every: number) => {
      const { host, rt } = await rig();
      host.tickMs = (n) => (n % every === every - 1 ? 45 : 0);
      const loop = rt.startLoop(rt.planLoop(spec({ rate_hz: 50, duration_ms: 3000 })));
      return { end: await loop.ended, r: loop.report() };
    };
    const often = await run(10); // 5 a second: 10 %
    expect(often.end).toEqual({ reason: "overrun" });
    expect(often.r.age_ms).toBeGreaterThanOrEqual(1000);
    expect(often.r.age_ms).toBeLessThan(1300);
    const seldom = await run(25); // 2 a second: 4 %
    expect(seldom.end).toEqual({ reason: "completed" });
    expect(seldom.r.overruns).toBeGreaterThan(0);
  });

  test("a rate over the maximum is refused with invalid_argument and nothing is sent", async () => {
    const { host, rt } = await rig({ rate: 50 });
    expect(() => rt.planLoop(spec({ rate_hz: 100 }))).toThrow(/above the maximum of 50 Hz/);
    try {
      rt.planLoop(spec({ rate_hz: 100 }));
    } catch (e) {
      expect((e as { code: string }).code).toBe("invalid_argument");
    }
    expect(host.writes).toEqual([]);
    expect(rt.loopInfo()).toEqual({ runs_on: "host", max_rate_hz: 50 });
  });

  test("planning refuses what the executor cannot honor, and nothing is sent", async () => {
    const { host, rt } = await rig({ extra: [new MockProvider({ clock: new FakeClock() })] });
    const code = (s: LoopSpec) => {
      try {
        rt.planLoop(s);
      } catch (e) {
        return { code: (e as { code: string }).code, next: (e as { next?: string[] }).next };
      }
      return null;
    };
    expect(code(spec({ outputs: [{ device: "h.m", command: "spin", terms: [{ feed: "k" }] }] }))).toEqual({
      code: "unsupported",
      next: undefined,
    });
    expect(code(spec({ signals: { x: { device: "h.s", channel: "y" } } }))).toEqual({
      code: "invalid_argument",
      next: ["read_device"],
    });
    expect(code(spec({ signals: { x: { device: "h.s", channel: "nope" } } }))?.code).toBe("unknown_channel");
    expect(code(spec({ signals: { x: { device: "nope", channel: "x" } } }))?.code).toBe("unknown_device");
    // a device whose provider runs no loops
    expect(code(spec({ signals: { x: { device: "mock.color", channel: "reflected_pct" } } }))?.code).toBe(
      "unsupported",
    );
    expect(code({ ...spec(), rate_hz: "fast" } as unknown as LoopSpec)?.code).toBe("invalid_argument");
    expect(host.writes).toEqual([]);
  });

  test("duration_ms over max_loop_ms is cut, and the report says so", async () => {
    const { rt } = await rig();
    const planned = rt.planLoop(spec({ duration_ms: 60000 }));
    expect(planned.plan.duration_ms).toBe(5000);
    const loop = rt.startLoop(planned);
    await loop.started;
    expect(loop.report().notes).toContain("duration_ms was cut from 60000 to 5000, the robot's max_loop_ms");
    await loop.stop({ reason: "preempted" });
  });

  test("a guard ends the loop on the tick that reads it, with its name", async () => {
    const { host, rt } = await rig();
    host.value = (_r, n) => (n < 30 ? 1 : 9);
    const loop = rt.startLoop(rt.planLoop(spec({ guards: [{ name: "too_high", signal: "x", op: "gt", value: 5 }] })));
    expect(await loop.ended).toEqual({ reason: "guard", guard: "too_high" });
    expect(loop.report()).toMatchObject({ reason: "guard", guard: "too_high", ticks: 31 });
    expect(host.writes).toHaveLength(31);
  });

  test("a tick that fails, or a signal whose device leaves the registry, ends the loop with input_lost", async () => {
    const failing = await rig();
    failing.host.tickMs = (n) => {
      if (n === 25) throw new Error("no reply");
      return 0;
    };
    const a = failing.rt.startLoop(failing.rt.planLoop(spec()));
    expect(await a.ended).toEqual({ reason: "input_lost" });
    expect(failing.host.ends).toHaveLength(1);

    const unplugged = await rig();
    const b = unplugged.rt.startLoop(unplugged.rt.planLoop(spec()));
    await b.started;
    unplugged.host.unplug("h.s");
    expect(await b.ended).toEqual({ reason: "input_lost" });
  });

  test("params change on a tick boundary and ramp; the trace and the statistics cover the ticks since the last report", async () => {
    const { clock, host, rt } = await rig();
    const loop = rt.startLoop(rt.planLoop(spec({ trace_hz: 10 })));
    await loop.started;
    const first = loop.report();
    expect(first.params).toEqual({ k: 2 });
    expect(first.outputs[0]).toMatchObject({ device: "h.m", command: "power", last: 2, mean_abs: 2 });
    loop.set({ k: 4 }, 100);
    await clock.sleep(200);
    const second = loop.report();
    expect(second.params).toEqual({ k: 4 });
    expect(second.outputs[0]!.last).toBe(4);
    expect(second.trace.t_ms.length).toBe(2);
    expect(second.trace.x).toEqual([1, 1]);
    expect(() => loop.set({ nope: 1 }, 0)).toThrow(/no param "nope"/);
    expect(host.writes.at(-1)).toEqual([{ device: "h.m", command: "power", args: { power_pct: 4 } }]);
    await loop.stop({ reason: "preempted" });
  });

  test("runtime.stop() ends a running loop with preempted: no tick after it, then the providers' stop", async () => {
    const { clock, host, rt } = await rig();
    const loop = rt.startLoop(rt.planLoop(spec()));
    await loop.started;
    const sent = host.writes.length;
    expect(await rt.stop()).toEqual({ motors_stopped: true });
    expect(loop.end).toEqual({ reason: "preempted" });
    await clock.sleep(100);
    expect(host.writes.length).toBe(sent);
    expect(host.ends).toEqual([["h.m"]]);
    expect(host.stops).toBe(1);
    // the first cause wins
    await loop.stop({ reason: "unattended" });
    expect(await loop.ended).toEqual({ reason: "preempted" });
    // one loop at a time
    const next = rt.startLoop(rt.planLoop(spec()));
    expect(() => rt.startLoop(rt.planLoop(spec()))).toThrow(/one loop at a time/);
    await next.stop({ reason: "preempted" });
  });

  test("describe_robot reports where a loop runs, and null without a loop provider", async () => {
    const { rt } = await rig();
    const d = (await rt.call("describe_robot", {}, new AbortController().signal)).data as Record<string, unknown>;
    expect(d.loop).toEqual({ runs_on: "host", max_rate_hz: 100 });
    const clock = new FakeClock();
    const none = createRuntime({ profile: PROFILE, providers: [new MockProvider({ clock })], clock });
    await none.ready();
    expect(((await none.call("describe_robot", {}, new AbortController().signal)).data as { loop: unknown }).loop).toBe(
      null,
    );
  });
});
