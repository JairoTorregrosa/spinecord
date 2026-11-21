// Tabular Q-learning on the 2D twin, driven entirely by data: a training spec says what the learner observes,
// which short moves it may make, where episodes start and how they are rewarded. There is no task in code and
// no user code to run: reward terms are contract Conditions over the twin's device channels.
import type { Condition, Scalar, Value } from "../protocol/types";
import { validateCondition } from "../protocol/validate";
import { World, Rng, type Pose } from "./world";
import { readSensorChannel, readWorldChannel, SIM_SENSOR_CHANNELS, type SimSensorKind } from "./channels";

export const TRAINING_SCHEMA = "spinecord/training@1";

export interface RewardTerm {
  /** A contract Condition over device channels, checked after every step. */
  when: Condition;
  reward: number;
  /** If set, a step where `when` holds ends the episode with this outcome. */
  terminal?: "success" | "failure";
}
/** Declarative reward: every step earns `per_step` plus the reward of each term whose condition holds. */
export interface RewardSpec {
  per_step: number;
  terms: RewardTerm[];
  max_steps: number;
}
/** One observed channel, cut into buckets by ascending `bins` edges (a boolean counts as 0 or 1). */
export interface ObserveSpec {
  device: string;
  channel: string;
  bins: number[];
}
/** One discrete move: wheel travel in cm (signed) for the left and right wheel. */
export interface ActionSpec {
  name: string;
  left_cm: number;
  right_cm: number;
}
export type StartSpec =
  /** The world's current pose, optionally jittered. */
  | { kind: "here"; jitter_cm?: number; jitter_deg?: number }
  /** The colour sensor over a random spot of a floor line, facing along it in either direction. */
  | { kind: "on_line"; line?: number; lateral_cm?: number; heading_deg?: number }
  /** Any free pose with room to turn on the spot, optionally at least `cm` away from a named point. */
  | { kind: "anywhere"; away_from?: { point: string; cm: number } };
export interface TrainingSpec {
  name: string;
  reward: RewardSpec;
  observe: ObserveSpec[];
  actions: ActionSpec[];
  /** Speed of the faster wheel during a move. */
  speed_cm_s: number;
  start: StartSpec;
  alpha: number;
  gamma: number;
}
/**
 * How the device names used in a spec map to the simulator: device id or role -> what it is in the twin.
 * Built by whoever assembles the twin from its device list (ids and roles), e.g. {"color": "color", "sim.world": "sim_world"}.
 */
export type DeviceBindings = Record<string, SimSensorKind | "sim_world">;

const CAPS = { max_steps: 5000, max_terms: 50, max_observe: 6, max_states: 20000, max_actions: 12 } as const;

