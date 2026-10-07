import { adminPool, queryTenantScoped } from "../db/pool.js";
import { decryptToken, encryptToken } from "../oauth/crypto.js";
import { compareVersions } from "../devices/agent-updates.js";
import { emailBackupAlerts } from "./alerts.js";
import { agentSupportsSystemStorage, systemAccess } from "./system-storage.js";
import { fileBackupAllowed } from "../db-backup/usage.js";
import { BACKUP_ROWS_SQL, PROBLEM_HEALTH, withHealth } from "./health.js";

// Proactive backup through restic (agent/internal/tools/backup.go). The backend
// owns the policy; the agent only receives it, per call, at delivery time.
// Repository credentials are AES-GCM encrypted at rest and never returned by
// any API — tool_calls.params for backup.run holds only an empty marker, and
// hydrateBackupParams() fills in the secrets as the agent polls for work.

export const BACKUP_MIN_AGENT_VERSION = "0.4.1";

export { BACKUP_PLATFORMS, platformSupportsBackup } from "./platforms.js";

import { BACKUP_ENV_KEYS } from "./env-keys.js";
export { BACKUP_ENV_KEYS };

export function agentSupportsBackup(version: string | null): boolean {
  return !!version && /^\d+\.\d+\.\d+$/.test(version) && compareVersions(version, BACKUP_MIN_AGENT_VERSION) >= 0;
}

export function encryptEnv(env: Record<string, string>): string {
  return encryptToken(JSON.stringify(env));
}

export function decryptEnv(stored: string): Record<string, string> {
  return JSON.parse(decryptToken(stored));
}

interface PolicyRow {
  repo: string; secrets_enc: string; paths: string[]; excludes: string[];
  keep_daily: number; keep_weekly: number; keep_monthly: number;
  use_vss: boolean; limit_upload_kbps: number; db_dumps: unknown[];
  storage: "custom" | "system"; repo_password_enc: string | null;
}

/** Pinned restic downloads per agent platform; the agent picks its own GOOS-GOARCH. */
export function resticDownloads(env: NodeJS.ProcessEnv = process.env): Record<string, { url: string; sha256: string }> {
  const out: Record<string, { url: string; sha256: string }> = {};
  for (const [key, prefix] of [["windows-amd64", "RESTIC_WINDOWS"], ["linux-amd64", "RESTIC_LINUX_AMD64"], ["linux-arm64", "RESTIC_LINUX_ARM64"], ["darwin-amd64", "RESTIC_DARWIN_AMD64"], ["darwin-arm64", "RESTIC_DARWIN_ARM64"]] as const) {
    const url = env[`${prefix}_URL`], sha256 = env[`${prefix}_SHA256`];
    if (url && sha256) out[key] = { url, sha256 };
  }
  return out;
}

const SECRET_TOOLS = new Set(["backup.run", "backup.snapshots", "backup.restore"]);

/** Fills the secret-bearing params of queued backup calls just before they are
 * handed to the authenticated agent. Restore and snapshot listing keep working
 * for a policy that has since been disabled (you still need your data back);
 * only scheduled/manual runs require it to be enabled. Anything that cannot be
 * resolved is left without secrets, which the agent rejects. */
export async function hydrateBackupParams<T extends { id?: string; tool: string; params: Record<string, unknown> }>(
  tenantId: string, deviceId: string, calls: T[],
): Promise<T[]> {
  if (!calls.some((c) => SECRET_TOOLS.has(c.tool))) return calls;
  const res = await queryTenantScoped<PolicyRow & { enabled: boolean }>(tenantId,
    `SELECT enabled, repo, secrets_enc, paths, excludes, keep_daily, keep_weekly, keep_monthly, use_vss, limit_upload_kbps, db_dumps, storage, repo_password_enc
     FROM backup_policies WHERE device_id = $1`, [deviceId]);
  const p = res.rows[0];
  const out = await Promise.all(calls.map(async (c): Promise<T | null> => {
    if (!SECRET_TOOLS.has(c.tool) || !p || (c.tool === "backup.run" && !p.enabled)) return c;
    const access: Record<string, unknown> = {};
    if (p.storage === "system" && p.repo_password_enc) {
      try { Object.assign(access, await systemAccess(tenantId, deviceId, p.repo_password_enc)); }
      catch (error) {
        // Do not hand the agent a half-filled request, and do not block the other
        // calls in this poll: fail just this one, with a message the user can read.
        const reason = "Không cấp được quyền truy cập kho lưu trữ của hệ thống: " + (error instanceof Error ? error.message : String(error));
        console.error("system storage credentials failed for device", deviceId, "-", reason);
        if (c.id) await adminPool.query(`UPDATE tool_calls SET executed_at = now(), result = 'error', error_message = $2 WHERE id = $1 AND executed_at IS NULL`, [c.id, reason.slice(0, 500)]);
        return null;
      }
    } else {
      Object.assign(access, { repo: p.repo, env: decryptEnv(p.secrets_enc) });
    }
    const downloads = resticDownloads();
    if (Object.keys(downloads).length) access.restic_downloads = downloads;
    // Legacy single pair, kept so 0.4.0 Windows agents can still self-install restic.
    if (process.env.RESTIC_WINDOWS_URL && process.env.RESTIC_WINDOWS_SHA256) {
      access.restic_url = process.env.RESTIC_WINDOWS_URL;
      access.restic_sha256 = process.env.RESTIC_WINDOWS_SHA256;
    }
    if (c.tool === "backup.run") {
      Object.assign(access, { paths: p.paths, excludes: p.excludes, keep_daily: p.keep_daily, keep_weekly: p.keep_weekly,
        keep_monthly: p.keep_monthly, use_vss: p.use_vss, limit_upload_kbps: p.limit_upload_kbps, db_dumps: p.db_dumps });
    }
    // Stored params (snapshot_id/target/include) are non-secret; credentials always win.
    return { ...c, params: { ...c.params, ...access } };
  }));
  return out.filter((c): c is Awaited<T> => c !== null) as T[];
}

