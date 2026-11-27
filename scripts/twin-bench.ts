// Twin fidelity benchmark: `bun run twin-bench` (or `bun scripts/twin-bench.ts`; `--json <file>` also writes the rows).
// Drives the twin through the path the app uses (tool call -> LocalRobot -> runtime -> Ev3Provider -> SimBrick ->
// World, see scripts/twin-bench/rig.ts) and sets each number beside what a real EV3 does, from
// scripts/twin-bench/real.json (every real number there names its source and kind). Prints one row per quantity:
// real, twin, error and a verdict:
//   ok        the twin is inside the real band widened by the row's tolerance
//   OFF       outside it, against a measurement, a LEGO spec or a figure derived from the firmware
//   SUSPECT   outside a first-principles estimate (not a measurement: check it on a robot)
//   MEASURE   there is no real number to compare with; the twin's value is shown so a robot can be measured against it
// Everything but the wall-clock rows runs on a virtual clock: noise off gives the same output on every run, noise
// on is seeded. Bounded: it aborts with exit 1 past 170 s. A row outside tolerance is a finding, not a failure.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OP } from "../packages/driver-ev3/encode";
import { LARGE_DEG_S } from "../packages/sim-ev3/brick";
import { DEFAULT_NOISE, type NoiseConfig } from "../packages/sim-world/world";
import { deg, during, reading, rig, ROOT, SALA_NOISE, settle, type Rig } from "./twin-bench/rig";

const WATCHDOG = setTimeout(() => {
  console.error("twin-bench: still running after 170 s; aborting");
  process.exit(1);
}, 170_000);

interface RealRow {
  lo?: number;
  hi?: number;
  unit: string;
  kind: "measured" | "spec" | "derived" | "estimate" | "none";
  src: string;
  tol_abs?: number;
  tol_rel?: number;
  how: string;
  text?: string;
}
const REAL = (await Bun.file(join(ROOT, "scripts", "twin-bench", "real.json")).json()) as {
  sources: Record<string, { url: string; what: string }>;
  rows: Record<string, RealRow>;
};

interface Row {
  group: string;
  label: string;
  /** Key into real.json's rows; the same key may back several twin rows (one per condition). */
  key: string;
  twin: number | string;
  /** For a categorical row: does the twin do what the real sensor does? */
  agrees?: boolean;
  note?: string;
}
const rows: Row[] = [];
const add = (group: string, key: string, label: string, twin: number | string, extra: Partial<Row> = {}): void => {
  if (!REAL.rows[key]) throw new Error(`twin-bench: no entry "${key}" in real.json`);
  rows.push({ group, key, label, twin, ...extra });
};
const r1 = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const pctl = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const idx = (port: string) => "ABCD".indexOf(port);

/** Clock time at which the brick executed the last packet that carried `op`. */
function lastOpAt(r: Rig, op: number): number {
  for (let i = r.brick.log.length - 1; i >= 0; i--) if (r.brick.log[i]!.opcodes.includes(op)) return r.brick.log[i]!.at;
  throw new Error(`no packet with opcode 0x${op.toString(16)} reached the brick`);
}
async function read(r: Rig, device: string, channel: string): Promise<any> {
  const env = await r.call("read_device", { device, channels: [channel] });
  return reading(env, channel);
}
/** Puts the robot at a pose by hand (the bench's hand, like lifting the robot; not a tool call). */
function place(r: Rig, x: number, y: number, heading_deg: number): void {
  r.brick.tick();
  r.world.setPose({ x, y, th: (heading_deg * Math.PI) / 180 });
}

// ------------------------------------------------------------------ motors
async function motorSpeed(): Promise<void> {
  for (const [port, type] of [
    ["D", "large"],
    ["A", "medium"],
  ] as const) {
    for (const pct of [25, 50, 75, 100]) {
      const r = await rig({ base: "r1-encoders" });
      const m = `ev3.${port}`;
      // one 1 s run_time: the runtime chunks it into ~200 ms operations that coast into each other, so the
      // shaft is at steady speed long before the last one; speed from the tacho over 100 ms before the final brake
      let reported = NaN;
      const work = r.call("command_device", { device: m, command: "run_time", args: { ms: 1000, speed_pct: pct } });
      const probe = (async () => {
        await r.sleep(700);
        reported = await read(r, m, "speed_deg_s");
      })();
      const { samples } = await during(r, 1, work, () => r.brick.peek().motors[idx(port)]!.tacho_deg);
      await probe;
      // the run ends where the tacho stops moving (the last operation brakes on the brick)
      const last = samples[samples.length - 1]!.v;
      const end = samples.find((s) => Math.abs(s.v - last) < 1e-6)!.t;
      const a = samples.find((s) => s.t >= end - 110)!,
        b = samples.find((s) => s.t >= end - 10)!;
      const speed = ((b.v - a.v) / (b.t - a.t)) * 1000;
      add("motor", `${type}_speed_${pct}`, `${type} motor, steady speed at ${pct} % (run_time)`, r1(speed, 0));
      if (pct === 50)
        add("honesty", `${type}_report_50`, `${type} motor at 50 %: speed_deg_s the model reads`, reported, {
          note: `true shaft speed ${r1(speed, 0)} deg/s; the provider converts every motor's % with ${LARGE_DEG_S} deg/s per 100 % (a real robot: 1050)`,
        });
    }
  }
}

