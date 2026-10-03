import { queryTenantScoped } from "../db/pool.js";

// Click-to-update for installed agents (Windows, macOS, Linux). The backend only reads the published
// manifest's version to tell the UI an update exists; the agent itself
// verifies the Ed25519 signature and every hash before installing anything
// (agent/internal/update), so nothing here is trusted for integrity.

// Release directory for each device platform. Agents older than
// FIRST_UPDATABLE_VERSION need the install command rerun once.
const RELEASE_DIRS: Record<string, string[]> = {
  windows: ["windows-amd64"],
  mac: ["darwin-arm64", "darwin-amd64"],
  linux: ["linux-amd64", "linux-arm64"],
};
export const FIRST_UPDATABLE_VERSION = "0.3.0";
const CACHE_MS = 5 * 60_000;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export function isVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION_RE.test(value);
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function downloadsBase(): string {
  return (process.env.AGENT_DOWNLOADS_URL ?? `${process.env.FRONTEND_URL ?? "http://localhost:3001"}/downloads/agent`).replace(/\/+$/, "");
}

const cache = new Map<string, { version: string | null; at: number }>();

export async function latestAgentVersion(platformKey: string): Promise<string | null> {
  const hit = cache.get(platformKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.version;
  let version: string | null = null;
  try {
    const res = await fetch(`${downloadsBase()}/${platformKey}/manifest.json`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const body = (await res.json()) as { version?: unknown; platform?: unknown };
      if (isVersion(body.version) && body.platform === platformKey) version = body.version;
    }
  } catch {
    // No published manifest (or downloads unreachable): just offer no update.
  }
  cache.set(platformKey, { version, at: Date.now() });
  return version;
}

export interface UpdateInfo {
  update_supported: boolean;
  latest_agent_version: string | null;
  update_available: boolean;
  update_state: "none" | "queued" | "installing" | "failed";
  update_error: string | null;
}

interface DeviceRow {
  id: string;
  platform: string;
  agent_version: string | null;
  revoked: boolean;
}

/** Adds update availability and the state of the latest update click to each device. */
export async function withUpdateInfo<T extends DeviceRow>(tenantId: string, devices: T[]): Promise<Array<T & UpdateInfo>> {
  // Every architecture of a platform is built and published together, so the
  // first published manifest gives that platform's latest version; the agent
  // itself downloads the build for its own architecture.
  const latestByPlatform = new Map<string, string | null>();
  for (const [platform, dirs] of Object.entries(RELEASE_DIRS)) {
    let latest: string | null = null;
    for (const dir of dirs) if ((latest = await latestAgentVersion(dir))) break;
    latestByPlatform.set(platform, latest);
  }

  const recent = devices.length
    ? await queryTenantScoped(tenantId,
      `SELECT DISTINCT ON (device_id) device_id, params->>'version' AS version, executed_at, result, error_message,
              requested_at > now() - interval '15 minutes' AS fresh
       FROM tool_calls
       WHERE tool = 'agent.update' AND device_id = ANY($1::uuid[]) AND requested_at > now() - interval '1 day'
       ORDER BY device_id, requested_at DESC`,
      [devices.map((d) => d.id)])
    : { rows: [] };
  const lastClick = new Map(recent.rows.map((r) => [r.device_id, r]));

  return devices.map((d) => {
    const supported = Object.hasOwn(RELEASE_DIRS, d.platform) && isVersion(d.agent_version) &&
      compareVersions(d.agent_version, FIRST_UPDATABLE_VERSION) >= 0 && !d.revoked;
    const latest = latestByPlatform.get(d.platform) ?? null;
    const available = Boolean(latest && (!isVersion(d.agent_version) || compareVersions(latest, d.agent_version) > 0));

    let state: UpdateInfo["update_state"] = "none";
    let error: string | null = null;
    const click = lastClick.get(d.id);
    if (click && click.version !== d.agent_version) {
      if (click.result === "error" || click.result === "timeout") {
        state = "failed";
        error = click.error_message;
      } else if (click.fresh) {
        state = click.executed_at ? "installing" : "queued";
      } else {
        state = "failed";
        error = "Máy chưa chạy phiên bản mới sau 15 phút.";
      }
    }
    return { ...d, update_supported: supported, latest_agent_version: latest, update_available: available, update_state: state, update_error: error };
  });
}
