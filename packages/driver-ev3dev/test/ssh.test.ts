import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeCommand } from "../src/ssh";

describe("the command that starts the bridge", () => {
  test("a file named like a module is imported, so Python keeps its bytecode", () => {
    expect(bridgeCommand("~/spinecord/ev3dev_bridge.py")).toBe(
      `python3 -u -c "import os, sys; d = os.path.expanduser('~/spinecord'); sys.path[0] = d; import runpy; m = __import__('ev3dev_bridge'); (getattr(m, 'run', None) or (lambda a: runpy.run_path(os.path.join(d, 'ev3dev_bridge.py'), run_name='__main__')))(['ev3dev_bridge.py'])"`,
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

const python3 = Bun.which("python3");
const posixPython = process.platform !== "win32" && python3 !== null;

describe.skipIf(!posixPython)("the command, run by a POSIX shell with the local Python", () => {
  const home = mkdtempSync(join(tmpdir(), "spinecord-launch-"));
  mkdirSync(join(home, "b"));
  // a module of the session's working folder (the home folder) must not shadow the standard library
  for (const mod of ["runpy", "json"])
    writeFileSync(join(home, `${mod}.py`), `raise SystemExit('the home folder shadowed ${mod}')\n`);
  const run = (file: string, body: string): string => {
    writeFileSync(join(home, "b", file), body);
    const out = Bun.spawnSync(["sh", "-c", bridgeCommand(`~/b/${file}`)], {
      cwd: home,
      env: { ...process.env, HOME: home },
    });
    return `${out.stdout.toString()}${out.stderr.toString()}`.trim();
  };
  const script = (tag: string) =>
    `import sys, json\ndef main():\n    print('${tag}', sys.argv[0] if sys.argv else '')\nif __name__ == '__main__':\n    main()\n`;
  test("a module with run is imported and run, with its name as argv[0]", () => {
    expect(run("withrun.py", "import sys, json\ndef run(argv):\n    print('run', argv[0])\n")).toBe("run withrun.py");
  });
  test("a module without run is run as a script", () => {
    expect(run("norun.py", script("main"))).toStartWith("main");
  });
  test("a name Python already loaded, or a keyword, is run as a script", () => {
    expect(run("os.py", script("main-os"))).toStartWith("main-os");
    expect(run("if.py", script("main-if"))).toStartWith("main-if");
  });
  test("the bytecode of an imported bridge is kept next to it", () => {
    run("cached.py", "def run(argv):\n    print('ok')\n");
    expect(readdirSync(join(home, "b", "__pycache__")).some((f) => f.startsWith("cached."))).toBe(true);
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));
});
