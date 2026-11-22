// Latency benchmark of the path from a tool call to the robot: `bun run bench`.
//   bun run bench                          run everything (under 3 min), write bench/results/<git-sha>.json, print a table
//   bun run bench --quick                  fewer samples, no result file (to try a change)
//   bun run bench --out <file.json>        write the result somewhere else
//   bun run bench --compare <a.json> <b.json>   before/after table with a speedup column (before / after)
// What is real: Ev3Provider and Ev3Link on a SimBrick (byte-level EV3 on 2D physics, real clock at 1x), the runtime,
// and apps/local's robot state and tool dispatch around it, all in this process, where the bench can tap every
// packet and read the world's ground truth. The stdio metrics start `bun apps/local/main.ts` as an MCP client does
// and speak JSON-RPC over its pipes. Everything is on one machine: numbers are the software's own latency, with
// link latency added only where a metric says so (see rig.ts, TapProvider).
// Every sample asserts ok:true and the expected reason, so an error path is never timed by accident.
// Not part of CI: wall-clock numbers on shared runners are noise. Compare runs taken on the same machine.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg, platform, arch, release, totalmem } from "node:os";
import { join } from "node:path";
import { benchEv3dev } from "./ev3dev";
import { startServer } from "../apps/local/test/client";
import { buildTwin, crossing, halted, isBrake, isMotion, localTools, now, place, ROOT, sleep, watch } from "./rig";
import type { Tools, Twin } from "./rig";
import {
  compareTable,
  derived,
  metric,
  percentile,
  prng,
  resultsTable,
  round,
  type Metric,
  type Results,
} from "./stats";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

if (flag("--compare")) {
  const i = argv.indexOf("--compare");
  const [a, b] = [argv[i + 1], argv[i + 2]];
  if (!a || !b) throw new Error("usage: bun run bench --compare <before.json> <after.json>");
  const load = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Results;
  const [before, after] = [load(a), load(b)];
  console.log(`before: ${before.sha} (${before.at}, ${before.machine.cpu})`);
  console.log(`after:  ${after.sha} (${after.at}, ${after.machine.cpu})`);
  if (before.machine.cpu !== after.machine.cpu)
    console.log("WARNING: the two runs come from different machines; the speedup column is not trustworthy");
  console.log(`\n${compareTable(before, after)}`);
  process.exit(0);
}

const QUICK = flag("--quick");
const SEED = 1;
const N = {
  reads: QUICK ? 30 : 200,
  warm: QUICK ? 5 : 20,
  cold: QUICK ? 2 : 8,
  stop: QUICK ? 4 : 16,
  reaction: QUICK ? 4 : 20,
  square: QUICK ? 1 : 3,
  usb: QUICK ? 10 : 50,
  bridge: QUICK ? 20 : 100,
  bridgeCold: QUICK ? 2 : 8,
};
const SPEED_PCT = 30;
const USB_PACKET_MS = 2;
const THRESHOLD_CM = 30;
const LINKS = [0, 30, 600] as const;
const ROBOT = "bench";

const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const started = now();
const stage = (name: string) => console.error(`[${((now() - started) / 1000).toFixed(1).padStart(5)} s] ${name}`);
const metrics: Record<string, Metric> = {};
const breakdown: Record<string, unknown> = {};
const p50 = (xs: number[]) => (xs.length ? round(percentile(xs, 50)) : null);

// ------------------------------------------------------------------ scenarios

async function coldStart(): Promise<void> {
  const ready: number[] = [],
    online: number[] = [],
    first: number[] = [];
  for (let i = 0; i < N.cold; i++) {
    const twin = await buildTwin(`bench-cold-${i + 1}`, SEED);
    ready.push(twin.ready_ms);
    const tools = await localTools(twin);
    online.push(tools.online_ms);
    const us = twin.runtime.devices().find((d) => d.kind === "ultrasonic")!.id;
    first.push((await tools.call("read_device", { robot_id: twin.id, device: us })).ms);
    twin.runtime.dispose();
  }
  metrics.cold_runtime_ready = metric("cold: createRuntime() until ready() (device scan over the brick)", ready);
  metrics.cold_robot_online = metric("cold: LocalRobot.attach() until online (device scan + verified stop)", online);
  metrics.cold_first_read = metric("cold: first read_device on a robot that just came online", first);
}

