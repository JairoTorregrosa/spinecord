// Condition compiler and evaluator. Shape rules live in packages/protocol/validate.ts (single owner); this
// file adds what needs real devices: names resolve (id or role), channels exist, value types fit the channel.
// A reading without a value is never silently "not met". On a channel whose manifest says null_when_absent,
// a null the device itself reports (Reading.absent: nothing in view) is a value: its comparisons are false. On any other channel one poll without a value
// leaves the condition not met for that poll, and UNREADABLE_POLLS of them in a row on the same comparison end
// the evaluation with condition_unreadable, so whoever watches it (a move's `until`, wait_until, a program)
// stops and says so. Reads here never switch a sensor mode: a comparison on a channel whose mode group is not
// active is refused when the condition is compiled, before anything is sent, and so is a comparison that the
// channel's declared range can never make true. `changed` on a channel that declares `noise` needs a difference
// larger than it in CHANGED_POLLS polls in a row.
import { RuntimeError } from "../protocol/types";
import type { ChannelSpec, CompareOp, DeviceSpec, Reading, Value } from "../protocol/types";
import { validateCondition } from "../protocol/validate";

export interface Resolver {
  resolve(name: string): DeviceSpec; // throws unknown_device listing valid ids and roles
}
type Leaf = {
  device: string;
  channel: string;
  op: CompareOp;
  value?: number | boolean | string;
  absent: boolean; // the channel's null means "nothing there" (ChannelSpec.null_when_absent)
  noise: number; // `changed` takes a difference up to this as no change (ChannelSpec.noise, else 0)
};
type Node = { leaf: number } | { any: Node[] } | { all: Node[] } | { not: Node };
export interface CompiledCondition {
  leaves: Leaf[];
  tree: Node;
}
export type ReadFn = (device: string, channels: string[]) => Promise<Reading[]>;

const MAX_LEAVES = 32;
// Polls in a row without a value, on the same comparison, that end an evaluation. One failed exchange with a
// brick is not a broken sensor; three polls of a watched move are about 30 ms, inside one chunk.
export const UNREADABLE_POLLS = 3;
// Polls in a row that decided nothing, whichever comparison lacked its value, that end an evaluation: channels
// failing in turn never reach UNREADABLE_POLLS each, and whoever waits for an answer must get one.
export const UNDECIDED_POLLS = 10;
// Polls in a row that must differ from the first value by more than the channel's declared noise before
// `changed` holds on such a channel: one reading far out is an outlier, two are a change.
export const CHANGED_POLLS = 2;
const bad = (msg: string) => new RuntimeError("invalid_argument", msg);
// A condition never switches a sensor mode, so a channel whose mode group is not active cannot be compared.
// The fix is a read_device that names the channel, and `next` starts with it. `where` is the condition's path
// when it is refused as it is compiled, before anything is sent; a poll that finds it says nothing about what
// was sent, and whoever watched a move adds that.
function inactive(
  where: string | null,
  device: string,
  channel: string,
  group?: string,
  active: string[] = [],
): RuntimeError {
  const e = bad(
    `${where === null ? "" : `${where}: nothing was sent and nothing moved. `}Channel ${device}.${channel} is not active: its sensor is in another mode${
      group ? ` of mode group "${group}"` : ""
    }${active.length ? ` (active: ${active.join(", ")})` : ""}, and a condition never switches a sensor mode. While the robot is idle, call read_device with device "${device}" and channels ["${channel}"] to switch the mode (describe_device tells the side effects: switching a gyro resets its angle), then send this call again.`,
  );
  e.next = ["read_device"];
  return e;
}

export function compileCondition(cond: unknown, reg: Resolver, path = "condition"): CompiledCondition {
  const issues = validateCondition(cond, path);
  if (issues.length)
    throw bad(
      issues.map((i) => `${i.path}: ${i.message}`).join("; ") +
        ". A condition is {device, channel, op, value} with op lt, lte, gt, gte, eq, neq, changed (no value) or contains, or {any:[...]}, {all:[...]}, {not:{...}}.",
    );
  const leaves: Leaf[] = [];
  const tree = build(cond as Record<string, unknown>, reg, path, leaves);
  return { leaves, tree };
}