async function stepResponse(): Promise<void> {
  for (const command of ["power", "run_time"] as const) {
    const r = await rig({ base: "r1-encoders" });
    const arg = command === "power" ? { power_pct: 50, ms: 250 } : { speed_pct: 50, ms: 250 };
    const { samples } = await during(
      r,
      1,
      r.call("command_device", { device: "ev3.D", command, args: arg }),
      () => r.brick.peek().motors[3]!.speed_pct,
    );
    const t0 = lastOpAt(r, command === "power" ? OP.OUTPUT_TIME_POWER : OP.OUTPUT_TIME_SPEED);
    const at = (f: number) => samples.find((s) => s.t >= t0 && s.v >= f * 50)!.t - t0;
    const peak = Math.max(...samples.map((s) => s.v));
    if (command === "power") {
      add("motor", "power_t63", "power 50 % from rest: time to 63 % of final speed", r1(at(0.632), 0));
      add("motor", "power_t90", "power 50 % from rest: time to 90 %", r1(at(0.9), 0));
      add(
        "motor",
        "power_50_speed",
        "power 50 % (unregulated): final shaft speed, no load",
        r1((peak / 100) * LARGE_DEG_S, 0),
        {
          note: "the twin runs power like a regulated speed: independent of battery and load",
        },
      );
    } else add("motor", "speed_t63", "speed 50 % from rest (regulated): time to 63 %", r1(at(0.632), 0));
  }
}

async function stops(): Promise<void> {
  // through the provider itself: the runtime brakes the last operation of every command_device move whatever its
  // `brake` says, but coasts between the chunks of a move, so the coast still decides where a move's chunks land
  for (const brake of [true, false]) {
    for (const pct of [25, 50, 75, 100]) {
      const r = await rig({ base: "r1-encoders" });
      const run = r.ev3.command("ev3.D", "run_time", { ms: 250, speed_pct: pct, brake }, new AbortController().signal);
      const { samples } = await during(r, 1, run, () => r.brick.peek().motors[3]!.tacho_deg);
      const end = lastOpAt(r, OP.OUTPUT_TIME_SPEED) + 250;
      const tEnd = samples.find((s) => s.t >= end)!;
      // a brake runs the shaft on, then springs it back toward the stop point: the row is the run-on (its peak)
      let peak = samples.filter((s) => s.t >= end).reduce((p, s) => Math.max(p, s.v), tEnd.v);
      const t1 = r.now();
      while (r.now() - t1 < 5000) {
        const m = r.brick.peek().motors[3]!;
        peak = Math.max(peak, m.tacho_deg);
        if (m.speed_pct === 0 && !m.coasting && !m.settling) break;
        await r.sleep(1);
      }
      const final = r.brick.peek().motors[3]!.tacho_deg;
      const ms = r.now() - end; // from the brick's end of the command to rest
      const over = final - tEnd.v;
      if (brake)
        add(
          "motor",
          `brake_overshoot_${pct}`,
          `brake from ${pct} %: shaft travel after the stop`,
          r1(peak - tEnd.v, 1),
          { note: `run-on peak; at rest ${r1(over, 1)} deg from the stop point after ${r1(ms, 0)} ms` },
        );
      else if (pct === 100 || pct === 50) {
        add(
          "motor",
          `coast_deg_${pct}`,
          `coast (provider, brake:false) from ${pct} %: travel after the end`,
          r1(over, 0),
        );
        if (pct === 100) add("motor", "coast_ms_100", "coast from 100 %: time to rest", r1(ms, 0));
      }
    }
  }
}

