import { describe, expect, test } from "bun:test";
import { acceptsGzip, cacheFile, etagMatches, respond } from "../src/http-cache";

describe("http-cache", () => {
  test("acceptsGzip: gzip or * with q above 0, unless gzip is refused", () => {
    expect(acceptsGzip(null)).toBe(false);
    expect(acceptsGzip("")).toBe(false);
    expect(acceptsGzip("gzip, deflate, br, zstd")).toBe(true);
    expect(acceptsGzip("br")).toBe(false);
    expect(acceptsGzip("identity")).toBe(false);
    expect(acceptsGzip("GZip;q=0.5")).toBe(true);
    expect(acceptsGzip("gzip;q=0")).toBe(false);
    expect(acceptsGzip("gzip;q=0.0, br")).toBe(false);
    expect(acceptsGzip("*")).toBe(true);
    expect(acceptsGzip("*;q=0")).toBe(false);
    expect(acceptsGzip("*, gzip;q=0")).toBe(false);
    expect(acceptsGzip("x-gzip")).toBe(true);
    expect(acceptsGzip("gzip;q=nonsense")).toBe(false);
  });

  test("etagMatches: one tag, a list, *, weak against strong", () => {
    expect(etagMatches(null, '"a"')).toBe(false);
    expect(etagMatches('"a"', '"a"')).toBe(true);
    expect(etagMatches('"b", "a"', '"a"')).toBe(true);
    expect(etagMatches('W/"a"', '"a"')).toBe(true);
    expect(etagMatches("*", '"a"')).toBe(true);
    expect(etagMatches('"ab"', '"a"')).toBe(false);
    expect(etagMatches('"a-gz"', '"a"')).toBe(false);
  });

  test("the tag follows the content: same bytes same tag, other bytes another", () => {
    const a = cacheFile("text/plain", "one", true);
    expect(cacheFile("text/plain", "one", true).etag).toBe(a.etag);
    expect(cacheFile("text/plain", "two", true).etag).not.toBe(a.etag);
    expect(a.etag).toMatch(/^"[\w-]+"$/);
  });

  test("respond: gzip for a browser that takes it, a 304 on its tag, and nothing compressed twice", async () => {
    const text = "spinecord ".repeat(2000);
    const f = cacheFile("text/javascript; charset=utf-8", text, true);
    const h = (o: Record<string, string>) => new Headers(o);
    const plain = respond(f, h({}), { "x-content-type-options": "nosniff" });
    expect(plain.status).toBe(200);
    expect(await plain.text()).toBe(text);
    expect(plain.headers.get("content-encoding")).toBeNull();
    const gz = respond(f, h({ "accept-encoding": "gzip" }), {});
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer())))).toBe(text);
    expect(gz.headers.get("etag")).not.toBe(plain.headers.get("etag"));
    // the identity tag never validates the gzipped copy, nor the other way round
    expect(respond(f, h({ "accept-encoding": "gzip", "if-none-match": plain.headers.get("etag")! }), {}).status).toBe(
      200,
    );
    expect(respond(f, h({ "if-none-match": gz.headers.get("etag")! }), {}).status).toBe(200);
    const hit = respond(f, h({ "accept-encoding": "gzip", "if-none-match": gz.headers.get("etag")! }), { x: "1" });
    expect(hit.status).toBe(304);
    expect(hit.headers.get("x")).toBe("1");
    expect(hit.headers.get("cache-control")).toBe("no-cache");
    const bin = cacheFile("application/gzip", new Uint8Array([31, 139, 8, 0]), false);
    const b = respond(bin, h({ "accept-encoding": "gzip" }), {});
    expect(b.headers.get("content-encoding")).toBeNull();
    expect(b.headers.get("vary")).toBeNull();
    expect(new Uint8Array(await b.arrayBuffer())).toEqual(new Uint8Array([31, 139, 8, 0]));
  });
});
