// --doctor: every check against injected probes (no subprocess, no port, no file written), then one run of the
// real entry point, which only reads this computer.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, USAGE } from "../src/config";
import { doctor, FIREWALL, MIN_BUN, report, runBounded, type Line, type Probes, type RunResult } from "../src/doctor";

const MAIN = join(REPO, "apps", "local", "main.ts");
const ok = (out: string): RunResult => ({ code: 0, out, timedOut: false });
const registered = (scope: string, args: string, status = "✔ Connected") =>
  ok(
    `spinecord:\n  Scope: ${scope} config (private to you)\n  Status: ${status}\n  Type: stdio\n  Command: bun\n  Args: ${args}\n  Environment:\n    SECRET_VALUE=do-not-print\n`,
  );

/** A Mac where everything is in place; each test changes one thing. */
function probes(over: Partial<Probes> & { runs?: Record<string, RunResult> } = {}): Probes & { calls: string[][] } {
  const calls: string[][] = [];
  const runs: Record<string, RunResult> = {
    "claude mcp get spinecord": registered("User", `${MAIN} --twin`),
    [`${FIREWALL} --getstealthmode --getglobalstate`]: ok(
      "Firewall stealth mode is off\nFirewall is disabled. (State = 0)\n",
    ),
    "ant --profile work auth status": ok(
      "Active profile:  work\n\nCredentials\n  Logged in to Example Org as person@example.com\n  (active) * Profile (user_oauth) sk-ant-oat01-abc…\n",
    ),
    ...over.runs,
  };
  return {
    platform: "darwin",
    bunVersion: MIN_BUN,
    execPath: "/opt/bun/bin/bun",
    env: {},
    home: "/Users/someone",
    repo: REPO,
    exists: (p) => p === "/Applications/Google Chrome.app",
    which: (cmd) => (["claude", "ant"].includes(cmd) ? `/usr/local/bin/${cmd}` : null),
    run: async (cmd) => {
      calls.push(cmd);
      return runs[cmd.join(" ")] ?? { code: 127, out: "not found", timedOut: false };
    },
    portFree: async () => true,
    interfaces: () => ({ lo0: [], en0: [{ address: "10.0.0.5", family: "IPv4", internal: false } as never] }),
    defaultRoute: async () => "10.0.0.5",
    realpath: (p) => p,
    ...over,
    calls,
  };
}
const run = (args: string[], p: Probes, assistant = false) => doctor({ robotArgs: args, assistant, checkMs: 200 }, p);
const line = (lines: Line[], check: string) => lines.find((l) => l.check === check);