async function hardwareLogRows(): Promise<void> {
  // the 2026-11-21 runs were one 250 ms operation each (no runtime chunking then): compare where the shaft is
  // 250 ms after the start reached the brick
  for (const [device, command, args, key, label] of [
    [
      "ev3.B",
      "run_degrees",
      { degrees: 90, speed_pct: 20 },
      "hw_run_degrees_90_20",
      "ev3.B run_degrees 90 @20: degrees 250 ms after the start",
    ],
    [
      "ev3.pair",
      "run_pair",
      { left_deg: 180, right_deg: 180, speed_pct: 25 },
      "hw_run_pair_180_25",
      "ev3.pair run_pair 180/180 @25: degrees 250 ms after the start",
    ],
  ] as const) {
    const r = await rig({ base: "r1-encoders" });
    const { samples } = await during(
      r,
      1,
      r.call("command_device", { device, command, args }),
      () => r.brick.peek().motors[1]!.tacho_deg,
    );
    const first = r.brick.log.find((l) =>
      l.opcodes.includes(command === "run_pair" ? OP.OUTPUT_TIME_SYNC : OP.OUTPUT_TIME_SPEED),
    )!.at;
    add("hw-log", key, label, r1(samples.find((s) => s.t >= first + 250)!.v, 0), {
      note: "real is ev3dev: its own regulator, 1050 deg/s per 100 %",
    });
  }
  // a constant round trip is the provider's best case (its poll and the runtime's link estimate predict the stop
  // exactly); the ev3dev runs had 21-149 ms of WiFi jitter, so jittered links (seeded) run beside the constant ones
  const links: [string, number | [number, number]][] = [
    ["rtt 0", 0],
    ["rtt 6", 6],
    ["rtt 50", 50],
    ["rtt 2-10", [2, 10]],
    ["rtt 21-149", [21, 149]],
  ];
  for (const [name, rtt] of links) {
    const r = await rig({ base: "r1-encoders", rtt_ms: rtt, seed: 3 });
    // how the runtime ran the move: brake on every operation (a slow or unknown link) or coast between them
    let coastSeen = 0,
      brakeSeen = 0;
    const mode = () => {
      const m = (r.brick as any).motors[1] as { speedPct: number; holdBrake: boolean };
      if (m.speedPct !== 0) {
        if (m.holdBrake) brakeSeen++;
        else coastSeen++;
      }
      return 0;
    };
    const { out: e } = await during(r, 2, r.call("drive", { distance_cm: 5, speed_pct: 25 }), mode);
    await settle(r);
    const target = (5 / (Math.PI * 5.6)) * 360;
    const m = e.data.measured;
    const chunking = () =>
      coastSeen > 0
        ? `coasting chunks (${Math.round((100 * coastSeen) / (coastSeen + brakeSeen))} % of the time)`
        : "every chunk braked";
    add(
      "hw-log",
      "hw_drive5_overshoot",
      `drive 5 cm @25, ${name} ms: encoder degrees past the target`,
      r1(Math.max(m.left_deg, m.right_deg) - target, 0),
      { note: `encoders ${m.left_deg}/${m.right_deg} for ${r1(target, 0)}; ${chunking()}` },
    );
    coastSeen = brakeSeen = 0;
    const sides: number[] = [],
      turns: number[] = [];
    await during(
      r,
      2,
      (async () => {
        for (let i = 0; i < 4; i++) {
          const d = await r.call("drive", { distance_cm: 15, speed_pct: 30 });
          sides.push(d.data.measured.distance_cm);
          const t = await r.call("turn", { angle_deg: 90, speed_pct: 30 });
          turns.push(t.data.measured.heading_change_deg);
        }
      })(),
      mode,
    );
    add("hw-log", "hw_square_side", `square, ${name} ms: encoder side for 15 cm (max)`, Math.max(...sides), {
      note: `sides ${sides.join(", ")}; ${chunking()}`,
    });
    add("hw-log", "hw_square_turn", `square, ${name} ms: encoder turn for 90 (max)`, Math.max(...turns), {
      note: `turns ${turns.join(", ")}`,
    });
  }
}

async function tachoTarget(): Promise<void> {
  for (const rtt of [0, 6, [2, 10], [21, 149]] as (number | [number, number])[]) {
    for (const [degrees, pct] of [
      [90, 50],
      [360, 50],
      [360, 100],
    ] as const) {
      const r = await rig({ base: "r1-encoders", rtt_ms: rtt, seed: 3 });
      let done = 0,
        reason = "";
      // degree targets past one 250 ms operation are sent again for the rest, as the model is told to
      for (let i = 0; i < 10 && degrees - done >= 1; i++) {
        const e = await r.call("command_device", {
          device: "ev3.D",
          command: "run_degrees",
          args: { degrees: degrees - done, speed_pct: pct },
        });
        done += e.data.measured.degrees;
        reason = e.data.reason;
      }
      await settle(r);
      const final = r.brick.peek().motors[3]!.tacho_deg;
      add(
        "motor",
        "tacho_target",
        `run_degrees ${degrees} @${pct}, rtt ${Array.isArray(rtt) ? rtt.join("-") : rtt} ms: final error`,
        r1(final - degrees, 1),
        {
          note: `reported ${done}, last reason ${reason}`,
        },
      );
    }
  }
}

async function blocked(): Promise<void> {
  const r = await rig({
    base: "r1-encoders",
    boxes: [{ x: 300, y: 0, w: 20, h: 800 }],
    start: { x: 291.5, y: 400, heading_deg: 0 },
  });
  let midSpeed = NaN;
  const probe = (async () => {
    await r.sleep(400);
    midSpeed = await read(r, "ev3.B", "speed_deg_s");
  })();
  const x0 = r.world.pose.x;
  const e = await r.call("drive", { distance_cm: 20, speed_pct: 30 }, true);
  await probe;
  const stalled = await read(r, "ev3.B", "stalled");
  const d = e.ok ? e.data : e.error;
  add(
    "regulation",
    "blocked_tacho",
    "drive 20 cm @30 against a wall: encoders, speed, stall",
    `tacho ${e.ok ? d.measured.left_deg : "?"} deg, speed ${midSpeed}, stalled ${stalled}`,
    {
      agrees: false,
      note: `reason ${e.ok ? d.reason : d.code}; body moved ${r1(r.world.pose.x - x0, 2)} cm`,
    },
  );
}