/** Validates a training spec given as JSON. Fails naming the exact field; conditions use the contract validator. */
export function parseTrainingSpec(json: unknown): TrainingSpec {
  const fail = (path: string, why: string): never => {
    throw new Error(`training spec: ${path} ${why}`);
  };
  const obj = (v: unknown, path: string): Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : fail(path, "must be an object");
  const num = (v: unknown, path: string): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fail(path, `must be a finite number, got ${JSON.stringify(v)}`);
  const pos = (v: unknown, path: string): number => {
    const n = num(v, path);
    return n > 0 ? n : fail(path, `must be > 0, got ${n}`);
  };
  const str = (v: unknown, path: string): string =>
    typeof v === "string" && v !== "" ? v : fail(path, "must be a non-empty string");
  const list = (v: unknown, path: string, max: number): unknown[] =>
    Array.isArray(v) && v.length > 0 && v.length <= max ? v : fail(path, `must be an array of 1..${max} items`);
  const only = (o: Record<string, unknown>, path: string, keys: string[]): void => {
    for (const k of Object.keys(o))
      if (!keys.includes(k)) fail(`${path}.${k}`, `is not a known field (${keys.join(", ")})`);
  };
  const opt = (v: unknown, path: string, fallback: number): number => (v === undefined ? fallback : num(v, path));

  const root = obj(json, "root");
  only(root, "root", [
    "schema",
    "name",
    "description",
    "reward",
    "observe",
    "actions",
    "speed_cm_s",
    "start",
    "alpha",
    "gamma",
  ]);
  if (root.schema !== TRAINING_SCHEMA)
    fail("schema", `must be "${TRAINING_SCHEMA}", got ${JSON.stringify(root.schema)}`);

  const rw = obj(root.reward, "reward");
  only(rw, "reward", ["per_step", "terms", "max_steps"]);
  const max_steps = num(rw.max_steps, "reward.max_steps");
  if (!Number.isInteger(max_steps) || max_steps < 1 || max_steps > CAPS.max_steps)
    fail("reward.max_steps", `must be an integer 1..${CAPS.max_steps}, got ${max_steps}`);
  const terms = list(rw.terms, "reward.terms", CAPS.max_terms).map((t, i): RewardTerm => {
    const path = `reward.terms[${i}]`,
      o = obj(t, path);
    only(o, path, ["when", "reward", "terminal"]);
    const issues = validateCondition(o.when, `${path}.when`);
    if (issues.length) fail(issues[0]!.path, issues[0]!.message);
    if (o.terminal !== undefined && o.terminal !== "success" && o.terminal !== "failure")
      fail(`${path}.terminal`, `must be "success" or "failure", got ${JSON.stringify(o.terminal)}`);
    return {
      when: o.when as Condition,
      reward: num(o.reward, `${path}.reward`),
      ...(o.terminal ? { terminal: o.terminal as "success" | "failure" } : {}),
    };
  });

  let states = 1;
  const observe = list(root.observe, "observe", CAPS.max_observe).map((x, i): ObserveSpec => {
    const path = `observe[${i}]`,
      o = obj(x, path);
    only(o, path, ["device", "channel", "bins"]);
    const bins = list(o.bins, `${path}.bins`, 64).map((b, j) => num(b, `${path}.bins[${j}]`));
    for (let j = 1; j < bins.length; j++)
      if (!(bins[j]! > bins[j - 1]!)) fail(`${path}.bins`, "must be strictly ascending");
    states *= bins.length + 1;
    return { device: str(o.device, `${path}.device`), channel: str(o.channel, `${path}.channel`), bins };
  });
  if (states > CAPS.max_states)
    fail(
      "observe",
      `gives ${states} states, more than the ${CAPS.max_states} a table may hold: use fewer channels or bins`,
    );

  const names = new Set<string>();
  const actions = list(root.actions, "actions", CAPS.max_actions).map((x, i): ActionSpec => {
    const path = `actions[${i}]`,
      o = obj(x, path);
    only(o, path, ["name", "left_cm", "right_cm"]);
    const a = {
      name: str(o.name, `${path}.name`),
      left_cm: num(o.left_cm, `${path}.left_cm`),
      right_cm: num(o.right_cm, `${path}.right_cm`),
    };
    if (names.has(a.name)) fail(`${path}.name`, `"${a.name}" is repeated`);
    names.add(a.name);
    if (a.left_cm === 0 && a.right_cm === 0) fail(path, "must move at least one wheel");
    if (Math.max(Math.abs(a.left_cm), Math.abs(a.right_cm)) > 50) fail(path, "may move a wheel at most 50 cm per step");
    return a;
  });
  if (actions.length < 2) fail("actions", "needs at least 2 actions to choose from");

  const st = obj(root.start, "start");
  let start: StartSpec;
  if (st.kind === "here") {
    only(st, "start", ["kind", "jitter_cm", "jitter_deg"]);
    start = {
      kind: "here",
      jitter_cm: opt(st.jitter_cm, "start.jitter_cm", 0),
      jitter_deg: opt(st.jitter_deg, "start.jitter_deg", 0),
    };
  } else if (st.kind === "on_line") {
    only(st, "start", ["kind", "line", "lateral_cm", "heading_deg"]);
    start = {
      kind: "on_line",
      line: opt(st.line, "start.line", 0),
      lateral_cm: opt(st.lateral_cm, "start.lateral_cm", 0),
      heading_deg: opt(st.heading_deg, "start.heading_deg", 0),
    };
  } else if (st.kind === "anywhere") {
    only(st, "start", ["kind", "away_from"]);
    start = { kind: "anywhere" };
    if (st.away_from !== undefined) {
      const a = obj(st.away_from, "start.away_from");
      only(a, "start.away_from", ["point", "cm"]);
      start.away_from = { point: str(a.point, "start.away_from.point"), cm: pos(a.cm, "start.away_from.cm") };
    }
  } else start = fail("start.kind", `must be "here", "on_line" or "anywhere", got ${JSON.stringify(st.kind)}`);

  const alpha = opt(root.alpha, "alpha", 0.1),
    gamma = opt(root.gamma, "gamma", 0.9);
  if (!(alpha > 0 && alpha <= 1)) fail("alpha", `must be in (0, 1], got ${alpha}`);
  if (!(gamma >= 0 && gamma < 1)) fail("gamma", `must be in [0, 1), got ${gamma}`);
  if (root.description !== undefined && typeof root.description !== "string") fail("description", "must be a string");
  return {
    name: str(root.name, "name"),
    reward: { per_step: num(rw.per_step, "reward.per_step"), terms, max_steps },
    observe,
    actions,
    speed_cm_s: pos(root.speed_cm_s, "speed_cm_s"),
    start,
    alpha,
    gamma,
  };
}

