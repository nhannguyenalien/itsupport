import type { QueryResultRow } from "pg";
import { platformSupportsBackup } from "./platforms.js";

// "Is this device's backup healthy?" — one definition shared by the dashboard
// (GET /backups) and the scheduler's audit alerts, so they can never disagree.

export type BackupHealth = "disabled" | "unsupported" | "running" | "ok" | "failed" | "overdue" | "never";

export interface BackupHealthInput {
  platform: string;
  supported: boolean;            // agent new enough for backup.*
  policy_enabled: boolean | null; // null = no policy configured
  interval_hours: number | null;
  policy_updated_at: Date | string | null;
  last_success_at: Date | string | null;
  last_state: string | null;     // state reported by the latest backup.status
}

/** A backup is overdue once twice its interval (minimum 24h) passes without a
 * success — one missed run (laptop off overnight) is normal, two is not. */
export function overdueAfterHours(intervalHours: number): number {
  return Math.max(intervalHours * 2, 24);
}

export function backupHealth(row: BackupHealthInput, now: Date = new Date()): BackupHealth {
  if (row.policy_enabled === null || row.policy_enabled === false) return "disabled";
  if (!platformSupportsBackup(row.platform) || !row.supported) return "unsupported";
  const since = row.last_success_at ?? row.policy_updated_at;
  const ageHours = since ? (now.getTime() - new Date(since).getTime()) / 3_600_000 : Infinity;
  const overdue = ageHours > overdueAfterHours(row.interval_hours ?? 24);
  if (overdue) return row.last_success_at ? "overdue" : "never";
  if (row.last_state === "error") return "failed";
  if (row.last_state === "running") return "running";
  return "ok";
}

export const PROBLEM_HEALTH: ReadonlySet<BackupHealth> = new Set(["overdue", "never", "failed"]);

/** Per-device backup rows. `tenantFilter` is only used by the cross-tenant
 * scheduler path (admin pool); request handlers go through RLS instead. */
export const BACKUP_ROWS_SQL = (tenantFilter: boolean) => `
  SELECT d.id AS device_id, d.tenant_id, d.hostname, d.platform, d.agent_version, d.status AS device_status,
         bp.enabled AS policy_enabled, bp.interval_hours, bp.updated_at AS policy_updated_at, bp.last_run_requested_at,
         ok.last_success_at, s.result_data AS last_status, s.executed_at AS status_at,
         s.result_data->>'state' AS last_state
  FROM devices d
  LEFT JOIN backup_policies bp ON bp.device_id = d.id
  LEFT JOIN LATERAL (SELECT max((t.result_data->>'finished_at')::timestamptz) AS last_success_at
                     FROM tool_calls t WHERE t.device_id = d.id AND t.tool = 'backup.status' AND t.result = 'success'
                       AND t.result_data->>'state' = 'success') ok ON true
  LEFT JOIN LATERAL (SELECT result_data, executed_at FROM tool_calls t
                     WHERE t.device_id = d.id AND t.tool = 'backup.status' AND t.result = 'success'
                     ORDER BY t.executed_at DESC LIMIT 1) s ON true
  WHERE d.cert_revoked_at IS NULL ${tenantFilter ? "AND d.tenant_id = $1" : ""}
  ORDER BY d.hostname`;

export function withHealth<T extends QueryResultRow>(rows: T[], supports: (v: string | null) => boolean) {
  return rows.map((r) => ({
    ...r,
    last_success_at: r.last_success_at ?? null,
    health: backupHealth({
      platform: r.platform, supported: supports(r.agent_version), policy_enabled: r.policy_enabled,
      interval_hours: r.interval_hours, policy_updated_at: r.policy_updated_at,
      last_success_at: r.last_success_at, last_state: r.last_state,
    }),
  }));
}