async function driveTurn(): Promise<void> {
  for (const base of ["r1", "orugas"] as const) {
    for (const rtt of [0, 6]) {
      const r = await rig({ base, rtt_ms: rtt });
      const x0 = r.world.pose.x;
      const t0 = r.now();
      const d = await r.call("drive", { distance_cm: 50, speed_pct: 50 });
      await settle(r);
      add("drive", "none_drive", `${base}, rtt ${rtt}: drive 50 @50, true distance (cm)`, r1(r.world.pose.x - x0, 2), {
        note: `reported ${d.data.measured.distance_cm} cm by ${d.data.measured.source}, ${r1(r.now() - t0, 0)} ms`,
      });
      for (const angle of [90, 360]) {
        const th0 = r.world.pose.th;
        const t1 = r.now();
        const t = await r.call("turn", { angle_deg: angle, speed_pct: 30 });
        await settle(r);
        add(
          "drive",
          "none_turn",
          `${base}, rtt ${rtt}: turn ${angle} @30, true heading change (deg)`,
          r1(deg(r.world.pose.th - th0), 1),
          {
            note: `reported ${t.data.measured.heading_change_deg} by ${t.data.measured.source}, ${r1(r.now() - t1, 0)} ms`,
          },
        );
      }
    }
  }
}

async function drift(): Promise<void> {
  for (const [base, noise] of [
    ["r1", DEFAULT_NOISE],
    ["orugas", SALA_NOISE],
  ] as ["r1" | "orugas", NoiseConfig][]) {
    const lat: number[] = [],
      head: number[] = [],
      along: number[] = [];
    for (let seed = 1; seed <= 30; seed++) {
      const r = await rig({ base, noise, seed });
      const p0 = { ...r.world.pose };
      await r.call("drive", { distance_cm: 200, speed_pct: 50 });
      await settle(r);
      const p = r.world.pose;
      lat.push(p.y - p0.y);
      along.push(p.x - p0.x);
      head.push(deg(p.th - p0.th));
    }
    const abs = (xs: number[]) => xs.map(Math.abs);
    add(
      "drive",
      "none_drift",
      `${base}: drive 200 @50 with noise, |lateral| p50 / p95 (cm), 30 seeds`,
      `${r1(pctl(abs(lat), 50))} / ${r1(pctl(abs(lat), 95))}`,
      {
        note: `heading p50/p95 ${r1(pctl(abs(head), 50))}/${r1(pctl(abs(head), 95))} deg; along ${r1(Math.min(...along))}..${r1(Math.max(...along))} cm`,
      },
    );
  }
}

