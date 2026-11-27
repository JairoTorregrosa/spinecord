// The name a person gives a robot (CONTRACT §3, `name`): how it is read and refused, how it reaches the model
// (list_robots, describe_robot and the server instructions, with ROBOT_NAME_RULE), the brick's screen and the 3D
// page; and that a robot without one behaves as before.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstViolation } from "../../../packages/protocol/schema";
import { ROBOT_NAME_RULE, SERVER_INSTRUCTIONS, TOOLS } from "../../../packages/protocol/tools";
import type { ServerMessage } from "../../twin-view/src/messages";
import { buildViewPage } from "../../twin-view/view-build";
import { EXAMPLE, loadConfig, MAX_NAME, parseRobotName } from "../src/config";
import { addCommand } from "../src/print-add";
import { buildFleet, type Fleet } from "../src/sources";
import { callTool } from "../src/tools";
import { serveView, type ViewServer } from "../src/view";
import { until } from "./client";

const tmp = mkdtempSync(join(tmpdir(), "spinecord-name-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const r1 = JSON.parse(readFileSync(EXAMPLE.robot, "utf8")) as Record<string, unknown>;
const pagesRobot = JSON.parse(readFileSync(EXAMPLE.pages, "utf8")) as Record<string, unknown>;
const file = (name: string, json: unknown): string => {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(json));
  return path;
};
const named = file("named.json", { ...r1, name: "  Doña Tuerca " });

describe("the rule of a name", () => {
  test("trimmed and in NFC; letters of any script with accents, digits, spaces, ' . and -", () => {
    expect(parseRobotName("  Doña Tuerca ", "name")).toBe("Doña Tuerca");
    // "n" + a combining tilde is the same name as "ñ"
    expect(parseRobotName("Don\u0303a", "name")).toBe("Doña");
    for (const ok of ["Rayo", "R2-D2", "Sr. Bolt", "O'Neil", "Ñandú 3", "ロボ", "x".repeat(MAX_NAME)])
      expect(parseRobotName(ok, "name")).toBe(ok);
  });
  test("refused, naming the field: empty, too long, a line break, a control character, a quote, not a string", () => {
    expect(() => parseRobotName("   ", "name")).toThrow(/^name is empty/);
    expect(() => parseRobotName("x".repeat(MAX_NAME + 1), "name")).toThrow(/^name has 23 characters, at most 22/);
    expect(() => parseRobotName("Ra\nyo", "--name")).toThrow(/^--name holds "\\n" \(U\+000A\)/);
    expect(() => parseRobotName("Ra\tyo", "name")).toThrow(/U\+0009/);
    expect(() => parseRobotName("Ra\u0000yo", "name")).toThrow(/U\+0000/);
    expect(() => parseRobotName('Ra"yo', "name")).toThrow(/holds "\\""/);
    expect(() => parseRobotName("Rayo%", "name")).toThrow(/holds "%"/);
    expect(() => parseRobotName("Rayo ⚡", "name")).toThrow(/holds "⚡"/);
    expect(() => parseRobotName(7, "name")).toThrow(/^name must be a string/);
  });
});

describe("where a name comes from", () => {
  test("a robot file's name: its twin and its EV3 share it; a file without one has none", () => {
    const c = loadConfig(["--ev3", named, "--twin", named]);
    expect(c.robots.map((r) => [r.id, r.name])).toEqual([
      ["r1", "Doña Tuerca"],
      ["r1-sim", "Doña Tuerca"],
    ]);
    expect(loadConfig(["--twin"]).robots[0]!.name).toBeNull();
    expect(loadConfig(["--pages"]).robots[0]!.name).toBeNull();
  });
  test("--name wins over the file's name, for every robot of the command line, and alone names the example twin", () => {
    const c = loadConfig(["--ev3", named, "--twin", named, "--name", "Rayo"]);
    expect(c.robots.map((r) => r.name)).toEqual(["Rayo", "Rayo"]);
    expect(loadConfig(["--name", "Rayo"]).robots.map((r) => [r.id, r.name])).toEqual([["r1-sim", "Rayo"]]);
    expect(loadConfig(["--view", "--name", "Rayo"]).robots[0]!.name).toBe("Rayo");
    expect(() => loadConfig(["--twin", "--name", ""])).toThrow(/^--name is empty/);
  });
  test("a robot without a body and a --config file read the name of the robot's file", () => {
    const pages = file("pages-named.json", { ...pagesRobot, name: "Ojo" });
    expect(loadConfig(["--pages", pages]).robots[0]!.name).toBe("Ojo");
    const config = file("config.json", {
      robots: [
        { source: "twin", robot: named, world: join(import.meta.dir, "..", "examples", "room.json") },
        { source: "pages", robot: pages, id: "eye" },
      ],
    });
    expect(loadConfig(["--config", config]).robots.map((r) => r.name)).toEqual(["Doña Tuerca", "Ojo"]);
    expect(() => loadConfig(["--config", config, "--name", "Rayo"])).toThrow(/--config holds everything/);
  });
  test("a bad name in a file ends the start, naming the file and the field", () => {
    const bad = file("bad.json", { ...r1, name: "Rayo\nMcQueen" });
    expect(() => loadConfig(["--twin", bad])).toThrow(/bad\.json: name holds "\\n"/);
    const long = file("pages-long.json", { ...pagesRobot, name: "x".repeat(30) });
    expect(() => loadConfig(["--pages", long])).toThrow(/pages-long\.json: name has 30 characters/);
  });
  test("--print-add keeps a name with spaces and accents as one argument", () => {
    const args = ["--twin", "--name", "Doña Tuerca"];
    expect(addCommand({ platform: "linux", repo: "/r", args }).endsWith('--twin --name "Doña Tuerca"')).toBe(true);
    expect(addCommand({ platform: "win32", repo: "C:\\r", args }).endsWith('--twin --name "Doña Tuerca"')).toBe(true);
  });
});

const open: { fleet: Fleet; view?: ViewServer; ws?: WebSocket }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    o.ws?.close();
    o.view?.stop();
    await o.fleet.shutdown();
  }
});
async function fleetOf(argv: string[]) {
  const events: Record<string, unknown>[] = [];
  const fleet = await buildFleet(loadConfig(argv), { log: (ev, f) => void events.push({ ev, ...f }) });
  const entry: (typeof open)[number] = { fleet };
  open.push(entry);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const env = (await callTool(fleet.robots, tool, args)).envelope;
    // what the MCP server checks before it answers
    expect(firstViolation(TOOLS.find((t) => t.name === tool)!.output, env)).toBeNull();
    return env as { ok: boolean; data: Record<string, any> };
  };
  return { fleet, events, call, entry };
}

