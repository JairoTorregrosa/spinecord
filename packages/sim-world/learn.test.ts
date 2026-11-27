import { test, expect, describe } from "bun:test";
import { World, Rng } from "./world";
import {
  parseTrainingSpec,
  train,
  evaluate,
  randomPolicy,
  Episode,
  episodeSource,
  greedyAction,
  stateCount,
  holds,
  TRAINING_SCHEMA,
  type DeviceBindings,
  type TrainingSpec,
} from "./learn";
import { readSensorChannel } from "./channels";
import { config, quietWorld, example, DRIVE } from "./testkit";

// A training run is data in, policy out: a world file, a training spec, and the twin's device bindings.
const LINE = example("line-oval.follow-line.training.json"),
  REACH = example("line-oval.reach-D.training.json");
const BINDINGS: DeviceBindings = {
  color: "color",
  distance: "ultrasonic",
  touch: "touch",
  gyro: "gyro",
  "sim.world": "sim_world",
};
const world = () => new World(config(), 1, DRIVE);
const spec = (over: Record<string, unknown> = {}): TrainingSpec => parseTrainingSpec({ ...LINE, ...over });
/**
 * CPU time a synchronous call takes, ms. Training runs on this thread and does no I/O, so its cost is the CPU it
 * uses: wall time on a loaded machine adds the time other processes held the cores.
 */
function cpuMs<T>(fn: () => T): { value: T; ms: number } {
  const before = process.cpuUsage();
  const value = fn();
  const used = process.cpuUsage(before);
  return { value, ms: (used.user + used.system) / 1000 };
}
const moved = { device: "sim.world", channel: "odometer_cm", op: "changed" };