// ---------- Reading channels and evaluating conditions ----------
type Snapshot = Map<string, Value>;
const key = (device: string, channel: string): string => `${device}\u0000${channel}`;

function leaves(c: Condition, out: { device: string; channel: string }[]): void {
  if ("any" in c) c.any.forEach((x) => leaves(x, out));
  else if ("all" in c) c.all.forEach((x) => leaves(x, out));
  else if ("not" in c) leaves(c.not, out);
  else out.push({ device: c.device, channel: c.channel });
}

/** Every (device, channel) a spec reads, checked once against the bindings and the world. Fails listing what exists. */
function channelsOf(spec: TrainingSpec, bindings: DeviceBindings, world: World): { device: string; channel: string }[] {
  const all: { device: string; channel: string }[] = [];
  for (const t of spec.reward.terms) leaves(t.when, all);
  for (const o of spec.observe) all.push({ device: o.device, channel: o.channel });
  const seen = new Set<string>(),
    out: { device: string; channel: string }[] = [];
  for (const r of all) {
    const k = key(r.device, r.channel);
    if (seen.has(k)) continue;
    seen.add(k);
    if (!Object.hasOwn(bindings, r.device))
      throw new Error(
        `training spec "${spec.name}" reads device "${r.device}", which this twin does not have; devices and roles: ${Object.keys(bindings).join(", ") || "(none)"}`,
      );
    read(world, bindings, r.device, r.channel); // an unknown channel fails here, before any training
    out.push(r);
  }
  return out;
}
function read(world: World, bindings: DeviceBindings, device: string, channel: string): Value {
  const kind = bindings[device]!;
  if (kind === "sim_world") return readWorldChannel(world, channel);
  if (!Object.hasOwn(SIM_SENSOR_CHANNELS, kind))
    throw new Error(
      `device "${device}" is bound to "${String(kind)}", which the simulator cannot model; kinds: sim_world, ${Object.keys(SIM_SENSOR_CHANNELS).join(", ")}`,
    );
  return readSensorChannel(world, kind, channel);
}

const same = (a: Value | undefined, b: Value | undefined): boolean =>
  Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b;

