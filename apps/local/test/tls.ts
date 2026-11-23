// Test certificates made at run time with node:crypto (no openssl on every CI runner, and no private key in the
// repository): a self-signed ECDSA P-256 certificate with the DNS names and IPv4 addresses asked for.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

const len = (n: number): number[] => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
const tlv = (tag: number, body: number[]): number[] => [tag, ...len(body.length), ...body];
const seq = (...xs: number[][]) => tlv(0x30, xs.flat());
function oid(dotted: string): number[] {
  const p = dotted.split(".").map(Number);
  const out = [40 * p[0]! + p[1]!];
  for (const v of p.slice(2)) {
    const b = [v & 0x7f];
    for (let x = v >> 7; x; x >>= 7) b.unshift((x & 0x7f) | 0x80);
    out.push(...b);
  }
  return tlv(0x06, out);
}
const utf8 = (s: string) => tlv(0x0c, [...Buffer.from(s)]);
const time = (d: Date) => tlv(0x18, [...Buffer.from(`${d.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`)]);

export interface TestCert {
  cert: string;
  key: string;
}
/** A certificate for `dns` and `ips`, valid from `notBefore` (default an hour ago) for `days` (default 30). */
export function testCert(o: { dns?: string[]; ips?: string[]; days?: number; notBefore?: Date }): TestCert {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const alg = seq(oid("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
  const name = seq(tlv(0x31, seq(oid("2.5.4.3"), utf8("spinecord test"))));
  const from = o.notBefore ?? new Date(Date.now() - 3_600_000);
  const to = new Date(from.getTime() + (o.days ?? 30) * 86_400_000);
  const san = [
    ...(o.dns ?? []).map((d) => tlv(0x82, [...Buffer.from(d)])),
    ...(o.ips ?? []).map((ip) => tlv(0x87, ip.split(".").map(Number))),
  ];
  const serial = [0x01, ...[...randomBytes(8)].map((b) => b & 0x7f)];
  const tbs = seq(
    tlv(0xa0, tlv(0x02, [2])), // v3
    tlv(0x02, serial),
    alg,
    name,
    seq(time(from), time(to)),
    name,
    [...publicKey.export({ type: "spki", format: "der" })],
    tlv(0xa3, seq(seq(oid("2.5.29.17"), tlv(0x04, seq(...san))))), // subjectAltName
  );
  const signature = sign("sha256", Buffer.from(tbs), privateKey);
  const der = Buffer.from(seq(tbs, alg, tlv(0x03, [0, ...signature])));
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${der
      .toString("base64")
      .match(/.{1,64}/g)!
      .join("\n")}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}
