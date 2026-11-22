import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, win32 } from "node:path";
import { DEFAULT_PORT, EXAMPLE, REPO, USAGE, loadConfig, parseSshTarget, pathFrom } from "../src/config";
import { addCommand } from "../src/print-add";

const tmp = mkdtempSync(join(tmpdir(), "spinecord-local-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const robot = JSON.parse(readFileSync(EXAMPLE.robot, "utf8"));
const file = (name: string, json: unknown): string => {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(json));
  return path;
};
const dev = file("dev.json", { ...robot, hardware: { ...robot.hardware, speech_volume_pct: 80 } });
const { speech_volume_pct: _none, ...silentHardware } = robot.hardware;
const silent = file("silent.json", { ...robot, hardware: silentHardware });
const MAIN = join(REPO, "apps", "local", "main.ts");
/** Runs the real entry point in `cwd` and waits for it to end. */
const main = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
};

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
    expect(parseSshTarget("--ssh", "robot@brick.local")).toEqual({ user: "robot", host: "brick.local" });
  });
  test("every wrong input names its flag", () => {
    expect(() => loadConfig(["--world", EXAMPLE.world])).toThrow("--world needs --twin");
    expect(() => loadConfig(["--port", "9001"])).toThrow("--port needs --ev3");
    expect(() => loadConfig(["--ev3dev", dev])).toThrow("--ev3dev needs --ssh");
    expect(() => loadConfig(["--ev3dev", silent, "--ssh", "robot@host"])).toThrow(
      `--ev3dev ${silent}: hardware.speech_volume_pct is required`,
    );
    expect(() => loadConfig(["--ev3dev", dev, "--ssh", "host"])).toThrow("user@host");
    expect(() => loadConfig(["--ev3", join(tmp, "none.json")])).toThrow("--ev3: cannot read");
    expect(() => loadConfig(["--ev3", EXAMPLE.robot, "--port", "0"])).toThrow("--port must be an integer");
    expect(() => loadConfig(["--ev3", EXAMPLE.robot, "--ev3dev", dev, "--ssh", "robot@host"])).toThrow("its own id");
    expect(() => loadConfig(["--nope"])).toThrow();
  });
});

describe("robots without a robot file", () => {
  test("--ev3, --twin and --ev3dev alone use the example robot; --twin alone uses the example room", () => {
    const example = loadConfig(["--twin", EXAMPLE.robot, "--world", EXAMPLE.world]).robots[0];
    expect(loadConfig(["--twin"]).robots).toEqual([example!]);
    expect(loadConfig(["--ev3"]).robots).toEqual([loadConfig(["--ev3", EXAMPLE.robot]).robots[0]!]);
    const all = loadConfig(["--ev3", "--port", "9001", "--twin", "--seed", "3"]);
    expect(all.robots.map((r) => [r.source, r.id])).toEqual([
      ["ev3", "r1"],
      ["twin", "r1-sim"],
    ]);
    expect(all).toMatchObject({ port: 9001, robots: [{}, { seed: 3 }] });
  });
  test("the example robot file starts an ev3dev brick as it is", () => {
    for (const argv of [
      ["--ev3dev", "--ssh", "robot@ev3dev.local", "--install-bridge"],
      ["--install-bridge", "--ssh", "robot@ev3dev.local", "--ev3dev"],
      ["--ev3dev", "deployments/example/robots/r1.json", "--ssh", "robot@ev3dev.local", "--install-bridge"],
    ])
      expect(loadConfig(argv).robots).toEqual([
        {
          source: "ev3dev",
          id: "r1",
          robot: loadConfig(["--ev3"]).robots[0]!.robot,
          hardware: { low_battery_v: 6.5, max_tone_ms: 5000, speech_volume_pct: 100 },
          ssh: { user: "robot", host: "ev3dev.local" },
          installBridge: true,
        },
      ]);
  });
});

