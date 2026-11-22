// The server as Claude Code runs it: a spawned `bun apps/local/main.ts`, MCP over its stdio, a twin inside.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "../../../packages/protocol/tools";
import { EXAMPLE } from "../src/config";
import { MAIN, startServer, until, wheelSpeeds, wheelsTurning, type TestServer } from "./client";

const R = "r1-sim";
const jsonRpcOnly = (s: TestServer) => {
  expect(s.stdout.length).toBeGreaterThan(0);
  for (const line of s.stdout) {
    const m = JSON.parse(line) as { jsonrpc?: string };
    expect(m.jsonrpc).toBe("2.0");
  }
};

describe("a twin behind stdio", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer();
  });
  afterAll(async () => {
    expect(await s.closeStdin()).toBe(0);
    jsonRpcOnly(s);
  });

  test("initialize names the server and carries its instructions", () => {
    expect(s.init.serverInfo.name).toBe("spinecord");
    expect(s.init.instructions).toContain("One moving call at a time");
  });

  test("tools/list is the catalog, each tool with its outputSchema", () => {
    expect(s.listed.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const t of s.listed) expect((t.outputSchema as { type: string }).type).toBe("object");
  });

  test("every tool answers with an envelope that matches its outputSchema", async () => {
    const robots = await s.tool("list_robots");
    expect(robots.envelope).toMatchObject({
      ok: true,
      data: { robots: [{ id: R, backend: "sim", link: "online", activity: "idle" }] },
    });
    const robot = await s.tool("describe_robot", { robot_id: R });
    expect(robot.envelope).toMatchObject({ ok: true, robot: { id: R, activity: "idle" } });
    expect((await s.tool("describe_device", { robot_id: R, device: "distance" })).envelope.ok).toBe(true);
    const read = await s.tool("read_device", { robot_id: R, device: "distance" });
    expect(read.envelope.ok && read.envelope.data.readings[0].channel).toBe("distance_cm");
    expect((await s.tool("read_all", { robot_id: R })).envelope.ok).toBe(true);
    const sample = await s.tool("sample_device", {
      robot_id: R,
      device: "distance",
      channel: "distance_cm",
      duration_ms: 100,
    });
    expect(sample.envelope.ok && sample.envelope.data.samples.length).toBeGreaterThan(0);
    const wait = await s.tool("wait_until", {
      robot_id: R,
      condition: { device: "touch", channel: "pressed", op: "eq", value: true },
      timeout_ms: 50,
    });
    expect(wait.envelope).toMatchObject({ ok: true, data: { met: false } });
    const drive = await s.tool("drive", { robot_id: R, distance_cm: 4, speed_pct: 50 });
    expect(drive.envelope).toMatchObject({ ok: true, data: { reason: "completed" }, robot: { activity: "idle" } });
    expect((await s.tool("turn", { robot_id: R, angle_deg: 20, speed_pct: 50 })).envelope.ok).toBe(true);
    expect((await s.tool("arc", { robot_id: R, radius_cm: 10, angle_deg: 15, speed_pct: 50 })).envelope.ok).toBe(true);
    const tone = await s.tool("command_device", {
      robot_id: R,
      device: "ev3.speaker",
      command: "tone",
      args: { frequency_hz: 440, duration_ms: 50 },
    });
    expect(tone.envelope.ok).toBe(true);
    const program = await s.tool("run_program", {
      robot_id: R,
      body: { seq: [{ call: { tool: "drive", args: { distance_cm: 3, speed_pct: 50 } } }, { succeed: "done" }] },
    });
    expect(program.envelope).toMatchObject({ ok: true, data: { outcome: "succeeded" }, robot: { activity: "idle" } });
    expect((await s.tool("stop", { robot_id: R })).envelope).toMatchObject({
      ok: true,
      data: { motors_stopped: true },
    });
    const reset = await s.tool("reset_fault", { robot_id: R });
    expect(reset.envelope).toMatchObject({ ok: false, error: { code: "illegal_state" } });
  });

  test("errors are typed envelopes", async () => {
    const nobody = await s.tool("read_all", { robot_id: "nobody" });
    expect(nobody).toMatchObject({ isError: true, envelope: { ok: false, error: { code: "unknown_robot" } } });
    const bad = await s.tool("drive", { robot_id: R });
    expect(bad.envelope).toMatchObject({ ok: false, error: { code: "invalid_argument" }, next: ["drive"] });
    const extra = await s.tool("drive", { robot_id: R, distance_cm: 1, token: "x" });
    expect(extra.envelope).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    const device = await s.tool("read_device", { robot_id: R, device: "nothing" });
    expect(device.envelope).toMatchObject({ ok: false, error: { code: "unknown_device" }, robot: { id: R } });
  });

  test("two moves sent in parallel: one runs, the other gets busy", async () => {
    const both = await Promise.all([
      s.tool("drive", { robot_id: R, distance_cm: 6, speed_pct: 50 }),
      s.tool("turn", { robot_id: R, angle_deg: 30, speed_pct: 50 }),
    ]);
    const ran = both.filter((r) => r.envelope.ok);
    const refused = both.filter((r) => !r.envelope.ok);
    expect(ran.length).toBe(1);
    expect(refused.length).toBe(1);
    const e = refused[0]!.envelope;
    expect(!e.ok && e.error).toMatchObject({ code: "busy", retryable: true });
    expect(!e.ok && e.error.retry_after_ms).toBeGreaterThan(0);
    // reads are served while a move runs, and the robot is idle again after it
    expect((await s.tool("list_robots")).envelope).toMatchObject({ data: { robots: [{ activity: "idle" }] } });
  });

  test("stop during a move preempts it and every motor reads speed 0", async () => {
    const move = s.tool("drive", { robot_id: R, distance_cm: -40, speed_pct: 20 });
    await until("the wheels to turn", () => wheelsTurning(s, R));
    const t0 = performance.now();
    const stop = await s.tool("stop", { robot_id: R });
    expect(performance.now() - t0).toBeLessThan(1500); // it did not wait for the move's 9 s
    expect(stop.envelope).toMatchObject({ ok: true, data: { motors_stopped: true, activity: "idle" } });
    expect((await move).envelope).toMatchObject({ ok: true, data: { reason: "preempted" } });
    expect(await wheelSpeeds(s, R)).toEqual([0, 0, 0]);
    // and the robot takes the next move
    expect((await s.tool("drive", { robot_id: R, distance_cm: 2, speed_pct: 50 })).envelope.ok).toBe(true);
  });
});