// ------------------------------------------------------------------ distance sensors
const WALL = 600;
async function ultrasonic(): Promise<void> {
  const r = await rig({ base: "r1", boxes: [{ x: WALL, y: 0, w: 20, h: 800 }] });
  const sx = 8; // r1 has the default body: the distance sensor 8 cm ahead of the axle
  for (const d of [5, 10, 30, 100, 200, 250, 300]) {
    place(r, WALL - d - sx, 400, 0);
    add("ultrasonic", `us_${d}`, `wall square on at ${d} cm`, await read(r, "ev3.S4", "distance_cm"));
  }
  for (const d of [2, 1]) {
    place(r, WALL - d - sx, 400, 0);
    add("ultrasonic", "us_min_2", `wall at ${d} cm (under the 3 cm minimum)`, await read(r, "ev3.S4", "distance_cm"));
  }
  for (const a of [0, 15, 30, 45, 60]) {
    // the sensor 50 cm from the wall along its normal, the robot turned `a` off it
    const rad = (a * Math.PI) / 180;
    place(r, WALL - 50 - sx * Math.cos(rad), 400 - sx * Math.sin(rad), a);
    const v = await read(r, "ev3.S4", "distance_cm");
    add("ultrasonic", `us_angle_${a}`, `wall 50 cm away, ${a} deg off square`, v, a >= 30 ? { agrees: v === 255 } : {});
  }
  {
    const n = await rig({ base: "r1", noise: { ...DEFAULT_NOISE }, boxes: [{ x: WALL, y: 0, w: 20, h: 800 }] });
    place(n, WALL - 100 - sx, 400, 0);
    const xs: number[] = [];
    for (let i = 0; i < 50; i++) xs.push(await read(n, "ev3.S4", "distance_cm"));
    add("ultrasonic", "us_noise", "wall at 100 cm, noise on: spread (std of 50 reads)", r1(std(xs), 2), {
      note: "compare with LEGO's +-1 cm; the provider declares noise 2",
    });
  }
  // a 5 cm post at 50, 100 and 150 cm, swept sideways
  for (const d of [50, 100, 150]) {
    const out: string[] = [];
    for (const off of [0, 3, 6, 10, 15, 20]) {
      const p = await rig({ base: "r1", boxes: [{ x: 300 + d, y: 400 + off - 2.5, w: 5, h: 5 }] });
      place(p, 300 - sx, 400, 0);
      out.push(`${off}:${await read(p, "ev3.S4", "distance_cm")}`);
    }
    add("ultrasonic", "us_post", `5 cm post at ${d} cm, lateral offset cm:reading`, out.join(" "));
  }
  {
    // where inside the cone a 5 cm post goes unseen: every 0.5 cm of lateral offset within the cone's half width
    let seen = 0,
      inside = 0;
    const blind: string[] = [];
    for (const d of [100, 150, 200, 250]) {
      const half = d * Math.tan((12 * Math.PI) / 180);
      for (let off = 0; off <= half; off += 0.5) {
        const p = await rig({ base: "r1", boxes: [{ x: 300 + d, y: 400 + off - 2.5, w: 5, h: 5 }] });
        place(p, 300 - sx, 400, 0);
        inside++;
        if ((await read(p, "ev3.S4", "distance_cm")) !== 255) seen++;
        else blind.push(`${d}/${off}`);
      }
    }
    add(
      "ultrasonic",
      "us_post_blind",
      "5 cm post anywhere inside the +-12 deg cone at 100-250 cm: positions missed",
      `${inside - seen}/${inside}`,
      {
        agrees: inside === seen,
        note: `missed at distance/offset cm ${blind.slice(0, 8).join(" ")}${blind.length > 8 ? " ..." : ""}`,
      },
    );
  }
  {
    // a room corner straight ahead along the diagonal, the sensor 70 cm from it
    const c = await rig({
      base: "r1",
      arena: { width_cm: 400, height_cm: 400 },
      start: { x: 100, y: 100, heading_deg: 0 },
    });
    const k = (70 + sx) / Math.SQRT2;
    place(c, 400 - k, 400 - k, 45);
    const v = await read(c, "ev3.S4", "distance_cm");
    add("ultrasonic", "us_inner_corner", "room corner 70 cm ahead, walls at 45 deg", v, {
      agrees: v !== 255 && Math.abs(v - 70) < 5,
    });
    const b = await rig({ base: "r1", boxes: [{ x: 300, y: 300, w: 60, h: 60 }] });
    const q = (70 + sx) / Math.SQRT2;
    place(b, 300 - q, 300 - q, 45);
    add(
      "ultrasonic",
      "us_box_corner",
      "box corner 70 cm ahead, faces at 45 deg",
      await read(b, "ev3.S4", "distance_cm"),
    );
  }
}

async function infrared(): Promise<void> {
  const r = await rig({ base: "orugas", boxes: [{ x: WALL, y: 0, w: 20, h: 800 }] });
  const sx = 6; // orugas' infrared sits 6 cm ahead of the axle
  const curve: string[] = [];
  for (const d of [5, 10, 20, 30, 38, 50, 70, 80, 90, 100]) {
    place(r, WALL - d - sx, 400, 0);
    const v = await read(r, "ev3.S4", "proximity_pct");
    curve.push(`${d}:${v}`);
    if (d === 38) {
      add("infrared", "ir_38", "white wall at 38 cm", v);
      add("infrared", "ir_38_black", "black wall at 38 cm (the twin has no surface colour)", v);
    }
    if (d === 70) add("infrared", "ir_70", "wall at 70 cm", v);
  }
  let first = NaN;
  for (let d = 60; d <= 120; d++) {
    place(r, WALL - d - sx, 400, 0);
    if ((await read(r, "ev3.S4", "proximity_pct")) === 100) {
      first = d;
      break;
    }
  }
  add("infrared", "ir_100_at", "nearest wall distance that reads 100 (cm)", first, {
    note: `curve cm:pct ${curve.join(" ")}`,
  });
  const n = await rig({ base: "orugas", noise: { ...SALA_NOISE }, boxes: [{ x: WALL, y: 0, w: 20, h: 800 }] });
  place(n, WALL - 38 - sx, 400, 0);
  const xs: number[] = [];
  for (let i = 0; i < 100; i++) xs.push(await read(n, "ev3.S4", "proximity_pct"));
  add("infrared", "ir_noise_38", "white wall at 38 cm, noise on: std of 100 reads", r1(std(xs), 2), {
    note: `range ${Math.min(...xs)}..${Math.max(...xs)}; the provider declares noise 3`,
  });
}