describe("where a path is taken from", () => {
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "spinecord elsewhere ")));
  afterAll(() => rmSync(elsewhere, { recursive: true, force: true }));
  const back = process.cwd();
  /** Runs `fn` with the working directory an MCP client would give the server: a folder that is not the clone. */
  const inElsewhere = <T>(fn: () => T): T => {
    process.chdir(elsewhere);
    try {
      return fn();
    } finally {
      process.chdir(back);
    }
  };

  test("a relative path on the command line is taken from the repository, whatever the working directory", () => {
    writeFileSync(join(elsewhere, "r1.json"), "this file in the working directory is never read");
    const here = loadConfig(["--ev3", EXAMPLE.robot, "--twin", EXAMPLE.robot, "--world", EXAMPLE.world]);
    const argv = [
      "--ev3",
      relative(REPO, EXAMPLE.robot),
      "--twin",
      "deployments/example/robots/r1.json",
      "--world",
      "apps/local/examples/room.json",
    ];
    expect(loadConfig(argv)).toEqual(here);
    expect(inElsewhere(() => loadConfig(argv))).toEqual(here);
    expect(inElsewhere(() => loadConfig(["--twin", "--world", "packages/sim-world/examples/walls-maze.json"]))).toEqual(
      loadConfig(["--twin", "--world", join(REPO, "packages", "sim-world", "examples", "walls-maze.json")]),
    );
  });
  test("a file that is not there: the error carries the absolute path that was tried", () => {
    writeFileSync(join(elsewhere, "mine.json"), JSON.stringify(robot));
    const tried = join(REPO, "mine.json");
    expect(isAbsolute(tried)).toBe(true);
    expect(() => inElsewhere(() => loadConfig(["--ev3", "mine.json"]))).toThrow(`--ev3: cannot read ${tried}`);
    expect(() => loadConfig(["--twin", "mine.json"])).toThrow(`--twin: cannot read ${tried}`);
    expect(() => loadConfig(["--twin", "--world", "none/w.json"])).toThrow(
      `--world: cannot read ${join(REPO, "none", "w.json")}`,
    );
    expect(() => loadConfig(["--config", "none.json"])).toThrow(`--config: cannot read ${join(REPO, "none.json")}`);
    expect(() => loadConfig(["--ev3dev", "mine.json", "--ssh", "robot@host"])).toThrow(
      `--ev3dev: cannot read ${tried}`,
    );
  });
  test("a relative path in a config file is taken from that file's folder, whatever the working directory", () => {
    const folder = join(elsewhere, "my robots");
    mkdirSync(join(folder, "robots"), { recursive: true });
    writeFileSync(
      join(folder, "robots", "r.json"),
      JSON.stringify({ ...robot, profile: { ...robot.profile, id: "mine" } }),
    );
    writeFileSync(join(folder, "w.json"), readFileSync(EXAMPLE.world, "utf8"));
    const path = join(folder, "local.json");
    writeFileSync(path, JSON.stringify({ robots: [{ source: "twin", robot: "robots/r.json", world: "w.json" }] }));
    expect(loadConfig(["--config", path]).robots.map((r) => r.id)).toEqual(["mine-sim"]);
    expect(inElsewhere(() => loadConfig(["--config", path])).robots.map((r) => r.id)).toEqual(["mine-sim"]);
    writeFileSync(path, JSON.stringify({ robots: [{ source: "ev3", robot: "robots/none.json" }] }));
    expect(() => loadConfig(["--config", path])).toThrow(`cannot read ${join(folder, "robots", "none.json")}`);
  });
  test("the same rule on Windows paths with spaces and on POSIX paths", () => {
    const repo = "C:\\Users\\Ana Maria\\my code\\spinecord";
    expect(pathFrom(repo, "deployments\\example\\robots\\r1.json", win32)).toBe(
      "C:\\Users\\Ana Maria\\my code\\spinecord\\deployments\\example\\robots\\r1.json",
    );
    expect(pathFrom(repo, "deployments/example/robots/r1.json", win32)).toBe(
      "C:\\Users\\Ana Maria\\my code\\spinecord\\deployments\\example\\robots\\r1.json",
    );
    expect(pathFrom(repo, "..\\my robots\\r 2.json", win32)).toBe("C:\\Users\\Ana Maria\\my code\\my robots\\r 2.json");
    expect(pathFrom(repo, "D:\\robots\\r 2.json", win32)).toBe("D:\\robots\\r 2.json");
    expect(pathFrom("/home/ana maria/spinecord", "robots/r 2.json", posix)).toBe(
      "/home/ana maria/spinecord/robots/r 2.json",
    );
    expect(pathFrom("/home/ana maria/spinecord", "/srv/r 2.json", posix)).toBe("/srv/r 2.json");
  });
  test("--help says where a relative path is taken from", () => {
    expect(USAGE).toContain("A relative path on the command line is taken from the repository\nroot,");
    expect(USAGE).toContain(`The repository root is\n  ${REPO}`);
    expect(USAGE).toContain("a relative path inside a --config file from that file's folder");
  });
});

