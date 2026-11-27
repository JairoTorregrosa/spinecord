// The 3D view's files over HTTP: revalidated by content (ETag, `Cache-Control: no-cache`), so a reload costs a few
// hundred bytes of 304s while a server started from other sources is never served stale from the browser's cache;
// and gzipped for a browser that takes gzip, once per file and process. A file that is already compressed
// (the meshes, gunzipped by the page itself) goes as it is: a Content-Encoding on it would be undone by the browser
// before the page sees it.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

/** One file as the server keeps it: its body, its tag, and its gzipped copy made on first use. */
export interface CachedFile {
  type: string;
  body: Uint8Array<ArrayBuffer>;
  /** Quoted strong tag of `body`'s content. */
  etag: string;
  /** Whether to offer it gzipped. */
  compressible: boolean;
  gz: { body: Uint8Array<ArrayBuffer>; etag: string } | null;
}

const enc = new TextEncoder();

/** The file as the server keeps it; `compressible` for text (HTML, JS, CSS, plain text). */
export function cacheFile(type: string, body: string | Uint8Array<ArrayBuffer>, compressible: boolean): CachedFile {
  const bytes = typeof body === "string" ? enc.encode(body) : body;
  const etag = `"${createHash("sha256").update(bytes).digest("base64url").slice(0, 22)}"`;
  return { type, body: bytes, etag, compressible, gz: null };
}

/** Whether an Accept-Encoding header takes gzip (`gzip` or `*` with a q above 0, and gzip not refused). */
export function acceptsGzip(header: string | null): boolean {
  if (!header) return false;
  let gzip: number | null = null;
  let star: number | null = null;
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split("=");
      if (k === "q") q = Number(v);
    }
    if (!Number.isFinite(q)) q = 0;
    if (name === "gzip" || name === "x-gzip") gzip = q;
    else if (name === "*") star = q;
  }
  return (gzip ?? star ?? 0) > 0;
}

/** Whether If-None-Match names `etag` (`*`, a list, weak or strong: RFC 9110 weak comparison). */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = (t: string) => (t.startsWith("W/") ? t.slice(2) : t);
  return ifNoneMatch.split(",").some((t) => {
    const tag = t.trim();
    return tag === "*" || bare(tag) === bare(etag);
  });
}

/** The response for `file` to a GET with these request headers: 200 with the body, or 304 when the tag matches. */
export function respond(file: CachedFile, req: Headers, base: Record<string, string>): Response {
  const gzip = file.compressible && acceptsGzip(req.get("accept-encoding"));
  if (gzip && !file.gz) {
    file.gz = { body: new Uint8Array(gzipSync(file.body)), etag: `${file.etag.slice(0, -1)}-gz"` };
  }
  const etag = gzip ? file.gz!.etag : file.etag;
  const headers: Record<string, string> = { ...base, "cache-control": "no-cache", etag };
  if (file.compressible) headers.vary = "accept-encoding";
  if (etagMatches(req.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  headers["content-type"] = file.type;
  if (gzip) headers["content-encoding"] = "gzip";
  return new Response(gzip ? file.gz!.body : file.body, { headers });
}
