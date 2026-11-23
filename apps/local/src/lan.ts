// What the network listener of pages needs to bind (CONTRACT §6, `--lan`): the address of one interface
// of this computer on a private network, a name that resolves to it, and a certificate for that name. Everything
// here runs once at start, ahead of any listener; every failure throws a message for the person at the
// terminal, and serve() ends the start with exit code 1.
import { createPrivateKey, X509Certificate } from "node:crypto";
import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";

/** The LAN-name service: `a-b-c-d.<domain>` resolves to a.b.c.d, and its wildcard certificate is public. */
export const LAN_NAME_SERVICE = {
  domain: "local-ip.sh",
  cert: "https://local-ip.sh/server.pem",
  key: "https://local-ip.sh/server.key",
} as const;
/** A fetch of the certificate that takes longer ends the start: the MCP client waits on it. */
export const LAN_FETCH_MS = 8000;

export interface LanCert {
  cert: string;
  key: string;
  /** When the certificate expires. */
  notAfter: Date;
}
/** The network listener's identity: where it binds and the name pages reach it by. */
export interface LanSetup {
  /** The interface address it binds (never the wildcard). */
  address: string;
  /** The interface it belongs to, for the person. */
  interface: string;
  /** The name in the link, in `Host` and in `Origin`. */
  host: string;
  cert: string;
  key: string;
  /** Where the certificate came from, for the person: the service's URL, the cache file, or the person's files. */
  source: string;
  /** Whether this computer's resolver gives `host` as `address`, in words: a phone's resolver may differ. */
  nameCheck: { ok: boolean; text: string };
}
/** `--lan`, `--lan-interface`, `--lan-cert`, `--lan-host` as config.ts read them. */
export interface LanConfig {
  interface?: string;
  /** The person's own certificate, as PEM text read from the files they named. */
  own?: { cert: string; key: string; certPath: string; keyPath: string };
  host?: string;
}
/** What a test swaps out: the network, the clock and the disk. */
export interface LanDeps {
  /** GET a URL, resolve with its text; reject on any failure. */
  fetchText?: (url: string) => Promise<string>;
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** The local address the default route leaves from, or null when there is none. */
  defaultRoute?: () => Promise<string | null>;
  /** Folder of the certificate cache. */
  cacheDir?: string;
  now?: () => Date;
  /** The address to bind, when it is not the chosen interface's (tests bind loopback); the name still follows the interface. */
  bindAddress?: string;
  /** Resolves a name to its IPv4 address. */
  resolve?: (name: string) => Promise<string>;
}
export const NAME_CHECK_MS = 3000;

