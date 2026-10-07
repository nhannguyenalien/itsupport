import { createHash, createHmac } from "node:crypto";

// Minimal AWS Signature V4 for S3-compatible storage (Cloudflare R2): query-string
// presigning for browser PUT/GET, and header signing for the server's own HEAD/DELETE.
// Kept dependency-free; verified against the worked example in the AWS documentation.

export interface SigningKey { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
export interface ObjectRef { endpoint: string; bucket: string; key: string; pathStyle?: boolean }

const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (p: string) => p.split("/").map(enc).join("/");

function stamps(now: Date) {
  const amz = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amz, date: amz.slice(0, 8) };
}

function signingKey(secret: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac("AWS4" + secret, date), region), "s3"), "aws4_request");
}

function locate(o: ObjectRef): { host: string; path: string; origin: string } {
  const u = new URL(o.endpoint);
  return { host: u.host, origin: u.origin, path: (o.pathStyle === false ? "/" : "/" + encPath(o.bucket) + "/") + encPath(o.key) };
}

/** A URL a browser can use once, without credentials, until `expiresSeconds` pass. */
export function presignUrl(
  method: "GET" | "PUT", o: ObjectRef, key: SigningKey,
  opts: { expiresSeconds: number; region?: string; now?: Date; query?: Record<string, string>; hostOverride?: string },
): string {
  const region = opts.region ?? "auto", { amz, date } = stamps(opts.now ?? new Date());
  const loc = locate(o);
  const { host, path } = loc;
  const scope = `${date}/${region}/s3/aws4_request`;
  const q: Record<string, string> = {
    ...opts.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${key.accessKeyId}/${scope}`,
    "X-Amz-Date": amz,
    "X-Amz-Expires": String(opts.expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  if (key.sessionToken) q["X-Amz-Security-Token"] = key.sessionToken;
  const canonicalQuery = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join("&");
  const canonical = [method, path, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amz, scope, sha256(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(key.secretAccessKey, date, region)).update(toSign).digest("hex");
  return `${loc.origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Run a HEAD or DELETE from the server, signed with headers. */
export async function signedRequest(
  method: "HEAD" | "DELETE", o: ObjectRef, key: SigningKey, fetchImpl: typeof fetch = fetch, region = "auto", now = new Date(),
): Promise<Response> {
  const { amz, date } = stamps(now), loc = locate(o), scope = `${date}/${region}/s3/aws4_request`;
  const payload = sha256("");
  const headers: Record<string, string> = { host: loc.host, "x-amz-content-sha256": payload, "x-amz-date": amz };
  if (key.sessionToken) headers["x-amz-security-token"] = key.sessionToken;
  const names = Object.keys(headers).sort();
  const canonical = [method, loc.path, "", names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), payload].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amz, scope, sha256(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(key.secretAccessKey, date, region)).update(toSign).digest("hex");
  const { host: _h, ...send } = headers;
  return fetchImpl(`${loc.origin}${loc.path}`, {
    method,
    headers: { ...send, Authorization: `AWS4-HMAC-SHA256 Credential=${key.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` },
    signal: AbortSignal.timeout(20_000),
  });
}
