// `--lan` and `--page-origin` (CONTRACT §6): the network listener over TLS with a test certificate, the
// certificate of the LAN-name service through an injected fetcher and its cache, a certificate of the person's
// own, the tunnel listener, the limit on wrong tokens, the interface choice, and the QR code of the join link.
// The fake page client (./pages.ts) dials 127.0.0.1 and sends the listener's name as Host: the name of the
// interface address (10.0.0.5, a placeholder) resolves nowhere in a test.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import {
  cacheFolder,
  chooseInterface,
  isPrivateIPv4,
  lanName,
  ownCertHost,
  serviceCert,
  type LanDeps,
} from "../src/lan";
import { MAX_WRONG_TOKENS, type PageTimes } from "../src/pages";
import { addCommand } from "../src/print-add";
import { formatBits, qrEncode, qrSvg, qrText } from "../src/qr";
import { buildFleet, type Fleet } from "../src/sources";
import { callTool } from "../src/tools";
import { until } from "./client";
import { fakePage, type FakePage } from "./pages";
import { testCert, type TestCert } from "./tls";

const ADDRESS = "10.0.0.5";
const NAME = "10-0-0-5.local-ip.sh";
/** What the LAN-name service would serve: a wildcard certificate (here also for 127.0.0.1, which the client dials). */
const SERVICE = testCert({ dns: ["*.local-ip.sh"], ips: ["127.0.0.1"] });

let tmp: string;
const open: { fleet: Fleet; pages: FakePage[] }[] = [];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spinecord-lan-"));
});
afterEach(async () => {
  for (const o of open.splice(0)) {
    for (const p of o.pages) p.close();
    await o.fleet.shutdown();
  }
  rmSync(tmp, { recursive: true, force: true });
});

const iface = (address: string, family = "IPv4", internal = false) => ({ address, family, internal }) as never;
function deps(over: Partial<LanDeps> = {}): LanDeps & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    interfaces: () => ({ lo0: [iface("127.0.0.1", "IPv4", true)], wlan0: [iface(ADDRESS)] }),
    defaultRoute: async () => null,
    bindAddress: "127.0.0.1",
    resolve: async () => ADDRESS,
    cacheDir: join(tmp, "cache"),
    fetchText: async (url) => {
      fetched.push(url);
      return url.endsWith(".key") ? SERVICE.key : SERVICE.cert;
    },
    ...over,
  };
}

async function rig(argv: string[], lan: LanDeps = deps(), times: Partial<PageTimes> = {}) {
  const events: Record<string, unknown>[] = [];
  const fleet = await buildFleet(loadConfig(argv), {
    log: (ev, fields) => void events.push({ ev, ...fields }),
    pagePort: 0,
    pageTimes: times,
    lan,
  });
  const entry = { fleet, pages: [] as FakePage[] };
  open.push(entry);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> =>
    (await callTool(fleet.robots, name, args)).envelope;
  const lanPort = () => Number(new URL(fleet.pages!.lanUrl!).port);
  /** A fake page that dials the network listener with the given link (default: the twin's, with the token). */
  const page = async (o: Partial<Parameters<typeof fakePage>[0]> = {}) => {
    const link = fleet.pages!.links().find((l) => l.via === "lan" && l.robot === "r1-sim")!.url;
    const p = await fakePage({
      url: link,
      dial: `wss://127.0.0.1:${lanPort()}`,
      ca: SERVICE.cert,
      robot: "r1-sim",
      ...o,
    });
    entry.pages.push(p);
    return p;
  };
  /** A request to the network listener, with that Host; the client checks the certificate against the listener's
   * own name, as a browser that dialled `host` would, so a foreign Host reaches the listener's own check. */
  const get = (path: string, host = `${NAME}:${lanPort()}`) =>
    fetch(`https://127.0.0.1:${lanPort()}${path}`, {
      headers: { Host: host },
      tls: { ca: SERVICE.cert, ...(host === `${NAME}:${lanPort()}` ? {} : { rejectUnauthorized: false }) },
    } as never);
  return { fleet, call, page, get, lanPort, events };
}
const TWIN_LAN = ["--twin", "--pages", "--lan"];

