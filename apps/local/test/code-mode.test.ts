// The example scripts of docs/code-mode.md, run as written: each fenced block is cut out of the document and its
// calls go through an MCP client to a spawned server with a twin. What the scripts read is what the server sends.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, type TestServer } from "./client";

const DOC = join(import.meta.dir, "..", "..", "..", "docs", "code-mode.md");
const R = "r1-sim";
const PREFIX = "mcp__spinecord__";

/** The JavaScript block that follows `<!-- example: <name> -->` in the document. */
function example(name: string): string {
  const lines = readFileSync(DOC, "utf8").split(/\r?\n/);
  const marker = lines.indexOf(`<!-- example: ${name} -->`);
  if (marker < 0) throw new Error(`docs/code-mode.md has no example "${name}"`);
  const open = lines.indexOf("```javascript", marker);
  const close = lines.indexOf("```", open + 1);
  if (open < 0 || close < 0) throw new Error(`example "${name}" has no javascript block`);
  return lines.slice(open + 1, close).join("\n");
}

type Envelope = { ok: boolean; data?: any; error?: { code: string; message: string }; next: string[] };
type Call = (tool: string, args: Record<string, unknown>) => Promise<Envelope>;
type Leg = { leg: number; driven_cm: number; wall_cm: number; turned_deg: number };
type Square = (
  call: Call,
  robot_id: string,
) => Promise<{ legs: Leg[]; failed?: string; ended?: string; error?: { code: string } }>;

let s: TestServer;
const calls: string[] = [];
/**
 * The tools as a Code Mode script sees them (docs/code-mode.md §3.1): a result with ok:true resolves to the
 * envelope as JSON text, one with ok:false rejects with the result's text block as the message. Both come from
 * the real server. `robotFor` lets a test send one call to another robot id.
 */
const tools = (robotFor: (tool: string, n: number) => string | undefined = () => undefined) => {
  const seen = new Map<string, number>();
  return new Proxy({} as Record<string, (args: Record<string, unknown>) => Promise<string>>, {
    get: (_, key: string) => async (args: Record<string, unknown>) => {
      if (!key.startsWith(PREFIX)) throw new Error(`no tool ${key}`);
      const tool = key.slice(PREFIX.length);
      const n = (seen.get(tool) ?? 0) + 1;
      seen.set(tool, n);
      calls.push(tool);
      const robot_id = robotFor(tool, n);
      const r = await s.tool(tool, robot_id ? { ...args, robot_id } : args);
      if (r.isError) throw new Error(r.content[0].text);
      return JSON.stringify(r.envelope);
    },
  });
};
const helper = (t: ReturnType<typeof tools>) => new Function("tools", `${example("call")}\nreturn call;`)(t) as Call;
const square = () => new Function(`${example("square")}\nreturn square;`)() as Square;

beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  expect(await s.closeStdin()).toBe(0);
});

test("the call helper returns the envelope for a result and for an error", async () => {
  const call = helper(tools());
  const ok = await call("list_robots", {});
  expect(ok).toMatchObject({ ok: true, data: { robots: [{ id: R }] } });
  const failed = await call("read_device", { robot_id: "nobody", device: "distance" });
  expect(failed).toMatchObject({ ok: false, error: { code: "unknown_robot" }, next: ["list_robots"] });
  expect(failed.data).toBeUndefined();
  // a call the client refuses, which never reaches the server, is thrown again as it came
  const refused = helper({
    [`${PREFIX}drive`]: async () => {
      throw new Error("Not sent: the tool does not declare `robot`.");
    },
  });
  await expect(refused("drive", { robot: R })).rejects.toThrow("Not sent: the tool does not declare `robot`.");
});

/** Puts the twin where a session finds it: the middle of the room, heading 0. Each scenario starts from there. */
async function home(): Promise<void> {
  const r = await s.tool("command_device", {
    robot_id: R,
    device: "sim.world",
    command: "reset",
    args: { x_cm: 60, y_cm: 60, heading_deg: 0 },
  });
  if (!r.envelope.ok) throw new Error(`reset failed: ${r.envelope.error.message}`);
}

