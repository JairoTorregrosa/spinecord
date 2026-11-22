import { describe, expect, test } from "bun:test";
import { bridgeCommand } from "../src/ssh";

describe("the command that starts the bridge", () => {
  test("a file named like a module is imported, so Python keeps its bytecode", () => {
    expect(bridgeCommand("~/spinecord/ev3dev_bridge.py")).toBe(
      `python3 -u -c "import os, sys; sys.path.insert(0, os.path.expanduser('~/spinecord')); import ev3dev_bridge; ev3dev_bridge.run(['ev3dev_bridge.py'])"`,
    );
  });
  test("any other name runs as a script", () => {
    expect(bridgeCommand("~/bin/ev3-bridge.py")).toBe("python3 -u ~/bin/ev3-bridge.py");
    expect(bridgeCommand("/opt/bridge")).toBe("python3 -u /opt/bridge");
  });
  test("a path the remote shell would parse is refused", () => {
    expect(() => bridgeCommand("~/a b.py")).toThrow();
    expect(() => bridgeCommand("~/x';rm.py")).toThrow();
  });
});
