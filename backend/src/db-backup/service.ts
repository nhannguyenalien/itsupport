import { adminPool } from "../db/pool.js";
import { decryptEnv, encryptEnv } from "../backup/index.js";
import { sendMail, mailConfigured } from "../backup/alerts.js";
import {
  dbBackupHealth, directConnection, isDue, parsePgUrl, platformAdminEmails, scrub, type DbBackupHealth, type PgConnection, type Retention,
} from "./config.js";
import { listSnapshots, performBackup, restoreInto, secretsOf, verifySnapshot, type RepoAccess } from "./runner.js";

export interface Settings {
  enabled: boolean; repo: string; intervalHours: number; retention: Retention;
  envKeys: string[]; updatedAt: Date; lastAlertAt: Date | null;
}

const STALE_AFTER_MS = 4 * 3_600_000;
let active: Promise<void> | null = null; // one operation at a time in this process

export function liveConnection(): PgConnection {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL is not set");
  return parsePgUrl(url);
}

async function row() {
  await adminPool.query(`INSERT INTO platform_db_backup (id) VALUES (1) ON CONFLICT DO NOTHING`);
  return (await adminPool.query(`SELECT * FROM platform_db_backup WHERE id = 1`)).rows[0];
}

function envKeysOf(secretsEnc: string): string[] {
  if (!secretsEnc) return [];
  try { return Object.keys(decryptEnv(secretsEnc)); } catch { return []; }
}

export async function getSettings(): Promise<Settings> {
  const r = await row();
  return {
    enabled: r.enabled, repo: r.repo, intervalHours: r.interval_hours,
    retention: { keepDaily: r.keep_daily, keepWeekly: r.keep_weekly, keepMonthly: r.keep_monthly },
    envKeys: envKeysOf(r.secrets_enc), updatedAt: r.updated_at, lastAlertAt: r.last_alert_at,
  };
}

/** `base/a/b`, tolerant of a trailing slash on the base (also works for b2:bucket:path). */
export function repoJoin(base: string, ...parts: string[]): string {
  return [base.replace(/\/+$/, ""), ...parts].join("/");
}

/** The operator's shared storage: where every backup lives. The settings hold its
 * base path and credentials; each backup gets its own sub-repository below it. */
export async function getStorage(): Promise<{ base: string; env: Record<string, string> } | null> {
  const r = await row();
  if (!r.repo || !r.secrets_enc) return null;
  try { return { base: r.repo, env: decryptEnv(r.secrets_enc) }; } catch { return null; }
}

export async function access(): Promise<RepoAccess> {
  const storage = await getStorage();
  if (!storage) throw new Error("The backup repository is not configured yet");
  return { repo: repoJoin(storage.base, "platform"), env: storage.env };
}

export async function saveSettings(input: {
  enabled: boolean; repo: string; env: Record<string, string>; intervalHours: number; retention: Retention;
}): Promise<void> {
  const r = await row();
  let env: Record<string, string> = {};
  if (r.secrets_enc) { try { env = decryptEnv(r.secrets_enc); } catch { /* key rotated: re-enter */ } }
  for (const [k, v] of Object.entries(input.env)) { if (v === "") delete env[k]; else env[k] = v; }
  if (!env.RESTIC_PASSWORD) throw Object.assign(new Error("Cần đặt mật khẩu mã hoá repository (RESTIC_PASSWORD)."), { statusCode: 400 });
  if (input.repo.startsWith("s3:") && !(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)) throw Object.assign(new Error("Repository S3 cần AWS_ACCESS_KEY_ID và AWS_SECRET_ACCESS_KEY."), { statusCode: 400 });
  if (input.repo.startsWith("b2:") && !(env.B2_ACCOUNT_ID && env.B2_ACCOUNT_KEY)) throw Object.assign(new Error("Repository B2 cần B2_ACCOUNT_ID và B2_ACCOUNT_KEY."), { statusCode: 400 });
  await adminPool.query(
    `UPDATE platform_db_backup SET enabled=$1, repo=$2, secrets_enc=$3, interval_hours=$4, keep_daily=$5, keep_weekly=$6, keep_monthly=$7, updated_at=now() WHERE id=1`,
    [input.enabled, input.repo, encryptEnv(env), input.intervalHours, input.retention.keepDaily, input.retention.keepWeekly, input.retention.keepMonthly]);
}