// ------------------------------------------------------------------ gyro
async function gyro(): Promise<void> {
  const err90: number[] = [],
    cw: number[] = [],
    ccw: number[] = [],
    slow: number[] = [];
  for (let seed = 1; seed <= 30; seed++) {
    const r = await rig({ base: "r1-encoders", noise: { ...DEFAULT_NOISE, motor: 0, slip: 0, wheel_bias: 0 }, seed });
    const sweep = async (angle: number, pct: number): Promise<{ gyro: number; truth: number }> => {
      await r.call("command_device", { device: "ev3.S2", command: "reset", args: {} });
      const th0 = r.world.pose.th;
      await r.call("turn", { angle_deg: angle, speed_pct: pct });
      await settle(r);
      return { gyro: await read(r, "ev3.S2", "angle_deg"), truth: deg(r.world.pose.th - th0) };
    };
    const a = await sweep(90, 30);
    err90.push(Math.abs(a.gyro - a.truth));
    const b = await sweep(-360, 30);
    cw.push((-b.gyro / -b.truth) * 360);
    const c = await sweep(360, 30);
    ccw.push((c.gyro / c.truth) * 360);
    if (seed <= 5) {
      const s = await sweep(-360, 5);
      slow.push((-s.gyro / -s.truth) * 360);
    }
  }
  add("gyro", "gyro_turn90", "turn 90 @30: |gyro - true|, p95 over 30 seeds", r1(pctl(err90, 95)), {
    note: `p50 ${r1(pctl(err90, 50))}`,
  });
  add("gyro", "gyro_cw360", "clockwise 360 @30: what the gyro reads (mean, 30 seeds)", r1(mean(cw)), {
    note: `range ${r1(Math.min(...cw))}..${r1(Math.max(...cw))}`,
  });
  add("gyro", "gyro_ccw360", "counter-clockwise 360 @30: what the gyro reads (mean)", r1(mean(ccw)), {
    note: `range ${r1(Math.min(...ccw))}..${r1(Math.max(...ccw))}`,
  });
  add("gyro", "gyro_slow360", "clockwise 360 @5 (slow): what the gyro reads (mean, 5 seeds)", r1(mean(slow)));
  {
    const r = await rig({ base: "r1-encoders", noise: { ...DEFAULT_NOISE } });
    await r.call("command_device", { device: "ev3.S2", command: "reset", args: {} });
    await r.sleep(60_000);
    add(
      "gyro",
      "gyro_rest_60s",
      "at rest 60 s after a reset: |angle| (default noise)",
      Math.abs(await read(r, "ev3.S2", "angle_deg")),
      {
        note: `noise.gyro_drift_deg_s is ${DEFAULT_NOISE.gyro_drift_deg_s} by default`,
      },
    );
  }
  {
    const r = await rig({ base: "r1-encoders" });
    await read(r, "ev3.S2", "rate_deg_s"); // the switch to rate mode, while idle
    let rate = NaN;
    const probe = (async () => {
      await r.sleep(500);
      rate = await read(r, "ev3.S2", "rate_deg_s");
    })();
    await r.call("turn", { angle_deg: 360, speed_pct: 100 });
    await probe;
    add("gyro", "gyro_rate_max", "spin at 100 % on wheels 5.6 / axle 12: rate_deg_s read", Math.abs(rate), {
      note: "the declared range of rate_deg_s is -440..440",
    });
  }
  {
    const r = await rig({ base: "r1-encoders" });
    const turn = r.call("turn", { angle_deg: 180, speed_pct: 50 });
    await r.sleep(300);
    await r.call("command_device", { device: "ev3.S2", command: "reset", args: {} });
    await turn;
    await settle(r);
    const a0 = await read(r, "ev3.S2", "angle_deg");
    await r.sleep(10_000);
    const a1 = await read(r, "ev3.S2", "angle_deg");
    add("gyro", "gyro_reset_moving", "reset while turning @50, then still: drift (deg/s)", r1((a1 - a0) / 10, 1));
  }
}

// ------------------------------------------------------------------ colour, touch
async function colour(): Promise<void> {
  // a 2 cm black line across the robot's path at x = 300; the colour sensor is 7 cm ahead of the axle
  const r = await rig({
    base: "r1",
    lines: [
      {
        points: [
          [300, 0],
          [300, 800],
        ],
        width_cm: 2,
      },
    ],
  });
  const prof: { x: number; v: number }[] = [];
  for (let x = 293 - 7; x <= 301 - 7; x += 0.1) {
    place(r, x, 400, 0);
    prof.push({ x: x + 7, v: await read(r, "ev3.S3", "reflected_pct") });
  }
  const white = prof[0]!.v,
    black = Math.min(...prof.map((p) => p.v));
  const hi = black + 0.9 * (white - black),
    lo = black + 0.1 * (white - black);
  const a = prof.find((p) => p.v <= hi)!.x,
    b = prof.find((p) => p.v <= lo)!.x;
  add("colour", "color_edge_width", "reflected across a line edge: 90 % to 10 % width (cm)", r1(b - a, 2), {
    note: `spot radius ${r.world.cfg.body.color_spot_radius_cm} cm (body.color_spot_radius_cm), no height`,
  });
  add("colour", "color_white_black", "reflected on white / on black", `${white} / ${black}`);
  const ids: string[] = [];
  for (let x = 297 - 7; x <= 300 - 7; x += 0.5) {
    place(r, x, 400, 0);
    ids.push(`${r1(x + 7 - 300, 1)}:${await read(r, "ev3.S3", "color")}`);
  }
  add("colour", "color_id_edge", "color id approaching the line, cm from its centre:id", ids.join(" "), {
    note: "the floor under the spot's centre: black or white, never an in-between colour",
  });
  place(r, 200, 400, 0);
  add("colour", "color_rgb_white", "rgb on white", JSON.stringify(await read(r, "ev3.S3", "rgb")), {
    note: "the floor colour's sRGB scaled by 400/255, not a sensor's raw counts",
  });
  add("colour", "color_ambient", "ambient_pct anywhere", await read(r, "ev3.S3", "ambient_pct"), {
    note: "a constant: the world has no light",
  });
  const t = await rig({ base: "r1", boxes: [{ x: WALL, y: 0, w: 20, h: 800 }] });
  const out: string[] = [];
  for (const gap of [2, 1, 0.8, 0.6, 0.4, 0.2]) {
    place(t, WALL - gap - 8, 400, 0); // r1's front is 8 cm ahead of the axle
    out.push(`${gap}:${(await read(t, "ev3.S1", "pressed")) ? 1 : 0}`);
  }
  add("touch", "touch_travel", "front-to-wall gap cm:pressed", out.join(" "));
}