/** One pass of the scheduler: queue backup.run for devices whose interval has
 * elapsed, and backup.status so the dashboard learns how a run finished.
 * Runs on the admin pool (cross-tenant) and only inserts tool_calls rows. */
export async function backupSchedulerTick(): Promise<void> {
  // Due backups: online, not revoked/paused, nothing already queued.
  const due = await adminPool.query(`
    SELECT bp.device_id, bp.tenant_id, bp.storage, d.agent_version
    FROM backup_policies bp JOIN devices d ON d.id = bp.device_id
    WHERE bp.enabled AND d.status = 'online' AND d.cert_revoked_at IS NULL AND NOT d.actions_paused
      AND d.platform IN ('windows', 'linux', 'mac')
      AND (bp.last_run_requested_at IS NULL OR bp.last_run_requested_at < now() - make_interval(hours => bp.interval_hours))
      AND NOT EXISTS (SELECT 1 FROM tool_calls t WHERE t.device_id = bp.device_id AND t.tool = 'backup.run' AND t.executed_at IS NULL)`);
  const overQuota = new Map<string, boolean>();
  for (const r of due.rows) {
    if (r.storage === "system") {
      // The system storage needs a newer agent, and counts against the plan: a
      // workspace already over its cap gets no new runs until it frees space.
      if (!agentSupportsSystemStorage(r.agent_version)) continue;
      if (!overQuota.has(r.tenant_id)) overQuota.set(r.tenant_id, !(await fileBackupAllowed(r.tenant_id)).ok);
      if (overQuota.get(r.tenant_id)) continue;
    }
    await adminPool.query(`INSERT INTO tool_calls (device_id, tool, risk, params) VALUES ($1, 'backup.run', 'medium', '{}'::jsonb)`, [r.device_id]);
    await adminPool.query(`UPDATE backup_policies SET last_run_requested_at = now() WHERE device_id = $1`, [r.device_id]);
  }

  // Status polling: every 2 minutes while a run is in flight, otherwise every 6 hours.
  await adminPool.query(`
    INSERT INTO tool_calls (device_id, tool, risk, params)
    SELECT bp.device_id, 'backup.status', 'read', '{}'::jsonb
    FROM backup_policies bp JOIN devices d ON d.id = bp.device_id
    WHERE bp.enabled AND d.status = 'online' AND d.cert_revoked_at IS NULL AND d.platform IN ('windows', 'linux', 'mac')
      AND NOT EXISTS (SELECT 1 FROM tool_calls t WHERE t.device_id = bp.device_id AND t.tool = 'backup.status' AND t.executed_at IS NULL)
      AND COALESCE((SELECT max(t.requested_at) FROM tool_calls t WHERE t.device_id = bp.device_id AND t.tool = 'backup.status'), 'epoch')
          < now() - CASE WHEN bp.last_run_requested_at > now() - interval '30 minutes'
                           OR EXISTS (SELECT 1 FROM tool_calls t WHERE t.device_id = bp.device_id AND t.tool = 'backup.restore' AND t.requested_at > now() - interval '30 minutes')
                           OR (SELECT t.result_data->>'state' = 'running' OR t.result_data->>'restore_state' = 'running' FROM tool_calls t
                               WHERE t.device_id = bp.device_id AND t.tool = 'backup.status' AND t.result = 'success'
                               ORDER BY t.executed_at DESC LIMIT 1)
                         THEN interval '2 minutes' ELSE interval '6 hours' END`);
}

/** Writes one `device.backup_alert` audit row per device per day while its
 * backup is overdue, never succeeded, or failing — the audit log is where the
 * team already looks for device events, and the dedupe keeps it from flooding. */
export async function backupAlertTick(): Promise<void> {
  const rows = withHealth((await adminPool.query(BACKUP_ROWS_SQL(false))).rows, agentSupportsBackup);
  const problems = rows.filter((x) => PROBLEM_HEALTH.has(x.health));
  for (const r of problems) {
    await adminPool.query(
      `INSERT INTO audit_log (tenant_id, actor_type, event_type, event_data, device_id)
       SELECT $1::uuid, 'system', 'device.backup_alert', $3::jsonb, $2::uuid
       WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE device_id = $2::uuid AND event_type = 'device.backup_alert' AND created_at > now() - interval '24 hours')`,
      [r.tenant_id, r.device_id, JSON.stringify({ health: r.health, hostname: r.hostname, last_success_at: r.last_success_at })]);
  }
  await emailBackupAlerts(problems as never);
}