function build(o: Record<string, unknown>, reg: Resolver, path: string, leaves: Leaf[]): Node {
  if ("any" in o)
    return { any: (o.any as Record<string, unknown>[]).map((x, i) => build(x, reg, `${path}.any[${i}]`, leaves)) };
  if ("all" in o)
    return { all: (o.all as Record<string, unknown>[]).map((x, i) => build(x, reg, `${path}.all[${i}]`, leaves)) };
  if ("not" in o) return { not: build(o.not as Record<string, unknown>, reg, `${path}.not`, leaves) };
  const op = o.op as CompareOp;
  const spec = reg.resolve(o.device as string);
  const ch = spec.channels.find((x) => x.name === o.channel);
  if (!ch)
    throw new RuntimeError(
      "unknown_channel",
      `${path}: device ${spec.id} has no channel "${String(o.channel)}". Valid channels: ${spec.channels.map((x) => x.name).join(", ") || "(none)"}`,
    );
  checkLeafTypes(path, ch, op, o.value);
  if (ch.active === false)
    throw inactive(
      path,
      spec.id,
      ch.name,
      ch.mode_group,
      spec.channels.filter((x) => x.mode_group === ch.mode_group && x.active !== false).map((x) => x.name),
    );
  if (leaves.length >= MAX_LEAVES) throw bad(`${path}: a condition may have at most ${MAX_LEAVES} comparisons`);
  leaves.push({
    device: spec.id,
    channel: ch.name,
    op,
    value: o.value as Leaf["value"],
    absent: ch.null_when_absent === true,
    noise: typeof ch.noise === "number" && ch.noise > 0 ? ch.noise : 0,
  });
  return { leaf: leaves.length - 1 };
}

function checkLeafTypes(path: string, ch: ChannelSpec, op: CompareOp, value: unknown): void {
  if (ch.type === "image") throw bad(`${path}: channel "${ch.name}" is an image and cannot be used in a condition`);
  if (op === "changed") return;
  if (op === "contains") {
    if (ch.type !== "vector")
      throw bad(`${path}: op contains needs a vector channel; "${ch.name}" is ${ch.type}. Use eq or neq`);
    return;
  }
  if (ch.type === "vector") throw bad(`${path}: channel "${ch.name}" is a vector; use op contains or changed`);
  if (typeof value !== ch.type)
    throw bad(
      `${path}.value must be a ${ch.type} to compare with channel "${ch.name}" (${ch.type}${ch.unit ? ", " + ch.unit : ""}), got ${typeof value}`,
    );
  if (op !== "eq" && op !== "neq" && ch.type !== "number")
    throw bad(`${path}: op ${op} needs a number channel; "${ch.name}" is ${ch.type}. Use eq or neq`);
  // A comparison the channel's declared range can never make true is a mistake wherever it stands (under
  // `not` it would always hold): a move guarded by it would run its whole length.
  if (ch.type === "number" && ch.range && typeof value === "number") {
    const [lo, hi] = ch.range;
    const never: Partial<Record<CompareOp, boolean>> = {
      lt: value <= lo,
      lte: value < lo,
      gt: value >= hi,
      gte: value > hi,
      eq: value < lo || value > hi,
    };
    if (never[op])
      throw bad(
        `${path}: nothing was sent and nothing moved. "${ch.name}" ${op} ${value} can never be true: the range of ${ch.name} is [${lo}, ${hi}]${ch.unit ? ` ${ch.unit}` : ""}. Use a value the channel can reach (describe_device gives the range and what its ends mean)`,
      );
  }
}

// Two values of one channel are the same when no number in them differs by more than the channel's noise.
const near = (a: unknown, b: unknown, noise: number) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= noise : a === b;
const same = (a: Value, b: Value, noise: number) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((x, i) => near(x, b[i], noise))
    : near(a, b, noise);

