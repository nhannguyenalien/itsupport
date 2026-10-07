import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { adminPool } from "../db/pool.js";
import { BACKUP_ENV_KEYS } from "../backup/env-keys.js";
import { REPO_PATTERN, directConnection, isPlatformAdmin, parsePgUrl, platformAdminEmails, scrub } from "./config.js";
import { run, tools, toolVersions, resticEnv, secretsOf } from "./runner.js";
import { access, getSettings, listRuns, liveConnection, saveSettings, snapshots, startBackup, startRestore, startVerify, summary } from "./service.js";
import { recordAudit } from "../audit/index.js";
import { isPlan, planLimitBytes, PLANS } from "./plans.js";

const settingsBody = z.object({
  enabled: z.boolean(),
  repo: z.string().max(500).regex(REPO_PATTERN, "Repository must start with rest:, s3: or b2:"),
  // Omitted keys keep the stored value; "" removes one.
  env: z.record(z.enum(BACKUP_ENV_KEYS), z.string().max(500)).default({}),
  interval_hours: z.number().int().min(1).max(168).default(24),
  keep_daily: z.number().int().min(0).max(365).default(7),
  keep_weekly: z.number().int().min(0).max(104).default(4),
  keep_monthly: z.number().int().min(0).max(120).default(6),
}).refine((v) => v.keep_daily + v.keep_weekly + v.keep_monthly > 0, "Retention must keep at least one snapshot");

const snapshotId = z.string().regex(/^([0-9a-f]{8,64}|latest)$/);
const restoreBody = z.object({
  snapshot_id: snapshotId,
  target_url: z.string().min(10).max(2000),
  // Typed on purpose: this overwrites the target database's objects.
  confirm: z.literal("KHOI PHUC"),
});

/** Only the platform operator may touch the database backup: it covers every tenant. */
function guard(req: FastifyRequest, reply: FastifyReply): boolean {
  const u = req.authUser;
  if (!u || !isPlatformAdmin(u.email, u.role)) {
    reply.code(403).send({ error: "Chỉ quản trị nền tảng được dùng tính năng này.", code: "PLATFORM_ADMIN_REQUIRED" });
    return false;
  }
  return true;
}