describe("the client cancels a call", () => {
  test("notifications/cancelled mid-move stops the robot: wheels at 0, activity idle", async () => {
    const s = await startServer();
    const move = s.request("tools/call", { name: "drive", arguments: { robot_id: R, distance_cm: 80, speed_pct: 20 } });
    await until("the wheels to turn", () => wheelsTurning(s, R));
    const t0 = performance.now();
    s.notify("notifications/cancelled", { requestId: move.id, reason: "the script was interrupted" });
    await until("the robot to be idle", async () => {
      const robots = await s.tool("list_robots");
      return robots.envelope.ok && robots.envelope.data.robots[0].activity === "idle";
    });
    expect(performance.now() - t0).toBeLessThan(2000); // the 80 cm would take 19 s
    expect(await wheelSpeeds(s, R)).toEqual([0, 0, 0]);
    expect(s.events("cancelled")).toEqual([{ ev: "cancelled", robot_id: R, tool: "drive", action: "stop" }]);
    // the robot takes the next move
    expect((await s.tool("drive", { robot_id: R, distance_cm: 2, speed_pct: 50 })).envelope.ok).toBe(true);
    expect(await s.closeStdin()).toBe(0);
    jsonRpcOnly(s);
  });

  test("a cancelled wait ends at once and moves nothing", async () => {
    const s = await startServer();
    const wait = s.request("tools/call", {
      name: "wait_until",
      arguments: {
        robot_id: R,
        condition: { device: "touch", channel: "pressed", op: "eq", value: true },
        timeout_ms: 10000,
      },
    });
    await until("the wait to be under way", async () => (await s.tool("read_all", { robot_id: R })).envelope.ok);
    s.notify("notifications/cancelled", { requestId: wait.id });
    await until("the cancel to be logged", () => s.events("cancelled").length > 0, 2000);
    expect(s.events("cancelled")).toEqual([{ ev: "cancelled", robot_id: R, tool: "wait_until", action: "abort" }]);
    expect((await s.tool("list_robots")).envelope).toMatchObject({ data: { robots: [{ activity: "idle" }] } });
    expect(await s.closeStdin()).toBe(0);
  });
});