describe("--lan: the network listener", () => {
  test("a page joins with the token of its link; join names the network address and never the token", async () => {
    const r = await rig(TWIN_LAN);
    const pages = r.fleet.pages!;
    expect(pages.lanUrl).toBe(`https://${NAME}:${r.lanPort()}/`);
    const link = pages.links().find((l) => l.robot === "r1-sim")!;
    expect(link.via).toBe("lan");
    expect(link.url).toMatch(/^https:\/\/10-0-0-5\.local-ip\.sh:\d+\/#t=[^&]+&robot=r1-sim$/);
    const token = new URLSearchParams(new URL(link.url).hash.slice(1)).get("t")!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/); // 128 bits, base64url
    const listed = await r.call("list_robots");
    const join = listed.data.robots[0].join as string;
    expect(join).toContain(`https://${NAME}:${r.lanPort()}/`);
    expect(join).toContain(pages.consoleUrl);
    expect(join).not.toContain(token);
    const p = await r.page();
    expect(await p.joined).toMatchObject({ t: "welcome", name: "desk", robot: "r1-sim" });
    await until("the page to be active", async () => {
      const d = await r.call("describe_robot", { robot_id: "r1-sim" });
      return d.ok && d.data.pages.some((x: { state: string }) => x.state === "active");
    });
    const read = await r.call("read_device", { robot_id: "r1-sim", device: "desk.camera", channels: ["width_px"] });
    expect(read.ok).toBe(true);
    expect(JSON.stringify(r.events)).not.toContain(token);
  });

  test("refused without the token (4001), and after 5 wrong ones the address is refused for a while (4029)", async () => {
    const r = await rig(TWIN_LAN, deps(), { lockout_ms: 600 });
    expect(await (await r.page({ token: "" })).closed).toMatchObject({ code: 4001 });
    for (let i = 1; i < MAX_WRONG_TOKENS; i++) {
      const wrong = await (await r.page({ token: "x".repeat(22) })).closed;
      expect(wrong.code).toBe(4001);
      expect(wrong.reason).toContain("join link");
    }
    // the fifth wrong token (the empty one counted) starts the refusal: the right token is refused too
    const right = await (await r.page()).closed;
    expect(right.code).toBe(4029);
    expect(right.reason).toContain("too many wrong tokens");
    await Bun.sleep(700);
    expect(await (await r.page()).joined).toMatchObject({ t: "welcome" });
  });

  test("the limit counts per listener: wrong tokens on the network do not lock this computer's own page", async () => {
    const r = await rig(TWIN_LAN);
    for (let i = 0; i < MAX_WRONG_TOKENS; i++) await (await r.page({ token: "y".repeat(22) })).closed;
    expect((await (await r.page()).closed).code).toBe(4029);
    const local = await fakePage({ url: r.fleet.pages!.url, robot: "r1-sim", name: "computer" });
    open[0]!.pages.push(local);
    expect(await local.joined).toMatchObject({ t: "welcome" });
  });

  test("a wrong Origin or Host on the network listener is refused; it serves no token and no console", async () => {
    const r = await rig(TWIN_LAN);
    for (const origin of ["https://evil.example", `http://${NAME}:${r.lanPort()}`, `http://127.0.0.1:${r.lanPort()}`]) {
      const p = await r.page({ origin });
      await expect(p.joined).rejects.toThrow();
    }
    expect((await r.get("/", `evil.example:${r.lanPort()}`)).status).toBe(403);
    expect((await r.get("/", `127.0.0.1:${r.lanPort()}`)).status).toBe(403);
    expect((await r.get("/", `localhost:${r.lanPort()}`)).status).toBe(403);
    const served = await r.get("/");
    expect(served.status).toBe(200);
    expect(served.headers.get("content-security-policy")).toBe("default-src 'self'; connect-src 'self'");
    expect(await served.text()).not.toContain("spinecord-token");
    expect((await r.get("/console")).status).toBe(404);
    // TLS only: a client that does not trust the certificate does not get through
    await expect(
      fetch(`https://127.0.0.1:${r.lanPort()}/`, { headers: { Host: `${NAME}:${r.lanPort()}` } }),
    ).rejects.toThrow();
  });

  test("the pairing console is on loopback: a QR code per robot of the link with the token, and the pages", async () => {
    const r = await rig(TWIN_LAN);
    const pages = r.fleet.pages!;
    const html = await (await fetch(pages.consoleUrl)).text();
    for (const l of pages.links()) expect(html).toContain(l.url.replaceAll("&", "&amp;"));
    expect(html.match(/<svg /g)?.length).toBe(2); // r1-sim and pages
    expect(html).toContain(`${NAME} resolves to ${ADDRESS} on this computer`);
    expect(html).not.toMatch(/<script|style=/);
    // a foreign Host is refused on loopback as before
    const foreign = await fetch(pages.consoleUrl, { headers: { Host: `${NAME}:${pages.port}` } });
    expect(foreign.status).toBe(403);
  });

  test("a start with no reachable certificate exits 1 with a message that names --lan-cert", async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "lan-main.ts"), ...TWIN_LAN, "--page-port", "0"], {
      cwd: import.meta.dir,
      env: { ...process.env, LAN_TEST: "unreachable", LAN_TEST_CACHE: join(tmp, "cache") },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(err).toContain("could not be fetched from https://local-ip.sh/server.pem");
    expect(err).toContain("--lan-cert <cert.pem> <key.pem>");
  }, 15_000);

  test("the join link and its QR code go to stderr, never to --log-file", async () => {
    const logFile = join(tmp, "log", "server.jsonl");
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "lan-main.ts"), ...TWIN_LAN, "--page-port", "0", "--log-file", logFile],
      {
        cwd: import.meta.dir,
        env: { ...process.env, LAN_TEST: "ok", LAN_TEST_CACHE: join(tmp, "cache") },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let err = "";
    const pump = (async () => {
      for await (const chunk of child.stderr) err += new TextDecoder().decode(chunk);
    })();
    await until("the server to be ready", () => err.includes('"ev":"ready"'), 10_000);
    void child.stdin.end();
    expect(await child.exited).toBe(0);
    await pump;
    const token = err.match(/#t=([A-Za-z0-9_-]{22})/)?.[1];
    expect(token).toBeDefined();
    expect(err).toContain("▀");
    expect(err).toContain(`as ${NAME}`);
    const logged = readFileSync(logFile, "utf8");
    expect(logged).toContain('"ev":"ready"');
    expect(logged).not.toContain(token!);
  }, 20_000);
});

