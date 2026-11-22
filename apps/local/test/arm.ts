// What the arm example (deployments/example/robots/arm.json) must show behind every source: shared by the tests
// of the twin, the stock code path and the ev3dev code path.
import { expect } from "bun:test";
import { join } from "node:path";
import { parseRobotFile, type RobotFile } from "../../../packages/driver-ev3/robot-file";
import { validateSchema } from "../../../packages/protocol/schema";
import { REPO } from "../src/config";
import type { LocalRobot } from "../src/robot";
import { TOOL, callTool } from "../src/tools";

export const ARM = join(REPO, "deployments", "example", "robots", "arm.json");
export const file = async (path: string): Promise<RobotFile> => parseRobotFile(await Bun.file(path).json(), path);
type Device = { id: string; kind: string; roles: string[] };

/** One robot's tools; every envelope is checked against the output schema the server lists for the tool. */
export const toolsOf =
  (robots: readonly LocalRobot[], robot_id: string) =>
  async (name: string, args = {}) => {
    const { envelope } = await callTool(robots, name, { robot_id, ...args });
    expect(validateSchema(TOOL.get(name)!.output, envelope, name)).toEqual([]);
    return envelope as any;
  };
export type Tool = ReturnType<typeof toolsOf>;

/** What every source of the arm example must show: no pair, no drivetrain, motors that move one by one. */
export async function armWorks(tool: Tool, motors: string[]) {
  const d = await tool("describe_robot");
  expect(d.ok).toBe(true);
  expect(d.data.drivetrain).toBeNull();
  expect(d.data.limits).toEqual({ max_speed_pct: 40, max_command_ms: 10000, max_program_ms: 120000 });
  const devices = d.data.devices as Device[];
  expect(devices.filter((x) => x.kind === "motor").map((x) => x.id)).toEqual(motors);
  expect(devices.some((x) => x.kind === "motor_pair" || x.id === "ev3.pair")).toBe(false);
  expect(d.data.roles).toEqual({ gripper: "ev3.A", lift: "ev3.B", limit: "ev3.S1" });

  for (const [name, args] of [
    ["drive", { distance_cm: 5 }],
    ["turn", { angle_deg: 30 }],
    ["arc", { radius_cm: 10, angle_deg: 30 }],
  ] as const) {
    const e = await tool(name, args);
    expect(e).toMatchObject({ ok: false, error: { code: "unsupported", retryable: false } });
    expect(e.error.message).toContain("no drivetrain");
    expect(e.next).toEqual(["describe_robot", "command_device"]);
  }
  expect((await tool("read_device", { device: "ev3.pair" })).error.code).toBe("unknown_device");

  for (const role of ["gripper", "lift"]) {
    const at = async () => (await tool("read_device", { device: role, channels: ["position_deg"] })).data.readings[0];
    const from = (await at()).value as number;
    const moved = await tool("command_device", {
      device: role,
      command: "run_degrees",
      args: { degrees: 90, speed_pct: 30 },
    });
    expect(moved).toMatchObject({ ok: true, data: { reason: "completed" } });
    expect(Math.abs(((await at()).value as number) - from - 90)).toBeLessThanOrEqual(25);
  }
  expect((await tool("read_device", { device: "limit" })).ok).toBe(true);
  expect((await tool("read_all")).ok).toBe(true);
  expect(await tool("stop")).toMatchObject({ ok: true, data: { motors_stopped: true, activity: "idle" } });
}