/** The server as an MCP client starts it: `bun apps/local/main.ts` with its default twin, JSON-RPC over stdio. */
async function stdio(): Promise<void> {
  const cold: number[] = [];
  for (let i = 0; i < N.cold; i++) {
    const t0 = now();
    const s = await startServer();
    await s.rpc("tools/call", { name: "list_robots", arguments: {} });
    cold.push(now() - t0);
    await s.closeStdin();
  }
  metrics.cold_stdio_first_call = metric(
    "cold: process spawn until the first tools/call is answered (initialize, tools/list, list_robots)",
    cold,
  );
  const s = await startServer();
  try {
    const robots = (await s.tool("list_robots")).envelope as { data: { robots: { id: string }[] } };
    const robot_id = robots.data.robots[0]!.id;
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await s.rpc("tools/call", { name, arguments: args });
      if (res.error || res.result.isError) throw new Error(`stdio ${name} failed: ${JSON.stringify(res)}`);
    };
    const fns = [
      () => call("read_device", { robot_id, device: "distance" }),
      () => call("read_all", { robot_id }),
      () => call("list_robots", {}),
      () => s.rpc("tools/list"),
    ];
    const out: number[][] = fns.map(() => []);
    for (let i = 0; i < N.warm + N.reads; i++)
      for (const [k, fn] of fns.entries()) {
        const t0 = now();
        await fn();
        if (i >= N.warm) out[k]!.push(now() - t0);
      }
    const [read, readAll, floor, list] = out as [number[], number[], number[], number[]];
    metrics.stdio_read = metric(
      "MCP over stdio, read_device(ultrasonic) end to end: client > pipe > apps/local > runtime > provider > brick > back",
      read,
    );
    metrics.stdio_read_all = metric("MCP over stdio, read_all end to end", readAll);
    metrics.stdio_floor = metric("MCP over stdio, list_robots: no runtime call (the pipe and JSON-RPC)", floor);
    metrics.stdio_tools_list = metric("MCP over stdio, tools/list", list);
    metrics.bytes_tools_list = metric(
      "size of tools/list (the catalog every session loads)",
      [Buffer.byteLength(JSON.stringify((await s.rpc("tools/list")).result), "utf8")],
      "bytes",
    );
  } finally {
    await s.closeStdin();
  }
}