describe("--lan: the certificate of the LAN-name service", () => {
  test("fetched once and cached with its expiry; fetched again once it expired", async () => {
    const d = deps();
    const first = await serviceCert(NAME, d);
    expect(first.source).toBe("https://local-ip.sh/server.pem");
    expect(d.fetched).toEqual(["https://local-ip.sh/server.pem", "https://local-ip.sh/server.key"]);
    const cached = JSON.parse(readFileSync(join(d.cacheDir!, "lan-cert.json"), "utf8"));
    expect(cached.not_after).toBe(new Date(new X509Certificate(SERVICE.cert).validTo).toISOString());
    const second = await serviceCert(NAME, d);
    expect(second.source).toBe(join(d.cacheDir!, "lan-cert.json"));
    expect(d.fetched.length).toBe(2);
    // a cached certificate that expired is fetched again
    const later = new Date(Date.now() + 40 * 86_400_000);
    const fresh = testCert({ dns: ["*.local-ip.sh"], notBefore: new Date(Date.now() + 39 * 86_400_000) });
    const d2 = deps({
      cacheDir: d.cacheDir,
      now: () => later,
      fetchText: async (url) => (url.endsWith(".key") ? fresh.key : fresh.cert),
    });
    const third = await serviceCert(NAME, d2);
    expect(third.source).toBe("https://local-ip.sh/server.pem");
    expect(third.cert.cert).toBe(fresh.cert);
  });

  test("refused loudly: unreachable, a key of another certificate, an expired one, one for another name", async () => {
    const other = testCert({ dns: ["*.local-ip.sh"] });
    const cases: [Partial<LanDeps>, string][] = [
      [{ fetchText: async () => Promise.reject(new Error("ENOTFOUND")) }, "could not be fetched"],
      [{ fetchText: async (u) => (u.endsWith(".key") ? other.key : SERVICE.cert) }, "does not belong"],
      [{ now: () => new Date(Date.now() + 60 * 86_400_000) }, "expired"],
      [
        { fetchText: async (u) => (u.endsWith(".key") ? SERVICE.key : SERVICE.cert) },
        "does not cover 10-0-0-5.other.example",
      ],
    ];
    for (const [over, message] of cases) {
      const host = message.includes("other.example") ? "10-0-0-5.other.example" : NAME;
      const d = deps({ ...over, cacheDir: join(tmp, `c${Math.random()}`) });
      const e = await serviceCert(host, d).catch((x: Error) => x);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain(message);
      expect((e as Error).message).toContain("--lan-cert <cert.pem> <key.pem>");
    }
  });

  test("buildFleet throws before anything listens, so serve() exits 1", async () => {
    const e = await buildFleet(loadConfig(TWIN_LAN), {
      log: () => {},
      pagePort: 0,
      lan: deps({ fetchText: async () => Promise.reject(new Error("offline")) }),
    }).catch((x: Error) => x);
    expect((e as Error).message).toContain("--lan-cert");
  });
});

