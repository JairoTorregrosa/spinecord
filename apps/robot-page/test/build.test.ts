// Smoke test of the static build, without a browser: it builds, the HTML only references files that exist,
// the page's ids match what main.ts looks up, and the local server serves it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPage, collectProfiles } from "../build";
import { servePage } from "../serve";
import type { ProfileEntry } from "../src/config";
import { COPY } from "../src/copy";

const app = join(import.meta.dir, "..");
let tmp: string;
let dist: string;
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "robot-page-"));
  dist = await buildPage({ outdir: join(tmp, "dist") });
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("build", () => {
  test("writes the page, its script, its styles and the profile list", () => {
    for (const file of ["index.html", "main.js", "styles.css", "profiles.json"])
      expect(statSync(join(dist, file)).size).toBeGreaterThan(0);
  });
  test("every src and href in the HTML is a local file that exists", () => {
    const html = readFileSync(join(dist, "index.html"), "utf8");
    const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    expect(refs).toEqual(expect.arrayContaining(["main.js", "styles.css"]));
    for (const ref of refs) {
      expect(ref).not.toMatch(/^([a-z]+:)?\/\//); // nothing is loaded from another origin
      expect(existsSync(join(dist, ref))).toBe(true);
    }
  });
  test("the HTML has every element and every copy key the script uses", () => {
    const html = readFileSync(join(app, "index.html"), "utf8");
    const main = readFileSync(join(app, "src", "main.ts"), "utf8");
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const wanted = [...main.matchAll(/\b(?:el(?:<[^>]+>)?|text)\(\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(wanted.length).toBeGreaterThan(10);
    expect(wanted.filter((id) => !ids.has(id))).toEqual([]);
    const keys = [...html.matchAll(/\sdata-t="([^"]+)"/g)].map((m) => m[1]!);
    expect(keys.filter((k) => typeof (COPY.en as unknown as Record<string, unknown>)[k] !== "string")).toEqual([]);
    // accessible names: every form control has a label
    for (const id of [...html.matchAll(/<(?:input|select|textarea)\s[^>]*\bid="([^"]+)"/g)].map((m) => m[1]))
      expect(html).toContain(`<label for="${id}"`);
  });
  test("the bundle is a browser script with no bun or node imports", () => {
    const js = readFileSync(join(dist, "main.js"), "utf8");
    expect(js).not.toMatch(/from\s*"(node:|bun)/);
    expect(js).not.toContain("require(");
  });
  test("profiles.json lists the example deployment's robot", () => {
    const profiles = JSON.parse(readFileSync(join(dist, "profiles.json"), "utf8")) as ProfileEntry[];
    const example = profiles.find((p) => p.id === "example/r1");
    expect(example?.config.profile.id).toBe("r1");
    expect(example?.config.hardware.low_battery_v).toBeGreaterThan(0);
    expect(example?.config.pair).toEqual({ left: "B", right: "C" });
  });
  test("a broken robot file fails the build and names the file", () => {
    const deployments = join(tmp, "deployments");
    mkdirSync(join(deployments, "demo", "robots"), { recursive: true });
    writeFileSync(join(deployments, "demo", "robots", "r1.json"), JSON.stringify({ profile: { id: "r1" } }));
    expect(() => collectProfiles(deployments)).toThrow(/r1\.json: .*pair must be an object/);
    expect(() => collectProfiles(join(tmp, "missing"))).toThrow(/not found/);
  });
});

describe("serve", () => {
  test("serves the built page on localhost and nothing outside it", async () => {
    const server = servePage(dist, 0);
    try {
      const base = `http://localhost:${server.port}`;
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain('<script type="module" src="main.js">');
      const js = await fetch(`${base}/main.js`);
      expect(js.headers.get("content-type")).toContain("text/javascript");
      await js.arrayBuffer();
      expect((await fetch(`${base}/nope.js`)).status).toBe(404);
      expect([403, 404]).toContain((await fetch(`${base}/..%2f..%2fpackage.json`)).status);
    } finally {
      await server.stop(true);
    }
  });
  test("refuses to serve a folder that was not built", () => {
    expect(() => servePage(join(tmp, "empty"), 0)).toThrow(/run the build first/);
  });
});