async function reads(tools: Tools, twin: Twin, us: string): Promise<void> {
  const idle = new AbortController().signal;
  const robot_id = twin.id;
  // one sample of each per round, so warm-up and drift land on every metric alike
  const fns = [
    () => tools.call("read_device", { robot_id, device: us }),
    () => tools.call("read_all", { robot_id }),
    () => twin.runtime.call("read_device", { device: us }, idle),
    () => twin.runtime.call("read_all", {}, idle),
    () => twin.ev3.read(us),
    () => tools.call("list_robots", {}),
  ];
  const out: number[][] = fns.map(() => []);
  const inside: number[] = [];
  const perReadAll = { provider_calls: 0, brick_packets: 0 };
  const readAllPackets: number[] = [];
  for (let i = 0; i < N.warm + N.reads; i++) {
    for (const [k, fn] of fns.entries()) {
      const c0 = twin.calls.length,
        o0 = twin.ops.length,
        k0 = twin.packets.length;
      const t0 = now();
      await fn();
      const ms = now() - t0;
      if (i < N.warm) continue;
      out[k]!.push(ms);
      if (k === 0) inside.push(twin.calls[c0]!.ms);
      if (k === 1) {
        perReadAll.provider_calls = twin.ops.length - o0;
        perReadAll.brick_packets = twin.packets.length - k0;
        readAllPackets.push(perReadAll.brick_packets);
      }
    }
  }
  const [toolRead, toolReadAll, rtRead, rtReadAll, provRead, floor] = out as [
    number[],
    number[],
    number[],
    number[],
    number[],
    number[],
  ];

  metrics.tool_read = metric(
    "tool call read_device(ultrasonic), in process: apps/local dispatch > robot state > runtime > provider > brick > back",
    toolRead,
  );
  metrics.tool_read_all = metric("tool call read_all, in process", toolReadAll);
  metrics.runtime_read = metric("runtime.call read_device(ultrasonic)", rtRead);
  metrics.runtime_read_all = metric("runtime.call read_all", rtReadAll);
  const diff = (a: number[], b: number[], p: number) => percentile(a, p) - percentile(b, p);
  metrics.dispatch_overhead = derived(
    "tool_read - runtime_read: what apps/local's input validation, robot state and envelope add to one read",
    diff(toolRead, rtRead, 50),
    diff(toolRead, rtRead, 95),
    N.reads,
  );
  metrics.dispatch_overhead_read_all = derived(
    "tool_read_all - runtime_read_all",
    diff(toolReadAll, rtReadAll, 50),
    diff(toolReadAll, rtReadAll, 95),
    N.reads,
  );
  metrics.provider_read = metric("Ev3Provider.read(ultrasonic) on the brick, no runtime", provRead);
  metrics.tool_floor = metric("tool call list_robots, in process: no runtime call", floor);

  const describe = await tools.call("describe_robot", { robot_id });
  const all = await tools.call("read_all", { robot_id });
  const one = await tools.call("read_device", { robot_id, device: us });
  metrics.bytes_read_device = metric("response size of read_device(ultrasonic)", [one.bytes], "bytes");
  metrics.bytes_read_all = metric("response size of read_all", [all.bytes], "bytes");
  metrics.bytes_describe_robot = metric("response size of describe_robot", [describe.bytes], "bytes");

  breakdown.read_layers_p50_ms = {
    brick_packet: p50(twin.packets.map((p) => p.ms)),
    provider_read: metrics.provider_read.p50,
    runtime_read: metrics.runtime_read.p50,
    runtime_inside_tool_read: p50(inside),
    tool_floor: metrics.tool_floor.p50,
    tool_read: metrics.tool_read.p50,
  };
  breakdown.read_all_per_call = perReadAll;
  metrics.packets_read_all = metric("packets one read_all sends to the stock EV3 brick", readAllPackets, "packets");

  // the same read_all with the cable's own latency on every packet: what round trips to the brick cost
  const usb: number[] = [];
  twin.usb.packet_ms = USB_PACKET_MS;
  try {
    for (let i = 0; i < 5 + N.usb; i++) {
      const t0 = now();
      await twin.runtime.call("read_all", {}, idle);
      if (i >= 5) usb.push(now() - t0);
    }
  } finally {
    twin.usb.packet_ms = 0;
  }
  metrics.ev3_read_all_usb = metric(
    `runtime read_all on the stock EV3 with ${USB_PACKET_MS} ms added to every packet (USB HID)`,
    usb,
  );
}

/** first_motion and stop_latency share a run: drive, wait for motion, stop. */
async function motionAndStop(tools: Tools, twin: Twin, rnd: () => number): Promise<void> {
  const robot_id = twin.id;
  const first: number[] = [],
    firstRuntime: number[] = [],
    stopCall: number[] = [],
    stopHalt: number[] = [],
    stopBrake: number[] = [],
    stopRuntime: number[] = [];
  for (let i = 0; i < N.stop + 2; i++) {
    place(twin, 20, 25, 0);
    const w = watch(twin);
    const k0 = twin.packets.length,
      c0 = twin.calls.length,
      o0 = twin.ops.length;
    const t0 = now();
    const drive = tools.call("drive", { robot_id, distance_cm: 80, speed_pct: SPEED_PCT }, true);
    let motion;
    while (!(motion = twin.packets.slice(k0).find(isMotion))) {
      if (now() - t0 > 5000) throw new Error("drive: no motion packet reached the brick within 5 s");
      await sleep(1);
    }
    await sleep(300 + rnd() * 200); // the stop lands at a different phase of the 200 ms chunks on every run
    const tStop = now();
    const stop = await tools.call("stop", { robot_id });
    if (stop.envelope.ok && stop.envelope.data.motors_stopped !== true)
      throw new Error(`stop was not verified: ${JSON.stringify(stop.envelope)}`);
    const driven = await drive;
    const reason = driven.envelope.ok ? driven.envelope.data.reason : driven.envelope.error.code;
    await sleep(30);
    const samples = w.stop();
    const halt = halted(samples);
    const brake = twin.packets.slice(k0).find((p) => p.at >= tStop && isBrake(p));
    const stopOp = twin.ops.slice(o0).find((o) => o.op === "stop" && o.provider === "ev3" && o.at >= tStop);
    if (!brake || !stopOp || halt.t < tStop)
      throw new Error(`stop run ${i}: no brake after the stop call (drive ended with ${reason})`);
    if (i >= 2) {
      first.push(motion.at - t0);
      firstRuntime.push(twin.calls[c0]!.at - t0);
      stopCall.push(stop.ms);
      stopHalt.push(halt.t - tStop);
      stopBrake.push(brake.at - tStop);
      stopRuntime.push(stopOp.at - tStop);
    }
  }
  metrics.first_motion = metric("drive call sent until the first motor operation reaches the brick", first);
  metrics.stop_latency = metric(
    "stop call sent until it returns motors_stopped:true (verified), robot driving",
    stopCall,
  );
  metrics.stop_to_halt = metric("stop call sent until the robot stands still (world ground truth)", stopHalt);
  breakdown.first_motion_p50_ms = {
    call_reaches_runtime: p50(firstRuntime),
    first_motor_packet: p50(first),
  };
  breakdown.stop_p50_ms = {
    stop_reaches_provider: p50(stopRuntime),
    brake_packet_at_brick: p50(stopBrake),
    robot_halted: p50(stopHalt),
    stop_returns: p50(stopCall),
  };
}