describe("--lan-cert: a certificate of the person's own", () => {
  const files = (c: TestCert) => {
    writeFileSync(join(tmp, "cert.pem"), c.cert);
    writeFileSync(join(tmp, "key.pem"), c.key);
    return [join(tmp, "cert.pem"), join(tmp, "key.pem")];
  };

  test("a certificate for the interface address: the page joins at https://<address>:<port>/", async () => {
    const own = testCert({ ips: [ADDRESS, "127.0.0.1"] });
    const lan = deps({ fetchText: async () => Promise.reject(new Error("must not be fetched")) });
    const r = await rig([...TWIN_LAN, "--lan-cert", ...files(own)], lan);
    expect(r.fleet.pages!.lanUrl).toBe(`https://${ADDRESS}:${r.lanPort()}/`);
    expect(r.fleet.lan!.source).toBe(join(tmp, "cert.pem"));
    const p = await r.page({ ca: own.cert });
    expect(await p.joined).toMatchObject({ t: "welcome" });
  });

  test("--lan-host for a certificate of a name; refused when the certificate names neither", async () => {
    const named = testCert({ dns: ["robot.home.example"], ips: ["127.0.0.1"] });
    const x = new X509Certificate(named.cert);
    expect(ownCertHost(x, ADDRESS, undefined, "cert.pem")).toBe("robot.home.example");
    expect(ownCertHost(x, ADDRESS, "robot.home.example", "cert.pem")).toBe("robot.home.example");
    expect(() => ownCertHost(x, ADDRESS, "other.example", "cert.pem")).toThrow("does not cover");
    const two = new X509Certificate(testCert({ dns: ["a.example", "b.example"] }).cert);
    expect(() => ownCertHost(two, ADDRESS, undefined, "cert.pem")).toThrow("--lan-host <name>");
    const r = await rig([...TWIN_LAN, "--lan-cert", ...files(named), "--lan-host", "robot.home.example"]);
    expect(r.fleet.pages!.lanUrl).toBe(`https://robot.home.example:${r.lanPort()}/`);
  });

  test("the flags: two files, each needs --lan, a file that is not there ends the start", () => {
    const [cert, key] = files(testCert({ ips: [ADDRESS] }));
    expect(loadConfig([...TWIN_LAN, "--lan-cert", cert!, key!]).pages?.lan?.own).toMatchObject({ certPath: cert });
    expect(() => loadConfig([...TWIN_LAN, "--lan-cert", cert!])).toThrow("--lan-cert needs two files");
    expect(() => loadConfig(["--twin", "--pages", "--lan-cert", cert!, key!])).toThrow("--lan-cert needs --lan");
    expect(() => loadConfig(["--twin", "--lan"])).toThrow("--lan needs --pages");
    expect(() => loadConfig(["--twin", "--pages", "--lan-interface", "wlan0"])).toThrow("--lan-interface needs --lan");
    expect(() => loadConfig([...TWIN_LAN, "--lan-host", "x.example"])).toThrow("needs --lan-cert");
    expect(() => loadConfig([...TWIN_LAN, "--lan-cert", join(tmp, "none.pem"), key!])).toThrow("cannot read");
    expect(() => loadConfig([...TWIN_LAN, "--page-port", "65535"])).toThrow("up to 65533");
    // --print-add makes both files absolute
    const add = addCommand({ platform: "linux", repo: "/repo", args: [...TWIN_LAN, "--lan-cert", "c.pem", "k.pem"] });
    expect(add).toContain('--lan-cert "/repo/c.pem" "/repo/k.pem"');
  });

  test("in a config file: pages.lan with cert and key relative to the file, and pages.origin", () => {
    files(testCert({ ips: [ADDRESS] }));
    const path = join(tmp, "c.json");
    writeFileSync(
      path,
      JSON.stringify({
        pages: { lan: { interface: "wlan0", cert: "cert.pem", key: "key.pem" }, origin: "https://t.example" },
        robots: [
          { source: "pages", robot: join(import.meta.dir, "..", "..", "..", "deployments/example/robots/pages.json") },
        ],
      }),
    );
    const c = loadConfig(["--config", path]);
    expect(c.pages).toMatchObject({
      lan: { interface: "wlan0", own: { certPath: join(tmp, "cert.pem") } },
      origin: "https://t.example",
    });
  });
});