export async function summary(): Promise<{
  health: DbBackupHealth; lastSuccessAt: Date | null; lastStartedAt: Date | null; lastBackupState: string | null; running: boolean; nextRunAt: Date | null;
}> {
  const s = await getSettings();
  const ok = await adminPool.query(`SELECT max(finished_at) AS t FROM platform_db_backup_runs WHERE kind='backup' AND state='success'`);
  const last = await adminPool.query(`SELECT started_at, state FROM platform_db_backup_runs WHERE kind='backup' ORDER BY started_at DESC LIMIT 1`);
  const running = await adminPool.query(`SELECT 1 FROM platform_db_backup_runs WHERE state='running' LIMIT 1`);
  const lastSuccessAt: Date | null = ok.rows[0]?.t ?? null;
  const lastStartedAt: Date | null = last.rows[0]?.started_at ?? null;
  const lastBackupState: string | null = last.rows[0]?.state ?? null;
  const health = dbBackupHealth({ enabled: s.enabled, intervalHours: s.intervalHours, lastSuccessAt, lastBackupState, updatedAt: s.updatedAt });
  const nextRunAt = s.enabled && s.repo ? new Date((lastSuccessAt ?? new Date()).getTime() + s.intervalHours * 3_600_000) : null;
  return { health, lastSuccessAt, lastStartedAt, lastBackupState, running: running.rowCount! > 0, nextRunAt };
}

export async function listRuns(limit = 30) {
  const r = await adminPool.query(
    `SELECT id, kind, trigger, state, started_at, finished_at, requested_by, snapshot_id, bytes_added, dump_bytes, tables_found, error, detail
     FROM platform_db_backup_runs ORDER BY started_at DESC LIMIT $1`, [limit]);
  return r.rows;
}

/** Called once at boot: a restart killed whatever was running. */
export async function failInterruptedRuns(): Promise<void> {
  await adminPool.query(`UPDATE platform_db_backup_runs SET state='error', finished_at=now(), error='interrupted (backend restarted)' WHERE state='running'`);
}

async function startRun(kind: "backup" | "verify" | "restore", trigger: "schedule" | "manual", by: string | null, detail: object = {}): Promise<string> {
  // Anything "running" for hours is a lost job; do not let it block new ones forever.
  await adminPool.query(`UPDATE platform_db_backup_runs SET state='error', finished_at=now(), error='timed out' WHERE state='running' AND started_at < now() - ($1 || ' milliseconds')::interval`, [String(STALE_AFTER_MS)]);
  const busy = await adminPool.query(`SELECT 1 FROM platform_db_backup_runs WHERE state='running' LIMIT 1`);
  if (busy.rowCount || active) throw Object.assign(new Error("Một thao tác sao lưu đang chạy. Đợi nó xong rồi thử lại."), { statusCode: 409 });
  const r = await adminPool.query(
    `INSERT INTO platform_db_backup_runs (kind, trigger, state, requested_by, detail) VALUES ($1,$2,'running',$3,$4) RETURNING id`,
    [kind, trigger, by, JSON.stringify(detail)]);
  return r.rows[0].id;
}

async function finishRun(id: string, patch: { state: "success" | "error"; snapshotId?: string; bytesAdded?: number; dumpBytes?: number; tablesFound?: number; error?: string; detail?: object }) {
  await adminPool.query(
    `UPDATE platform_db_backup_runs SET state=$2, finished_at=now(), snapshot_id=$3, bytes_added=$4, dump_bytes=$5, tables_found=$6, error=$7,
       detail = detail || $8::jsonb WHERE id=$1`,
    [id, patch.state, patch.snapshotId ?? null, patch.bytesAdded ?? null, patch.dumpBytes ?? null, patch.tablesFound ?? null, patch.error ?? null, JSON.stringify(patch.detail ?? {})]);
}