/** The safety metric: drive `until distance_cm < X`; from the true distance crossing X until the robot stands still. */
async function reaction(tools: Tools, twin: Twin, us: string, rnd: () => number): Promise<void> {
  const robot_id = twin.id;
  place(twin, 43, 25, 0);
  const x0 = 43,
    d0 = twin.brick.world.coneDistance();
  const wall: number[] = [],
    sim: number[] = [],
    brakeSent: number[] = [],
    overshoot: number[] = [],
    reported: number[] = [],
    period: number[] = [];
  for (let i = 0; i < N.reaction + 1; i++) {
    // the crossing falls at a different phase of the runtime's chunks on every run (seeded jitter)
    const lead = 4 + rnd() * 8;
    place(twin, x0 + d0 - (THRESHOLD_CM + lead), 25, 0);
    const k0 = twin.packets.length;
    const w = watch(twin);
    const res = await tools.call("drive", {
      robot_id,
      distance_cm: 60,
      speed_pct: SPEED_PCT,
      until: { device: us, channel: "distance_cm", op: "lt", value: THRESHOLD_CM },
    });
    const returned = now();
    if (res.envelope.ok && res.envelope.data.reason !== "condition_met")
      throw new Error(`drive until: expected condition_met, got ${JSON.stringify(res.envelope.data)}`);
    await sleep(30);
    const samples = w.stop();
    // the sensor reports 0.1 cm steps: it first reads under the threshold when the true distance passes X - 0.05
    const cross = crossing(samples, THRESHOLD_CM - 0.05);
    const halt = halted(samples);
    if (!cross || halt.t < cross.t) throw new Error(`reaction run ${i}: the distance never crossed ${THRESHOLD_CM} cm`);
    const brake = twin.packets.slice(k0).find((p) => p.at >= cross.t && isBrake(p));
    if (i >= 1) {
      wall.push(halt.t - cross.t);
      sim.push(halt.sim - cross.sim);
      if (brake) brakeSent.push(brake.at - cross.t); // none when the chunk in flight ended braking by itself
      overshoot.push(cross.d - halt.d);
      reported.push(returned - cross.t);
      const gaps = samples.slice(1).map((s, j) => s.t - samples[j]!.t);
      period.push(percentile(gaps, 50));
    }
  }
  metrics.reaction = metric(
    `drive until distance_cm < ${THRESHOLD_CM}: true distance crosses the threshold until the robot stands still (wall time)`,
    wall,
  );
  metrics.reaction_sim = metric("the same interval on the world's own clock (sim time; the twin runs at 1x)", sim);
  metrics.reaction_overshoot = metric(
    `distance travelled past the threshold before standing still, at ${SPEED_PCT} % speed`,
    overshoot,
    "cm",
  );
  metrics.reaction_reported = metric("threshold crossed until the drive call returns condition_met", reported);
  breakdown.reaction_p50_ms = {
    brake_packet_at_brick: p50(brakeSent),
    robot_halted: p50(wall),
    drive_returns: p50(reported),
    ground_truth_sampling_period: p50(period),
  };
}

