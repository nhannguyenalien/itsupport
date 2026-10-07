import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { directConnection, parsePgUrl, type PgConnection } from "./config.js";

// Customers type the address of their own database and OUR server connects to
// it. Without a guard that is a server-side request forgery primitive: pointing
// the URL at 10.x, localhost, the Docker network (`db`), Tailscale or a cloud
// metadata address would let a customer probe or talk to our internal services.
// So a target must resolve ONLY to public addresses, and we connect to the very
// address we validated (PGHOSTADDR) so a DNS answer cannot change in between.

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10] /* CGNAT, Tailscale */, ["127.0.0.0", 8], ["169.254.0.0", 16] /* link-local, metadata */,
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["64:ff9b::", 96], ["100::", 64],
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** IPv4 address embedded in an IPv4-mapped IPv6 one (::ffff:a.b.c.d or ::ffff:7f00:1), else null. */
function mappedV4(ip: string): string | null {
  const m = ip.toLowerCase().match(/^(?:0{0,4}:){0,5}:?ffff:(.+)$/);
  if (!m) return null;
  if (isIP(m[1]) === 4) return m[1];
  const hex = m[1].match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPublicIp(ip: string): boolean {
  const version = isIP(ip);
  if (!version) return false;
  if (version === 6) {
    const v4 = mappedV4(ip);
    if (v4) return isPublicIp(v4);
    return !blocked.check(ip, "ipv6");
  }
  return !blocked.check(ip, "ipv4");
}

/** Test-only escape hatch so end-to-end tests can use localhost. Never honoured in production. */
const allowPrivate = () => process.env.DBBACKUP_ALLOW_PRIVATE === "1" && process.env.NODE_ENV !== "production";

/** Resolves a host and returns its addresses, refusing anything non-public. */
export async function resolvePublic(host: string): Promise<string[]> {
  const bare = host.replace(/^\[|\]$/g, "");
  const addresses = isIP(bare) ? [bare] : (await lookup(bare, { all: true, verbatim: true }).catch(() => { throw new Error("Không phân giải được tên máy chủ của database."); })).map((a) => a.address);
  if (!addresses.length) throw new Error("Không phân giải được tên máy chủ của database.");
  if (!allowPrivate() && !addresses.every(isPublicIp)) {
    throw new Error("Chỉ chấp nhận database có địa chỉ công khai trên Internet (không nhận địa chỉ nội bộ, localhost hay mạng riêng).");
  }
  // IPv4 first: many hosts publish an unreachable AAAA record.
  return [...addresses].sort((a, b) => (isIP(a) === 4 ? 0 : 1) - (isIP(b) === 4 ? 0 : 1));
}

/** A customer database must be reached over TLS: its password crosses the Internet. */
export function requireTls(conn: PgConnection): void {
  const mode = conn.env.PGSSLMODE;
  if (!mode || !["require", "verify-ca", "verify-full"].includes(mode)) {
    throw new Error("URL cần có ?sslmode=require (kết nối mã hoá TLS là bắt buộc).");
  }
}

export interface ValidatedTarget { conn: PgConnection; address: string }

/** Parses a customer URL, requires TLS and a public address, and pins the
 * connection to that address. `direct` swaps a Neon pooler host for the direct
 * one first (for pg_dump), so the address we pin is the one we really connect to. */
export async function validateCustomerUrl(url: string, opts: { direct?: boolean } = {}): Promise<ValidatedTarget> {
  const parsed = parsePgUrl(url);
  const conn = opts.direct ? directConnection(parsed) : parsed;
  requireTls(conn);
  const [address] = await resolvePublic(conn.host);
  return { conn: { ...conn, env: { ...conn.env, PGHOSTADDR: address } }, address };
}