function background(id: string, work: () => Promise<Parameters<typeof finishRun>[1]>, secrets: string[]) {
  active = (async () => {
    try { await finishRun(id, await work()); }
    catch (error) { await finishRun(id, { state: "error", error: scrub(error instanceof Error ? error.message : String(error), secrets) }).catch(() => undefined); }
    finally { active = null; }
  })();
}

export async function startBackup(trigger: "schedule" | "manual", by: string | null): Promise<string> {
  const acc = await access();
  const s = await getSettings();
  const live = liveConnection();
  const id = await startRun("backup", trigger, by);
  background(id, async () => {
    const res = await performBackup(acc, directConnection(live), s.retention);
    return { state: "success", snapshotId: res.snapshotId, bytesAdded: res.bytesAdded, dumpBytes: res.dumpBytes, tablesFound: res.tablesFound, detail: { warnings: res.warnings } };
  }, secretsOf(acc, [live.env.PGPASSWORD ?? ""]));
  return id;
}

export async function startVerify(snapshotId: string, by: string): Promise<string> {
  const acc = await access();
  const id = await startRun("verify", "manual", by, { snapshotId });
  background(id, async () => ({ state: "success", snapshotId, tablesFound: await verifySnapshot(acc, snapshotId) }), secretsOf(acc));
  return id;
}

export async function startRestore(snapshotId: string, targetUrl: string, by: string): Promise<string> {
  const acc = await access();
  const live = liveConnection();
  const target = parsePgUrl(targetUrl);          // fail fast, before a run row exists
  const id = await startRun("restore", "manual", by, { snapshotId, target: `${target.host}/${target.database}` });
  background(id, async () => {
    await restoreInto(acc, snapshotId, target, live);
    return { state: "success" as const, snapshotId, detail: { target: `${target.host}/${target.database}` } };
  }, secretsOf(acc, [target.env.PGPASSWORD ?? "", targetUrl]));
  return id;
}

export async function snapshots() { return listSnapshots(await access()); }

/** One scheduler pass: run a due backup, and warn the operators (once a day)
 * when backups are overdue or failing. */
export async function tick(): Promise<void> {
  const s = await getSettings();
  const sum = await summary();
  if (!active && !sum.running && isDue({ enabled: s.enabled, repo: s.repo, intervalHours: s.intervalHours, lastSuccessAt: sum.lastSuccessAt, lastStartedAt: sum.lastStartedAt })) {
    try { await startBackup("schedule", null); } catch (error) { console.error("scheduled database backup could not start:", (error as Error).message); }
  }
  if (["overdue", "never", "failed"].includes(sum.health) && mailConfigured()
      && (!s.lastAlertAt || Date.now() - s.lastAlertAt.getTime() > 24 * 3_600_000)) {
    const to = platformAdminEmails();
    if (!to.length) return;
    const last = (await adminPool.query(`SELECT error FROM platform_db_backup_runs WHERE kind='backup' AND state='error' ORDER BY started_at DESC LIMIT 1`)).rows[0]?.error;
    try {
      await sendMail(to, "[IT Support] Sao lưu database cần chú ý",
        `Trạng thái sao lưu database: ${sum.health}.\nLần thành công cuối: ${sum.lastSuccessAt ? sum.lastSuccessAt.toISOString() : "chưa có"}.\n${last ? "Lỗi gần nhất: " + String(last).slice(0, 400) + "\n" : ""}\nMở Thêm → Sao lưu database để xem chi tiết.\n`);
      await adminPool.query(`UPDATE platform_db_backup SET last_alert_at = now() WHERE id = 1`);
    } catch (error) { console.error("database backup alert email failed:", (error as Error).message); }
  }
}
