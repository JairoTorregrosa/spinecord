// ev3dev side: the real bridge (Python) on the fake sysfs tree of the driver's tests.
//   micro      bench/ev3dev_micro.py times each bridge operation inside Python (time.perf_counter)
//   runtime    the real Ev3devProvider + runtime reading through the bridge over local stdio
//   cold       installBridge() + hello through the real ssh code path, with bench/fake-ssh.ts as the ssh program
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ev3devProvider, EXAMPLE_EV3DEV_HARDWARE } from "../packages/driver-ev3dev/src/provider";
import { BRIDGE_FILE, installBridge, SshLineTransport } from "../packages/driver-ev3dev/src/ssh";
import { FakeBrick, findPython } from "../packages/driver-ev3dev/test/fake-brick";
import { createRuntime } from "../packages/runtime/runtime";
import { now, profileFor, ROOT } from "./rig";
import { metric, skipped, type Metric } from "./stats";

const fakeBrick = () =>
  new FakeBrick({
    motors: [{ port: "B" }, { port: "C" }],
    sensors: [
      { port: 1, driver: "lego-ev3-touch", mode: "TOUCH", modes: ["TOUCH"], values: [0] },
      { port: 2, driver: "lego-ev3-gyro", mode: "GYRO-ANG", modes: ["GYRO-ANG", "GYRO-RATE"], values: [90] },
      { port: 3, driver: "lego-ev3-color", mode: "COL-REFLECT", modes: ["COL-REFLECT", "COL-AMBIENT"], values: [40] },
      {
        port: 4,
        driver: "lego-ev3-us",
        mode: "US-DIST-CM",
        modes: ["US-DIST-CM", "US-DIST-IN"],
        values: [2550],
        decimals: 1,
      },
    ],
    battery_uv: 7654321,
  });

const WHAT: Record<string, string> = {
  bridge_hello: "ev3dev bridge: hello (rescan of sysfs), request line to reply, timed in Python",
  bridge_read_one: "ev3dev bridge: read ultrasonic distance_cm, timed in Python",
  bridge_read_all: "ev3dev bridge: every device read (9 devices) the way the provider's read_all asks, timed in Python",
  bridge_run_pair:
    "ev3dev bridge: run_pair with a motor that arrives at once (overhead around a move), timed in Python",
  bridge_stop: "ev3dev bridge: verified stop with idle motors, timed in Python",
  cold_bridge_spawn_hello: "cold: start the bridge process (python) until its first hello is answered",
};
const NAMES = Object.keys(WHAT).concat(["ev3dev_runtime_read", "ev3dev_runtime_read_all", "cold_bridge_install_hello"]);

export async function benchEv3dev(n: number, cold: number): Promise<Record<string, Metric>> {
  const python = findPython();
  if (!python) {
    const why = "no local Python 3 (python3 or python) to run the bridge";
    return Object.fromEntries(NAMES.map((k) => [k, skipped(WHAT[k] ?? k, why)]));
  }
  const out: Record<string, Metric> = {};
  const brick = fakeBrick();
  try {
    // ---- inside Python
    const child = Bun.spawn(
      [python, join(ROOT, "bench", "ev3dev_micro.py"), BRIDGE_FILE, brick.root, String(n), String(cold)],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`bench/ev3dev_micro.py failed (exit ${code}):\n${stderr}`);
    const micro = JSON.parse(stdout) as { samples: Record<string, number[]> };
    for (const [k, v] of Object.entries(micro.samples)) {
      const name = k === "cold_spawn_hello" ? "cold_bridge_spawn_hello" : `bridge_${k}`;
      out[name] = metric(WHAT[name]!, v);
    }

    // ---- the real provider and runtime over the local bridge
    const profile = profileFor("bench-ev3dev");
    const provider = new Ev3devProvider(brick.transport(python), {
      limits: profile.limits,
      hardware: EXAMPLE_EV3DEV_HARDWARE,
      roles: profile.roles,
    });
    try {
      const runtime = createRuntime({ profile, providers: [provider] });
      await runtime.ready();
      const us = runtime.devices().find((d) => d.kind === "ultrasonic")!.id;
      const idle = new AbortController().signal;
      const time = async (tool: "read_device" | "read_all", args: Record<string, unknown>) => {
        const samples: number[] = [];
        for (let i = 0; i < n + 10; i++) {
          const t0 = now();
          await runtime.call(tool, args, idle);
          if (i >= 10) samples.push(now() - t0);
        }
        return samples;
      };
      out.ev3dev_runtime_read = metric(
        "runtime read_device(ultrasonic) through Ev3devProvider and the local bridge",
        await time("read_device", { device: us }),
      );
      out.ev3dev_runtime_read_all = metric(
        "runtime read_all through Ev3devProvider and the local bridge",
        await time("read_all", {}),
      );
      runtime.dispose();
    } finally {
      await provider.close();
    }

    // ---- install + hello through the ssh code path
    const what = "cold: installBridge() + first hello through the ssh code path (local fake ssh, no network)";
    if (process.platform === "win32") out.cold_bridge_install_hello = skipped(what, "the fake ssh needs a POSIX sh");
    else {
      const home = mkdtempSync(join(tmpdir(), "spinecord-bench-home-"));
      const env = { BENCH_FAKE_HOME: home, SYSFS_ROOT: brick.root };
      Object.assign(process.env, env);
      const ssh = { host: "fake-brick", user: "robot", sshCommand: join(ROOT, "bench", "fake-ssh.ts") };
      try {
        const samples: number[] = [];
        for (let i = 0; i < cold; i++) {
          const t0 = now();
          await installBridge(ssh);
          const p = new Ev3devProvider(new SshLineTransport(ssh), {
            limits: profile.limits,
            hardware: EXAMPLE_EV3DEV_HARDWARE,
          });
          try {
            const devices = await p.devices();
            if (!devices.some((d) => d.kind === "motor_pair"))
              throw new Error("the bridge behind the fake ssh did not announce the motor pair");
            samples.push(now() - t0);
          } finally {
            await p.close();
          }
        }
        out.cold_bridge_install_hello = metric(what, samples);
      } finally {
        for (const k of Object.keys(env)) delete process.env[k];
        rmSync(home, { recursive: true, force: true });
      }
    }
  } finally {
    brick.dispose();
  }
  return out;
}