// ------------------------------------------------------------------ rates, battery, link, time
async function rates(): Promise<void> {
  const r = await rig({
    base: "r1",
    boxes: [{ x: WALL, y: 0, w: 20, h: 800 }],
    start: { x: 450, y: 400, heading_deg: 0 },
  });
  const values: number[] = [];
  await during(r, 20, r.call("drive", { distance_cm: 30, speed_pct: 30 }), () => 0);
  // read at 50 Hz while it drives back
  const back = r.call("drive", { distance_cm: -30, speed_pct: 30 });
  const reads = (async () => {
    for (let i = 0; i < 40; i++) {
      values.push(await read(r, "ev3.S4", "distance_cm"));
      await r.sleep(20);
    }
  })();
  await Promise.all([back, reads]);
  let changes = 0,
    minStep = Infinity;
  for (let i = 1; i < values.length; i++) {
    const s = Math.abs(values[i]! - values[i - 1]!);
    if (s > 0) {
      changes++;
      minStep = Math.min(minStep, s);
    }
  }
  add(
    "rates",
    "rate_us",
    "ultrasonic read at 50 Hz while moving: reads that changed / reads",
    `${changes}/${values.length - 1}`,
    {
      note: `smallest step ${r1(minStep, 2)} cm: a fresh value on every read, at any rate`,
    },
  );
}

async function battery(): Promise<void> {
  const r = await rig({ base: "r1-encoders" });
  const rest = await read(r, "ev3.battery", "voltage_v");
  add("battery", "battery_v", "battery voltage_v at rest", rest);
  let loaded = NaN;
  const probe = (async () => {
    await r.sleep(150);
    loaded = await read(r, "ev3.battery", "voltage_v");
  })();
  await r.call("command_device", {
    device: "ev3.pair",
    command: "run_pair",
    args: { left_deg: 2000, right_deg: 2000, speed_pct: 100 },
  });
  await probe;
  add("battery", "battery_sag", "battery voltage_v with both drive motors at 100 %", loaded, {
    note: "motor speed never depends on it in the twin",
  });
}

async function link(): Promise<void> {
  const r = await rig({ base: "r1-encoders", real: true });
  const ms: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    await r.call("read_device", { device: "ev3.S4", channels: ["distance_cm"] });
    ms.push(performance.now() - t0);
  }
  add(
    "link",
    "rtt_usb",
    "read_device round trip, twin in-process, real clock: p50 / p95 ms",
    `${r1(pctl(ms, 50), 2)} / ${r1(pctl(ms, 95), 2)}`,
    {
      note: "the twin's cable is a microtask: a real USB round trip adds to every read and to every host-decided stop",
    },
  );
  const t0 = performance.now();
  const e = await r.call("command_device", {
    device: "ev3.speaker",
    command: "tone",
    args: { frequency_hz: 440, duration_ms: 500 },
  });
  add("link", "tone_call_ms", "tone 440 Hz 500 ms: how long the call takes (ms)", r1(performance.now() - t0, 1), {
    note: `reason ${e.data.reason}; tones logged ${r.brick.toneCount}`,
  });
}

