// The ev3dev source end to end without a brick or a network: the driver's real bridge (Python) on a fake sysfs
// tree, reached through the real ssh code path with a local program standing in for `ssh` (bench/fake-ssh.ts).
// Needs a POSIX sh and a local python3, like the driver's own bridge tests.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRobotFile } from "../../../packages/driver-ev3/robot-file";
import { FakeBrick } from "../../../packages/driver-ev3dev/test/fake-brick";
import { EXAMPLE, loadConfig } from "../src/config";
import { buildFleet, type Fleet } from "../src/sources";
import { callTool } from "../src/tools";
import { sleep, until } from "./client";

const python3 = Bun.which("python3");
const runs = process.platform !== "win32" && python3 !== null;
if (!runs) console.warn("SKIPPED: the ev3dev source test needs a POSIX sh and python3 on PATH");

type Listed = { id: string; link: string; activity: string; connect: string | null };
const listed = async (fleet: Fleet, id: string): Promise<Listed> =>
  ((await callTool(fleet.robots, "list_robots", {})).envelope as { data: { robots: Listed[] } }).data.robots.find(
    (r) => r.id === id,
  )!;
/** The brick is connected in the background: a fleet is built before its robot is online. */
const online = (fleet: Fleet, id = "dev"): Promise<void> =>
  until(`${id} is online`, async () => (await listed(fleet, id)).link === "online", 20_000);

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
    delete process.env.BENCH_FAKE_SESSIONS;
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
      await online(fleet);
      expect(events).toContain("bridge_installed");
      expect(await tool("describe_robot")).toMatchObject({
        ok: true,
        data: { backend: "ev3" },
        robot: { link: "online" },
      });
      const read = await tool("read_device", { device: "distance" });
      expect(read).toMatchObject({ ok: true, data: { readings: [{ channel: "distance_cm", value: 42 }] } });
      const drive = await tool("drive", { distance_cm: 3, speed_pct: 40 });
      expect(drive.ok).toBe(true);
      expect(await tool("stop")).toMatchObject({ ok: true, data: { motors_stopped: true, activity: "idle" } });
    } finally {
      expect(await fleet.shutdown()).toEqual([{ robot_id: "dev", motors_stopped: true }]);
    }
  });

  /** The fleet of one ev3dev robot reached through fake-ssh, with the bridge already on the brick. */
  const preinstalled = async (bridge: string, events: string[]) => {
    const home2 = mkdtempSync(join(tmpdir(), "spinecord-local-home-"));
    mkdirSync(join(home2, "spinecord"));
    writeFileSync(join(home2, "spinecord", "ev3dev_bridge.py"), bridge);
    Object.assign(process.env, { BENCH_FAKE_HOME: home2, SYSFS_ROOT: brick!.root });
    const robot = parseRobotFile(await Bun.file(EXAMPLE.robot).json(), EXAMPLE.robot);
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
            installBridge: false,
          },
        ],
      },
      { log: (ev) => void events.push(ev), reconnectMs: 50 },
    );
    return { fleet, done: () => rmSync(home2, { recursive: true, force: true }) };
  };
  const BRIDGE = readFileSync(
    join(import.meta.dir, "..", "..", "..", "packages", "driver-ev3dev", "bridge", "ev3dev_bridge.py"),
    "utf8",
  );
  /** The same bridge as a script only: no `run`, its main called from `__main__`. */
  const withoutRun = (src: string) =>
    src
      .replace("def run(argv):", "def _start(argv):")
      .replace(/\n    run\(sys\.argv\)\s*$/, "\n    _start(sys.argv)\n");

  test.skipIf(!runs)("a bridge without run on the brick is run as a script and comes online", async () => {
    const legacy = withoutRun(BRIDGE);
    expect(legacy).not.toMatch(/^def run\(/m);
    expect(legacy).toContain("    _start(sys.argv)");
    const events: string[] = [];
    const { fleet, done } = await preinstalled(legacy, events);
    try {
      await online(fleet);
      expect(events).not.toContain("bridge_installed");
    } finally {
      await fleet.shutdown();
      done();
    }
  });

  test.skipIf(!runs)("an older bridge without run is misconfigured, with the reinstall hint", async () => {
    const older = withoutRun(BRIDGE).replace('VERSION = "4"', 'VERSION = "3"');
    const events: string[] = [];
    const { fleet, done } = await preinstalled(older, events);
    try {
      await until("an attempt failed", () => events.includes("ev3dev_attach_failed"), 20_000);
      const dev = await listed(fleet, "dev");
      expect(dev.link).toBe("offline");
      expect(dev.connect).toContain("--install-bridge");
    } finally {
      await fleet.shutdown();
      done();
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
      const dev = () => listed(fleet, "dev");
      await online(fleet);
      expect(await dev()).toMatchObject({ link: "online", connect: null });

      writeFileSync(down, "");
      await until("the robot is offline", async () => (await dev()).link === "offline");
      expect((await dev()).connect).toContain("ssh robot@fake-brick");
      // every attempt while the host is down fails and leaves the robot offline
      await until("a failed attempt", () => events.includes("ev3dev_attach_failed"));
      expect(await tool("read_all")).toMatchObject({
        ok: false,
        robot: { link: "offline" },
        error: { code: "robot_offline", retryable: true },
      });
      expect(await tool("drive", { distance_cm: 3 })).toMatchObject({ ok: false, error: { code: "robot_offline" } });
      expect((await tool("stop")).ok).toBe(false);
      expect((await dev()).link).toBe("offline");

      rmSync(down);
      await until("the robot is online again", async () => (await dev()).link === "online");
      expect(await dev()).toMatchObject({ activity: "idle", connect: null });
      expect(await tool("read_device", { device: "distance" })).toMatchObject({
        ok: true,
        data: { readings: [{ channel: "distance_cm", value: 42 }] },
      });
      expect(events).toEqual(expect.arrayContaining(["ev3dev_gone", "ev3dev_ready"]));
    } finally {
      rmSync(down, { force: true });
      expect(await fleet.shutdown()).toEqual([{ robot_id: "dev", motors_stopped: true }]);
    }
  });

  test.skipIf(!runs)(
    "a link cut during a coasting move: the move answers robot_offline at once, one link lives after",
    async () => {
      const down = join(home, "host-is-down");
      const sessions = join(home, "sessions.log");
      rmSync(sessions, { force: true });
      Object.assign(process.env, {
        BENCH_FAKE_HOME: home,
        SYSFS_ROOT: brick!.root,
        BENCH_FAKE_DOWN: down,
        BENCH_FAKE_SESSIONS: sessions,
      });
      /** Pids of the ssh processes that are running: opened and not yet exited. */
      const alive = (): number[] => {
        const lines = existsSync(sessions) ? readFileSync(sessions, "utf8").split("\n").filter(Boolean) : [];
        const exited = new Set(lines.filter((l) => l.startsWith("exit ")).map((l) => l.slice(5)));
        return lines.filter((l) => l.startsWith("open ") && !exited.has(l.slice(5))).map((l) => Number(l.slice(5)));
      };
      const robot = parseRobotFile(await Bun.file(EXAMPLE.robot).json(), EXAMPLE.robot);
      // motors that run and coast on, so a move is made of chunks that do not brake
      const stopPlaying = [0, 1].map((i) => brick!.playMotor(i, 120, 50, 2));
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
              installBridge: false,
            },
          ],
        },
        { log: () => {}, reconnectMs: 50 },
      );
      try {
        const tool = async (name: string, args: Record<string, unknown> = {}) =>
          (await callTool(fleet.robots, name, { robot_id: "dev", ...args })).envelope;
        const link = async () =>
          ((await callTool(fleet.robots, "list_robots", {})).envelope as { data: { robots: { link: string }[] } }).data
            .robots[0]!.link;
        await online(fleet);
        expect(alive().length).toBe(1);
        // under `until` the move is made of short chunks, and on this fast link they coast
        const drive = tool("drive", {
          distance_cm: 80,
          speed_pct: 20,
          until: { device: "distance", channel: "distance_cm", op: "lt", value: 5 },
        });
        await sleep(200);
        // a blip: the connection is cut while the move is in flight, and the host answers again at once
        const cut = Date.now();
        for (const pid of alive()) process.kill(pid, "SIGTERM");
        expect(await drive).toMatchObject({ ok: false, error: { code: "robot_offline", retryable: false } });
        expect(Date.now() - cut).toBeLessThan(2000);
        await until("the robot is online again", async () => (await link()) === "online");
        // the closed link stays closed: nothing opens a second connection beside the new one
        await sleep(1000);
        expect(alive().length).toBe(1);
      } finally {
        for (const stop of stopPlaying) stop();
        rmSync(down, { force: true });
        await fleet.shutdown();
      }
      expect(alive().length).toBe(0);
    },
  );

  test.skipIf(!runs)(
    "a brick that is off at start: the twin serves, the brick is offline with its hint, then online when it answers",
    async () => {
      // a brick that never had a bridge: its home is empty, and the host is down before the server starts
      const fresh = mkdtempSync(join(tmpdir(), "spinecord-local-off-"));
      const down = join(fresh, "host-is-down");
      writeFileSync(down, "");
      Object.assign(process.env, { BENCH_FAKE_HOME: fresh, SYSFS_ROOT: brick!.root, BENCH_FAKE_DOWN: down });
      // the command line of the README: the example robot file as it is, the bridge copied by the server
      const config = loadConfig(["--twin", "--ev3dev", "--ssh", "robot@fake-brick", "--install-bridge"]);
      const dev = config.robots.find((r) => r.source === "ev3dev")!;
      if (dev.source !== "ev3dev") throw new Error("unreachable");
      dev.ssh.sshCommand = join(import.meta.dir, "..", "..", "..", "bench", "fake-ssh.ts");
      const events: { ev: string; error?: unknown }[] = [];
      const started = Date.now();
      const fleet = await buildFleet(config, {
        log: (ev, f) => void events.push({ ev, error: f?.error }),
        reconnectMs: 50,
      });
      try {
        const tool = async (robot_id: string, name: string, args: Record<string, unknown> = {}) =>
          (await callTool(fleet.robots, name, { robot_id, ...args })).envelope;
        // the start does not wait for the brick
        expect(Date.now() - started).toBeLessThan(2000);
        expect((await listed(fleet, "r1")).link).not.toBe("online");
        expect(await listed(fleet, "r1-sim")).toMatchObject({ link: "online", activity: "idle", connect: null });
        expect(await tool("r1-sim", "read_device", { device: "distance" })).toMatchObject({ ok: true });
        expect(await tool("r1-sim", "drive", { distance_cm: 3, speed_pct: 40 })).toMatchObject({ ok: true });

        await until("a failed attempt", () => events.some((e) => e.ev === "ev3dev_attach_failed"));
        await until("the robot is offline", async () => (await listed(fleet, "r1")).link === "offline");
        const hint = (await listed(fleet, "r1")).connect!;
        expect(hint).toContain("Check that the brick is on");
        expect(hint).toContain('"ssh robot@fake-brick" connects from this computer without asking for a password');
        expect(hint).toContain("The last attempt failed:");
        // a brick out of reach is not a misconfigured one: nothing tells the person to reinstall anything
        expect(hint).not.toContain("does not come online by itself");
        expect(await tool("r1", "drive", { distance_cm: 3 })).toMatchObject({
          ok: false,
          robot: { link: "offline" },
          error: { code: "robot_offline", retryable: true },
        });
        expect(existsSync(join(fresh, "spinecord", "ev3dev_bridge.py"))).toBe(false);
        expect(events.some((e) => e.ev === "bridge_installed")).toBe(false);
        // the twin still serves while the attempts fail
        expect(await tool("r1-sim", "read_all")).toMatchObject({ ok: true, robot: { link: "online" } });

        rmSync(down);
        await online(fleet, "r1");
        expect(await listed(fleet, "r1")).toMatchObject({ activity: "idle", connect: null });
        expect(events.filter((e) => e.ev === "bridge_installed").length).toBe(1);
        expect(existsSync(join(fresh, "spinecord", "ev3dev_bridge.py"))).toBe(true);
        expect(await tool("r1", "read_device", { device: "distance" })).toMatchObject({
          ok: true,
          data: { readings: [{ channel: "distance_cm", value: 42 }] },
        });
        expect(await tool("r1", "stop")).toMatchObject({ ok: true, data: { motors_stopped: true } });
      } finally {
        rmSync(down, { force: true });
        const stopped = await fleet.shutdown();
        rmSync(fresh, { recursive: true, force: true });
        expect(stopped).toContainEqual({ robot_id: "r1", motors_stopped: true });
      }
    },
  );
});