describe("training spec (data, no code)", () => {
  test("the example specs parse; defaults fill in", () => {
    const s = parseTrainingSpec(LINE);
    expect(s.name).toBe("line-oval.follow-line");
    expect(s.actions.map((a) => a.name)).toEqual(["forward", "left", "right"]);
    expect(stateCount(s)).toBe(3);
    expect(stateCount(parseTrainingSpec(REACH))).toBe(7 * 3 * 3);
    const { alpha: _a, gamma: _g, ...rest } = LINE;
    expect([parseTrainingSpec(rest).alpha, parseTrainingSpec(rest).gamma]).toEqual([0.1, 0.9]);
  });
  test("a bad spec fails naming the field; conditions go through the contract validator", () => {
    const bad = (over: Record<string, unknown>) => () => parseTrainingSpec({ ...LINE, ...over });
    const reward = LINE.reward as Record<string, unknown>;
    expect(bad({ schema: "x" })).toThrow(new RegExp(`schema must be "${TRAINING_SCHEMA}"`));
    expect(bad({ code: "() => 1" })).toThrow(/root\.code is not a known field/);
    expect(bad({ reward: { ...reward, max_steps: 0 } })).toThrow(/reward\.max_steps must be an integer 1\.\.5000/);
    expect(bad({ reward: { ...reward, terms: [] } })).toThrow(/reward\.terms must be an array of 1\.\.50 items/);
    expect(
      bad({
        reward: {
          ...reward,
          terms: [{ when: { device: "color", channel: "reflected_pct", op: "above", value: 3 }, reward: 1 }],
        },
      }),
    ).toThrow(/reward\.terms\[0\]\.when\.op must be one of/);
    expect(
      bad({
        reward: {
          ...reward,
          terms: [{ when: { device: "color", channel: "reflected_pct", op: "lt", value: "dark" }, reward: 1 }],
        },
      }),
    ).toThrow(/value must be a number for op lt/);
    expect(bad({ reward: { ...reward, terms: [{ when: moved, reward: 1, terminal: "win" }] } })).toThrow(
      /terminal must be "success" or "failure"/,
    );
    expect(bad({ reward: { ...reward, terms: [{ when: moved, reward: "lots" }] } })).toThrow(
      /reward\.terms\[0\]\.reward must be a finite number/,
    );
    expect(bad({ observe: [{ device: "color", channel: "reflected_pct", bins: [50, 20] }] })).toThrow(
      /observe\[0\]\.bins must be strictly ascending/,
    );
    expect(
      bad({
        observe: Array.from({ length: 5 }, () => ({
          device: "color",
          channel: "reflected_pct",
          bins: Array.from({ length: 20 }, (_, i) => i),
        })),
      }),
    ).toThrow(/more than the 20000 a table may hold/);
    expect(bad({ actions: [{ name: "go", left_cm: 2, right_cm: 2 }] })).toThrow(/needs at least 2 actions/);
    expect(
      bad({
        actions: [
          { name: "go", left_cm: 2, right_cm: 2 },
          { name: "stay", left_cm: 0, right_cm: 0 },
        ],
      }),
    ).toThrow(/must move at least one wheel/);
    expect(bad({ start: { kind: "orbit" } })).toThrow(/start\.kind must be "here", "on_line" or "anywhere"/);
    expect(bad({ gamma: 1 })).toThrow(/gamma must be in \[0, 1\)/);
    expect(bad({ speed_cm_s: 0 })).toThrow(/speed_cm_s must be > 0/);
  });
  test("a spec that names a device or channel the twin does not have fails before training, listing what exists", () => {
    expect(() => train(world(), spec(), { "sim.world": "sim_world" }, 5, 1)).toThrow(
      /reads device "color", which this twin does not have; devices and roles: sim\.world/,
    );
    const wrongChannel = spec({ observe: [{ device: "color", channel: "distance_cm", bins: [10] }] });
    expect(() => train(world(), wrongChannel, BINDINGS, 5, 1)).toThrow(
      /simulated color sensor has no channel "distance_cm"; channels: reflected_pct, color/,
    );
    const noPoint = parseTrainingSpec({
      ...REACH,
      observe: [{ device: "sim.world", channel: "bearing_to.Z", bins: [0] }],
    });
    expect(() => train(world(), noPoint, BINDINGS, 5, 1)).toThrow(/has no channel "bearing_to\.Z"; channels: pose/);
    expect(() => train(world(), spec(), { ...BINDINGS, color: "lidar" as never }, 5, 1)).toThrow(
      /bound to "lidar", which the simulator cannot model/,
    );
    expect(() => train(new World(config(), 1), spec(), BINDINGS, 5, 1)).toThrow(/needs a robot with a drivetrain/);
    expect(() => train(new World({ ...config(), lines: [] }, 1, DRIVE), spec(), BINDINGS, 5, 1)).toThrow(
      /starts on line 0, but world "line-oval" has 0 line/,
    );
    expect(() => train(world(), spec(), BINDINGS, 0, 1)).toThrow(/episodes must be an integer > 0/);
  });
});

