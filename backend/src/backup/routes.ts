import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { queryTenantScoped } from "../db/pool.js";
import { recordAudit } from "../audit/index.js";
import { mailConfigured, sendMail } from "./alerts.js";
import { BACKUP_ROWS_SQL, withHealth } from "./health.js";
import { agentSupportsSystemStorage, newRepoPassword, SYSTEM_STORAGE_MIN_AGENT_VERSION, systemStorageReady } from "./system-storage.js";
import { fileBackupAllowed, usage } from "../db-backup/usage.js";
import { BACKUP_ENV_KEYS, BACKUP_MIN_AGENT_VERSION, agentSupportsBackup, platformSupportsBackup, decryptEnv, encryptEnv } from "./index.js";

const deviceParams = z.object({ deviceId: z.string().uuid() });

const repo = z.string().max(500).refine(
  (v) => /^(rest:https?:\/\/|s3:https:\/\/|b2:)/.test(v),
  "Repository must start with rest:, s3: or b2:",
);
const absolutePath = z.string().min(3).max(500).regex(/^([A-Za-z]:[\\/]|\/)/, "Path must be absolute").refine((v) => !v.includes("\0"));
const envKey = z.enum(BACKUP_ENV_KEYS);

const dbDump = z.object({
  container: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/, "Tên container không hợp lệ"),
  user: z.string().regex(/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/).default("postgres"),
  // Empty = dump every database (pg_dumpall).
  database: z.string().regex(/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/).or(z.literal("")).default(""),
});

const policyBody = z.object({
  enabled: z.boolean(),
  // "custom": the customer's own repository and keys. "system": the operator's shared
  // storage (no repository or keys to enter; space counts against the workspace plan).
  storage: z.enum(["custom", "system"]).default("custom"),
  repo: z.string().max(500).default(""),
  // Omitted values keep what is stored; "" clears an optional key.
  env: z.record(envKey, z.string().max(500)).default({}),
  paths: z.array(absolutePath).min(1).max(20),
  excludes: z.array(z.string().min(1).max(300).refine((v) => !v.startsWith("-"))).max(50).default([]),
  interval_hours: z.number().int().min(1).max(168).default(24),
  keep_daily: z.number().int().min(0).max(365).default(7),
  keep_weekly: z.number().int().min(0).max(104).default(4),
  keep_monthly: z.number().int().min(0).max(120).default(6),
  use_vss: z.boolean().default(true),
  limit_upload_kbps: z.number().int().min(0).max(10_000_000).default(0),
  db_dumps: z.array(dbDump).max(20).default([]),
}).superRefine((v, ctx) => {
  if (v.keep_daily + v.keep_weekly + v.keep_monthly <= 0) ctx.addIssue({ code: "custom", message: "Retention must keep at least one snapshot" });
  if (v.storage === "custom" && !repo.safeParse(v.repo).success) ctx.addIssue({ code: "custom", path: ["repo"], message: "Repository must start with rest:, s3: or b2:" });
});

const SELECT_POLICY = `SELECT enabled, repo, secrets_enc, paths, excludes, interval_hours, keep_daily, keep_weekly, keep_monthly,
  use_vss, limit_upload_kbps, db_dumps, storage, last_run_requested_at, updated_at FROM backup_policies WHERE device_id = $1`;

function publicPolicy(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  const { secrets_enc, ...rest } = row;
  let configured: string[] = [];
  try { configured = Object.keys(decryptEnv(String(secrets_enc))); } catch { /* key rotated or missing */ }
  // On the system storage the repository is an internal detail the customer never needs.
  return { ...rest, repo: rest.storage === "system" ? "" : rest.repo, env_configured: configured };
}

