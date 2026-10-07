// Temporary, prefix-scoped R2 credentials (Cloudflare "temp-access-credentials").
//
// Agents run on customers' machines, so they must never hold the operator's real
// R2 key. For each device the backend asks Cloudflare for a credential that can
// ONLY read/write objects under that device's own prefix and expires after a few
// hours. The data still goes straight from the agent to R2 (not through our
// server); we only mint the key. Docs: Cloudflare API, "Create Temporary Access
// Credentials" (POST /accounts/{account_id}/r2/temp-access-credentials).

export interface S3Location { endpoint: string; bucket: string; prefix: string }

/** `s3:https://<endpoint>/<bucket>[/sub/path]` -> parts. Prefix has no leading/trailing slash. */
export function parseS3Base(base: string): S3Location {
  const m = base.match(/^s3:(https:\/\/[^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (!m) throw new Error("The storage must be an S3-compatible repository: s3:https://<endpoint>/<bucket>[/path]");
  return { endpoint: m[1], bucket: m[2], prefix: (m[3] ?? "").replace(/^\/+|\/+$/g, "") };
}

export interface TempCredentials { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiresAt: number }

export interface R2Config { accountId: string; apiToken: string; parentKeyId: string }

/** All three are needed; with any missing the system storage is simply "not available". */
export function r2Config(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID, apiToken = env.CLOUDFLARE_API_TOKEN, parentKeyId = env.R2_PARENT_ACCESS_KEY_ID;
  return accountId && apiToken && parentKeyId ? { accountId, apiToken, parentKeyId } : null;
}

export interface Minter { mint(location: { bucket: string; prefix: string }, ttlSeconds: number): Promise<TempCredentials> }

export function cloudflareMinter(cfg: R2Config, fetchImpl: typeof fetch = fetch, apiBase = process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4"): Minter {
  return {
    async mint({ bucket, prefix }, ttlSeconds) {
      // A trailing slash stops "files-a-b" from also matching "files-a-b2".
      const res = await fetchImpl(`${apiBase}/accounts/${cfg.accountId}/r2/temp-access-credentials`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ bucket, parentAccessKeyId: cfg.parentKeyId, permission: "object-read-write", ttlSeconds, prefixes: [prefix.replace(/\/*$/, "/")] }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; errors?: Array<{ message?: string }>; result?: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string } };
      const r = body.result;
      if (!res.ok || body.success === false || !r?.accessKeyId || !r.secretAccessKey || !r.sessionToken) {
        // Never echo the token or the response body wholesale.
        throw new Error(`Cloudflare did not issue storage credentials (HTTP ${res.status}${body.errors?.[0]?.message ? `: ${String(body.errors[0].message).slice(0, 160)}` : ""})`);
      }
      return { accessKeyId: r.accessKeyId, secretAccessKey: r.secretAccessKey, sessionToken: r.sessionToken, expiresAt: Date.now() + ttlSeconds * 1000 };
    },
  };
}

let injected: Minter | null = null;
/** Tests substitute a fake minter. */
export function setMinter(m: Minter | null): void { injected = m; }
export function currentMinter(): Minter | null {
  if (injected) return injected;
  const cfg = r2Config();
  return cfg ? cloudflareMinter(cfg) : null;
}

const TTL_SECONDS = 12 * 3600; // a large first backup can take hours
const cache = new Map<string, TempCredentials>();

/** Credentials for one prefix, reused until half their life is gone. */
export async function credentialsFor(location: { bucket: string; prefix: string }): Promise<TempCredentials> {
  const minter = currentMinter();
  if (!minter) throw new Error("System storage is not configured (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, R2_PARENT_ACCESS_KEY_ID)");
  const key = `${location.bucket}/${location.prefix}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt - Date.now() > (TTL_SECONDS * 1000) / 2) return hit;
  const fresh = await minter.mint(location, TTL_SECONDS);
  cache.set(key, fresh);
  return fresh;
}
export function clearCredentialCache(): void { cache.clear(); }

export const FILES_PREFIX = (tenantId: string, deviceId: string) => `files-${tenantId}-${deviceId}`;