/** Evaluates a contract Condition against this step's readings (and the previous step's, for `changed`). */
export function holds(c: Condition, now: Snapshot, before: Snapshot): boolean {
  if ("any" in c) return c.any.some((x) => holds(x, now, before));
  if ("all" in c) return c.all.every((x) => holds(x, now, before));
  if ("not" in c) return !holds(c.not, now, before);
  const k = key(c.device, c.channel),
    v = now.get(k);
  const want = c.value as Scalar;
  switch (c.op) {
    case "changed":
      return !same(v, before.get(k));
    case "eq":
      return same(v, want);
    case "neq":
      return !same(v, want);
    case "contains":
      return Array.isArray(v)
        ? typeof want === "number" && (v as number[]).includes(want)
        : typeof v === "string" && typeof want === "string" && v.includes(want);
  }
  if (typeof v !== "number")
    throw new Error(
      `condition ${c.device}.${c.channel} ${c.op} ${String(want)}: the channel is not a number (it reads ${JSON.stringify(v)})`,
    );
  const w = want as number;
  return c.op === "lt" ? v < w : c.op === "lte" ? v <= w : c.op === "gt" ? v > w : v >= w;
}

// ---------- Episodes ----------
export function stateCount(spec: TrainingSpec): number {
  return spec.observe.reduce((n, o) => n * (o.bins.length + 1), 1);
}

export type Outcome = "running" | "success" | "failure" | "max_steps";

/** One episode: places the robot, runs short moves, and scores each step with the spec's reward. */
export class Episode {
  done = false;
  success = false;
  outcome: Outcome = "running";
  steps = 0;
  private now: Snapshot;
  private before: Snapshot;
  private readonly reads: { device: string; channel: string }[];

  constructor(
    readonly world: World,
    readonly spec: TrainingSpec,
    readonly bindings: DeviceBindings,
    rng: Rng,
    start?: Pose,
  ) {
    if (!world.drive)
      throw new Error(
        "training needs a robot with a drivetrain: this twin's profile has none, so its wheels cannot move it",
      );
    world.setPose(start ?? randomStart(world, spec, rng));
    this.reads = channelsOf(spec, bindings, world);
    this.now = this.snapshot();
    this.before = this.now;
  }

  private snapshot(): Snapshot {
    const m: Snapshot = new Map();
    for (const r of this.reads) m.set(key(r.device, r.channel), read(this.world, this.bindings, r.device, r.channel));
    return m;
  }

  /** Current reading of a channel the spec uses (for display). */
  reading(device: string, channel: string): Value | undefined {
    return this.now.get(key(device, channel));
  }

  /** Discrete state for the Q table: one bucket per observed channel. */
  state(): number {
    let s = 0;
    for (const o of this.spec.observe) {
      const raw = this.now.get(key(o.device, o.channel));
      const v = typeof raw === "boolean" ? (raw ? 1 : 0) : raw;
      if (typeof v !== "number")
        throw new Error(
          `observe ${o.device}.${o.channel}: only number and boolean channels can be put in bins (it reads ${JSON.stringify(raw)})`,
        );
      let b = 0;
      while (b < o.bins.length && v >= o.bins[b]!) b++;
      s = s * (o.bins.length + 1) + b;
    }
    return s;
  }

  /** Runs action `a` and returns the reward of the step. */
  step(a: number): number {
    if (this.done) throw new Error("Episode.step: the episode is already over");
    const action = this.spec.actions[a];
    if (!action) throw new Error(`Episode.step: invalid action ${a}`);
    this.world.advance(action.left_cm, action.right_cm, this.spec.speed_cm_s);
    this.steps++;
    this.before = this.now;
    this.now = this.snapshot();
    let reward = this.spec.reward.per_step;
    let end: Outcome | null = null;
    for (const t of this.spec.reward.terms) {
      if (!holds(t.when, this.now, this.before)) continue;
      reward += t.reward;
      if (t.terminal && !end) end = t.terminal;
    }
    if (!end && this.steps >= this.spec.reward.max_steps) end = "max_steps";
    if (end) {
      this.done = true;
      this.outcome = end;
      this.success = end === "success";
    }
    return reward;
  }
}

