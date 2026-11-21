// Condition compiler and evaluator. Shape rules live in packages/protocol/validate.ts (single owner); this
// file adds what needs real devices: names resolve (id or role), channels exist, value types fit the channel.
// Evaluation is three-valued: a channel that could not be read makes its leaf unknown, and an unknown
// condition is never "met". Reads here never switch a sensor mode.
import { RuntimeError } from "../protocol/types";
import type { ChannelSpec, CompareOp, DeviceSpec, Reading, Value } from "../protocol/types";
import { validateCondition } from "../protocol/validate";

export interface Resolver {
  resolve(name: string): DeviceSpec; // throws unknown_device listing valid ids and roles
}
type Leaf = { device: string; channel: string; op: CompareOp; value?: number | boolean | string };
type Node = { leaf: number } | { any: Node[] } | { all: Node[] } | { not: Node };
export interface CompiledCondition {
  leaves: Leaf[];
  tree: Node;
}
export type ReadFn = (device: string, channels: string[]) => Promise<Reading[]>;

const MAX_LEAVES = 32;
const bad = (msg: string) => new RuntimeError("invalid_argument", msg);

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
  if (leaves.length >= MAX_LEAVES) throw bad(`${path}: a condition may have at most ${MAX_LEAVES} comparisons`);
  leaves.push({ device: spec.id, channel: ch.name, op, value: o.value as Leaf["value"] });
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
}

const same = (a: Value, b: Value) =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b;

// One evaluator per wait/move: `changed` compares against the first value this evaluator saw.
export function makeEvaluator(
  c: CompiledCondition,
  read: ReadFn,
): { poll(): Promise<{ met: boolean; readings: Reading[] }> } {
  const baseline: (Value | undefined)[] = c.leaves.map(() => undefined);
  const byDevice = new Map<string, string[]>();
  for (const l of c.leaves) {
    const list = byDevice.get(l.device) ?? [];
    if (!list.includes(l.channel)) list.push(l.channel);
    byDevice.set(l.device, list);
  }
  const leafValue = (i: number, v: Value | null): boolean | undefined => {
    if (v === null || v === undefined) return undefined;
    const l = c.leaves[i]!;
    if (l.op === "changed") {
      if (baseline[i] === undefined) {
        baseline[i] = v;
        return false;
      }
      return !same(baseline[i]!, v);
    }
    const w = l.value!;
    switch (l.op) {
      case "contains":
        return Array.isArray(v) ? (v as (number | string)[]).includes(w as number | string) : undefined;
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
  const evalNode = (n: Node, vals: (boolean | undefined)[]): boolean | undefined => {
    if ("leaf" in n) return vals[n.leaf];
    if ("not" in n) {
      const x = evalNode(n.not, vals);
      return x === undefined ? undefined : !x;
    }
    const xs = ("any" in n ? n.any : n.all).map((k) => evalNode(k, vals));
    if ("any" in n) return xs.includes(true) ? true : xs.includes(undefined) ? undefined : false;
    return xs.includes(false) ? false : xs.includes(undefined) ? undefined : true;
  };
  return {
    async poll() {
      const groups = await Promise.all([...byDevice].map(([device, channels]) => read(device, channels)));
      const readings = groups.flat();
      const needsSwitch = readings.find((r) => r.error === "mode_switch_required");
      if (needsSwitch)
        throw bad(
          `Channel ${needsSwitch.device}.${needsSwitch.channel} is not active: reading it needs a sensor mode switch, which a condition never does. While the robot is idle, call read_device naming that channel to switch the mode, then retry.`,
        );
      const vals = c.leaves.map((l, i) =>
        leafValue(i, readings.find((r) => r.device === l.device && r.channel === l.channel)?.value ?? null),
      );
      return { met: evalNode(c.tree, vals) === true, readings };
    },
  };
}