describe("two processes, one port", () => {
  test("the second one ends with a message that names the port, and prints nothing on stdout", async () => {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = probe.port!;
    await probe.stop(true);
    const args = ["--ev3", EXAMPLE.robot, "--port", String(port)];
    const first = await startServer(args);
    try {
      expect(first.stderr.some((l) => l.includes(`http://127.0.0.1:${port}/`))).toBe(true);
      const second = Bun.spawn([process.execPath, MAIN, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([
        new Response(second.stdout).text(),
        new Response(second.stderr).text(),
        second.exited,
      ]);
      expect(code).toBe(1);
      expect(out).toBe("");
      expect(err).toContain(`cannot listen on 127.0.0.1:${port}`);
      // the first one is untouched
      expect((await first.tool("list_robots")).envelope).toMatchObject({
        ok: true,
        data: { robots: [{ id: "r1", link: "offline" }] },
      });
    } finally {
      expect(await first.closeStdin()).toBe(0);
    }
  });
});

describe("the process ends", () => {
  test("stdin closed mid-move: the motors are stopped, then it exits 0", async () => {
    const s = await startServer();
    void s.tool("drive", { robot_id: R, distance_cm: 40, speed_pct: 20 }).catch(() => {});
    await until("the wheels to turn", () => wheelsTurning(s, R));
    expect(await s.closeStdin()).toBe(0);
    expect(s.events("stopped")).toEqual([{ ev: "stopped", robot_id: R, motors_stopped: true }]);
    const order = s.stderr.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l).ev as string);
    expect(order.indexOf("stopped")).toBeLessThan(order.indexOf("exit"));
    jsonRpcOnly(s);
  });

  // Windows has no signal a parent can send that the child may handle: there the client closing stdin is the way
  test.skipIf(process.platform === "win32")("SIGTERM mid-move: the motors are stopped, then it exits 0", async () => {
    const s = await startServer();
    void s.tool("drive", { robot_id: R, distance_cm: 40, speed_pct: 20 }).catch(() => {});
    await until("the wheels to turn", () => wheelsTurning(s, R));
    s.child.kill("SIGTERM");
    expect(await s.exited()).toBe(0);
    expect(s.events("stopped")).toEqual([{ ev: "stopped", robot_id: R, motors_stopped: true }]);
    jsonRpcOnly(s);
  });

  test("--log-file: the file gets every line of stderr, the last ones too, and a second start appends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spinecord-log-"));
    try {
      const file = join(dir, "not", "there", "yet", "server.log");
      const s = await startServer(["--log-file", file]);
      await s.tool("drive", { robot_id: R, distance_cm: 3, speed_pct: 50 });
      await s.tool("read_all", { robot_id: "nobody" });
      expect(await s.closeStdin()).toBe(0);
      jsonRpcOnly(s);
      const first = readFileSync(file, "utf8");
      expect(first.endsWith("\n")).toBe(true);
      expect(first.split("\n").slice(0, -1)).toEqual(s.stderr);
      expect(s.events("call").map((l) => l.tool)).toEqual(["drive", "read_all"]);
      expect(s.events("exit")).toHaveLength(1);
      const again = await startServer(["--log-file", file]);
      expect(await again.closeStdin()).toBe(0);
      expect(readFileSync(file, "utf8").split("\n").slice(0, -1)).toEqual([...s.stderr, ...again.stderr]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--log-file that cannot be opened exits 1 with its path on stderr and nothing on stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spinecord-log-"));
    try {
      // a folder cannot be made inside a file, on every OS
      writeFileSync(join(dir, "a-file"), "");
      const file = join(dir, "a-file", "server.log");
      const child = Bun.spawn([process.execPath, MAIN, "--log-file", file], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(1);
      expect(out).toBe("");
      expect(err).toContain(`--log-file: cannot open ${file} for appending`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a wrong flag exits 2 with the usage on stderr and nothing on stdout", async () => {
    const child = Bun.spawn([process.execPath, MAIN, "--twin", "missing.json"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("--twin: cannot read");
    expect(err).toContain("usage:");
  });
});