describe("--print-add", () => {
  test("Windows: absolute paths with spaces, quoted for PowerShell and cmd.exe", () => {
    const repo = "C:\\Users\\Ana Maria\\my code\\spinecord";
    const main = '"C:\\Users\\Ana Maria\\my code\\spinecord\\apps\\local\\main.ts"';
    // "--" in quotes: PowerShell keeps a bare one for itself when claude is a script
    expect(addCommand({ platform: "win32", repo, args: [] })).toBe(`claude mcp add -s user spinecord "--" bun ${main}`);
    expect(addCommand({ platform: "win32", repo, args: ["--ev3", "--twin"] })).toBe(
      `claude mcp add -s user spinecord "--" bun ${main} --ev3 --twin`,
    );
    expect(
      addCommand({
        platform: "win32",
        repo,
        args: ["--twin", "deployments/example/robots/r1.json", "--world=D:\\my worlds\\w.json", "--seed", "7"],
      }),
    ).toBe(
      `claude mcp add -s user spinecord "--" bun ${main} ` +
        '--twin "C:\\Users\\Ana Maria\\my code\\spinecord\\deployments\\example\\robots\\r1.json" ' +
        '--world "D:\\my worlds\\w.json" --seed 7',
    );
    expect(
      addCommand({
        platform: "win32",
        repo,
        args: ["--ev3dev", "--ssh", "robot@ev3dev.local", "--ssh-key", "C:\\Users\\Ana Maria\\.ssh\\id_ed25519"],
      }),
    ).toBe(
      `claude mcp add -s user spinecord "--" bun ${main} --ev3dev --ssh robot@ev3dev.local ` +
        '--ssh-key "C:\\Users\\Ana Maria\\.ssh\\id_ed25519"',
    );
    // what PowerShell and cmd.exe read differently inside double quotes is refused, never printed
    expect(() => addCommand({ platform: "win32", repo: "C:\\Users\\$ana\\spinecord", args: [] })).toThrow("contains $");
    expect(() => addCommand({ platform: "win32", repo: "C:\\100%\\spinecord", args: [] })).toThrow("contains %");
  });
  test("macOS and Linux: absolute paths with spaces, quoted for sh, bash and zsh", () => {
    for (const platform of ["darwin", "linux"]) {
      expect(addCommand({ platform, repo: "/Users/ana maria/spinecord", args: ["--ev3"] })).toBe(
        'claude mcp add -s user spinecord -- bun "/Users/ana maria/spinecord/apps/local/main.ts" --ev3',
      );
      expect(
        addCommand({
          platform,
          repo: "/home/ana/spinecord",
          args: ["--config", "deployments/example/local.json"],
        }),
      ).toBe(
        'claude mcp add -s user spinecord -- bun "/home/ana/spinecord/apps/local/main.ts" ' +
          '--config "/home/ana/spinecord/deployments/example/local.json"',
      );
      // a character a shell expands inside double quotes: single quotes
      expect(addCommand({ platform, repo: "/home/ana/$5 robot's", args: [] })).toBe(
        "claude mcp add -s user spinecord -- bun '/home/ana/$5 robot'\\''s/apps/local/main.ts'",
      );
    }
  });
  test("the entry point prints the command for this computer from any folder and starts nothing", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "spinecord elsewhere "));
    try {
      const run = main(elsewhere, "--print-add", "--ev3", "--twin", "--world", "apps/local/examples/room.json");
      expect(run.out).toBe(
        `${addCommand({ platform: process.platform, repo: REPO, args: ["--ev3", "--twin", "--world", EXAMPLE.world] })}\n`,
      );
      expect(run.out).toContain(` bun "${MAIN}" --ev3 --twin --world "${EXAMPLE.world}"`);
      expect(run.out).toStartWith(
        process.platform === "win32"
          ? 'claude mcp add -s user spinecord "--" bun '
          : "claude mcp add -s user spinecord -- bun ",
      );
      expect(run.err).toContain("claude mcp remove -s user spinecord");
      expect(run.code).toBe(0);
      // a command that would not start is not printed
      const wrong = main(elsewhere, "--print-add", "--ev3", "none.json");
      expect(wrong).toMatchObject({ code: 2, out: "" });
      expect(wrong.err).toContain(`--ev3: cannot read ${join(REPO, "none.json")}`);
      expect(main(elsewhere, "--help")).toMatchObject({ code: 0, out: "" });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
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