describe("conditions over the twin's channels", () => {
  const snap = (o: Record<string, unknown>) =>
    new Map(Object.entries(o).map(([k, v]) => [k.replace(".", "\u0000"), v])) as never;
  const leaf = (channel: string, op: string, value?: unknown) =>
    ({ device: "d", channel, op, ...(value === undefined ? {} : { value }) }) as never;
  test("every contract operator, plus any / all / not", () => {
    const now = snap({ "d.n": 5, "d.s": "left-up", "d.b": true, "d.v": [1, 2, 3] }),
      before = snap({ "d.n": 4, "d.s": "left-up", "d.b": true, "d.v": [1, 2, 3] });
    expect([
      holds(leaf("n", "lt", 6), now, before),
      holds(leaf("n", "lte", 5), now, before),
      holds(leaf("n", "gt", 5), now, before),
      holds(leaf("n", "gte", 5), now, before),
    ]).toEqual([true, true, false, true]);
    expect([
      holds(leaf("n", "eq", 5), now, before),
      holds(leaf("s", "neq", "x"), now, before),
      holds(leaf("b", "eq", true), now, before),
      holds(leaf("v", "eq", 1), now, before),
    ]).toEqual([true, true, true, false]);
    expect([
      holds(leaf("n", "changed"), now, before),
      holds(leaf("s", "changed"), now, before),
      holds(leaf("v", "changed"), now, before),
    ]).toEqual([true, false, false]);
    expect([
      holds(leaf("v", "contains", 2), now, before),
      holds(leaf("v", "contains", 9), now, before),
      holds(leaf("s", "contains", "up"), now, before),
    ]).toEqual([true, false, true]);
    expect(
      holds(
        {
          all: [
            leaf("n", "gt", 1),
            { not: leaf("b", "eq", false) },
            { any: [leaf("n", "eq", 0), leaf("s", "eq", "left-up")] },
          ],
        } as never,
        now,
        before,
      ),
    ).toBe(true);
    expect(() => holds(leaf("s", "lt", 3), now, before)).toThrow(/the channel is not a number/);
  });
  test("sensor channels use the contract's names and the counter-clockwise sign", () => {
    const w = quietWorld();
    expect(readSensorChannel(w, "color", "reflected_pct")).toBe(6);
    expect(readSensorChannel(w, "color", "color")).toBe(1);
    expect(readSensorChannel(w, "ultrasonic", "distance_cm")).toBe(69);
    expect(readSensorChannel(w, "touch", "pressed")).toBe(false);
    w.advance(-4.71, 4.71, 10); // a left turn of about 45 degrees
    expect(readSensorChannel(w, "gyro", "angle_deg")).toBe(45);
    expect(readSensorChannel(w, "infrared", "proximity_pct")).toBe(17);
    expect(() => readSensorChannel(w, "gyro", "heading")).toThrow(
      /no channel "heading"; channels: angle_deg, rate_deg_s/,
    );
  });
});

describe("episodes", () => {
  test("a step earns per_step plus every term that holds; a terminal term ends the episode", () => {
    const s = spec({
      reward: {
        per_step: -1,
        max_steps: 50,
        terms: [
          { when: moved, reward: 5 },
          {
            when: { device: "sim.world", channel: "odometer_cm", op: "gte", value: 4 },
            reward: 100,
            terminal: "success",
          },
          {
            when: { device: "sim.world", channel: "collided", op: "eq", value: true },
            reward: -50,
            terminal: "failure",
          },
        ],
      },
    });
    const e = new Episode(quietWorld(), s, BINDINGS, new Rng(1), { x: 43, y: 25, th: 0 });
    expect(e.step(1)).toBe(-1); // a turn: nothing moved
    expect(e.step(0)).toBe(4); // 2 cm forward: -1 + 5
    expect(e.done).toBe(false);
    expect(e.step(0)).toBe(104); // 4 cm in total: -1 + 5 + 100, and done
    expect([e.done, e.success, e.outcome, e.steps]).toEqual([true, true, "success", 3]);
    expect(() => e.step(0)).toThrow(/already over/);
    expect(e.reading("sim.world", "odometer_cm")).toBe(4);
  });
  test("failure and max_steps outcomes; the first terminal term in the list wins", () => {
    const terms = [
      { when: { device: "sim.world", channel: "collided", op: "eq", value: true }, reward: -50, terminal: "failure" },
      { when: { device: "touch", channel: "pressed", op: "eq", value: true }, reward: 7, terminal: "success" },
    ];
    const crash = new Episode(
      quietWorld(),
      spec({ reward: { per_step: 0, max_steps: 100, terms } }),
      BINDINGS,
      new Rng(1),
      { x: 100, y: 45, th: 0 },
    );
    let last = 0;
    while (!crash.done) last = crash.step(0);
    expect([crash.outcome, last]).toEqual(["failure", -43]); // both terms held on the last step: -50 + 7
    const idle = new Episode(
      quietWorld(),
      spec({ reward: { per_step: 0, max_steps: 4, terms } }),
      BINDINGS,
      new Rng(1),
      { x: 43, y: 25, th: 0 },
    );
    while (!idle.done) idle.step(1);
    expect([idle.outcome, idle.success, idle.steps]).toEqual(["max_steps", false, 4]);
  });
  test("states come from the bins; starts follow the spec", () => {
    const s = spec();
    const onBlack = new Episode(quietWorld(), s, BINDINGS, new Rng(1), { x: 43, y: 25, th: 0 });
    expect(onBlack.state()).toBe(0);
    const onWhite = new Episode(quietWorld(), s, BINDINGS, new Rng(1), { x: 43, y: 40, th: 0 });
    expect(onWhite.state()).toBe(2);
    const w = quietWorld();
    for (let i = 0; i < 20; i++) {
      new Episode(w, s, BINDINGS, new Rng(i + 1));
      const [sx, sy] = w.pointAhead(w.cfg.body.color_sensor_x_cm);
      expect(w.nearestOnLine(sx, sy)!.dist).toBeLessThanOrEqual(1.01); // the colour sensor starts over the line
    }
    const reach = parseTrainingSpec(REACH);
    for (let i = 0; i < 20; i++) {
      const e = new Episode(w, reach, BINDINGS, new Rng(i + 1));
      expect(e.reading("sim.world", "distance_to.D") as number).toBeGreaterThanOrEqual(35);
    }
    const here = spec({ start: { kind: "here", jitter_cm: 1, jitter_deg: 5 } });
    new Episode(w, here, BINDINGS, new Rng(3), undefined);
    expect(
      () =>
        new Episode(
          quietWorld(),
          parseTrainingSpec({ ...REACH, start: { kind: "anywhere", away_from: { point: "Z", cm: 5 } } }),
          BINDINGS,
          new Rng(1),
        ),
    ).toThrow(/unknown point "Z"/);
  });
});