describe("--page-origin: a tunnel the person runs", () => {
  test("its own listener on loopback answers the tunnel's Host and Origin, with no token served", async () => {
    const r = await rig(["--twin", "--pages", "--page-origin", "https://tunnel.example"]);
    const pages = r.fleet.pages!;
    expect(pages.lanUrl).toBeNull();
    const tunnelPort = Number(new URL(pages.tunnelUrl!).port);
    expect(tunnelPort).not.toBe(pages.port);
    const link = pages.links().find((l) => l.robot === "r1-sim")!;
    expect(link.via).toBe("tunnel");
    expect(link.url).toMatch(/^https:\/\/tunnel\.example\/#t=[^&]+&robot=r1-sim$/);
    const served = await fetch(pages.tunnelUrl!, { headers: { Host: "tunnel.example" } });
    expect(served.status).toBe(200);
    expect(await served.text()).not.toContain("spinecord-token");
    expect((await fetch(pages.tunnelUrl!)).status).toBe(403); // a loopback Host on the tunnel listener
    expect((await fetch(`${pages.tunnelUrl}console`, { headers: { Host: "tunnel.example" } })).status).toBe(404);
    const p = await fakePage({ url: link.url, dial: `ws://127.0.0.1:${tunnelPort}`, robot: "r1-sim" });
    open[0]!.pages.push(p);
    expect(await p.joined).toMatchObject({ t: "welcome" });
    const foreign = await fakePage({
      url: link.url,
      dial: `ws://127.0.0.1:${tunnelPort}`,
      origin: `http://127.0.0.1:${pages.port}`,
      name: "other",
    });
    await expect(foreign.joined).rejects.toThrow();
    expect(() => loadConfig(["--twin", "--pages", "--page-origin", "http://tunnel.example"])).toThrow("https origin");
    expect(() => loadConfig(["--twin", "--pages", "--page-origin", "https://tunnel.example/x"])).toThrow("no path");
  });
});

describe("--lan: the interface", () => {
  const table = (entries: Record<string, string[]>) =>
    Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v.map((a) => iface(a))]));

  test("a private IPv4 address: the only one, else the default route's, else the one asked for", () => {
    expect(isPrivateIPv4("10.1.2.3")).toBe(true);
    expect(isPrivateIPv4("172.16.200.9")).toBe(true);
    expect(isPrivateIPv4("172.31.200.9")).toBe(true);
    expect(isPrivateIPv4("172.32.200.9")).toBe(false);
    expect(isPrivateIPv4("192.168.200.9")).toBe(true);
    expect(isPrivateIPv4("192.0.2.1")).toBe(false);
    expect(isPrivateIPv4("100.64.0.1")).toBe(false);
    expect(lanName("10.0.0.5")).toBe(NAME);
    const one = table({ en0: ["192.0.2.10", "10.0.0.5"], utun0: ["100.64.0.2"] });
    expect(chooseInterface(one, null)).toEqual({ interface: "en0", address: "10.0.0.5" });
    const two = table({ en0: ["10.0.0.5"], en1: ["10.9.0.7"] });
    expect(chooseInterface(two, "10.9.0.7")).toEqual({ interface: "en1", address: "10.9.0.7" });
    expect(() => chooseInterface(two, null)).toThrow("--lan-interface <name|address>");
    expect(chooseInterface(two, null, "en0")).toEqual({ interface: "en0", address: "10.0.0.5" });
    expect(chooseInterface(two, null, "10.9.0.7")).toEqual({ interface: "en1", address: "10.9.0.7" });
    expect(() => chooseInterface(two, null, "wlan9")).toThrow("no interface of this computer has that name");
    expect(() => chooseInterface(one, null, "utun0")).toThrow("is not a private address");
    expect(() => chooseInterface(table({ utun0: ["100.64.0.2"] }), null)).toThrow("no private IPv4 address");
    // IPv6 and internal addresses never count
    expect(() =>
      chooseInterface({ lo: [iface("127.0.0.1", "IPv4", true)], en0: [iface("fd00::1", "IPv6")] }, null),
    ).toThrow("no private IPv4 address");
  });

  test("a start with no private address exits before anything listens", async () => {
    const e = await buildFleet(loadConfig(TWIN_LAN), {
      log: () => {},
      pagePort: 0,
      lan: deps({ interfaces: () => ({ lo: [iface("127.0.0.1", "IPv4", true)] }) }),
    }).catch((x: Error) => x);
    expect((e as Error).message).toContain("no private IPv4 address");
  });

  test("the cache folder of each operating system", () => {
    expect(cacheFolder("darwin", {}, "/h")).toBe(join("/h", "Library", "Caches", "spinecord"));
    expect(cacheFolder("linux", {}, "/h")).toBe(join("/h", ".cache", "spinecord"));
    expect(cacheFolder("linux", { XDG_CACHE_HOME: "/x" }, "/h")).toBe(join("/x", "spinecord"));
    expect(cacheFolder("win32", { LOCALAPPDATA: "C:/L" }, "C:/h")).toBe(join("C:/L", "spinecord", "Cache"));
  });
});