async function time(): Promise<void> {
  // real clock: a free motor runs the whole 30 s; 50 Hz reads for 15 s, then 1 Hz for 15 s
  const r = await rig({ base: "r1-encoders", real: true });
  let running = true;
  const motor = (async () => {
    while (running)
      await r.call("command_device", {
        device: "ev3.D",
        command: "run_time",
        args: { ms: 250, speed_pct: 40, brake: false },
      });
  })();
  const half = async (hz: number) => {
    r.brick.tick();
    const w0 = performance.now(),
      s0 = r.world.t_ms;
    while (performance.now() - w0 < 15_000) {
      await r.call("read_device", { device: "ev3.D", channels: ["position_deg"] });
      await new Promise((res) => setTimeout(res, 1000 / hz));
    }
    r.brick.tick();
    return (r.world.t_ms - s0) / (performance.now() - w0);
  };
  const fast = await half(50);
  const slow = await half(1);
  running = false;
  await motor;
  add("time", "time_ratio", "simulated / wall-clock time over 15 s, reading at 50 Hz", r1(fast, 4));
  add("time", "time_ratio", "simulated / wall-clock time over 15 s, reading at 1 Hz", r1(slow, 4));
  // does reading change the path? the same noisy drive, unwatched and read at 50 Hz (virtual clock)
  const path = async (watch: boolean) => {
    const v = await rig({ base: "orugas", noise: { ...SALA_NOISE }, seed: 7 });
    const work = v.call("drive", { distance_cm: 60, speed_pct: 40 });
    if (watch) {
      let on = true;
      const reads = (async () => {
        while (on) {
          await v.call("read_device", { device: "ev3.S4", channels: ["proximity_pct"] });
          await v.sleep(20);
        }
      })();
      await work;
      on = false;
      await reads;
    } else await work;
    await settle(v);
    return v.world.pose;
  };
  const a = await path(false),
    b = await path(true);
  add(
    "time",
    "read_changes_path",
    "pose difference, drive 60 cm unwatched vs read at 50 Hz (cm)",
    r1(Math.hypot(a.x - b.x, a.y - b.y), 4),
    {
      note: "noise on, seed 7, orugas in its room's noise",
    },
  );
}

// ------------------------------------------------------------------ table
interface Out extends Row {
  real: string;
  src: string;
  err: string;
  verdict: string;
}
function judge(row: Row): Out {
  const e = REAL.rows[row.key]!;
  const real =
    e.text ??
    (e.lo === undefined ? "-" : e.lo === e.hi ? `${e.lo}` : `${e.lo}..${e.hi}`) +
      (e.lo === undefined ? "" : ` ${e.unit}`);
  const src = `${e.kind}: ${e.src}`;
  let verdict = "MEASURE",
    err = "-";
  if (row.agrees !== undefined) verdict = row.agrees ? "ok" : e.kind === "estimate" ? "SUSPECT" : "OFF";
  else if (e.lo !== undefined && e.hi !== undefined && typeof row.twin === "number") {
    const mid = (e.lo + e.hi) / 2;
    const tol = e.tol_abs ?? (e.tol_rel ?? 0) * Math.abs(mid);
    const out = row.twin < e.lo - tol ? row.twin - e.lo : row.twin > e.hi + tol ? row.twin - e.hi : 0;
    const rel = (100 * (row.twin - mid)) / Math.abs(mid);
    // a band from 0 (an error bound) has no meaningful relative error: show how far past it, in its unit
    err = e.lo === 0 ? `${out > 0 ? "+" : ""}${r1(out, 2)} ${e.unit}` : `${rel > 0 ? "+" : ""}${r1(rel, 1)} %`;
    verdict = out === 0 ? "ok" : e.kind === "estimate" ? "SUSPECT" : "OFF";
  }
  return { ...row, real, src, err, verdict };
}

const started = performance.now();
const steps: [string, () => Promise<void>][] = [
  ["motor speed", motorSpeed],
  ["step response", stepResponse],
  ["stops", stops],
  ["tacho targets", tachoTarget],
  ["hardware log", hardwareLogRows],
  ["blocked wheel", blocked],
  ["drive and turn", driveTurn],
  ["drift", drift],
  ["ultrasonic", ultrasonic],
  ["infrared", infrared],
  ["gyro", gyro],
  ["colour and touch", colour],
  ["rates", rates],
  ["battery", battery],
  ["link and tone", link],
  ["time", time],
];
for (const [name, run] of steps) {
  const t = performance.now();
  await run();
  console.error(`twin-bench: ${name} (${Math.round(performance.now() - t)} ms)`);
}
const out = rows.map(judge);
const cells = (o: Out) => [o.group, o.label, o.real, o.src, String(o.twin), o.err, o.verdict, o.note ?? ""];
const head = ["group", "quantity", "real", "source", "twin", "error", "verdict", "note"];
console.log(`| ${head.join(" | ")} |\n| ${head.map(() => "---").join(" | ")} |`);
for (const o of out)
  console.log(
    `| ${cells(o)
      .map((c) => c.replaceAll("|", "/"))
      .join(" | ")} |`,
  );
const count = (v: string) => out.filter((o) => o.verdict === v).length;
console.log(
  `\n${out.length} rows: ${count("ok")} ok, ${count("OFF")} OFF, ${count("SUSPECT")} SUSPECT, ${count("MEASURE")} MEASURE (${Math.round((performance.now() - started) / 1000)} s)`,
);
console.log("\nSources:");
for (const [k, s] of Object.entries(REAL.sources)) console.log(`- ${k}: ${s.url}`);
const json = process.argv.indexOf("--json");
if (json >= 0) {
  const file = process.argv[json + 1];
  if (!file) throw new Error("usage: bun scripts/twin-bench.ts --json <file>");
  writeFileSync(file, JSON.stringify(out, null, 2));
}
clearTimeout(WATCHDOG);
process.exit(0);
