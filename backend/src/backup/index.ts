import { adminPool, queryTenantScoped } from "../db/pool.js";
import { decryptToken, encryptToken } from "../oauth/crypto.js";
import { compareVersions } from "../devices/agent-updates.js";
import { emailBackupAlerts } from "./alerts.js";
import { BACKUP_ROWS_SQL, PROBLEM_HEALTH, withHealth } from "./health.js";

// Proactive backup through restic (agent/internal/tools/backup.go). The backend
// owns the policy; the agent only receives it, per call, at delivery time.
// Repository credentials are AES-GCM encrypted at rest and never returned by
// any API — tool_calls.params for backup.run holds only an empty marker, and
// hydrateBackupParams() fills in the secrets as the agent polls for work.

export const BACKUP_MIN_AGENT_VERSION = "0.4.0";

// Must mirror backupEnvAllowlist in agent/internal/tools/backup.go.
export const BACKUP_ENV_KEYS = [
  "RESTIC_PASSWORD", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION",
  "B2_ACCOUNT_ID", "B2_ACCOUNT_KEY", "RESTIC_REST_USERNAME", "RESTIC_REST_PASSWORD",
] as const;

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
  use_vss: boolean; limit_upload_kbps: number;
}

const SECRET_TOOLS = new Set(["backup.run", "backup.snapshots", "backup.restore"]);

/** Fills the secret-bearing params of queued backup calls just before they are
 * handed to the authenticated agent. Restore and snapshot listing keep working
 * for a policy that has since been disabled (you still need your data back);
 * only scheduled/manual runs require it to be enabled. Anything that cannot be
 * resolved is left without secrets, which the agent rejects. */
export async function hydrateBackupParams<T extends { tool: string; params: Record<string, unknown> }>(
  tenantId: string, deviceId: string, calls: T[],
): Promise<T[]> {
  if (!calls.some((c) => SECRET_TOOLS.has(c.tool))) return calls;
  const res = await queryTenantScoped<PolicyRow & { enabled: boolean }>(tenantId,
    `SELECT enabled, repo, secrets_enc, paths, excludes, keep_daily, keep_weekly, keep_monthly, use_vss, limit_upload_kbps
     FROM backup_policies WHERE device_id = $1`, [deviceId]);
  const p = res.rows[0];
  return calls.map((c) => {
    if (!SECRET_TOOLS.has(c.tool) || !p || (c.tool === "backup.run" && !p.enabled)) return c;
    const access: Record<string, unknown> = { repo: p.repo, env: decryptEnv(p.secrets_enc) };
    if (process.env.RESTIC_WINDOWS_URL && process.env.RESTIC_WINDOWS_SHA256) {
      access.restic_url = process.env.RESTIC_WINDOWS_URL;
      access.restic_sha256 = process.env.RESTIC_WINDOWS_SHA256;
    }
    if (c.tool === "backup.run") {
      Object.assign(access, { paths: p.paths, excludes: p.excludes, keep_daily: p.keep_daily, keep_weekly: p.keep_weekly,
        keep_monthly: p.keep_monthly, use_vss: p.use_vss, limit_upload_kbps: p.limit_upload_kbps });
    }
    // Stored params (snapshot_id/target/include) are non-secret; credentials always win.
    return { ...c, params: { ...c.params, ...access } };
  });
}

/** One pass of the scheduler: queue backup.run for devices whose interval has
 * elapsed, and backup.status so the dashboard learns how a run finished.
 * Runs on the admin pool (cross-tenant) and only inserts tool_calls rows. */
export async function backupSchedulerTick(): Promise<void> {
  // Due backups: online, not revoked/paused, nothing already queued.
  await adminPool.query(`
    WITH due AS (
      SELECT bp.device_id FROM backup_policies bp JOIN devices d ON d.id = bp.device_id
      WHERE bp.enabled AND d.status = 'online' AND d.cert_revoked_at IS NULL AND NOT d.actions_paused
        AND d.platform = 'windows'
        AND (bp.last_run_requested_at IS NULL OR bp.last_run_requested_at < now() - make_interval(hours => bp.interval_hours))
        AND NOT EXISTS (SELECT 1 FROM tool_calls t WHERE t.device_id = bp.device_id AND t.tool = 'backup.run' AND t.executed_at IS NULL)
    ), queued AS (
      INSERT INTO tool_calls (device_id, tool, risk, params)
      SELECT device_id, 'backup.run', 'medium', '{}'::jsonb FROM due RETURNING device_id
    )
    UPDATE backup_policies SET last_run_requested_at = now() WHERE device_id IN (SELECT device_id FROM queued)`);

  // Status polling: every 2 minutes while a run is in flight, otherwise every 6 hours.
  await adminPool.query(`
    INSERT INTO tool_calls (device_id, tool, risk, params)
    SELECT bp.device_id, 'backup.status', 'read', '{}'::jsonb
    FROM backup_policies bp JOIN devices d ON d.id = bp.device_id
    WHERE bp.enabled AND d.status = 'online' AND d.cert_revoked_at IS NULL AND d.platform = 'windows'
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
