import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { recordAudit } from "../audit/index.js";
import { getStorage } from "./service.js";
import {
  UserError, createTarget, deleteTarget, limits, listRuns, listTargets, loadRow, snapshotsOf, startBackup, startRestore, startVerify, updateTarget,
} from "./customer-service.js";

const idParams = z.object({ id: z.string().uuid() });
const snapshotId = z.string().regex(/^([0-9a-f]{8,64}|latest)$/);

const createBody = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().min(10).max(2000),
});
const updateBody = z.object({ enabled: z.boolean().optional(), interval_hours: z.union([z.literal(6), z.literal(12), z.literal(24), z.literal(48), z.literal(168)]).optional() });
const restoreBody = z.object({ snapshot_id: snapshotId, target_url: z.string().trim().min(10).max(2000), confirm: z.literal("KHOI PHUC") });
const deleteBody = z.object({ confirm: z.literal("XOA") });

/** Members only read their own workspace; managing backups needs a technician or admin. */
function allowed(req: FastifyRequest, reply: FastifyReply): boolean {
  const u = req.authUser;
  if (!u || u.role === "member") { reply.code(403).send({ error: "Cần quyền kỹ thuật viên hoặc quản trị viên." }); return false; }
  return true;
}

async function handle<T>(reply: FastifyReply, work: () => Promise<T>): Promise<T | undefined> {
  try { return await work(); }
  catch (error) {
    if (error instanceof UserError) { reply.code(error.statusCode).send({ error: error.message }); return undefined; }
    throw error;
  }
}

export async function customerDbBackupRoutes(app: FastifyInstance) {
  app.get("/db-backups", async (req, reply) => {
    if (!allowed(req, reply)) return;
    reply.header("Cache-Control", "no-store");
    const l = limits();
    return { storage_ready: !!(await getStorage()), limits: { max_targets: l.maxTargets, max_gb: Math.round(l.maxBytes / 2 ** 30) }, targets: await listTargets(req.authUser!.tenantId) };
  });

  app.post("/db-backups", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!allowed(req, reply)) return;
    const b = createBody.parse(req.body);
    const user = req.authUser!;
    const created = await handle(reply, () => createTarget(user, b));
    if (!created) return;
    // The URL holds the customer's password: audit only where it points.
    await recordAudit({ tenantId: user.tenantId, actorType: "user", actorId: user.id, eventType: "tenant.db_backup_added", eventData: { name: b.name, target: created.label } });
    return reply.code(201).send(created);
  });

  app.patch("/db-backups/:id", async (req, reply) => {
    if (!allowed(req, reply)) return;
    const { id } = idParams.parse(req.params);
    const patch = updateBody.parse(req.body);
    if (!(await handle(reply, async () => { await updateTarget(req.authUser!.tenantId, id, patch); return true; }))) return;
    return { ok: true };
  });

  app.post("/db-backups/:id/run", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!allowed(req, reply)) return;
    const { id } = idParams.parse(req.params);
    const runId = await handle(reply, async () => startBackup(await loadRow(req.authUser!.tenantId, id), "manual"));
    if (!runId) return;
    return reply.code(202).send({ runId });
  });

  app.get("/db-backups/:id/runs", async (req, reply) => {
    if (!allowed(req, reply)) return;
    const { id } = idParams.parse(req.params);
    reply.header("Cache-Control", "no-store");
    return handle(reply, () => listRuns(req.authUser!.tenantId, id));
  });

  app.get("/db-backups/:id/snapshots", async (req, reply) => {
    if (!allowed(req, reply)) return;
    const { id } = idParams.parse(req.params);
    return handle(reply, async () => snapshotsOf(await loadRow(req.authUser!.tenantId, id)));
  });

  app.post("/db-backups/:id/verify", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!allowed(req, reply)) return;
    const { id } = idParams.parse(req.params);
    const b = z.object({ snapshot_id: snapshotId }).parse(req.body);
    const runId = await handle(reply, async () => startVerify(await loadRow(req.authUser!.tenantId, id), b.snapshot_id));
    if (!runId) return;
    return reply.code(202).send({ runId });
  });

  app.post("/db-backups/:id/restore", { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!allowed(req, reply)) return;
    const { id } = idParams.parse(req.params);
    const b = restoreBody.parse(req.body);
    const user = req.authUser!;
    const runId = await handle(reply, async () => startRestore(await loadRow(user.tenantId, id), b.snapshot_id, b.target_url));
    if (!runId) return;
    await recordAudit({ tenantId: user.tenantId, actorType: "user", actorId: user.id, eventType: "tenant.db_restore_requested", eventData: { backup_id: id, snapshot_id: b.snapshot_id } });
    return reply.code(202).send({ runId });
  });

  app.post("/db-backups/:id/delete", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!allowed(req, reply)) return;
    const { id } = idParams.parse(req.params);
    deleteBody.parse(req.body);
    const user = req.authUser!;
    const result = await handle(reply, () => deleteTarget(user.tenantId, id));
    if (!result) return;
    await recordAudit({ tenantId: user.tenantId, actorType: "user", actorId: user.id, eventType: "tenant.db_backup_deleted", eventData: { backup_id: id, removed_snapshots: result.removedSnapshots } });
    return result;
  });
}
