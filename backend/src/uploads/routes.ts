import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { recordAudit } from "../audit/index.js";
import { usage } from "../db-backup/usage.js";
import { getStorage } from "../db-backup/storage.js";
import { MAX_FILE_BYTES, UploadError, completeUpload, deleteFile, downloadUrl, listFiles, startUpload } from "./service.js";

const idParams = z.object({ id: z.string().uuid() });
const startBody = z.object({
  name: z.string().trim().min(1).max(300),
  size: z.number().int().min(0),
  content_type: z.string().trim().max(120).default("application/octet-stream"),
});

/** Anyone in the workspace can look and download; adding and removing needs a technician or admin. */
function canChange(req: FastifyRequest, reply: FastifyReply): boolean {
  const u = req.authUser;
  if (!u || u.role === "member") { reply.code(403).send({ error: "Cần quyền kỹ thuật viên hoặc quản trị viên." }); return false; }
  return true;
}

async function handle<T>(reply: FastifyReply, work: () => Promise<T>): Promise<T | undefined> {
  try { return await work(); }
  catch (error) {
    if (error instanceof UploadError) { reply.code(error.statusCode).send({ error: error.message }); return undefined; }
    throw error;
  }
}

export async function uploadRoutes(app: FastifyInstance) {
  app.get("/files", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = req.authUser!;
    const files = await handle(reply, () => listFiles(user.tenantId));
    if (!files) return;
    const u = await usage(user.tenantId);
    return { storage_ready: !!(await getStorage()), max_file_bytes: MAX_FILE_BYTES, plan: u.plan, used_bytes: u.usedBytes, limit_bytes: u.limitBytes, upload_bytes: u.uploadBytes, files };
  });

  app.post("/files/uploads", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!canChange(req, reply)) return;
    const b = startBody.parse(req.body), user = req.authUser!;
    const started = await handle(reply, () => startUpload(user, { name: b.name, size: b.size, contentType: b.content_type }));
    return started && reply.code(201).send(started);
  });

  app.post("/files/:id/complete", async (req, reply) => {
    if (!canChange(req, reply)) return;
    const { id } = idParams.parse(req.params), user = req.authUser!;
    const file = await handle(reply, () => completeUpload(user.tenantId, id));
    if (!file) return;
    await recordAudit({ tenantId: user.tenantId, actorType: "user", actorId: user.id, eventType: "tenant.file_uploaded", eventData: { name: file.name, size_bytes: file.size_bytes } });
    return file;
  });

  app.get("/files/:id/download", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    reply.header("Cache-Control", "no-store");
    return handle(reply, () => downloadUrl(req.authUser!.tenantId, id));
  });

  app.delete("/files/:id", async (req, reply) => {
    if (!canChange(req, reply)) return;
    const { id } = idParams.parse(req.params), user = req.authUser!;
    const name = await handle(reply, () => deleteFile(user.tenantId, id));
    if (name === undefined) return;
    await recordAudit({ tenantId: user.tenantId, actorType: "user", actorId: user.id, eventType: "tenant.file_deleted", eventData: { name } });
    return { ok: true };
  });
}
