// Latency benchmark of the whole physical-AI path: `bun run bench`.
//   bun run bench                          run everything (under 3 min), write bench/results/<git-sha>.json, print a table
//   bun run bench --quick                  fewer samples, no result file (to try a change)
//   bun run bench --out <file.json>        write the result somewhere else
//   bun run bench --compare <a.json> <b.json>   before/after table with a speedup column (before / after)
// What is real: Ev3Provider and Ev3Link on a SimBrick (byte-level EV3 on 2D physics, real clock at 1x), the runtime,
// createRuntimeClient over a real WebSocket, the Worker in Miniflare with wrangler.jsonc's own timings, and an MCP
// client over Streamable HTTP. Everything is on loopback on one machine: numbers are the software's own latency,
// with link latency added only where a metric says so (see rig.ts, TapProvider).
// Every sample asserts ok:true and the expected reason, so an error path is never timed by accident.
// Not part of CI: wall-clock numbers on shared runners are noise. Compare runs taken on the same machine.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg, platform, arch, release, totalmem } from "node:os";
import { join } from "node:path";
import { benchEv3dev } from "./ev3dev";
import { ADMIN_TOKEN, ROOT, SERVER, startRelay, TOKEN, type Relay } from "./relay";
import { buildTwin, connect, crossing, halted, isBrake, isMotion, mcpClient, now, place, sleep, watch } from "./rig";
import type { Mcp, Twin } from "./rig";
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
  bridge: QUICK ? 20 : 100,
  bridgeCold: QUICK ? 2 : 8,
};
const SPEED_PCT = 30;
const THRESHOLD_CM = 30;
const LINKS = [0, 30, 600] as const;
const ROBOT = "bench";
const COLD_ROBOTS = Array.from({ length: N.cold }, (_, i) => `bench-cold-${i + 1}`);

const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const rid = () => crypto.randomUUID();
const started = now();
const stage = (name: string) => console.error(`[${((now() - started) / 1000).toFixed(1).padStart(5)} s] ${name}`);
const metrics: Record<string, Metric> = {};
const breakdown: Record<string, unknown> = {};
const p50 = (xs: number[]) => (xs.length ? round(percentile(xs, 50)) : null);

/** A mutating call as a model would make it: a rate_limited or busy answer is waited out and retried, and counted. */
async function act(mcp: Mcp, name: string, args: Record<string, unknown>) {
  const attempts: { bytes: number; ms: number; code?: string }[] = [];
  for (;;) {
    const out = await mcp.call(name, { ...args, request_id: rid() }, true);
    if (out.envelope.ok) {
      attempts.push({ bytes: out.bytes, ms: out.ms });
      return { out, attempts };
    }
    const e = out.envelope.error;
    attempts.push({ bytes: out.bytes, ms: out.ms, code: e.code });
    if ((e.code !== "rate_limited" && e.code !== "busy") || attempts.length > 20)
      throw new Error(`${name} ${JSON.stringify(args)} failed: ${JSON.stringify(e)}`);
    await sleep(e.retry_after_ms ?? 50);
  }
}

// ------------------------------------------------------------------ scenarios

async function coldStart(relay: Relay): Promise<Mcp> {
  metrics.cold_server_start = metric("cold: Miniflare (workerd) start until the Worker accepts requests", [
    relay.cold.start_ms,
  ]);
  metrics.cold_server_first_request = metric("cold: first request the Worker serves (GET /health)", [
    relay.cold.first_request_ms,
  ]);
  breakdown.cold_worker_bundle_ms = round(relay.cold.bundle_ms);
  const t0 = now();
  const mcp = await mcpClient(relay.url);
  await mcp.call("list_robots", {});
  metrics.cold_server_first_mcp = metric("cold: MCP initialize + first tools/call (list_robots) on a new Worker", [
    now() - t0,
  ]);

  const ready: number[] = [],
    online: number[] = [],
    first: number[] = [];
  for (const id of COLD_ROBOTS) {
    const twin = await buildTwin(id, SEED);
    ready.push(twin.ready_ms);
    const { client, online_ms } = await connect(twin, relay.url);
    online.push(online_ms);
    const us = twin.runtime.devices().find((d) => d.kind === "ultrasonic")!.id;
    first.push((await mcp.call("read_device", { robot_id: id, device: us })).ms);
    client.close();
    twin.runtime.dispose();
  }
  metrics.cold_runtime_ready = metric("cold: createRuntime() until ready() (device scan over the brick)", ready);
  metrics.cold_runtime_online = metric(
    "cold: runtime client connect() until online (WebSocket + hello + welcome)",
    online,
  );
  metrics.cold_first_read = metric("cold: first MCP read_device on a robot that just came online", first);
  return mcp;
}

