import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, EXAMPLE, loadConfig, parseSshTarget } from "../src/config";

const tmp = mkdtempSync(join(tmpdir(), "spinecord-local-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const robot = JSON.parse(readFileSync(EXAMPLE.robot, "utf8"));
const file = (name: string, json: unknown): string => {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(json));
  return path;
};
const dev = file("dev.json", { ...robot, hardware: { ...robot.hardware, speech_volume_pct: 80 } });

describe("command line", () => {
  test("no arguments: the example robot's twin", () => {
    const c = loadConfig([]);
    expect(c.robots.map((r) => [r.source, r.id])).toEqual([["twin", "r1-sim"]]);
    expect(c.port).toBe(DEFAULT_PORT);
  });
  test("an EV3 and its twin side by side", () => {
    const c = loadConfig(["--ev3", EXAMPLE.robot, "--twin", EXAMPLE.robot, "--world", EXAMPLE.world, "--port", "9001"]);
    expect(c.robots.map((r) => [r.source, r.id])).toEqual([
      ["ev3", "r1"],
      ["twin", "r1-sim"],
    ]);
    expect(c.port).toBe(9001);
  });
  test("ev3dev over ssh", () => {
    const c = loadConfig(["--ev3dev", dev, "--ssh", "robot@ev3dev.local:2222"]);
    expect(c.robots[0]).toMatchObject({
      source: "ev3dev",
      id: "r1",
      ssh: { user: "robot", host: "ev3dev.local", port: 2222 },
      hardware: { speech_volume_pct: 80 },
      installBridge: false,
    });
    expect(parseSshTarget("--ssh", "robot@10.0.0.2")).toEqual({ user: "robot", host: "10.0.0.2" });
  });
  test("every wrong input names its flag", () => {
    expect(() => loadConfig(["--twin", EXAMPLE.robot])).toThrow("--twin needs --world");
    expect(() => loadConfig(["--world", EXAMPLE.world])).toThrow("--world needs --twin");
    expect(() => loadConfig(["--port", "9001"])).toThrow("--port needs --ev3");
    expect(() => loadConfig(["--ev3dev", dev])).toThrow("--ev3dev needs --ssh");
    expect(() => loadConfig(["--ev3dev", EXAMPLE.robot, "--ssh", "robot@host"])).toThrow("speech_volume_pct");
    expect(() => loadConfig(["--ev3dev", dev, "--ssh", "host"])).toThrow("user@host");
    expect(() => loadConfig(["--ev3", join(tmp, "none.json")])).toThrow("--ev3: cannot read");
    expect(() => loadConfig(["--ev3", EXAMPLE.robot, "--port", "0"])).toThrow("--port must be an integer");
    expect(() => loadConfig(["--ev3", EXAMPLE.robot, "--ev3dev", dev, "--ssh", "robot@host"])).toThrow("its own id");
    expect(() => loadConfig(["--nope"])).toThrow();
  });
});

describe("config file", () => {
  test("paths are relative to the file; ids can be set", () => {
    writeFileSync(join(tmp, "r.json"), JSON.stringify(robot));
    writeFileSync(join(tmp, "w.json"), readFileSync(EXAMPLE.world, "utf8"));
    const path = file("local.json", {
      port: 9100,
      robots: [
        { source: "twin", robot: "r.json", world: "w.json", seed: 7 },
        { source: "twin", robot: "r.json", world: "w.json", id: "second-sim" },
        { source: "ev3", robot: "r.json" },
        {
          source: "ev3dev",
          robot: "dev.json",
          id: "dev",
          ssh: { host: "ev3dev.local", user: "robot" },
          install_bridge: true,
        },
      ],
    });
    const c = loadConfig(["--config", path]);
    expect(c.port).toBe(9100);
    expect(c.robots.map((r) => r.id)).toEqual(["r1-sim", "second-sim", "r1", "dev"]);
    expect(c.robots[0]).toMatchObject({ seed: 7 });
    expect(c.robots[3]).toMatchObject({ installBridge: true });
  });
  test("every wrong field is named", () => {
    const bad = (json: unknown) => () => loadConfig(["--config", file("bad.json", json)]);
    expect(bad({ robots: [] })).toThrow("robots must be a non-empty array");
    expect(bad({ robots: [{ source: "car", robot: EXAMPLE.robot }] })).toThrow('robots[0].source must be "twin"');
    expect(bad({ robots: [{ source: "twin", robot: EXAMPLE.robot }] })).toThrow("robots[0].world must be a path");
    expect(bad({ robots: [{ source: "ev3", robot: EXAMPLE.robot }], extra: 1 })).toThrow("unknown field extra");
    expect(
      bad({
        robots: [
          { source: "ev3", robot: EXAMPLE.robot },
          { source: "ev3", robot: EXAMPLE.robot, id: "other" },
        ],
      }),
    ).toThrow("one stock-firmware EV3 per process");
    expect(() => loadConfig(["--config", join(tmp, "bad.json"), "--port", "1"])).toThrow("--config holds everything");
  });
});