test("the square example drives four legs to the wall and reports each one", async () => {
  await home();
  calls.length = 0;
  const out = await square()(helper(tools()), R);
  expect(out.failed).toBeUndefined();
  expect(out.ended).toBeUndefined();
  expect(out.legs.map((l) => l.leg)).toEqual([1, 2, 3, 4]);
  for (const l of out.legs) {
    // the reading that met the condition, so never above the threshold; close to the wall and not in it
    expect(l.wall_cm).toBeLessThanOrEqual(15);
    expect(l.wall_cm).toBeGreaterThan(8);
    expect(l.driven_cm).toBeGreaterThan(10);
    expect(Math.abs(l.turned_deg - 90)).toBeLessThan(5);
  }
  // two calls per leg, and no stop: the script ended cleanly
  expect(calls).toEqual(Array.from({ length: 4 }, () => ["drive", "turn"]).flat());
  expect((await s.tool("list_robots")).envelope).toMatchObject({ data: { robots: [{ id: R, activity: "idle" }] } });
}, 120_000);

test("the square example leaves at the first error and brakes", async () => {
  await home();
  calls.length = 0;
  // the second drive goes to a robot the server does not have: a real error envelope, thrown as Code Mode throws it
  const out = await square()(helper(tools((tool, n) => (tool === "drive" && n === 2 ? "nobody" : undefined))), R);
  expect(out).toMatchObject({ failed: "drive", leg: 2, error: { code: "unknown_robot" } });
  expect(out.legs.length).toBe(1);
  expect(calls).toEqual(["drive", "turn", "drive", "stop"]);
}, 120_000);

test("the shapes the document tabulates are the shapes the server sends", async () => {
  const data = async (tool: string, args: Record<string, unknown> = {}) => {
    const e = (await s.tool(tool, { robot_id: R, ...args })).envelope;
    if (!e.ok) throw new Error(`${tool}: ${e.error.message}`);
    return e.data as Record<string, any>;
  };
  const listed = (await s.tool("list_robots")).envelope;
  expect(listed.ok && Object.keys(listed.data)).toEqual(["robots"]);
  const one = await data("read_device", { device: "distance" });
  const all = await data("read_all");
  const waited = await data("wait_until", {
    condition: { device: "distance", channel: "distance_cm", op: "gt", value: 0 },
    timeout_ms: 100,
  });
  // one reading shape in the three tools that read channels
  for (const d of [one, all, waited]) {
    expect(Array.isArray(d.readings)).toBe(true);
    expect(d.readings.find((r: { channel: string }) => r.channel === "distance_cm")).toMatchObject({
      device: "ev3.S4",
      unit: "cm",
      value: expect.any(Number),
      ts: expect.any(Number),
    });
  }
  expect(waited).toMatchObject({ met: true, reason: "condition_met", ms: expect.any(Number) });
  // a move that its condition ended carries the same readings; one that ran to its end carries none
  const met = await data("drive", {
    distance_cm: 5,
    until: { device: "distance", channel: "distance_cm", op: "gt", value: 0 },
  });
  expect(met.reason).toBe("condition_met");
  expect(met.readings).toMatchObject([{ device: "ev3.S4", channel: "distance_cm", value: expect.any(Number) }]);
  expect((await data("drive", { distance_cm: 2 })).readings).toBeUndefined();
  expect((await data("describe_robot")).scan_error).toBeNull();
  // one measured shape in the three drivetrain tools
  const fields = ["distance_cm", "heading_change_deg", "source", "left_deg", "right_deg"];
  for (const [tool, args] of [
    ["drive", { distance_cm: -3 }],
    ["turn", { angle_deg: 10 }],
    ["arc", { radius_cm: 10, angle_deg: -10, direction: "backward" }],
  ] as const) {
    const d = await data(tool, args);
    expect(Object.keys(d.measured)).toEqual(fields);
    expect(Object.keys(d)).toEqual(
      expect.arrayContaining(["requested", "applied", "measured", "clamped", "reason", "ms"]),
    );
  }
}, 60_000);