/** 4 x (drive 15 cm + turn 90), one tool call per move, with a link round trip added to every provider call. */
async function square(tools: Tools, twin: Twin, link_ms: number, runs: number): Promise<void> {
  const robot_id = twin.id;
  const totals: number[] = [],
    packets: number[] = [],
    bytes: number[] = [],
    closure: number[] = [];
  const detail: unknown[] = [];
  twin.link.round_trip_ms = link_ms;
  try {
    for (let run = 0; run < runs; run++) {
      place(twin, 25, 20, 0);
      const start = { ...twin.brick.world.pose };
      const o0 = twin.ops.length,
        k0 = twin.packets.length;
      const moves: { tool: string; ms: number; chunks: number; inside_runtime_ms: number }[] = [];
      const t0 = now();
      for (let side = 0; side < 4; side++) {
        for (const [tool, args] of [
          ["drive", { distance_cm: 15 }],
          ["turn", { angle_deg: 90 }],
        ] as const) {
          const out = await tools.call(tool, { robot_id, speed_pct: SPEED_PCT, ...args });
          if (out.envelope.ok && out.envelope.data.reason !== "completed")
            throw new Error(`square (link ${link_ms} ms): ${tool} ended with ${JSON.stringify(out.envelope.data)}`);
          bytes.push(out.bytes);
          const data = (out.envelope as { data: { chunks: number; ms: number } }).data;
          moves.push({ tool, ms: round(out.ms), chunks: data.chunks, inside_runtime_ms: data.ms });
        }
      }
      const total = now() - t0;
      await sleep(30);
      twin.brick.tick();
      const end = twin.brick.world.pose;
      totals.push(total);
      packets.push(twin.packets.length - k0);
      closure.push(Math.hypot(end.x - start.x, end.y - start.y));
      const ops = twin.ops.slice(o0);
      const sum = (xs: number[]) => round(xs.reduce((a, b) => a + b, 0));
      detail.push({
        total_ms: round(total),
        tool_calls: moves.length,
        provider_calls: ops.length,
        provider_commands: ops.filter((o) => o.op === "command").length,
        provider_reads: ops.filter((o) => o.op === "read").length,
        provider_read_ms: sum(ops.filter((o) => o.op === "read").map((o) => o.ms)),
        provider_command_ms: sum(ops.filter((o) => o.op === "command").map((o) => o.ms)),
        brick_packets: twin.packets.length - k0,
        inside_runtime_ms: sum(moves.map((m) => m.inside_runtime_ms)),
        outside_runtime_ms: sum(moves.map((m) => m.ms - m.inside_runtime_ms)),
        moves,
      });
    }
  } finally {
    twin.link.round_trip_ms = 0;
  }
  const tag = `square_twin_${link_ms}ms`;
  metrics[tag] = metric(
    `4 x (drive 15 cm + turn 90) on the twin, one tool call per move, total wall time, ${link_ms} ms link round trip per provider call`,
    totals,
  );
  if (link_ms === 0) {
    metrics.bytes_square_response = metric("response size of one drive or turn in the square", bytes, "bytes");
    metrics.bytes_square_total = metric(
      "response bytes of the whole square",
      [bytes.reduce((a, b) => a + b, 0) / runs],
      "bytes",
    );
    metrics.packets_square = metric(
      "packets the whole square sends to the stock EV3 brick (8 moves)",
      packets,
      "packets",
    );
    metrics.square_closure = metric("distance between where the square ends and where it started", closure, "cm");
  }
  (breakdown.square as Record<string, unknown>)[`${link_ms}ms`] = detail;
}

// ------------------------------------------------------------------ run

const sha = git("rev-parse", "--short=12", "HEAD");
const results: Results = {
  schema: "spinecord/bench@1",
  sha,
  packages_tree: git("rev-parse", "HEAD:packages"),
  packages_dirty: git("status", "--porcelain", "--", "packages").length > 0,
  at: new Date().toISOString(),
  seed: SEED,
  wall_s: 0,
  machine: {
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memory_gb: Math.round(totalmem() / 2 ** 30),
    os: `${platform()} ${release()} ${arch()}`,
    // 1-minute load average when the run started: a busy machine shows here (always 0 on Windows)
    load_1m_start: Math.round(loadavg()[0]! * 100) / 100,
    bun: Bun.version,
  },
  params: {
    quick: QUICK,
    samples: N,
    speed_pct: SPEED_PCT,
    reaction_threshold_cm: THRESHOLD_CM,
    link_round_trip_ms: LINKS,
    usb_packet_ms: USB_PACKET_MS,
    world: "packages/sim-world/examples/line-oval.json, noise off",
    profile: "packages/sim-ev3/examples/twin.example.json (max_command_ms 60000)",
    sim_clock: "real time, 1x",
    stdio_robot: "apps/local's default twin (deployments/example/robots/r1.json in apps/local/examples/room.json)",
    // the ideal: only the motion itself at the commanded speed on the simulated motor (1020 deg/s at 100 %)
    square_motion_only_ms: Math.round(
      (4 * ((15 * 360) / (Math.PI * 5.6) + (90 * 12) / 5.6) * 1000) / ((SPEED_PCT / 100) * 1020),
    ),
  },
  metrics,
  breakdown,
};
breakdown.square = {};

