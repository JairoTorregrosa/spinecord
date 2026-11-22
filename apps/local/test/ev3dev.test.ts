// The ev3dev source end to end without a brick or a network: the driver's real bridge (Python) on a fake sysfs
// tree, reached through the real ssh code path with a local program standing in for `ssh` (bench/fake-ssh.ts).
// Needs a POSIX sh and a local python3, like the driver's own bridge tests.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRobotFile } from "../../../packages/driver-ev3/robot-file";
import { FakeBrick } from "../../../packages/driver-ev3dev/test/fake-brick";
import { EXAMPLE } from "../src/config";
import { buildFleet } from "../src/sources";
import { callTool } from "../src/tools";
import { until } from "./client";

const python3 = Bun.which("python3");
const runs = process.platform !== "win32" && python3 !== null;
if (!runs) console.warn("SKIPPED: the ev3dev source test needs a POSIX sh and python3 on PATH");

describe("an ev3dev brick over ssh", () => {
  const home = mkdtempSync(join(tmpdir(), "spinecord-local-home-"));
  const brick = runs
    ? new FakeBrick({
        motors: [{ port: "B" }, { port: "C" }],
        sensors: [
          {
            port: 4,
            driver: "lego-ev3-us",
            mode: "US-DIST-CM",
            modes: ["US-DIST-CM", "US-DIST-IN"],
            values: [420],
            decimals: 1,
          },
        ],
        battery_uv: 7900000,
      })
    : null;
  afterAll(() => {
    delete process.env.BENCH_FAKE_HOME;
    delete process.env.SYSFS_ROOT;
    delete process.env.BENCH_FAKE_DOWN;
    brick?.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  test.skipIf(!runs)("installs the bridge, comes online, reads, moves and stops", async () => {
    Object.assign(process.env, { BENCH_FAKE_HOME: home, SYSFS_ROOT: brick!.root });
    const robot = parseRobotFile(await Bun.file(EXAMPLE.robot).json(), EXAMPLE.robot);
    const events: string[] = [];
    const fleet = await buildFleet(
      {
        port: 0,
        robots: [
          {
            source: "ev3dev",
            id: "dev",
            robot,
            hardware: { low_battery_v: 6.5, max_tone_ms: 5000, speech_volume_pct: 80 },
            ssh: {
              host: "fake-brick",
              user: "robot",
              sshCommand: join(import.meta.dir, "..", "..", "..", "bench", "fake-ssh.ts"),
            },
            installBridge: true,
          },
        ],
      },
      { log: (ev) => void events.push(ev) },
    );
    try {
      const tool = async (name: string, args: Record<string, unknown> = {}) =>
        (await callTool(fleet.robots, name, { robot_id: "dev", ...args })).envelope;
      expect(events).toContain("bridge_installed");
      expect(await tool("describe_robot")).toMatchObject({
        ok: true,
        data: { backend: "ev3" },
        robot: { link: "online" },
      });
      const read = await tool("read_device", { device: "distance" });
      expect(read).toMatchObject({ ok: true, data: [{ channel: "distance_cm", value: 42 }] });
      const drive = await tool("drive", { distance_cm: 3, speed_pct: 40 });
      expect(drive.ok).toBe(true);
      expect(await tool("stop")).toMatchObject({ ok: true, data: { motors_stopped: true, activity: "idle" } });
    } finally {
      expect(await fleet.shutdown()).toEqual([{ robot_id: "dev", motors_stopped: true }]);
    }
  });

  test.skipIf(!runs)("ssh failing puts the robot offline with its hint; ssh back brings it online", async () => {
    const down = join(home, "host-is-down");
    Object.assign(process.env, { BENCH_FAKE_HOME: home, SYSFS_ROOT: brick!.root, BENCH_FAKE_DOWN: down });
    const robot = parseRobotFile(await Bun.file(EXAMPLE.robot).json(), EXAMPLE.robot);
    const events: string[] = [];
    const fleet = await buildFleet(
      {
        port: 0,
        robots: [
          {
            source: "ev3dev",
            id: "dev",
            robot,
            hardware: { low_battery_v: 6.5, max_tone_ms: 5000, speech_volume_pct: 80 },
            ssh: {
              host: "fake-brick",
              user: "robot",
              sshCommand: join(import.meta.dir, "..", "..", "..", "bench", "fake-ssh.ts"),
            },
            installBridge: true,
          },
        ],
      },
      { log: (ev) => void events.push(ev), reconnectMs: 50 },
    );
    try {
      const tool = async (name: string, args: Record<string, unknown> = {}) =>
        (await callTool(fleet.robots, name, { robot_id: "dev", ...args })).envelope;
      const listed = async () =>
        ((await callTool(fleet.robots, "list_robots", {})).envelope as { data: { link: string; connect: string }[] })
          .data[0]!;
      expect(await listed()).toMatchObject({ link: "online", connect: null });

      writeFileSync(down, "");
      await until("the robot is offline", async () => (await listed()).link === "offline");
      expect((await listed()).connect).toContain("ssh robot@fake-brick");
      // every attempt while the host is down fails and leaves the robot offline
      await until("a failed attempt", () => events.includes("ev3dev_attach_failed"));
      expect(await tool("read_all")).toMatchObject({
        ok: false,
        robot: { link: "offline" },
        error: { code: "robot_offline", retryable: true },
      });
      expect(await tool("drive", { distance_cm: 3 })).toMatchObject({ ok: false, error: { code: "robot_offline" } });
      expect((await tool("stop")).ok).toBe(false);
      expect((await listed()).link).toBe("offline");

      rmSync(down);
      await until("the robot is online again", async () => (await listed()).link === "online");
      expect(await listed()).toMatchObject({ activity: "idle", connect: null });
      expect(await tool("read_device", { device: "distance" })).toMatchObject({
        ok: true,
        data: [{ channel: "distance_cm", value: 42 }],
      });
      expect(events).toEqual(expect.arrayContaining(["ev3dev_gone", "ev3dev_ready"]));
    } finally {
      rmSync(down, { force: true });
      expect(await fleet.shutdown()).toEqual([{ robot_id: "dev", motors_stopped: true }]);
    }
  });
});
