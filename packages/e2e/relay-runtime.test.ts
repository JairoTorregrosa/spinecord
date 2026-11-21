// End to end: the real runtime (createRuntime + createRuntimeClient, mock provider, real clock) connected over a
// real WebSocket to the real relay in Miniflare, driven through MCP. This is the one place where the relay's
// deadlines, argument checks and socket auth meet the runtime's own limits; each side's unit tests fake the other.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { RobotProfile } from "../protocol/types";
import { type ClientState, createRuntimeClient, type RuntimeClient } from "../runtime/client";
import { realClock } from "../runtime/clock";
import { MockProvider } from "../runtime/mock";
import { createRuntime } from "../runtime/runtime";
import { BASE, TOKENS, http, resetRelay, rid, tool, until } from "../server/test/harness";

beforeAll(resetRelay);

type Loose = { ok: boolean; data?: any; error?: any; robot?: any; next: string[] };
/** One MCP tool call; the envelope, loosely typed for assertions. */
const mcp = async (token: string, name: string, args: Record<string, unknown>): Promise<Loose> =>
  (await tool(token, name, args)).envelope;

const open: RuntimeClient[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});

const profile = (id: string): RobotProfile => ({
  id,
  roles: {},
  notes: [],
  limits: { max_speed_pct: 60, max_command_ms: 700, max_drive_cm: 100, max_turn_deg: 360, max_program_ms: 3000 },
  drivetrain: {
    type: "differential",
    pair_device: "mock.pair",
    wheel_diameter_cm: 5.6,
    axle_track_cm: 12,
    forward_sign: 1,
  },
});

/** A real runtime for `id`, connected with `token`. Resolves once the relay welcomed or refused it. */
async function robot(id: string, token: string = TOKENS.rt) {
  const mock = new MockProvider({ clock: realClock });
  mock.values.set("mock.color.reflected_pct", 40);
  const runtime = createRuntime({ profile: profile(id), providers: [mock], clock: realClock });
  const states: ClientState[] = [];
  const client = createRuntimeClient({
    runtime,
    url: `${BASE.replace(/^http/, "ws")}/ws/robot`,
    token,
    heartbeat_ms: 40, // the test relay drops a runtime that is silent for 400 ms
    onState: (s) => states.push(s),
  });
  open.push(client);
  client.connect();
  await until(`${id} welcomed or refused`, () => states.includes("online") || states.includes("closed"));
  return { mock, client, states };
}

describe("the runtime's own limits decide, not the relay's deadline", () => {
  test("wait_until whose timeout passes answers met:false, not an error", async () => {
    await robot("a1");
    const out = await mcp(TOKENS.a, "wait_until", {
      robot_id: "a1",
      condition: { device: "mock.color", channel: "reflected_pct", op: "gt", value: 90 },
      timeout_ms: 300,
    });
    expect(out).toMatchObject({ ok: true, data: { met: false } });
    expect(out.data.after_ms).toBeGreaterThanOrEqual(300);
    expect(out.data.reason).toBeUndefined();
  });

  test("sample_device for its whole duration answers with the samples", async () => {
    await robot("a2");
    const out = await mcp(TOKENS.a, "sample_device", {
      robot_id: "a2",
      device: "mock.color",
      channel: "reflected_pct",
      duration_ms: 1000,
      rate_hz: 10,
    });
    expect(out.ok).toBe(true);
    expect(out.data.reason).toBeUndefined();
    expect(out.data.samples.length).toBeGreaterThan(2);
  });

  test("a drive longer than max_command_ms ends with reason timeout and what it measured", async () => {
    const r = await robot("a3");
    const out = await mcp(TOKENS.a, "drive", { robot_id: "a3", distance_cm: 90, speed_pct: 10, request_id: rid() });
    expect(out).toMatchObject({ ok: true, data: { reason: "timeout" }, robot: { activity: "idle" } });
    expect(Math.abs(out.data.measured.distance_cm)).toBeGreaterThan(0);
    expect(r.mock.stops).toBe(0); // the runtime ended the move itself; the relay did not have to stop it
  });

  test("a program longer than max_program_ms ends with outcome timeout", async () => {
    await robot("s1-sim");
    const saved = await mcp(TOKENS.a, "save_program", {
      name: "e2e_long",
      description: "waits longer than the robot allows",
      body: { seq: [{ wait_ms: 2500 }, { wait_ms: 2500 }] },
      request_id: rid(),
    });
    expect(saved).toMatchObject({ ok: true });
    const out = await mcp(TOKENS.a, "run_program", { robot_id: "s1-sim", name: "e2e_long", request_id: rid() });
    expect(out).toMatchObject({ ok: true, data: { outcome: "timeout" }, robot: { activity: "idle" } });
  });
});