describe("the QR code of the join link", () => {
  const rows = (m: boolean[][]) => m.map((r) => r.map((d) => (d ? "#" : ".")).join(""));
  const sha = (m: boolean[][]) => createHash("sha256").update(rows(m).join("\n")).digest("hex");

  // Each vector was decoded back to its text with zbarimg (ZBar 0.23) on 2026-11-23.
  test("known vectors: version 1, a join link (version 5), the longest link (version 10)", () => {
    expect(rows(qrEncode("spinecord"))).toEqual([
      "#######.##.#..#######",
      "#.....#.#.#...#.....#",
      "#.###.#.##..#.#.###.#",
      "#.###.#..#.#..#.###.#",
      "#.###.#.##.##.#.###.#",
      "#.....#.......#.....#",
      "#######.#.#.#.#######",
      ".........##..........",
      "#..#######.#.#..#.###",
      "##.........##.##..##.",
      "...#..###.###....####",
      "##.###.#.#..##.#..###",
      "#.#.####.#####...#.##",
      "........#.#.#.#.#....",
      "#######.##.#.#..###..",
      "#.....#.#.....##.####",
      "#.###.#.#.....##.#...",
      "#.###.#.#.#.###......",
      "#.###.#...####..##.##",
      "#.....#...###..#.####",
      "#######.###.##..#....",
    ]);
    const link = "https://10-0-0-5.local-ip.sh:8769/#t=AAAAAAAAAAAAAAAAAAAAAA&robot=r1-sim";
    expect(qrEncode(link).length).toBe(37);
    expect(sha(qrEncode(link))).toBe("2bb7b469a5cc539e5f5187c874c8cb44c811d8a2d034766d44e7945287497f42");
    const longest = `https://10-0-0-5.local-ip.sh:8769/#t=AAAAAAAAAAAAAAAAAAAAAA&robot=${"r".repeat(48)}&name=${"n".repeat(32)}&pad=${"p".repeat(40)}`;
    expect(qrEncode(longest).length).toBe(57);
    expect(sha(qrEncode(longest))).toBe("6a52d62c0d8eaa42f7e797280b80e556c9f70e35d9e04099d717672cf95ec856");
  });

  test("format bits of the standard's table, a version per length, and a loud refusal above capacity", () => {
    // ISO/IEC 18004 table C.1, level M
    expect(formatBits(0)).toBe(0b101010000010010);
    expect(formatBits(5)).toBe(0b100000011001110);
    expect(formatBits(7)).toBe(0b100101010100000);
    expect(qrEncode("x".repeat(213)).length).toBe(57);
    expect(() => qrEncode("x".repeat(214))).toThrow("do not fit");
    const text = qrText(qrEncode("spinecord"));
    expect(text.split("\n").length).toBe(Math.ceil((21 + 4) / 2));
    expect(qrSvg(qrEncode("spinecord"))).not.toContain("style");
  });
});