describe("--doctor", () => {
  test("all in place: every line ok, the summary says ok, exit 0", async () => {
    const { lines, code } = await run(["--twin"], probes());
    expect(lines.map((l) => [l.check, l.status])).toEqual([
      ["bun", "ok"],
      ["robots", "ok"],
      ["twin r1-sim", "ok"],
      ["browser", "ok"],
      ["ports", "ok"],
      ["claude code", "ok"],
    ]);
    expect(code).toBe(0);
    const text = report(lines);
    expect(text.trimEnd().split("\n").at(-1)).toBe("doctor: ok");
    expect(text).not.toContain("do-not-print");
    expect(line(lines, "claude code")!.reason).toContain("user scope");
    expect(line(lines, "claude code")!.reason).toContain("--twin");
  });

  test("the summary counts fails only; a warn alone exits 0", async () => {
    const warnOnly = await run(["--twin"], probes(), true);
    expect(line(warnOnly.lines, "assistant")!.status).toBe("warn");
    expect(warnOnly.code).toBe(0);
    expect(report(warnOnly.lines)).toEndWith("doctor: ok\n");
    const two = await run(["--twin"], probes({ bunVersion: "1.2.0", which: () => null }));
    expect(two.code).toBe(1);
    expect(report(two.lines)).toEndWith("doctor: 2 to fix\n");
  });

  test("bun: at least the version the README states", async () => {
    expect(readFileSync(join(REPO, "README.md"), "utf8")).toContain(`[bun](https://bun.sh) ≥ ${MIN_BUN}`);
    expect(line((await run([], probes({ bunVersion: "9.0.0" }))).lines, "bun")!.status).toBe("ok");
    const old = line((await run([], probes({ bunVersion: "1.1.0" }))).lines, "bun")!;
    expect(old).toMatchObject({ status: "fail", next: "bun upgrade" });
  });

  test("browser: found on macOS and Windows; missing fails only for --ev3 and --pages", async () => {
    const win = probes({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" },
      exists: (p) => p === "C:\\Users\\someone\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
      runs: { "cmd.exe /d /c claude mcp get spinecord": registered("User", `${MAIN} --ev3`) },
    });
    const edge = line((await run(["--ev3"], win)).lines, "browser")!;
    expect(edge.status).toBe("ok");
    expect(edge.reason).toContain("Microsoft Edge");
    expect(edge.reason).toContain("WebHID");
    const none = probes({ exists: () => false });
    expect(line((await run(["--twin"], none)).lines, "browser")!.status).toBe("ok");
    const ev3 = line((await run(["--ev3"], none)).lines, "browser")!;
    expect(ev3.status).toBe("fail");
    expect(ev3.reason).toContain("WebHID");
    expect(line((await run(["--pages"], none)).lines, "browser")!.status).toBe("fail");
    const linux = probes({
      platform: "linux",
      which: (c) => (c === "google-chrome" ? "/usr/bin/google-chrome" : null),
    });
    expect(line((await run(["--ev3"], linux)).lines, "browser")!.reason).toContain("/usr/bin/google-chrome");
  });

  test("claude code: missing, not registered, another clone, a folder's own scope, failing to start", async () => {
    const lines = async (p: Probes, args = ["--twin"]) => line((await run(args, p)).lines, "claude code")!;
    expect(await lines(probes({ which: () => null }))).toMatchObject({
      status: "fail",
      reason: "claude is not on PATH",
    });
    const missing = await lines(
      probes({
        runs: { "claude mcp get spinecord": { code: 1, out: 'No MCP server named "spinecord".', timedOut: false } },
      }),
      ["--ev3"],
    );
    expect(missing.status).toBe("fail");
    expect(missing.next).toBe("bun apps/local/main.ts --print-add --ev3, then run the line it prints");
    const other = await lines(
      probes({ runs: { "claude mcp get spinecord": registered("User", "/elsewhere/spinecord/apps/local/main.ts") } }),
    );
    expect(other.status).toBe("fail");
    expect(other.reason).toContain("/elsewhere/spinecord/apps/local/main.ts");
    expect(other.next).toStartWith("claude mcp remove -s user spinecord");
    // a folder's own registration, seen from that folder, is deliberate: only its sessions start a robot link
    for (const scope of ["Local", "Project"]) {
      const folder = await lines(probes({ runs: { "claude mcp get spinecord": registered(scope, `${MAIN} --ev3`) } }));
      expect(folder.status).toBe("ok");
      expect(folder.reason).toContain(`${scope.toLowerCase()} scope: only sessions opened in this folder see it`);
      expect(folder.next).toBeUndefined();
    }
    const broken = await lines(
      probes({ runs: { "claude mcp get spinecord": registered("User", MAIN, "✘ Failed to connect") } }),
    );
    expect(broken.status).toBe("fail");
    const slow = await lines(probes({ runs: { "claude mcp get spinecord": { code: null, out: "", timedOut: true } } }));
    expect(slow.status).toBe("fail");
    expect(slow.reason).toContain("did not answer");
    // the path of a clone reached through a link, and Windows' case and separators
    const linked = probes({
      realpath: () => "/real/spinecord/apps/local/main.ts",
      runs: { "claude mcp get spinecord": registered("User", "/real/spinecord/apps/local/main.ts --ev3") },
    });
    expect((await lines(linked, ["--ev3"])).status).toBe("ok");
    const win = probes({
      platform: "win32",
      repo: "C:\\Users\\someone\\spinecord",
      runs: {
        "cmd.exe /d /c claude mcp get spinecord": registered("User", "c:/users/someone/spinecord/apps/local/main.ts"),
      },
    });
    expect((await lines(win)).status).toBe("ok");
  });

  test("ports: free, held, none; the one of --lan and --page-origin; probed ahead of the server claude starts", async () => {
    const p = probes({ portFree: async (port) => port !== 8768 });
    const { lines } = await run(["--ev3", "--pages", "--lan", "--page-origin", "https://name.example"], p);
    const ports = lines.filter((l) => l.check === "port");
    expect(ports.map((l) => [l.reason.split(" ")[0], l.status])).toEqual([
      ["8767", "ok"],
      ["8768", "fail"],
      ["8769", "ok"],
      ["8770", "ok"],
    ]);
    expect(ports[1]!.reason).toContain("another spinecord");
    expect(ports[1]!.next).toContain("close the other Claude Code session");
    expect(line((await run([], probes())).lines, "ports")!.reason).toContain("no port");
    // a held port is the likely cause of a registration that does not start: one fail, not two
    const both = probes({
      portFree: async () => false,
      runs: { "claude mcp get spinecord": registered("User", `${MAIN} --ev3`, "✘ Failed to connect") },
    });
    const held = await run(["--ev3"], both);
    expect(line(held.lines, "claude code")!.status).toBe("warn");
    expect(report(held.lines)).toEndWith("doctor: 1 to fix\n");
    const order = held.lines.map((l) => l.check);
    expect(order.indexOf("port")).toBeLessThan(order.indexOf("claude code"));
  });

  test("robots: the server's own parsing; a file that fails is a fail and the ports are not checked", async () => {
    const good = line((await run(["--ev3", "--twin"], probes())).lines, "robots")!;
    expect(good).toMatchObject({ status: "ok", reason: "ev3 r1, twin r1-sim" });
    const { lines, code } = await run(["--ev3", "none.json"], probes());
    expect(line(lines, "robots")!.status).toBe("fail");
    expect(line(lines, "robots")!.reason).toContain(join(REPO, "none.json"));
    expect(line(lines, "ports")!.status).toBe("warn");
    expect(line(lines, "browser")!.reason).toContain("WebHID");
    expect(code).toBe(1);
  });

  test("--lan: a private address, or none; the macOS firewall off, on, blocking all, unreadable; Windows", async () => {
    const lan = async (p: Probes) => (await run(["--pages", "--lan"], p)).lines;
    const fine = await lan(probes());
    expect(line(fine, "lan")).toMatchObject({ status: "ok", reason: "listens on en0 10.0.0.5" });
    expect(line(fine, "firewall")).toMatchObject({ status: "ok" });
    const none = await lan(
      probes({ interfaces: () => ({ en0: [{ address: "203.0.113.9", family: "IPv4", internal: false } as never] }) }),
    );
    expect(line(none, "lan")!.status).toBe("fail");
    expect(line(none, "lan")!.reason).toContain("no private IPv4 address");
    const fw = (out: string, code = 0) =>
      lan(probes({ runs: { [`${FIREWALL} --getstealthmode --getglobalstate`]: { code, out, timedOut: false } } }));
    const on = line(await fw("Firewall stealth mode is on\nFirewall is enabled. (State = 1)\n"), "firewall")!;
    expect(on.status).toBe("warn");
    expect(on.reason).toContain("stealth mode on");
    expect(on.next).toContain('--unblockapp "/opt/bun/bin/bun"');
    expect(line(await fw("Firewall stealth mode is off\nFirewall is enabled. (State = 2)\n"), "firewall")!.status).toBe(
      "fail",
    );
    expect(line(await fw("", 1), "firewall")!.status).toBe("warn");
    const win = await lan(
      probes({
        platform: "win32",
        runs: { "cmd.exe /d /c claude mcp get spinecord": registered("User", MAIN) },
      }),
    );
    expect(line(win, "firewall")!.reason).toContain("allow it on private networks");
    // no --lan, no network check
    expect(line((await run(["--pages"], probes())).lines, "lan")).toBeUndefined();
  });

  test("--assistant: names, never values; a profile that pays, one a key comes ahead of, one with no login", async () => {
    const env = { ANTHROPIC_PROFILE: "work" };
    const good = await run([], probes({ env }), true);
    expect(line(good.lines, "assistant")).toMatchObject({ status: "ok" });
    expect(line(good.lines, "ant")).toMatchObject({
      status: "ok",
      reason: "the profile work is logged in to Example Org",
    });
    const text = report(good.lines);
    expect(text).not.toContain("person@example.com");
    expect(text).not.toContain("sk-ant");
    const secret = "sk-ant-api03-zzzz";
    const conflict = await run([], probes({ env: { ...env, ANTHROPIC_API_KEY: secret } }), true);
    const c = line(conflict.lines, "assistant")!;
    expect(c.status).toBe("fail");
    expect(c.reason).toContain("ANTHROPIC_API_KEY is set too");
    expect(c.next).toBe("unset ANTHROPIC_API_KEY");
    expect(report(conflict.lines)).not.toContain(secret);
    const cloud = await run([], probes({ platform: "win32", env: { ...env, CLAUDE_CODE_USE_BEDROCK: "1" } }), true);
    expect(line(cloud.lines, "assistant")!.next).toBe("Remove-Item Env:CLAUDE_CODE_USE_BEDROCK");
    const token = await run([], probes({ env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } }), true);
    expect(line(token.lines, "assistant")).toMatchObject({ status: "ok" });
    expect(line(token.lines, "ant")).toBeUndefined();
    const nope = await run(
      [],
      probes({
        env: { ANTHROPIC_PROFILE: "nope" },
        runs: { "ant --profile nope auth status": ok('Credentials\n  (profile "nope" not configured)\n') },
      }),
      true,
    );
    expect(line(nope.lines, "ant")).toMatchObject({ status: "fail", next: "ant --profile nope auth login" });
    const noAnt = await run([], probes({ env, which: (c) => (c === "claude" ? "/bin/claude" : null) }), true);
    expect(line(noAnt.lines, "ant")!.status).toBe("fail");
    // an organization whose name holds " as "
    const as = await run(
      [],
      probes({ env, runs: { "ant --profile work auth status": ok("  Logged in to Known as Org as a@b.example\n") } }),
      true,
    );
    expect(line(as.lines, "ant")!.reason).toBe("the profile work is logged in to Known as Org");
  });

  test("a probe that never answers becomes a fail within its bound", async () => {
    const t = Date.now();
    const { lines, code } = await run(["--ev3"], probes({ portFree: () => new Promise<boolean>(() => {}) }));
    expect(line(lines, "ports")).toMatchObject({ status: "fail", reason: "did not finish within 0.4 s" });
    expect(code).toBe(1);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  test("--help lists --doctor", () => {
    expect(USAGE).toContain("--doctor [robots...]");
    expect(USAGE).toContain("--assistant");
  });

  test("a probe command that outlives its bound is stopped with what it started, and answers at the bound", async () => {
    // the child starts a grandchild that keeps the output open for 5 s
    const script =
      "Bun.spawn([process.execPath, '-e', 'await Bun.sleep(5000)'], { stdout: 'inherit' }); await Bun.sleep(5000)";
    const t = Date.now();
    const slow = await runBounded([process.execPath, "-e", script], 300);
    expect(slow).toMatchObject({ code: null, timedOut: true });
    expect(Date.now() - t).toBeLessThan(2000);
    // a command that exits while a grandchild still holds its output answers once it exits
    const left =
      "Bun.spawn([process.execPath, '-e', 'await Bun.sleep(5000)'], { stdout: 'inherit' }).unref(); console.log('done')";
    const t2 = Date.now();
    const quick = await runBounded([process.execPath, "-e", left], 10_000);
    expect(quick).toMatchObject({ code: 0, timedOut: false });
    expect(quick.out).toContain("done");
    expect(Date.now() - t2).toBeLessThan(4000);
  }, 20_000);

  test("the entry point: one line per check, the summary last, exit 0 or 1", () => {
    const r = Bun.spawnSync(["bun", MAIN, "--doctor", "--twin"], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString().trimEnd().split("\n");
    expect(out.at(-1)).toMatch(/^doctor: (ok|\d+ to fix)$/);
    expect(out.slice(0, -1).every((l) => /^(ok|warn|fail) {2}/.test(l))).toBe(true);
    expect(r.exitCode).toBe(out.at(-1) === "doctor: ok" ? 0 : 1);
    const both = Bun.spawnSync(["bun", MAIN, "--doctor", "--print-add"], { cwd: REPO, stderr: "pipe" });
    expect(both.exitCode).toBe(2);
  }, 30_000);
});