/** Room to turn on the spot without touching anything. */
function canSpin(world: World, p: Pose): boolean {
  for (let i = 0; i < 12; i++) if (world.collides({ x: p.x, y: p.y, th: p.th + (i * Math.PI) / 6 })) return false;
  return true;
}

/** A random start pose as the spec's `start` asks. Fails if the world cannot provide one. */
export function randomStart(world: World, spec: TrainingSpec, rng: Rng): Pose {
  const c = world.cfg,
    st = spec.start,
    rad = Math.PI / 180;
  if (st.kind === "on_line" && world.line_lengths_cm[st.line ?? 0] === undefined)
    throw new Error(
      `training spec "${spec.name}" starts on line ${st.line ?? 0}, but world "${c.name}" has ${c.lines.length} line(s)`,
    );
  const away =
    st.kind === "anywhere" && st.away_from ? { p: world.point(st.away_from.point), cm: st.away_from.cm } : null;
  const here = { ...world.pose };
  for (let i = 0; i < 500; i++) {
    let p: Pose;
    if (st.kind === "here") {
      const j = st.jitter_cm ?? 0;
      p = {
        x: here.x + rng.range(-j, j),
        y: here.y + rng.range(-j, j),
        th: here.th + rng.range(-(st.jitter_deg ?? 0), st.jitter_deg ?? 0) * rad,
      };
    } else if (st.kind === "on_line") {
      const line = st.line ?? 0;
      const q = world.pointOnLine(rng.range(0, world.line_lengths_cm[line]!), line);
      const th = q.th + (rng.next() < 0.5 ? 0 : Math.PI) + rng.range(-(st.heading_deg ?? 0), st.heading_deg ?? 0) * rad;
      const off = rng.range(-(st.lateral_cm ?? 0), st.lateral_cm ?? 0);
      const sx = q.x - off * Math.sin(q.th),
        sy = q.y + off * Math.cos(q.th);
      p = { x: sx - c.body.color_sensor_x_cm * Math.cos(th), y: sy - c.body.color_sensor_x_cm * Math.sin(th), th };
    } else {
      p = { x: rng.range(0, c.width), y: rng.range(0, c.height), th: rng.range(-Math.PI, Math.PI) };
      if (away && Math.hypot(away.p.x - p.x, away.p.y - p.y) < away.cm) continue;
      if (!canSpin(world, p)) continue;
    }
    if (!world.collides(p)) return p;
  }
  throw new Error(`training spec "${spec.name}": found no free start pose (${st.kind}) in world "${c.name}"`);
}

/**
 * Episode factory for a run of independent trials on `world`. A `start.kind: "here"` spec means the pose the
 * world has when the run begins: it is captured once, here, and every episode is placed from it (plus the
 * spec's jitter), never from wherever the previous episode ended.
 */
export function episodeSource(world: World, spec: TrainingSpec, bindings: DeviceBindings, rng: Rng): () => Episode {
  const home = spec.start.kind === "here" ? { ...world.pose } : null;
  return () => {
    if (home) world.setPose(home);
    return new Episode(world, spec, bindings, rng);
  };
}

// ---------- Policy, training, evaluation ----------
export interface Policy {
  spec: TrainingSpec;
  /** q[state][action]; `null` = uniformly random actions (the baseline). */
  q: number[][] | null;
}
export function randomPolicy(spec: TrainingSpec): Policy {
  return { spec, q: null };
}

export function greedyAction(policy: Policy, state: number, rng: Rng): number {
  if (!policy.q) return rng.int(policy.spec.actions.length);
  const row = policy.q[state];
  if (!row) throw new Error(`greedyAction: state ${state} is outside the table`);
  let best = 0;
  for (let a = 1; a < row.length; a++) if (row[a]! > row[best]!) best = a;
  return best;
}