let exit = 0;
try {
  stage("cold start");
  await coldStart();
  stage("MCP over stdio");
  await stdio();
  const twin = await buildTwin(ROBOT, SEED);
  const tools = await localTools(twin);
  const us = twin.runtime.devices().find((d) => d.kind === "ultrasonic")!.id;
  const rnd = prng(SEED);

  stage("reads");
  await reads(tools, twin, us);
  stage("first motion and stop");
  await motionAndStop(tools, twin, rnd);
  stage("reaction (drive until)");
  await reaction(tools, twin, us, rnd);
  for (const link of [LINKS[0], LINKS[1]]) {
    stage(`square, link ${link} ms`);
    await square(tools, twin, link, link === 0 ? N.square : Math.min(2, N.square));
  }
  // the tunnel profile waits on injected sleeps, so the ev3dev part (another process, timed in Python) runs beside it
  stage(`square, link ${LINKS[2]} ms (one run) + ev3dev bridge`);
  const [, ev3dev] = await Promise.all([square(tools, twin, LINKS[2], 1), benchEv3dev(N.bridge, N.bridgeCold)]);
  Object.assign(metrics, ev3dev);

  if (twin.brick.errors.length || twin.brick.overlaps || twin.brick.unboundedMoves)
    throw new Error(
      `the brick saw protocol problems: ${JSON.stringify({ errors: twin.brick.errors, overlaps: twin.brick.overlaps, unbounded: twin.brick.unboundedMoves })}`,
    );
  twin.runtime.dispose();
} catch (e) {
  console.error(e);
  exit = 1;
}
if (exit) process.exit(exit);

results.wall_s = Math.round((now() - started) / 100) / 10;
// reads, split, reaction, stop, first motion, square, packets and bytes, ev3dev bridge, cold start
const ORDER = [
  "stdio_read",
  "stdio_read_all",
  "stdio_floor",
  "stdio_tools_list",
  "tool_read",
  "tool_read_all",
  "runtime_read",
  "runtime_read_all",
  "dispatch_overhead",
  "dispatch_overhead_read_all",
  "provider_read",
  "tool_floor",
  "reaction",
  "reaction_sim",
  "reaction_overshoot",
  "reaction_reported",
  "stop_latency",
  "stop_to_halt",
  "first_motion",
  "square_twin_0ms",
  "square_twin_30ms",
  "square_twin_600ms",
  "square_closure",
  "packets_square",
  "packets_read_all",
  "ev3_read_all_usb",
  "bytes_square_response",
  "bytes_square_total",
  "bytes_read_device",
  "bytes_read_all",
  "bytes_describe_robot",
  "bytes_tools_list",
  "bridge_hello",
  "bridge_read_one",
  "bridge_read_all",
  "bridge_run_pair",
  "bridge_stop",
  "ev3dev_runtime_read",
  "ev3dev_runtime_read_all",
];
const names = [...ORDER.filter((k) => k in metrics), ...Object.keys(metrics).filter((k) => !ORDER.includes(k))];
results.metrics = Object.fromEntries(names.map((k) => [k, metrics[k]!]));

console.log(
  `\nspinecord bench @ ${sha}${results.packages_dirty ? " (packages/ has uncommitted changes)" : ""}, ${results.machine.cpu}, ${results.wall_s} s\n`,
);
console.log(resultsTable(results));
if (!QUICK || value("--out")) {
  const out = value("--out") ?? join(ROOT, "bench", "results", `${sha}.json`);
  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  // the repository's formatter decides the layout, so `bun fmt:check` stays green
  Bun.spawnSync([process.execPath, "x", "oxfmt", out], { cwd: ROOT });
  console.log(`\nwrote ${out}`);
}
process.exit(0);