describe("the relay checks the shape of command arguments; the runtime clamps their size", () => {
  test("run_time longer than one operation is chunked by the runtime, not rejected by the relay", async () => {
    const r = await robot("a4");
    const out = await mcp(TOKENS.a, "command_device", {
      robot_id: "a4",
      device: "mock.arm",
      command: "run_time",
      args: { ms: 600, speed_pct: 20 },
      request_id: rid(),
    });
    expect(out).toMatchObject({ ok: true, data: { reason: "completed" } });
    expect(r.mock.log.filter((x) => x.command === "run_time").length).toBeGreaterThan(1);
  });

  test("speed above the device's schema and the robot's limit is clamped and reported, not rejected", async () => {
    const r = await robot("a5");
    const out = await mcp(TOKENS.a, "command_device", {
      robot_id: "a5",
      device: "mock.arm",
      command: "run_degrees",
      args: { degrees: 90, speed_pct: 150 }, // the device allows 100, the robot 60
      request_id: rid(),
    });
    expect(out).toMatchObject({ ok: true, data: { clamped: true } });
    expect(r.mock.log.find((x) => x.command === "run_degrees")!.args.speed_pct).toBe(60);
  });

  test("a wrong type or an unknown field is still refused before anything is sent", async () => {
    const r = await robot("a6");
    const call = (args: Record<string, unknown>) =>
      mcp(TOKENS.a, "command_device", {
        robot_id: "a6",
        device: "mock.arm",
        command: "run_time",
        args,
        request_id: rid(),
      });
    for (const [args, what] of [
      [{ ms: "long", speed_pct: 20 }, /args\.ms: must be of type integer/],
      [{ speed_pct: 20 }, /args\.ms: is required/],
      [{ ms: 100, speed_pct: 20, warp: 1 }, /args\.warp: unknown field/],
    ] as const) {
      const out = await call(args);
      expect(out).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
      expect(out.error.message).toMatch(what);
    }
    expect(r.mock.log.length).toBe(0);
  });
});

describe("only a runtime credential can be a robot", () => {
  test("a user or admin token is refused as a runtime and cannot replace the live one", async () => {
    const real = await robot("a7");
    expect(real.states).toContain("online");
    for (const token of [TOKENS.a, TOKENS.admin]) {
      const fake = await robot("a7", token);
      expect(fake.states).not.toContain("online");
      expect(fake.states.at(-1)).toBe("closed");
    }
    expect(real.client.state()).toBe("online");
    const out = await mcp(TOKENS.a, "read_device", { robot_id: "a7", device: "mock.color" });
    expect(out).toMatchObject({ ok: true, robot: { link: "online" } });
  });

  test("a runtime credential is bound to its robots and opens nothing else", async () => {
    const other = await robot("b1"); // TOKENS.rt names the a* robots and the twins, not b1
    expect(other.states.at(-1)).toBe("closed");
    const res = await http("/mcp", { method: "POST", token: TOKENS.rt, body: "{}" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect((await http("/api/robots", { token: TOKENS.rt })).status).toBe(403);
  });
});
