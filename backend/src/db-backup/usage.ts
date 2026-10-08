import { adminPool } from "../db/pool.js";
import { checkQuota, isPlan, planLimitBytes, type Plan, type QuotaResult } from "./plans.js";

// One quota per workspace, shared by everything it backs up to the system storage:
// customer databases (their source size), device files on system storage (the
// source size the last successful backup scanned) and files uploaded from the web. Both are "bytes of data protected".

export async function tenantPlan(tenantId: string): Promise<Plan> {
  // plan_expires_at is set by the billing sync; a lapsed subscription falls back to Free.
  const r = await adminPool.query(`SELECT plan, plan_expires_at < now() AS expired FROM tenants WHERE id = $1`, [tenantId]);
  if (r.rows[0]?.expired) return "free";
  return isPlan(r.rows[0]?.plan) ? r.rows[0].plan : "free";
}

export async function databaseBytes(tenantId: string, excludeId: string | null = null): Promise<number> {
  const r = await adminPool.query(
    `SELECT COALESCE(sum(last_size_bytes), 0)::bigint AS n FROM tenant_db_backups WHERE tenant_id = $1 AND ($2::uuid IS NULL OR id <> $2)`, [tenantId, excludeId]);
  return Number(r.rows[0].n);
}

/** Latest successful scan size of every device that backs up to the system storage. */
export async function fileBytes(tenantId: string): Promise<number> {
  const r = await adminPool.query(
    `SELECT COALESCE(sum((s.result_data->>'bytes_total')::bigint), 0)::bigint AS n
     FROM backup_policies bp
     LEFT JOIN LATERAL (SELECT result_data FROM tool_calls t
                        WHERE t.device_id = bp.device_id AND t.tool = 'backup.status' AND t.result = 'success' AND t.result_data->>'state' = 'success'
                        ORDER BY t.executed_at DESC LIMIT 1) s ON true
     WHERE bp.tenant_id = $1 AND bp.storage = 'system'`, [tenantId]);
  return Number(r.rows[0].n);
}

/** Files customers uploaded from the web (finished uploads only). */
export async function uploadBytes(tenantId: string): Promise<number> {
  const r = await adminPool.query(`SELECT COALESCE(sum(size_bytes), 0)::bigint AS n FROM tenant_files WHERE tenant_id = $1 AND status = 'ready'`, [tenantId]);
  return Number(r.rows[0].n);
}

export interface Usage { plan: Plan; databaseBytes: number; fileBytes: number; uploadBytes: number; usedBytes: number; limitBytes: number }

export async function usage(tenantId: string): Promise<Usage> {
  const [plan, db, files, uploads] = await Promise.all([tenantPlan(tenantId), databaseBytes(tenantId), fileBytes(tenantId), uploadBytes(tenantId)]);
  return { plan, databaseBytes: db, fileBytes: files, uploadBytes: uploads, usedBytes: db + files + uploads, limitBytes: planLimitBytes(plan) };
}

/** Device files are measured after the fact, so the cap is soft: a workspace that
 * is already OVER its plan stops getting new runs; one at or under still runs. */
export async function fileBackupAllowed(tenantId: string): Promise<QuotaResult> {
  const u = await usage(tenantId);
  return checkQuota(u.plan, u.usedBytes, 0);
}