export async function dbBackupRoutes(app: FastifyInstance) {
  app.get("/platform/db-backup", async (req, reply) => {
    if (!guard(req, reply)) return;
    const [s, sum, versions] = await Promise.all([getSettings(), summary(), toolVersions()]);
    reply.header("Cache-Control", "no-store");
    return {
      enabled: s.enabled, repo: s.repo, interval_hours: s.intervalHours,
      keep_daily: s.retention.keepDaily, keep_weekly: s.retention.keepWeekly, keep_monthly: s.retention.keepMonthly,
      env_configured: s.envKeys,
      health: sum.health, last_success_at: sum.lastSuccessAt, next_run_at: sum.nextRunAt, running: sum.running,
      tools: versions, alert_recipients: platformAdminEmails().length,
    };
  });

  app.put("/platform/db-backup", async (req, reply) => {
    if (!guard(req, reply)) return;
    const b = settingsBody.parse(req.body);
    await saveSettings({ enabled: b.enabled, repo: b.repo, env: b.env, intervalHours: b.interval_hours,
      retention: { keepDaily: b.keep_daily, keepWeekly: b.keep_weekly, keepMonthly: b.keep_monthly } });
    // Never log credentials: only that the policy changed and where it points.
    await recordAudit({ tenantId: req.authUser!.tenantId, actorType: "user", actorId: req.authUser!.id, eventType: "platform.db_backup_updated",
      eventData: { enabled: b.enabled, repo: b.repo, interval_hours: b.interval_hours } });
    return { ok: true };
  });

  // Checks the pieces a backup needs without changing anything.
  app.post("/platform/db-backup/test", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!guard(req, reply)) return;
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    const v = await toolVersions();
    checks.push({ name: "pg_dump", ok: !!v.pgDump, detail: v.pgDump ?? "không tìm thấy trong image backend" });
    checks.push({ name: "restic", ok: !!v.restic, detail: v.restic ?? "không tìm thấy trong image backend" });
    try {
      const live = liveConnection();
      const r = await adminPool.query(`SHOW server_version`);
      const server = String(r.rows[0].server_version);
      const clientMajor = Number((v.pgDump ?? "").match(/(\d+)\./)?.[1] ?? 0);
      const serverMajor = Number(server.match(/^(\d+)/)?.[1] ?? 0);
      const direct = directConnection(live);
      checks.push({ name: "database", ok: true, detail: `${live.host}/${live.database}, PostgreSQL ${server}` + (direct.host !== live.host ? `; sao lưu sẽ dùng endpoint trực tiếp ${direct.host}` : "") });
      if (clientMajor && serverMajor) checks.push({ name: "version", ok: clientMajor >= serverMajor, detail: clientMajor >= serverMajor ? `pg_dump ${clientMajor} đọc được server ${serverMajor}` : `pg_dump ${clientMajor} cũ hơn server ${serverMajor}: cần nâng client` });
    } catch (e) { checks.push({ name: "database", ok: false, detail: e instanceof Error ? e.message : String(e) }); }
    try {
      const acc = await access();
      const out = await run(tools().restic, ["cat", "config", "--no-lock"], resticEnv(acc), 60_000);
      const missing = out.code === 10 || /does not exist|Is there a repository|unable to open config file/i.test(out.stderr);
      checks.push({ name: "repository", ok: out.code === 0 || missing, detail: out.code === 0 ? "kết nối được, repository đã có" : missing ? "kết nối được, repository sẽ được tạo ở lần chạy đầu" : scrub(out.stderr, secretsOf(acc), 300) });
    } catch (e) { checks.push({ name: "repository", ok: false, detail: e instanceof Error ? e.message : String(e) }); }
    return { ok: checks.every((c) => c.ok), checks };
  });

  app.post("/platform/db-backup/run", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = await startBackup("manual", req.authUser!.email);
    await recordAudit({ tenantId: req.authUser!.tenantId, actorType: "user", actorId: req.authUser!.id, eventType: "platform.db_backup_run_requested" });
    return reply.code(202).send({ runId: id });
  });

  app.get("/platform/db-backup/runs", async (req, reply) => {
    if (!guard(req, reply)) return;
    reply.header("Cache-Control", "no-store");
    return listRuns(30);
  });

  app.get("/platform/db-backup/snapshots", async (req, reply) => {
    if (!guard(req, reply)) return;
    try { return await snapshots(); }
    catch (e) { return reply.code(502).send({ error: e instanceof Error ? e.message : "Không đọc được danh sách bản sao." }); }
  });

  app.post("/platform/db-backup/verify", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!guard(req, reply)) return;
    const { snapshot_id } = z.object({ snapshot_id: snapshotId }).parse(req.body);
    const id = await startVerify(snapshot_id, req.authUser!.email);
    return reply.code(202).send({ runId: id });
  });

  app.post("/platform/db-backup/restore", { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!guard(req, reply)) return;
    const b = restoreBody.parse(req.body);
    try { parsePgUrl(b.target_url); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    const id = await startRestore(b.snapshot_id, b.target_url, req.authUser!.email);
    // The target URL holds a password: audit only where it points, never the URL.
    const t = parsePgUrl(b.target_url);
    await recordAudit({ tenantId: req.authUser!.tenantId, actorType: "user", actorId: req.authUser!.id, eventType: "platform.db_restore_requested",
      eventData: { snapshot_id: b.snapshot_id, target: `${t.host}/${t.database}` } });
    return reply.code(202).send({ runId: id });
  });

  // ---- Service plans (platform operator only): which workspace may back up how much ----
  app.get("/platform/tenants", async (req, reply) => {
    if (!guard(req, reply)) return;
    const r = await adminPool.query(
      `SELECT t.id, t.name, t.plan, t.created_at,
              (SELECT count(*)::int FROM tenant_db_backups b WHERE b.tenant_id = t.id) AS databases,
              (SELECT COALESCE(sum(last_size_bytes), 0)::bigint FROM tenant_db_backups b WHERE b.tenant_id = t.id) AS used_bytes
       FROM tenants t ORDER BY t.created_at`);
    reply.header("Cache-Control", "no-store");
    return r.rows.map((t) => ({ ...t, used_bytes: Number(t.used_bytes), limit_bytes: planLimitBytes(t.plan) }));
  });

  app.put("/platform/tenants/:id/plan", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { plan } = z.object({ plan: z.string().refine(isPlan, `plan must be one of ${PLANS.join(", ")}`) }).parse(req.body);
    const r = await adminPool.query(`UPDATE tenants SET plan = $2 WHERE id = $1 RETURNING name`, [id, plan]);
    if (!r.rowCount) return reply.code(404).send({ error: "workspace not found" });
    await recordAudit({ tenantId: id, actorType: "user", actorId: req.authUser!.id, eventType: "tenant.plan_changed", eventData: { plan, by: req.authUser!.email } });
    return { ok: true, plan };
  });
}
