import { randomBytes } from "node:crypto";
import pg from "pg";
import { adminPool, queryTenantScoped } from "../db/pool.js";
import { decryptToken, encryptToken } from "../oauth/crypto.js";
import { sendMail, mailConfigured } from "../backup/alerts.js";
import { dbBackupHealth, isDue, parsePgUrl, sameDatabase, scrub, type DbBackupHealth } from "./config.js";
import { validateCustomerUrl, type ValidatedTarget } from "./net-guard.js";
import { listSnapshots, performBackup, purgeRepository, restoreInto, secretsOf, verifySnapshot, type RepoAccess } from "./runner.js";
import { getStorage, repoJoin } from "./service.js";

// A customer pastes the URL of THEIR PostgreSQL database; the platform backs it
// up on a schedule into the operator's shared storage. Each database gets its own
// restic repository (so one key never opens another customer's data) with a
// random password the platform generates and keeps, encrypted.

export const limits = () => ({
  maxTargets: Number(process.env.CUSTOMER_DB_MAX_PER_TENANT ?? 5),
  maxBytes: Number(process.env.CUSTOMER_DB_MAX_GB ?? 20) * 2 ** 30,
  maxConcurrent: Number(process.env.CUSTOMER_DB_MAX_CONCURRENT ?? 2),
});

let running = 0; // jobs in this process

/** One flat path segment per database: works on S3/R2/B2 and on a restic REST
 * server (which only allows two directory levels), and never mixes customers. */
export const customerRepoName = (tenantId: string, id: string) => `customers-${tenantId}-${id}`;

export class UserError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}

// ---------------------------------------------------------------- connection probe

function friendlyPgError(e: unknown, secrets: string[]): string {
  const err = e as { code?: string; message?: string };
  switch (err.code) {
    case "28P01": case "28000": return "Sai tên người dùng hoặc mật khẩu của database.";
    case "3D000": return "Database này không tồn tại trên máy chủ.";
    case "ENOTFOUND": return "Không tìm thấy máy chủ database.";
    case "ECONNREFUSED": return "Máy chủ database từ chối kết nối (kiểm tra cổng và tường lửa).";
    case "ETIMEDOUT": case "ECONNRESET": return "Không kết nối được tới database (hết thời gian chờ). Kiểm tra database có cho phép kết nối từ Internet.";
    case "57P03": return "Database đang khởi động hoặc tạm dừng. Thử lại sau ít phút.";
    default: return scrub(err.message ?? "Không kết nối được tới database.", secrets, 200);
  }
}