// One evaluator per wait/move: `changed` compares against the first value this evaluator saw (on a channel that
// declares noise: a difference larger than it, in CHANGED_POLLS polls in a row), and the count of polls without
// a value runs across its polls. `unreadable: true` = this poll decided nothing (met is false).
export function makeEvaluator(
  c: CompiledCondition,
  read: ReadFn,
): { poll(): Promise<{ met: boolean; unreadable: boolean; readings: Reading[] }> } {
  const baseline: (Value | null | undefined)[] = c.leaves.map(() => undefined);
  const blindPolls: number[] = c.leaves.map(() => 0);
  const apart: number[] = c.leaves.map(() => 0); // polls in a row in which a `changed` leaf differed from its first value
  let undecided = 0;
  const byDevice = new Map<string, string[]>();
  for (const l of c.leaves) {
    const list = byDevice.get(l.device) ?? [];
    if (!list.includes(l.channel)) list.push(l.channel);
    byDevice.set(l.device, list);
  }
  const leafValue = (i: number, v: Value | null): boolean => {
    const l = c.leaves[i]!;
    if (l.op === "changed") {
      if (baseline[i] === undefined) {
        baseline[i] = v;
        return false;
      }
      const was = baseline[i]!;
      const differs = was === null || v === null ? was !== v : !same(was, v, l.noise);
      apart[i] = differs ? apart[i]! + 1 : 0;
      return apart[i]! >= (l.noise > 0 ? CHANGED_POLLS : 1);
    }
    if (v === null) return false; // nothing there: no comparison holds
    const w = l.value!;
    switch (l.op) {
      case "contains":
        return Array.isArray(v) && (v as (number | string)[]).includes(w as number | string);
      case "eq":
        return v === w;
      case "neq":
        return v !== w;
      case "lt":
        return (v as number) < (w as number);
      case "lte":
        return (v as number) <= (w as number);
      case "gt":
        return (v as number) > (w as number);
      case "gte":
        return (v as number) >= (w as number);
    }
  };
  const evalNode = (n: Node, vals: boolean[]): boolean => {
    if ("leaf" in n) return vals[n.leaf]!;
    if ("not" in n) return !evalNode(n.not, vals);
    return "any" in n ? n.any.some((k) => evalNode(k, vals)) : n.all.every((k) => evalNode(k, vals));
  };
  return {
    async poll() {
      const groups = await Promise.all([...byDevice].map(([device, channels]) => read(device, channels)));
      const readings = groups.flat();
      const needsSwitch = readings.find((r) => r.error === "mode_switch_required");
      // the registry said active and the device says otherwise (a mode switched since the last scan)
      if (needsSwitch) throw inactive(null, needsSwitch.device, needsSwitch.channel);
      const got = c.leaves.map((l) => readings.find((r) => r.device === l.device && r.channel === l.channel));
      const value = (i: number): Value | null => got[i]?.value ?? null;
      let unreadable = false;
      for (let i = 0; i < c.leaves.length; i++) {
        const l = c.leaves[i]!;
        // null is an answer only when the device said so itself; a failed read of such a channel is a failed read
        if (value(i) !== null || (l.absent && got[i]?.absent === true)) {
          blindPolls[i] = 0;
          continue;
        }
        unreadable = true;
        if (++blindPolls[i]! >= UNREADABLE_POLLS)
          throw new RuntimeError(
            "condition_unreadable",
            `The condition cannot be evaluated: ${l.device}.${l.channel} returned no value in ${blindPolls[i]} polls in a row (${got[i]?.error ?? "no value"}). A channel that cannot be read is never taken as "not met". Read the robot (read_all); if the channel stays without a value, check the sensor and its cable.`,
          );
      }
      // A poll with a comparison that could not be read decides nothing: not met, and `changed` keeps its baseline.
      if (unreadable) {
        if (++undecided >= UNDECIDED_POLLS) {
          const blind = c.leaves.flatMap((l, i) => (blindPolls[i]! > 0 ? [`${l.device}.${l.channel}`] : []));
          throw new RuntimeError(
            "condition_unreadable",
            `The condition cannot be evaluated: ${undecided} polls in a row had a channel without a value (in the last one: ${blind.join(", ")}). A channel that cannot be read is never taken as "not met". Read the robot (read_all) and check the sensors the condition names.`,
          );
        }
        return { met: false, unreadable, readings };
      }
      undecided = 0;
      return {
        met: evalNode(
          c.tree,
          c.leaves.map((_, i) => leafValue(i, value(i))),
        ),
        unreadable,
        readings,
      };
    },
  };
}