// Review finding: with start.kind "here" each episode started where the previous one ended.
describe('start.kind "here" means the pose the run began at, for every episode', () => {
  const here = (jitter: object = {}) => parseTrainingSpec({ ...REACH, start: { kind: "here", ...jitter } });
  const forward = (s: TrainingSpec) => ({
    spec: s,
    q: Array.from({ length: stateCount(s) }, () => [1, 0, 0]), // always "forward": no chance in the episode
  });
  test("zero jitter: two episodes start at the identical pose", () => {
    const w = quietWorld(),
      s = here();
    const home = { ...w.pose };
    const next = episodeSource(w, s, BINDINGS, new Rng(1));
    const a = next();
    expect(w.pose).toEqual(home);
    while (!a.done) a.step(0);
    expect(Math.hypot(w.pose.x - home.x, w.pose.y - home.y)).toBeGreaterThan(4); // it really drove away
    next();
    expect(w.pose).toEqual(home);
  });
  test("evaluate and train run independent trials from that pose", () => {
    const w = quietWorld(),
      s = here();
    const one = evaluate(forward(s), w, BINDINGS, 1, 5),
      three = evaluate(forward(s), w, BINDINGS, 3, 5);
    expect(three.mean_steps).toBe(one.mean_steps);
    expect(three.outcomes).toEqual({ [Object.keys(one.outcomes)[0]!]: 3 });
    // training without exploration or learning repeats the same episode, so every total reward is the same
    const r = train(w, s, BINDINGS, 3, 1, { epsilon_start: 0, epsilon_end: 0, alpha: 0, eval_trials: 1 });
    expect(new Set(r.curve).size).toBe(1);
    // train works on a copy: its final evaluation starts from the caller's world, which never moved
    expect(w.pose).toEqual(quietWorld().pose);
    expect(r.success_rate).toBe(evaluate(r.policy, w, BINDINGS, 1, 1 + 7919).success_rate);
  });
  test("jitter is applied around the captured pose, not accumulated", () => {
    const w = quietWorld(),
      s = here({ jitter_cm: 1, jitter_deg: 5 });
    const home = { ...w.pose };
    const next = episodeSource(w, s, BINDINGS, new Rng(2));
    for (let i = 0; i < 30; i++) {
      const e = next();
      expect(Math.abs(w.pose.x - home.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(w.pose.y - home.y)).toBeLessThanOrEqual(1);
      for (let k = 0; k < 3 && !e.done; k++) e.step(0);
    }
  });
});

// Training is CPU-bound and sized in work (episodes, steps), not time. The test timeout is only a hang guard, set
// for a machine whose cores are shared many times over: there each run takes many times its idle 1-2 s.
const TRAINING_HANG_GUARD_MS = 120_000;

describe("Q-learning from the example specs beats random by a clear margin", () => {
  test(
    "follow the line (line-oval.follow-line.training.json)",
    () => {
      const w = world(),
        s = parseTrainingSpec(LINE);
      const { value: r, ms } = cpuMs(() => train(w, s, BINDINGS, 1000, 1));
      const learned = evaluate(r.policy, w, BINDINGS, 100, 2024),
        random = evaluate(randomPolicy(s), w, BINDINGS, 100, 2024);
      console.log(
        `follow-line: learned ${learned.success_rate} vs random ${random.success_rate} (train ${ms.toFixed(0)} ms of CPU, ${r.steps} steps) ${JSON.stringify(learned.outcomes)}`,
      );
      expect(ms).toBeLessThan(8000);
      expect(learned.success_rate).toBeGreaterThanOrEqual(0.8);
      expect(random.success_rate).toBeLessThanOrEqual(0.05);
      expect(r.curve.length).toBe(1000);
      const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
      expect(mean(r.curve.slice(-100))).toBeGreaterThan(mean(r.curve.slice(0, 100)) + 20);
      expect(r.policy.q!.length).toBe(3);
      expect(w.pose).toEqual({ x: 43, y: 25, th: 0 }); // training works on a copy
    },
    TRAINING_HANG_GUARD_MS,
  );
  test(
    "reach a named point without touching walls (line-oval.reach-D.training.json)",
    () => {
      const w = world(),
        s = parseTrainingSpec(REACH);
      const { value: r, ms } = cpuMs(() => train(w, s, BINDINGS, 3000, 1));
      const learned = evaluate(r.policy, w, BINDINGS, 100, 2024),
        random = evaluate(randomPolicy(s), w, BINDINGS, 100, 2024);
      console.log(
        `reach-D: learned ${learned.success_rate} vs random ${random.success_rate} (train ${ms.toFixed(0)} ms of CPU, ${r.steps} steps) ${JSON.stringify(learned.outcomes)}`,
      );
      expect(ms).toBeLessThan(10000);
      expect(learned.success_rate).toBeGreaterThanOrEqual(0.5);
      expect(random.success_rate).toBeLessThanOrEqual(0.1);
      expect(learned.success_rate - random.success_rate).toBeGreaterThanOrEqual(0.45);
    },
    TRAINING_HANG_GUARD_MS,
  );
  test("same world, spec, bindings and seed give the same policy; the policy is plain JSON", () => {
    const s = spec();
    const a = train(world(), s, BINDINGS, 60, 9),
      b = train(world(), s, BINDINGS, 60, 9),
      c = train(world(), s, BINDINGS, 60, 10);
    expect(a.curve).toEqual(b.curve);
    expect(a.policy.q).toEqual(b.policy.q);
    expect(a.curve).not.toEqual(c.curve);
    const copy = JSON.parse(JSON.stringify(a.policy));
    expect(evaluate(copy, world(), BINDINGS, 10, 5)).toEqual(evaluate(a.policy, world(), BINDINGS, 10, 5));
    expect(greedyAction({ spec: s, q: [[0, 2, 1]] }, 0, new Rng(1))).toBe(1);
    expect(() => evaluate(a.policy, world(), BINDINGS, 0)).toThrow(/trials/);
  });
  test(
    "the reward terms decide what is learned: paying for spinning gives a robot that does not follow the line",
    () => {
      const w = world();
      const base = LINE.reward as { terms: { terminal?: string }[] };
      const spin = spec({
        reward: {
          per_step: 1,
          max_steps: 250,
          terms: [...base.terms.filter((t) => t.terminal), { when: moved, reward: -2 }],
        },
      });
      const r = train(w, spin, BINDINGS, 300, 1);
      expect(evaluate(r.policy, w, BINDINGS, 30, 7).success_rate).toBe(0);
    },
    TRAINING_HANG_GUARD_MS,
  );
});