/** Asks this computer's resolver for `host`. Never throws: the answer is advice for the person. */
export async function checkName(
  host: string,
  address: string,
  resolve: (name: string) => Promise<string> = async (n) => (await lookup(n, { family: 4 })).address,
): Promise<{ ok: boolean; text: string }> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return { ok: true, text: `${host} is an address: no name to resolve` };
  let got: string;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    got = await Promise.race([
      resolve(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${NAME_CHECK_MS} ms`)), NAME_CHECK_MS);
      }),
    ]);
  } catch (e) {
    return {
      ok: false,
      text: `this computer cannot resolve ${host} (${(e as Error).message}): its DNS may strip private addresses (rebinding protection); a phone on the same DNS will fail the same way. See README, Peripheral pages on a phone`,
    };
  } finally {
    clearTimeout(timer);
  }
  return got === address
    ? { ok: true, text: `${host} resolves to ${address} on this computer` }
    : {
        ok: false,
        text: `${host} resolves to ${got} on this computer, not to ${address}: a phone may not reach this listener. See README, Peripheral pages on a phone`,
      };
}

/** RFC 1918: 10/8, 172.16/12, 192.168/16. */
export function isPrivateIPv4(address: string): boolean {
  const p = address.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 10 || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 192 && p[1] === 168);
}

/** `a-b-c-d.<domain>` for a.b.c.d. */
export const lanName = (address: string, domain: string = LAN_NAME_SERVICE.domain): string =>
  `${address.split(".").join("-")}.${domain}`;

/**
 * The interface the network listener binds: a private IPv4 address. `wanted` (an interface name or one of its
 * addresses) decides; else the only one; else the one the default route leaves from. Throws when none fits.
 */
export function chooseInterface(
  table: NodeJS.Dict<NetworkInterfaceInfo[]>,
  route: string | null,
  wanted?: string,
): { interface: string; address: string } {
  const all = Object.entries(table).flatMap(([name, list]) =>
    (list ?? [])
      .filter((a) => a.family === "IPv4" && !a.internal)
      .map((a) => ({ interface: name, address: a.address })),
  );
  const candidates = all.filter((a) => isPrivateIPv4(a.address));
  const list = (xs: typeof all) => xs.map((a) => `${a.interface} ${a.address}`).join(", ") || "none";
  if (wanted !== undefined) {
    const hit = all.filter((a) => a.interface === wanted || a.address === wanted);
    if (hit.length === 0)
      throw new Error(
        `--lan-interface ${wanted}: no interface of this computer has that name or IPv4 address; its interfaces: ${list(all)}`,
      );
    const ok = hit.find((a) => isPrivateIPv4(a.address));
    if (!ok)
      throw new Error(
        `--lan-interface ${wanted}: ${list(hit)} is not a private address (10/8, 172.16/12, 192.168/16), the only ones --lan binds`,
      );
    return ok;
  }
  if (candidates.length === 0)
    throw new Error(
      `--lan: this computer has no private IPv4 address (10/8, 172.16/12, 192.168/16) to listen on; join the network the phone is on (its hotspot, for example) and start again. Its IPv4 interfaces: ${list(all)}`,
    );
  if (candidates.length === 1) return candidates[0]!;
  const byRoute = candidates.find((a) => a.address === route);
  if (byRoute) return byRoute;
  throw new Error(
    `--lan: this computer has several private addresses (${list(candidates)}) and none is the one its default route leaves from; pick one with --lan-interface <name|address>`,
  );
}

/** The local address of the default route: a UDP socket "connected" to a documentation address sends nothing. */
export function defaultRouteAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const s = createSocket("udp4");
    const done = (v: string | null) => {
      try {
        s.close();
      } catch {
        // already closed
      }
      resolve(v);
    };
    s.on("error", () => done(null));
    try {
      s.connect(9, "192.0.2.1", () => {
        try {
          done(s.address().address);
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });
}

/** The folder of this computer's caches, for spinecord. */
export function cacheFolder(platform: string = process.platform, env = process.env, home = homedir()): string {
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "spinecord", "Cache");
  if (platform === "darwin") return join(home, "Library", "Caches", "spinecord");
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "spinecord");
}

/** Parses a certificate and its key; throws when they do not belong together or the time is outside it. */
export function checkCert(cert: string, key: string, now: Date, where: string): LanCert & { x509: X509Certificate } {
  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(cert);
  } catch (e) {
    throw new Error(`${where}: the certificate is not PEM X.509: ${(e as Error).message}`, { cause: e });
  }
  let matches: boolean;
  try {
    matches = x509.checkPrivateKey(createPrivateKey(key));
  } catch (e) {
    throw new Error(`${where}: the key is not a PEM private key: ${(e as Error).message}`, { cause: e });
  }
  if (!matches) throw new Error(`${where}: the key does not belong to the certificate`);
  const notAfter = new Date(x509.validTo);
  const notBefore = new Date(x509.validFrom);
  if (now >= notAfter) throw new Error(`${where}: the certificate expired on ${notAfter.toISOString()}`);
  if (now < notBefore) throw new Error(`${where}: the certificate is valid only from ${notBefore.toISOString()}`);
  return { cert, key, notAfter, x509 };
}

const OWN_CERT_HINT =
  "give a certificate of your own with --lan-cert <cert.pem> <key.pem> (mkcert makes one; see README, Peripheral pages on a phone), or start without --lan";

async function defaultFetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(LAN_FETCH_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

/**
 * The service's wildcard certificate: from the cache while it has not expired, else fetched (and cached).
 * Throws a message that names --lan-cert when neither gives a certificate that covers `host`.
 */
export async function serviceCert(host: string, d: LanDeps = {}): Promise<{ cert: LanCert; source: string }> {
  const now = (d.now ?? (() => new Date()))();
  const dir = d.cacheDir ?? cacheFolder();
  const file = join(dir, "lan-cert.json");
  try {
    const cached = JSON.parse(readFileSync(file, "utf8")) as { domain?: string; cert?: string; key?: string };
    if (
      cached.domain === LAN_NAME_SERVICE.domain &&
      typeof cached.cert === "string" &&
      typeof cached.key === "string"
    ) {
      const c = checkCert(cached.cert, cached.key, now, file);
      if (c.x509.checkHost(host)) return { cert: c, source: file };
    }
  } catch {
    // no cache, an unreadable one or an expired certificate: fetch it again
  }
  const fetchText = d.fetchText ?? defaultFetchText;
  let cert: string;
  let key: string;
  try {
    [cert, key] = await Promise.all([fetchText(LAN_NAME_SERVICE.cert), fetchText(LAN_NAME_SERVICE.key)]);
  } catch (e) {
    throw new Error(
      `--lan: a phone's browser needs HTTPS, and the certificate for ${host} could not be fetched from ${LAN_NAME_SERVICE.cert} (${(e as Error).message}); ${OWN_CERT_HINT}`,
      { cause: e },
    );
  }
  let c: ReturnType<typeof checkCert>;
  try {
    c = checkCert(cert, key, now, LAN_NAME_SERVICE.cert);
  } catch (e) {
    throw new Error(`--lan: ${(e as Error).message}; ${OWN_CERT_HINT}`, { cause: e });
  }
  if (!c.x509.checkHost(host))
    throw new Error(`--lan: the certificate of ${LAN_NAME_SERVICE.cert} does not cover ${host}; ${OWN_CERT_HINT}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ domain: LAN_NAME_SERVICE.domain, not_after: c.notAfter.toISOString(), cert, key }, null, 2),
    );
  } catch {
    // the cache saves a fetch at the next start; without it the next start fetches again
  }
  return { cert: c, source: LAN_NAME_SERVICE.cert };
}

/**
 * The name a certificate of the person's own is served under: `--lan-host` when given (it must be covered), else
 * the interface address when the certificate names it, else its only exact DNS name.
 */
export function ownCertHost(x509: X509Certificate, address: string, given: string | undefined, where: string): string {
  if (given !== undefined) {
    const covered = /^\d+\.\d+\.\d+\.\d+$/.test(given) ? x509.checkIP(given) : x509.checkHost(given);
    if (!covered) throw new Error(`--lan-host ${given}: ${where} does not cover that name`);
    return given.toLowerCase();
  }
  if (x509.checkIP(address)) return address;
  const names = (x509.subjectAltName ?? "")
    .split(", ")
    .filter((s) => s.startsWith("DNS:") && !s.includes("*"))
    .map((s) => s.slice(4));
  if (names.length === 1) return names[0]!;
  throw new Error(
    `--lan-cert: ${where} does not name ${address}, the address --lan listens on${names.length ? `, and names ${names.join(", ")}` : ""}; make it for that address (mkcert ${address}) or say which name resolves to this computer with --lan-host <name>`,
  );
}

/** Everything the network listener needs, or a throw that ends the start. */
export async function prepareLan(c: LanConfig, d: LanDeps = {}): Promise<LanSetup> {
  const route = await (d.defaultRoute ?? defaultRouteAddress)();
  const chosen = chooseInterface((d.interfaces ?? networkInterfaces)(), route, c.interface);
  const now = (d.now ?? (() => new Date()))();
  const address = d.bindAddress ?? chosen.address;
  if (c.own) {
    const where = c.own.certPath;
    const checked = checkCert(c.own.cert, c.own.key, now, `--lan-cert ${where}`);
    const host = ownCertHost(checked.x509, chosen.address, c.host, where);
    const nameCheck = await checkName(host, chosen.address, d.resolve);
    return { address, interface: chosen.interface, host, cert: c.own.cert, key: c.own.key, source: where, nameCheck };
  }
  if (c.host !== undefined)
    throw new Error("--lan-host names the host of a certificate of your own: it needs --lan-cert");
  const host = lanName(chosen.address);
  const [{ cert, source }, nameCheck] = await Promise.all([
    serviceCert(host, d),
    checkName(host, chosen.address, d.resolve),
  ]);
  return { address, interface: chosen.interface, host, cert: cert.cert, key: cert.key, source, nameCheck };
}