describe("what the model is told", () => {
  test("the server instructions and both tools' descriptions carry the rule, word for word", () => {
    expect(ROBOT_NAME_RULE).toMatch(/you are this robot/);
    expect(ROBOT_NAME_RULE).toMatch(/first person/);
    expect(ROBOT_NAME_RULE).toMatch(/robot_id/);
    expect(ROBOT_NAME_RULE).toMatch(/say so plainly/);
    expect(SERVER_INSTRUCTIONS).toContain(ROBOT_NAME_RULE);
    for (const name of ["list_robots", "describe_robot"]) {
      const t = TOOLS.find((x) => x.name === name)!;
      expect(t.description).toContain(ROBOT_NAME_RULE);
      expect(JSON.stringify(t.output)).toContain(JSON.stringify(ROBOT_NAME_RULE).slice(1, -1));
    }
  });
  test("a named twin: list_robots and describe_robot give its name, and robot_id stays its id", async () => {
    const { call } = await fleetOf(["--twin", named]);
    const list = await call("list_robots");
    expect(list.data.robots).toEqual([expect.objectContaining({ id: "r1-sim", name: "Doña Tuerca" })]);
    const d = await call("describe_robot", { robot_id: "r1-sim" });
    expect(d.data).toMatchObject({ id: "r1-sim", name: "Doña Tuerca" });
    expect((await call("describe_robot", { robot_id: "Doña Tuerca" })).ok).toBe(false);
  }, 15_000);
  test("a robot without a name answers name null", async () => {
    const { call } = await fleetOf(["--twin"]);
    expect((await call("list_robots")).data.robots[0].name).toBeNull();
    expect((await call("describe_robot", { robot_id: "r1-sim" })).data.name).toBeNull();
  }, 15_000);
});

describe("what the person sees", () => {
  test("a named twin writes its name on the brick's screen once online; one without a name leaves it blank", async () => {
    const { fleet, events } = await fleetOf(["--twin", "--name", "Doña Tuerca"]);
    // the screen drops accents (ev3.display)
    expect(fleet.bricks.get("r1-sim")!.peek().lcd).toEqual(["Dona Tuerca"]);
    expect(events.filter((e) => e.ev === "greet_failed")).toEqual([]);
    const plain = await fleetOf(["--twin"]);
    expect(plain.fleet.bricks.get("r1-sim")!.peek().lcd).toEqual([]);
  }, 15_000);
  test("the 3D page gets the name with each robot's meta; null without one", async () => {
    const { fleet, entry } = await fleetOf(["--twin", named]);
    const twins = fleet.robots.map((r) => ({
      id: r.id,
      brick: fleet.bricks.get(r.id)!,
      sim: fleet.sims.get(r.id)!,
      robot: r,
    }));
    const view = serveView(twins, 0, { page: await buildViewPage(), log: () => {} });
    entry.view = view;
    const ws = new WebSocket(`${view.url.replace("http", "ws")}ws`, {
      headers: { origin: new URL(view.url).origin },
    } as never);
    entry.ws = ws;
    const got: ServerMessage[] = [];
    ws.onmessage = (e) => void got.push(JSON.parse(String(e.data)) as ServerMessage);
    await until("the hello", () => got.some((m) => m.t === "hello"), 4000);
    const hello = got.find((m) => m.t === "hello") as Extract<ServerMessage, { t: "hello" }>;
    expect(hello.robots.map((r) => [r.id, r.name])).toEqual([["r1-sim", "Doña Tuerca"]]);
  }, 15_000);
});