export interface TrainOptions {
  alpha?: number;
  gamma?: number;
  epsilon_start?: number;
  epsilon_end?: number;
  /** Episodes of the final evaluation (greedy policy, fresh starts). */
  eval_trials?: number;
  /** Called after each training episode (1-based count). The worker uses it as its heartbeat. */
  on_episode?: (episodes_done: number) => void;
}
export interface TrainResult {
  policy: Policy;
  /** Total reward of each training episode. */
  curve: number[];
  /** Share of evaluation episodes that ended in a `terminal: "success"` term, on starts not seen in training. */
  success_rate: number;
  steps: number;
}

/**
 * Trains with Q-learning. Does not touch `world`: it works on a copy with the given seed.
 * Same world, spec, bindings and seed give the same result.
 */
export function train(
  world: World,
  spec: TrainingSpec,
  bindings: DeviceBindings,
  episodes: number,
  seed: number,
  opts: TrainOptions = {},
): TrainResult {
  if (!(Number.isInteger(episodes) && episodes > 0))
    throw new Error(`train: episodes must be an integer > 0, got ${episodes}`);
  const alpha = opts.alpha ?? spec.alpha,
    gamma = opts.gamma ?? spec.gamma;
  const e0 = opts.epsilon_start ?? 1,
    e1 = opts.epsilon_end ?? 0.05;
  const w = world.clone(seed);
  const rng = new Rng(seed ^ 0x1234567);
  const nS = stateCount(spec),
    nA = spec.actions.length;
  const q: number[][] = Array.from({ length: nS }, () => new Array<number>(nA).fill(0));
  const policy: Policy = { spec, q };
  const curve: number[] = [];
  let steps = 0;
  const next = episodeSource(w, spec, bindings, rng);
  for (let ep = 0; ep < episodes; ep++) {
    const eps = e0 + (e1 - e0) * Math.min(1, ep / Math.max(1, episodes * 0.7));
    const e = next();
    let s = e.state(),
      total = 0;
    while (!e.done) {
      const a = rng.next() < eps ? rng.int(nA) : greedyAction(policy, s, rng);
      const r = e.step(a);
      const s2 = e.state();
      // Running out of steps is not a property of the state: keep bootstrapping there.
      const target = e.done && e.outcome !== "max_steps" ? r : r + gamma * Math.max(...q[s2]!);
      q[s]![a]! += alpha * (target - q[s]![a]!);
      s = s2;
      total += r;
      steps++;
    }
    curve.push(Math.round(total * 100) / 100);
    opts.on_episode?.(ep + 1);
  }
  const ev = evaluate(policy, world, bindings, opts.eval_trials ?? 50, seed + 7919);
  return { policy, curve, success_rate: ev.success_rate, steps };
}

export interface EvalResult {
  success_rate: number;
  trials: number;
  mean_steps: number;
  outcomes: Record<string, number>;
}

/** Runs the policy (greedy, no exploration) from `trials` random starts and counts successes. */
export function evaluate(
  policy: Policy,
  world: World,
  bindings: DeviceBindings,
  trials: number,
  seed = 4242,
): EvalResult {
  if (!(Number.isInteger(trials) && trials > 0))
    throw new Error(`evaluate: trials must be an integer > 0, got ${trials}`);
  const w = world.clone(seed);
  const rng = new Rng(seed ^ 0x7654321);
  const outcomes: Record<string, number> = {};
  let ok = 0,
    steps = 0;
  const next = episodeSource(w, policy.spec, bindings, rng);
  for (let i = 0; i < trials; i++) {
    const e = next();
    while (!e.done) e.step(greedyAction(policy, e.state(), rng));
    if (e.success) ok++;
    steps += e.steps;
    outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1;
  }
  return { success_rate: ok / trials, trials, mean_steps: steps / trials, outcomes };
}