async function reads(relay: Relay, mcp: Mcp, twin: Twin, us: string): Promise<void> {
  const idle = new AbortController().signal;
  const robot_id = twin.id;
  // one sample of each per round, so warm-up and drift land on every metric alike
  const fns = [
    () => mcp.call("read_device", { robot_id, device: us }),
    () => mcp.call("read_all", { robot_id }),
    () => twin.runtime.call("read_device", { device: us }, idle),
    () => twin.runtime.call("read_all", {}, idle),
    () => twin.ev3.read(us),
    () => mcp.call("list_robots", {}),
    async () => (await fetch(`${relay.url}/health`)).text(),
    () => mcp.listTools(),
    async () => {
      // the same read as one raw JSON-RPC POST: no MCP client library on this side
      const res = await fetch(`${relay.url}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "read_device", arguments: { robot_id, device: us } },
        }),
      });
      const text = await res.text();
      if (res.status !== 200 || !text.includes('\\"ok\\":true'))
        throw new Error(`raw read_device answered ${res.status}: ${text.slice(0, 300)}`);
    },
  ];
  const out: number[][] = fns.map(() => []);
  const inside: number[] = [];
  const perReadAll = { provider_calls: 0, brick_packets: 0 };
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
      }
    }
  }
  const [mcpRead, mcpReadAll, rtRead, rtReadAll, provRead, floor, health, toolsList, rawRead] = out as [
    number[],
    number[],
    number[],
    number[],
    number[],
    number[],
    number[],
    number[],
    number[],
  ];

  metrics.mcp_read = metric(
    "MCP read_device(ultrasonic) end to end: MCP > server > runtime client > runtime > provider > brick > back",
    mcpRead,
  );
  metrics.mcp_read_all = metric("MCP read_all end to end", mcpReadAll);
  metrics.runtime_read = metric("runtime.call read_device(ultrasonic), no server", rtRead);
  metrics.runtime_read_all = metric("runtime.call read_all, no server", rtReadAll);
  const diff = (a: number[], b: number[], p: number) => percentile(a, p) - percentile(b, p);
  metrics.server_overhead = derived(
    "mcp_read - runtime_read: what MCP, the Worker, the Durable Object and the WebSocket add to one read",
    diff(mcpRead, rtRead, 50),
    diff(mcpRead, rtRead, 95),
    N.reads,
  );
  metrics.server_overhead_read_all = derived(
    "mcp_read_all - runtime_read_all",
    diff(mcpReadAll, rtReadAll, 50),
    diff(mcpReadAll, rtReadAll, 95),
    N.reads,
  );
  metrics.provider_read = metric("Ev3Provider.read(ultrasonic) on the brick, no runtime", provRead);
  metrics.mcp_floor = metric(
    `MCP list_robots: no runtime round trip (Worker + a status RPC to each of the ${1 + COLD_ROBOTS.length} robots' Durable Objects)`,
    floor,
  );
  metrics.http_floor = metric("GET /health: one HTTP round trip to the Worker", health);
  metrics.mcp_tools_list = metric("MCP tools/list: auth + MCP server in the Worker, no Durable Object", toolsList);
  metrics.raw_jsonrpc_read = metric(
    "read_device as one raw JSON-RPC POST to /mcp (no MCP client library on the caller's side)",
    rawRead,
  );

  const describe = await mcp.call("describe_robot", { robot_id });
  const all = await mcp.call("read_all", { robot_id });
  const one = await mcp.call("read_device", { robot_id, device: us });
  metrics.bytes_read_device = metric("response size of read_device(ultrasonic)", [one.bytes], "bytes");
  metrics.bytes_read_all = metric("response size of read_all", [all.bytes], "bytes");
  metrics.bytes_describe_robot = metric("response size of describe_robot", [describe.bytes], "bytes");
  metrics.bytes_tools_list = metric(
    "size of tools/list (the catalog every session loads)",
    [await mcp.toolsListBytes()],
    "bytes",
  );

  // the relay's own clock for the same calls (calls.ms in D1): time inside the Durable Object, WebSocket trip included
  const res = await fetch(`${relay.url}/api/calls?robot_id=${robot_id}&limit=1000`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  if (!res.ok) throw new Error(`/api/calls answered ${res.status}: ${await res.text()}`);
  const list = ((await res.json()) as { data: { tool: string; ms: number }[] }).data;
  breakdown.read_layers_p50_ms = {
    brick_packet: p50(twin.packets.map((p) => p.ms)),
    provider_read: metrics.provider_read.p50,
    runtime_read: metrics.runtime_read.p50,
    runtime_inside_mcp_read: p50(inside),
    relay_calls_ms_read_device: p50(list.filter((r) => r.tool === "read_device").map((r) => r.ms)),
    relay_calls_ms_read_all: p50(list.filter((r) => r.tool === "read_all").map((r) => r.ms)),
    http_floor: metrics.http_floor.p50,
    mcp_floor: metrics.mcp_floor.p50,
    mcp_tools_list: metrics.mcp_tools_list.p50,
    raw_jsonrpc_read: metrics.raw_jsonrpc_read.p50,
    mcp_read: metrics.mcp_read.p50,
  };
  breakdown.read_all_per_call = perReadAll;
}

/** first_motion and stop_latency share a run: drive, wait for motion, stop through MCP. */
async function motionAndStop(mcp: Mcp, twin: Twin, rnd: () => number): Promise<void> {
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
    const drive = mcp.call("drive", { robot_id, distance_cm: 80, speed_pct: SPEED_PCT, request_id: rid() }, true);
    let motion;
    while (!(motion = twin.packets.slice(k0).find(isMotion))) {
      if (now() - t0 > 5000) throw new Error("drive: no motion packet reached the brick within 5 s");
      await sleep(1);
    }
    await sleep(300 + rnd() * 200); // the stop lands at a different phase of the 200 ms chunks on every run
    const tStop = now();
    const stop = await mcp.call("stop", { robot_id });
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
    await sleep(220); // stay under the relay's 5 mutating calls per second
  }
  metrics.first_motion = metric("MCP drive call sent until the first motor operation reaches the brick", first);
  metrics.stop_latency = metric(
    "MCP stop call sent until it returns motors_stopped:true (verified), robot driving",
    stopCall,
  );
  metrics.stop_to_halt = metric("MCP stop call sent until the robot stands still (world ground truth)", stopHalt);
  breakdown.first_motion_p50_ms = {
    call_reaches_runtime: p50(firstRuntime),
    first_motor_packet: p50(first),
  };
  breakdown.stop_p50_ms = {
    stop_reaches_provider: p50(stopRuntime),
    brake_packet_at_brick: p50(stopBrake),
    robot_halted: p50(stopHalt),
    mcp_stop_returns: p50(stopCall),
  };
}

/** The safety metric: drive `until distance_cm < X`; from the true distance crossing X until the robot stands still. */
async function reaction(mcp: Mcp, twin: Twin, us: string, rnd: () => number): Promise<void> {
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
    const res = await mcp.call("drive", {
      robot_id,
      distance_cm: 60,
      speed_pct: SPEED_PCT,
      until: { device: us, channel: "distance_cm", op: "lt", value: THRESHOLD_CM },
      request_id: rid(),
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
    await sleep(220);
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
  metrics.reaction_reported = metric("threshold crossed until the MCP drive call returns condition_met", reported);
  breakdown.reaction_p50_ms = {
    brake_packet_at_brick: p50(brakeSent),
    robot_halted: p50(wall),
    mcp_returns: p50(reported),
    ground_truth_sampling_period: p50(period),
  };
}

/** 4 x (drive 15 cm + turn 90) through MCP, one call per move, with a link round trip added to every provider call. */
async function square(mcp: Mcp, twin: Twin, link_ms: number, runs: number): Promise<void> {
  const robot_id = twin.id;
  const totals: number[] = [],
    counts: number[] = [],
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
      let calls = 0;
      const t0 = now();
      for (let side = 0; side < 4; side++) {
        for (const [tool, args] of [
          ["drive", { distance_cm: 15 }],
          ["turn", { angle_deg: 90 }],
        ] as const) {
          const { out, attempts } = await act(mcp, tool, { robot_id, speed_pct: SPEED_PCT, ...args });
          if (out.envelope.ok && out.envelope.data.reason !== "completed")
            throw new Error(`square (link ${link_ms} ms): ${tool} ended with ${JSON.stringify(out.envelope.data)}`);
          calls += attempts.length;
          for (const a of attempts) bytes.push(a.bytes);
          const data = (out.envelope as { data: { chunks: number; ms: number } }).data;
          moves.push({ tool, ms: round(out.ms), chunks: data.chunks, inside_runtime_ms: data.ms });
        }
      }
      const total = now() - t0;
      await sleep(30);
      twin.brick.tick();
      const end = twin.brick.world.pose;
      totals.push(total);
      counts.push(calls);
      closure.push(Math.hypot(end.x - start.x, end.y - start.y));
      const ops = twin.ops.slice(o0);
      const sum = (xs: number[]) => round(xs.reduce((a, b) => a + b, 0));
      detail.push({
        total_ms: round(total),
        mcp_calls: calls,
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
      await sleep(220);
    }
  } finally {
    twin.link.round_trip_ms = 0;
  }
  const tag = `square_twin_${link_ms}ms`;
  metrics[tag] = metric(
    `4 x (drive 15 cm + turn 90) on the twin through MCP, total wall time, ${link_ms} ms link round trip per provider call`,
    totals,
  );
  if (link_ms === 0) {
    metrics.calls_square = metric(
      "MCP calls the square takes (retries after rate_limited or busy count)",
      counts,
      "calls",
    );
    metrics.bytes_square_response = metric("response size of one drive or turn in the square", bytes, "bytes");
    metrics.bytes_square_total = metric(
      "response bytes of the whole square",
      [bytes.reduce((a, b) => a + b, 0) / runs],
      "bytes",
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
    miniflare: (JSON.parse(readFileSync(join(SERVER, "package.json"), "utf8")) as any).devDependencies.miniflare,
  },
  params: {
    quick: QUICK,
    samples: N,
    speed_pct: SPEED_PCT,
    reaction_threshold_cm: THRESHOLD_CM,
    link_round_trip_ms: LINKS,
    world: "packages/sim-world/examples/line-oval.json, noise off",
    profile: "packages/sim-ev3/examples/twin.example.json (max_command_ms 60000)",
    sim_clock: "real time, 1x",
    relay_timings: "packages/server/wrangler.jsonc vars, unchanged",
    // the ideal: only the motion itself at the commanded speed on the simulated motor (1020 deg/s at 100 %)
    square_motion_only_ms: Math.round(
      (4 * ((15 * 360) / (Math.PI * 5.6) + (90 * 12) / 5.6) * 1000) / ((SPEED_PCT / 100) * 1020),
    ),
  },
  metrics,
  breakdown,
};
breakdown.square = {};

stage("relay: bundling the Worker and starting Miniflare");
const relay = await startRelay([ROBOT, ...COLD_ROBOTS]);
let exit = 0;
try {
  stage("cold start");
  const mcp = await coldStart(relay);
  const twin = await buildTwin(ROBOT, SEED);
  const { client } = await connect(twin, relay.url);
  const us = twin.runtime.devices().find((d) => d.kind === "ultrasonic")!.id;
  const rnd = prng(SEED);

  stage("reads");
  await reads(relay, mcp, twin, us);
  stage("first motion and stop");
  await motionAndStop(mcp, twin, rnd);
  stage("reaction (drive until)");
  await reaction(mcp, twin, us, rnd);
  for (const link of [LINKS[0], LINKS[1]]) {
    stage(`square, link ${link} ms`);
    await square(mcp, twin, link, link === 0 ? N.square : Math.min(2, N.square));
  }
  // the tunnel profile waits on injected sleeps, so the ev3dev part (another process, timed in Python) runs beside it
  stage(`square, link ${LINKS[2]} ms (one run) + ev3dev bridge`);
  const [, ev3dev] = await Promise.all([square(mcp, twin, LINKS[2], 1), benchEv3dev(N.bridge, N.bridgeCold)]);
  Object.assign(metrics, ev3dev);

  if (twin.brick.errors.length || twin.brick.overlaps || twin.brick.unboundedMoves)
    throw new Error(
      `the brick saw protocol problems: ${JSON.stringify({ errors: twin.brick.errors, overlaps: twin.brick.overlaps, unbounded: twin.brick.unboundedMoves })}`,
    );
  client.close();
  await mcp.close();
} catch (e) {
  console.error(e);
  exit = 1;
} finally {
  await relay.dispose();
}
if (exit) process.exit(exit);

results.wall_s = Math.round((now() - started) / 100) / 10;
// the order of the brief: reads, split, reaction, stop, first motion, square, calls and bytes, bridge, cold start
const ORDER = [
  "mcp_read",
  "mcp_read_all",
  "runtime_read",
  "runtime_read_all",
  "server_overhead",
  "server_overhead_read_all",
  "provider_read",
  "mcp_floor",
  "http_floor",
  "mcp_tools_list",
  "raw_jsonrpc_read",
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
  "calls_square",
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