export async function backupRoutes(app: FastifyInstance) {
  async function loadDevice(tenantId: string, deviceId: string) {
    const r = await queryTenantScoped(tenantId,
      `SELECT id, hostname, platform, agent_version, status, actions_paused, cert_revoked_at IS NOT NULL AS revoked FROM devices WHERE id = $1`, [deviceId]);
    return r.rows[0] as { id: string; hostname: string; platform: string; agent_version: string | null; status: string; actions_paused: boolean; revoked: boolean } | undefined;
  }

  // Fleet overview: policy, last success and a computed health per device.
  app.get("/backups", async (req, reply) => {
    const tenantId = req.authUser!.tenantId;
    const rows = await queryTenantScoped(tenantId, BACKUP_ROWS_SQL(true), [tenantId]);
    reply.header("Cache-Control", "no-store");
    return withHealth(rows.rows, agentSupportsBackup).map(({ tenant_id, last_state, ...r }) => r);
  });

  app.get("/devices/:deviceId/backup", async (req, reply) => {
    const { deviceId } = deviceParams.parse(req.params);
    const tenantId = req.authUser!.tenantId;
    const device = await loadDevice(tenantId, deviceId);
    if (!device) return reply.code(404).send({ error: "device not found" });
    const policy = await queryTenantScoped(tenantId, SELECT_POLICY, [deviceId]);
    const status = await queryTenantScoped(tenantId,
      `SELECT result_data, executed_at FROM tool_calls WHERE device_id = $1 AND tool = 'backup.status' AND result = 'success'
       ORDER BY executed_at DESC LIMIT 1`, [deviceId]);
    reply.header("Cache-Control", "no-store");
    return {
      supported: platformSupportsBackup(device.platform) && agentSupportsBackup(device.agent_version),
      platform: device.platform,
      min_agent_version: BACKUP_MIN_AGENT_VERSION,
      system_storage_ready: await systemStorageReady(),
      system_min_agent_version: SYSTEM_STORAGE_MIN_AGENT_VERSION,
      system_agent_ok: agentSupportsSystemStorage(device.agent_version),
      quota: await usage(tenantId).then((u) => ({ plan: u.plan, used_bytes: u.usedBytes, limit_bytes: u.limitBytes, over: u.usedBytes > u.limitBytes })),
      policy: publicPolicy(policy.rows[0]),
      status: status.rows[0]?.result_data ?? null,
      status_at: status.rows[0]?.executed_at ?? null,
    };
  });

  app.put("/devices/:deviceId/backup", async (req, reply) => {
    const { deviceId } = deviceParams.parse(req.params);
    const user = req.authUser!;
    if (user.role === "member") return reply.code(403).send({ error: "technician role required" });
    const body = policyBody.parse(req.body);
    const device = await loadDevice(user.tenantId, deviceId);
    if (!device) return reply.code(404).send({ error: "device not found" });
    if (!platformSupportsBackup(device.platform)) return reply.code(409).send({ error: "Backup hiện chỉ hỗ trợ máy Windows, macOS và Linux." });

    const existing = await queryTenantScoped(user.tenantId, SELECT_POLICY, [deviceId]);
    let secrets: string;
    let repoToStore = body.repo;
    let repoPasswordEnc: string | null = null;
    if (body.storage === "system") {
      if (!(await systemStorageReady())) return reply.code(409).send({ error: "Kho lưu trữ của hệ thống chưa được cấu hình. Hãy liên hệ quản trị viên hoặc dùng kho riêng." });
      if (!agentSupportsSystemStorage(device.agent_version)) return reply.code(409).send({ error: `Dùng kho của hệ thống cần agent ${SYSTEM_STORAGE_MIN_AGENT_VERSION} trở lên. Hãy cập nhật agent trước.` });
      repoToStore = "";
      secrets = encryptEnv({});
      // Keep the existing password when saving again: changing it would orphan earlier backups.
      const keep = await queryTenantScoped(user.tenantId, `SELECT repo_password_enc FROM backup_policies WHERE device_id = $1 AND storage = 'system'`, [deviceId]);
      repoPasswordEnc = keep.rows[0]?.repo_password_enc ?? newRepoPassword();
    } else {
      let stored: Record<string, string> = {};
      if (existing.rows[0] && existing.rows[0].storage === "custom") { try { stored = decryptEnv(existing.rows[0].secrets_enc); } catch { /* re-enter secrets */ } }
      const env = { ...stored };
      for (const [k, v] of Object.entries(body.env)) { if (v === "") delete env[k]; else env[k] = v; }
      if (!env.RESTIC_PASSWORD) return reply.code(400).send({ error: "Cần đặt mật khẩu mã hoá repository (RESTIC_PASSWORD)." });
      if (body.repo.startsWith("s3:") && !(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)) return reply.code(400).send({ error: "Repository S3 cần AWS_ACCESS_KEY_ID và AWS_SECRET_ACCESS_KEY." });
      if (body.repo.startsWith("b2:") && !(env.B2_ACCOUNT_ID && env.B2_ACCOUNT_KEY)) return reply.code(400).send({ error: "Repository B2 cần B2_ACCOUNT_ID và B2_ACCOUNT_KEY." });
      try { secrets = encryptEnv(env); } catch (e) { return reply.code(503).send({ error: e instanceof Error ? e.message : "Cannot encrypt backup credentials" }); }
    }

    await queryTenantScoped(user.tenantId, `
      INSERT INTO backup_policies (device_id, tenant_id, enabled, repo, secrets_enc, paths, excludes, interval_hours,
        keep_daily, keep_weekly, keep_monthly, use_vss, limit_upload_kbps, db_dumps, storage, repo_password_enc)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (device_id) DO UPDATE SET enabled = $3, repo = $4, secrets_enc = $5, paths = $6, excludes = $7,
        interval_hours = $8, keep_daily = $9, keep_weekly = $10, keep_monthly = $11, use_vss = $12, limit_upload_kbps = $13, db_dumps = $14,
        storage = $15, repo_password_enc = $16, updated_at = now()`,
      [deviceId, user.tenantId, body.enabled, repoToStore, secrets, JSON.stringify(body.paths), JSON.stringify(body.excludes), body.interval_hours,
       body.keep_daily, body.keep_weekly, body.keep_monthly, body.use_vss, body.limit_upload_kbps, JSON.stringify(body.db_dumps), body.storage, repoPasswordEnc]);
    // Never log credentials — only that the policy changed and what it targets.
    await recordAudit({ tenantId: user.tenantId, actorType: "user", actorId: user.id, eventType: "device.backup_policy_updated",
      eventData: { enabled: body.enabled, storage: body.storage, repo: repoToStore, paths: body.paths, interval_hours: body.interval_hours, db_dumps: body.db_dumps.map((d) => `${d.container}/${d.database || "*"}`) }, deviceId });
    const saved = await queryTenantScoped(user.tenantId, SELECT_POLICY, [deviceId]);
    return publicPolicy(saved.rows[0]);
  });

  async function queue(req: FastifyRequest, reply: FastifyReply, deviceId: string, tool: "backup.run" | "backup.status" | "backup.snapshots") {
    const user = req.authUser!;
    if (user.role === "member" || (tool === "backup.snapshots" && user.role !== "admin")) return reply.code(403).send({ error: tool === "backup.snapshots" ? "admin role required" : "technician role required" });
    const device = await loadDevice(user.tenantId, deviceId);
    if (!device || device.revoked) return reply.code(404).send({ error: "device not found" });
    if (!agentSupportsBackup(device.agent_version)) return reply.code(409).send({ error: `Cần cập nhật agent lên ${BACKUP_MIN_AGENT_VERSION} trở lên để dùng Backup.` });
    if (device.status !== "online") return reply.code(409).send({ error: "Máy đang ngoại tuyến. Hãy bật máy rồi thử lại." });
    if (tool === "backup.run") {
      if (device.actions_paused) return reply.code(409).send({ error: "Thao tác trên máy này đang bị tạm dừng." });
      const policy = await queryTenantScoped(user.tenantId, `SELECT storage FROM backup_policies WHERE device_id = $1 AND enabled`, [deviceId]);
      if (!policy.rowCount) return reply.code(409).send({ error: "Chưa bật chính sách backup cho máy này." });
      if (policy.rows[0].storage === "system") {
        if (!agentSupportsSystemStorage(device.agent_version)) return reply.code(409).send({ error: `Dùng kho của hệ thống cần agent ${SYSTEM_STORAGE_MIN_AGENT_VERSION} trở lên. Hãy cập nhật agent trước.` });
        const quota = await fileBackupAllowed(user.tenantId);
        if (!quota.ok) return reply.code(402).send({ error: quota.message });
      }
    }
    if (tool === "backup.snapshots") {
      const policy = await queryTenantScoped(user.tenantId, `SELECT 1 FROM backup_policies WHERE device_id = $1`, [deviceId]);
      if (!policy.rowCount) return reply.code(409).send({ error: "Máy này chưa có chính sách backup (cần repository để liệt kê snapshot)." });
    }
    const pending = await queryTenantScoped(user.tenantId,
      `SELECT 1 FROM tool_calls WHERE device_id = $1 AND tool = $2 AND executed_at IS NULL`, [deviceId, tool]);
    if (pending.rowCount) return reply.code(409).send({ error: "Yêu cầu trước vẫn đang chờ máy xử lý." });
    await queryTenantScoped(user.tenantId, `INSERT INTO tool_calls (device_id, tool, risk, params) VALUES ($1, $2, $3, '{}')`,
      [deviceId, tool, tool === "backup.run" ? "medium" : "read"]);
    if (tool === "backup.run") {
      await queryTenantScoped(user.tenantId, `UPDATE backup_policies SET last_run_requested_at = now() WHERE device_id = $1`, [deviceId]);
      await recordAudit({ tenantId: user.tenantId, actorType: "user", actorId: user.id, eventType: "device.backup_run_requested", deviceId });
    }
    return reply.code(202).send({ queued: tool });
  }

  app.post("/devices/:deviceId/backup/run", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) =>
    queue(req, reply, deviceParams.parse(req.params).deviceId, "backup.run"));
  app.post("/devices/:deviceId/backup/refresh", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) =>
    queue(req, reply, deviceParams.parse(req.params).deviceId, "backup.status"));

  // ---- Restore (admin only). Extracts into a new empty directory on the device. ----
  app.post("/devices/:deviceId/backup/snapshots", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) =>
    queue(req, reply, deviceParams.parse(req.params).deviceId, "backup.snapshots"));

  app.get("/devices/:deviceId/backup/snapshots", async (req, reply) => {
    const { deviceId } = deviceParams.parse(req.params);
    const user = req.authUser!;
    if (user.role !== "admin") return reply.code(403).send({ error: "admin role required" });
    const latest = await queryTenantScoped(user.tenantId,
      `SELECT result, result_data, error_message, executed_at, requested_at FROM tool_calls
       WHERE device_id = $1 AND tool = 'backup.snapshots' ORDER BY requested_at DESC LIMIT 1`, [deviceId]);
    const row = latest.rows[0];
    reply.header("Cache-Control", "no-store");
    if (!row) return { state: "none", snapshots: [] };
    if (!row.executed_at) return { state: "pending", snapshots: [] };
    if (row.result !== "success") return { state: "error", error: row.error_message ?? "Không lấy được danh sách snapshot.", snapshots: [] };
    return { state: "ready", fetched_at: row.executed_at, snapshots: row.result_data?.snapshots ?? [] };
  });

  const restoreBody = z.object({
    snapshot_id: z.string().regex(/^([0-9a-f]{8,64}|latest)$/),
    target: absolutePath,
    include: z.array(absolutePath).max(20).default([]),
    confirm: z.literal(true),
  });

  app.post("/devices/:deviceId/backup/restore", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { deviceId } = deviceParams.parse(req.params);
    const user = req.authUser!;
    if (user.role !== "admin") return reply.code(403).send({ error: "Chỉ quản trị viên được khôi phục dữ liệu." });
    const body = restoreBody.parse(req.body);
    const device = await loadDevice(user.tenantId, deviceId);
    if (!device || device.revoked) return reply.code(404).send({ error: "device not found" });
    if (!agentSupportsBackup(device.agent_version)) return reply.code(409).send({ error: `Cần cập nhật agent lên ${BACKUP_MIN_AGENT_VERSION} trở lên.` });
    if (device.status !== "online") return reply.code(409).send({ error: "Máy đang ngoại tuyến. Hãy bật máy rồi thử lại." });
    if (device.actions_paused) return reply.code(409).send({ error: "Thao tác trên máy này đang bị tạm dừng." });
    const policy = await queryTenantScoped(user.tenantId, `SELECT 1 FROM backup_policies WHERE device_id = $1`, [deviceId]);
    if (!policy.rowCount) return reply.code(409).send({ error: "Máy này chưa có chính sách backup." });
    const pending = await queryTenantScoped(user.tenantId,
      `SELECT 1 FROM tool_calls WHERE device_id = $1 AND tool = 'backup.restore' AND executed_at IS NULL`, [deviceId]);
    if (pending.rowCount) return reply.code(409).send({ error: "Yêu cầu khôi phục trước vẫn đang chờ máy xử lý." });
    await queryTenantScoped(user.tenantId,
      `INSERT INTO tool_calls (device_id, tool, risk, params) VALUES ($1, 'backup.restore', 'high', $2)`,
      [deviceId, JSON.stringify({ snapshot_id: body.snapshot_id, target: body.target, include: body.include })]);
    await recordAudit({ tenantId: user.tenantId, actorType: "user", actorId: user.id, eventType: "device.backup_restore_requested",
      eventData: { snapshot_id: body.snapshot_id, target: body.target, include: body.include }, deviceId });
    return reply.code(202).send({ queued: "backup.restore" });
  });

  // ---- Alert email settings (admin only) ----
  const alertBody = z.object({ enabled: z.boolean(), emails: z.array(z.string().email().max(254)).max(10) });

  app.get("/backup-alerts", async (req, reply) => {
    const user = req.authUser!;
    if (user.role !== "admin") return reply.code(403).send({ error: "admin role required" });
    const r = await queryTenantScoped(user.tenantId, `SELECT enabled, emails FROM backup_alert_settings WHERE tenant_id = $1`, [user.tenantId]);
    reply.header("Cache-Control", "no-store");
    return { enabled: r.rows[0]?.enabled ?? false, emails: r.rows[0]?.emails ?? [], mail_configured: mailConfigured() };
  });

  app.put("/backup-alerts", async (req, reply) => {
    const user = req.authUser!;
    if (user.role !== "admin") return reply.code(403).send({ error: "admin role required" });
    const body = alertBody.parse(req.body);
    const emails = [...new Set(body.emails.map((e) => e.trim().toLowerCase()))];
    await queryTenantScoped(user.tenantId,
      `INSERT INTO backup_alert_settings (tenant_id, enabled, emails) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET enabled = $2, emails = $3, updated_at = now()`, [user.tenantId, body.enabled, emails]);
    await recordAudit({ tenantId: user.tenantId, actorType: "user", actorId: user.id, eventType: "tenant.backup_alert_settings_updated",
      eventData: { enabled: body.enabled, recipients: emails.length } });
    return { enabled: body.enabled, emails, mail_configured: mailConfigured() };
  });

  // Sends only to the already-saved recipients, never to an address in the request.
  app.post("/backup-alerts/test", { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = req.authUser!;
    if (user.role !== "admin") return reply.code(403).send({ error: "admin role required" });
    const r = await queryTenantScoped(user.tenantId, `SELECT emails FROM backup_alert_settings WHERE tenant_id = $1`, [user.tenantId]);
    const emails: string[] = r.rows[0]?.emails ?? [];
    if (!emails.length) return reply.code(409).send({ error: "Chưa lưu email nhận cảnh báo." });
    if (!mailConfigured()) return reply.code(503).send({ error: "Email chưa được cấu hình trên server (SMTP_URL, MAIL_FROM)." });
    try {
      await sendMail(emails, `[${user.tenantName}] Email thử cảnh báo backup`, "Đây là email thử. Cảnh báo backup sẽ được gửi tới địa chỉ này.\n");
    } catch (err) {
      req.log.error({ err }, "backup alert test email failed");
      return reply.code(502).send({ error: "Gửi email thất bại. Kiểm tra cấu hình SMTP của server." });
    }
    return { sent: emails.length };
  });
}