export async function probeDatabase(v: ValidatedTarget): Promise<{ version: string; sizeBytes: number; tables: number }> {
  const { conn } = v;
  const strict = conn.env.PGSSLMODE === "verify-full" || conn.env.PGSSLMODE === "verify-ca";
  const client = new pg.Client({
    host: v.address, port: Number(conn.port), user: conn.user, password: conn.env.PGPASSWORD, database: conn.database,
    // Connect to the validated address; the name is only for SNI and certificate checks.
    ssl: { servername: conn.host, rejectUnauthorized: strict },
    connectionTimeoutMillis: 10_000, statement_timeout: 10_000, query_timeout: 10_000, application_name: "itsupport-backup-probe",
  });
  try {
    await client.connect();
    const r = await client.query(
      `SELECT current_setting('server_version') AS v, pg_database_size(current_database())::bigint AS s,
              (SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema'))::int AS t`);
    return { version: String(r.rows[0].v), sizeBytes: Number(r.rows[0].s), tables: Number(r.rows[0].t) };
  } catch (e) {
    throw new UserError(friendlyPgError(e, [conn.env.PGPASSWORD ?? ""]), 400);
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- rows

interface Row {
  id: string; tenant_id: string; name: string; source_label: string; source_enc: string; repo_password_enc: string;
  enabled: boolean; interval_hours: number; keep_daily: number; keep_weekly: number; keep_monthly: number; last_alert_at: Date | null;
}

export async function loadRow(tenantId: string, id: string): Promise<Row> {
  const r = await adminPool.query(`SELECT * FROM tenant_db_backups WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!r.rows[0]) throw new UserError("Không tìm thấy database này.", 404);
  return r.rows[0];
}

async function accessFor(row: Row): Promise<RepoAccess> {
  const storage = await getStorage();
  if (!storage) throw new UserError("Hệ thống chưa cấu hình kho lưu trữ. Hãy liên hệ quản trị viên.", 503);
  const { RESTIC_PASSWORD: _platformPassword, ...credentials } = storage.env;
  void _platformPassword;
  return { repo: repoJoin(storage.base, customerRepoName(row.tenant_id, row.id)), env: { ...credentials, RESTIC_PASSWORD: decryptToken(row.repo_password_enc) } };
}

export async function listTargets(tenantId: string) {
  const targets = (await queryTenantScoped(tenantId,
    `SELECT id, name, source_label, enabled, interval_hours, keep_daily, keep_weekly, keep_monthly, created_at, updated_at
     FROM tenant_db_backups ORDER BY created_at`)).rows;
  const out = [];
  for (const t of targets) {
    const ok = await queryTenantScoped(tenantId, `SELECT max(finished_at) AS at FROM tenant_db_backup_runs WHERE backup_id = $1 AND kind = 'backup' AND state = 'success'`, [t.id]);
    const last = await queryTenantScoped(tenantId, `SELECT state, error, started_at FROM tenant_db_backup_runs WHERE backup_id = $1 AND kind = 'backup' ORDER BY started_at DESC LIMIT 1`, [t.id]);
    const busy = await queryTenantScoped(tenantId, `SELECT 1 FROM tenant_db_backup_runs WHERE backup_id = $1 AND state = 'running' LIMIT 1`, [t.id]);
    const lastSuccessAt: Date | null = ok.rows[0]?.at ?? null;
    const health: DbBackupHealth = dbBackupHealth({ enabled: t.enabled, intervalHours: t.interval_hours, lastSuccessAt, lastBackupState: last.rows[0]?.state ?? null, updatedAt: t.created_at });
    out.push({
      ...t, health, running: busy.rowCount! > 0, last_success_at: lastSuccessAt,
      last_error: last.rows[0]?.state === "error" ? last.rows[0].error : null,
      next_run_at: t.enabled ? new Date((lastSuccessAt ?? new Date()).getTime() + t.interval_hours * 3_600_000) : null,
    });
  }
  return out;
}

export async function listRuns(tenantId: string, id: string, limit = 30) {
  await loadRow(tenantId, id);
  return (await queryTenantScoped(tenantId,
    `SELECT id, kind, trigger, state, started_at, finished_at, snapshot_id, bytes_added, dump_bytes, tables_found, error
     FROM tenant_db_backup_runs WHERE backup_id = $1 ORDER BY started_at DESC LIMIT $2`, [id, limit])).rows;
}

// ---------------------------------------------------------------- runs

async function startRun(row: Row, kind: "backup" | "verify" | "restore", trigger: "schedule" | "manual", detail: object = {}): Promise<string> {
  await adminPool.query(`UPDATE tenant_db_backup_runs SET state='error', finished_at=now(), error='timed out' WHERE backup_id=$1 AND state='running' AND started_at < now() - interval '4 hours'`, [row.id]);
  const busy = await adminPool.query(`SELECT 1 FROM tenant_db_backup_runs WHERE backup_id=$1 AND state='running' LIMIT 1`, [row.id]);
  if (busy.rowCount) throw new UserError("Database này đang có một thao tác chạy. Đợi nó xong rồi thử lại.", 409);
  if (running >= limits().maxConcurrent) throw new UserError("Hệ thống đang bận sao lưu nhiều database. Thử lại sau ít phút.", 429);
  const r = await adminPool.query(
    `INSERT INTO tenant_db_backup_runs (backup_id, tenant_id, kind, trigger, state, detail) VALUES ($1,$2,$3,$4,'running',$5) RETURNING id`,
    [row.id, row.tenant_id, kind, trigger, JSON.stringify(detail)]);
  running++;
  return r.rows[0].id;
}

interface Patch { state: "success" | "error"; snapshotId?: string; bytesAdded?: number; dumpBytes?: number; tablesFound?: number; error?: string; detail?: object }

async function finishRun(id: string, p: Patch) {
  await adminPool.query(
    `UPDATE tenant_db_backup_runs SET state=$2, finished_at=now(), snapshot_id=$3, bytes_added=$4, dump_bytes=$5, tables_found=$6, error=$7, detail = detail || $8::jsonb WHERE id=$1`,
    [id, p.state, p.snapshotId ?? null, p.bytesAdded ?? null, p.dumpBytes ?? null, p.tablesFound ?? null, p.error ?? null, JSON.stringify(p.detail ?? {})]);
}

function background(runId: string, work: () => Promise<Patch>, secrets: string[]): void {
  void (async () => {
    try { await finishRun(runId, await work()); }
    catch (error) { await finishRun(runId, { state: "error", error: scrub(error instanceof Error ? error.message : String(error), secrets) }).catch(() => undefined); }
    finally { running = Math.max(0, running - 1); }
  })();
}

export async function startBackup(row: Row, trigger: "schedule" | "manual"): Promise<string> {
  const acc = await accessFor(row);
  const url = decryptToken(row.source_enc);
  const id = await startRun(row, "backup", trigger);
  background(id, async () => {
    // Re-validate on every run: the address behind a name can change, and the cap can be exceeded later.
    const target = await validateCustomerUrl(url, { direct: true });
    const info = await probeDatabase(target);
    if (info.sizeBytes > limits().maxBytes) throw new Error(`Database ${(info.sizeBytes / 2 ** 30).toFixed(1)} GB vượt giới hạn ${(limits().maxBytes / 2 ** 30).toFixed(0)} GB.`);
    const res = await performBackup(acc, target.conn, { keepDaily: row.keep_daily, keepWeekly: row.keep_weekly, keepMonthly: row.keep_monthly });
    return { state: "success", snapshotId: res.snapshotId, bytesAdded: res.bytesAdded, dumpBytes: res.dumpBytes, tablesFound: res.tablesFound, detail: { warnings: res.warnings } };
  }, [...secretsOf(acc), url, parsePgUrl(url).env.PGPASSWORD ?? ""]);
  return id;
}

export async function startVerify(row: Row, snapshotId: string): Promise<string> {
  const acc = await accessFor(row);
  const id = await startRun(row, "verify", "manual", { snapshotId });
  background(id, async () => ({ state: "success", snapshotId, tablesFound: await verifySnapshot(acc, snapshotId) }), secretsOf(acc));
  return id;
}

export async function startRestore(row: Row, snapshotId: string, targetUrl: string): Promise<string> {
  const acc = await accessFor(row);
  const sourceUrl = decryptToken(row.source_enc);
  const target = await validateCustomerUrl(targetUrl);
  const source = parsePgUrl(sourceUrl);
  if (sameDatabase(target.conn, source)) throw new UserError("Không thể khôi phục đè lên chính database nguồn. Hãy chọn một database khác (ví dụ một nhánh Neon mới).", 400);
  const label = `${target.conn.host}/${target.conn.database}`;
  const id = await startRun(row, "restore", "manual", { snapshotId, target: label });
  background(id, async () => { await restoreInto(acc, snapshotId, target.conn, source); return { state: "success", snapshotId, detail: { target: label } }; },
    [...secretsOf(acc, [target.conn.env.PGPASSWORD ?? "", targetUrl])]);
  return id;
}

export async function snapshotsOf(row: Row) { return listSnapshots(await accessFor(row)); }

// ---------------------------------------------------------------- create / update / delete

export async function createTarget(user: { tenantId: string; id: string }, input: { name: string; url: string }) {
  if (!(await getStorage())) throw new UserError("Hệ thống chưa cấu hình kho lưu trữ. Hãy liên hệ quản trị viên.", 503);
  const count = Number((await queryTenantScoped(user.tenantId, `SELECT count(*)::int AS n FROM tenant_db_backups`)).rows[0].n);
  if (count >= limits().maxTargets) throw new UserError(`Mỗi khách hàng tối đa ${limits().maxTargets} database.`, 409);

  const target = await validateCustomerUrl(input.url);
  const label = `${target.conn.host}/${target.conn.database}`;
  const dup = await queryTenantScoped(user.tenantId, `SELECT 1 FROM tenant_db_backups WHERE source_label = $1`, [label]);
  if (dup.rowCount) throw new UserError("Database này đã được thêm.", 409);
  const info = await probeDatabase(target);
  if (info.sizeBytes > limits().maxBytes) throw new UserError(`Database ${(info.sizeBytes / 2 ** 30).toFixed(1)} GB vượt giới hạn ${(limits().maxBytes / 2 ** 30).toFixed(0)} GB.`, 413);

  const r = await queryTenantScoped(user.tenantId,
    `INSERT INTO tenant_db_backups (tenant_id, name, source_label, source_enc, repo_password_enc, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [user.tenantId, input.name.trim(), label, encryptToken(input.url), encryptToken(randomBytes(32).toString("base64url")), user.id]);
  const id: string = r.rows[0].id;
  // First backup right away, so the customer sees it work (and a bad grant fails now, not tomorrow night).
  try { await startBackup(await loadRow(user.tenantId, id), "manual"); } catch (error) { console.error("first customer backup could not start:", (error as Error).message); }
  return { id, label, serverVersion: info.version, sizeBytes: info.sizeBytes, tables: info.tables };
}

export async function updateTarget(tenantId: string, id: string, patch: { enabled?: boolean; interval_hours?: number }) {
  await loadRow(tenantId, id);
  await queryTenantScoped(tenantId,
    `UPDATE tenant_db_backups SET enabled = COALESCE($2, enabled), interval_hours = COALESCE($3, interval_hours), updated_at = now() WHERE id = $1`,
    [id, patch.enabled ?? null, patch.interval_hours ?? null]);
}

/** Deletes the target and removes its stored backups. Irreversible. */
export async function deleteTarget(tenantId: string, id: string): Promise<{ removedSnapshots: number }> {
  const row = await loadRow(tenantId, id);
  const busy = await adminPool.query(`SELECT 1 FROM tenant_db_backup_runs WHERE backup_id=$1 AND state='running' LIMIT 1`, [id]);
  if (busy.rowCount) throw new UserError("Đang có một thao tác chạy. Đợi nó xong rồi xoá.", 409);
  let removed = 0;
  try { removed = await purgeRepository(await accessFor(row)); }
  catch (error) { throw new UserError("Không xoá được các bản sao đã lưu: " + (error instanceof Error ? error.message : String(error)) + " Database chưa bị xoá khỏi danh sách.", 502); }
  await adminPool.query(`DELETE FROM tenant_db_backups WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return { removedSnapshots: removed };
}

// ---------------------------------------------------------------- scheduler

export async function failInterruptedRuns(): Promise<void> {
  await adminPool.query(`UPDATE tenant_db_backup_runs SET state='error', finished_at=now(), error='interrupted (backend restarted)' WHERE state='running'`);
}

/** One scheduler pass: start due backups (a few at a time) and warn each
 * customer's admins, once a day, about databases that are overdue or failing. */
export async function tick(): Promise<void> {
  const due = await adminPool.query(`
    SELECT b.*,
      (SELECT max(finished_at) FROM tenant_db_backup_runs r WHERE r.backup_id = b.id AND r.kind='backup' AND r.state='success') AS last_success,
      (SELECT max(started_at)  FROM tenant_db_backup_runs r WHERE r.backup_id = b.id AND r.kind='backup') AS last_started,
      (SELECT state FROM tenant_db_backup_runs r WHERE r.backup_id = b.id AND r.kind='backup' ORDER BY started_at DESC LIMIT 1) AS last_state,
      EXISTS (SELECT 1 FROM tenant_db_backup_runs r WHERE r.backup_id = b.id AND r.state='running') AS busy
    FROM tenant_db_backups b WHERE b.enabled`);
  for (const b of due.rows) {
    if (!b.busy && running < limits().maxConcurrent &&
        isDue({ enabled: true, repo: "x", intervalHours: b.interval_hours, lastSuccessAt: b.last_success, lastStartedAt: b.last_started })) {
      try { await startBackup(b, "schedule"); } catch (error) { console.error("scheduled customer backup could not start:", (error as Error).message); }
    }
    const health = dbBackupHealth({ enabled: true, intervalHours: b.interval_hours, lastSuccessAt: b.last_success, lastBackupState: b.last_state, updatedAt: b.created_at });
    if (["overdue", "never", "failed"].includes(health) && mailConfigured() && (!b.last_alert_at || Date.now() - new Date(b.last_alert_at).getTime() > 24 * 3_600_000)) {
      const to = (await adminPool.query(`SELECT email FROM users WHERE tenant_id = $1 AND role = 'admin'`, [b.tenant_id])).rows.map((u) => u.email);
      if (!to.length) continue;
      try {
        await sendMail(to, `[IT Support] Sao lưu database "${b.name}" cần chú ý`,
          `Database "${b.name}" (${b.source_label}) đang ở trạng thái: ${health}.\nLần sao lưu thành công cuối: ${b.last_success ? new Date(b.last_success).toISOString() : "chưa có"}.\n\nMở Thêm → Sao lưu database để xem chi tiết. Nguyên nhân thường gặp: mật khẩu database đã đổi, hoặc database không còn cho phép kết nối từ Internet.\n`);
        await adminPool.query(`UPDATE tenant_db_backups SET last_alert_at = now() WHERE id = $1`, [b.id]);
      } catch (error) { console.error("customer database backup alert failed:", (error as Error).message); }
    }
  }
}
