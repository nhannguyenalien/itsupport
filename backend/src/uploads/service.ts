import { randomUUID } from "node:crypto";
import { adminPool, queryTenantScoped } from "../db/pool.js";
import { credentialsFor, parseS3Base } from "../backup/r2-credentials.js";
import { formatSize, planLimitBytes } from "../db-backup/plans.js";
import { getStorage } from "../db-backup/storage.js";
import { usage } from "../db-backup/usage.js";
import { presignUrl, signedRequest, type ObjectRef, type SigningKey } from "./s3-sign.js";

// Files customers upload from the browser. The bytes go straight from the browser to
// R2 through a short-lived presigned URL (our server never carries them); we keep a
// row per file so the workspace can list, download and delete them, and so they count
// toward the same plan quota as database and device backups.

export class UploadError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}

export const MAX_FILE_BYTES = 5 * 2 ** 30; // one presigned PUT is limited to 5 GiB by S3
const PUT_SECONDS = 3600, GET_SECONDS = 300, PENDING_TTL_HOURS = 24;

export const UPLOADS_PREFIX = (tenantId: string) => `uploads-${tenantId}`;

/** Keep what a person would recognise, drop path parts and control characters. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").trim().slice(0, 200);
  return cleaned || "file";
}

export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\;]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

interface Where { endpoint: string; bucket: string; keyFor: (id: string) => string; key: SigningKey }

async function where(tenantId: string): Promise<Where> {
  const storage = await getStorage();
  if (!storage) throw new UploadError("Hệ thống chưa cấu hình kho lưu trữ. Liên hệ quản trị nền tảng.", 409);
  const loc = parseS3Base(storage.base);
  const prefix = [loc.prefix, UPLOADS_PREFIX(tenantId)].filter(Boolean).join("/");
  let creds;
  try { creds = await credentialsFor({ bucket: loc.bucket, prefix }); }
  catch (e) { throw new UploadError(`Không cấp được quyền truy cập kho lưu trữ: ${(e as Error).message}`, 503); }
  return {
    endpoint: loc.endpoint, bucket: loc.bucket, keyFor: (id) => `${prefix}/${id}`,
    key: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken },
  };
}
const ref = (w: Where, id: string): ObjectRef => ({ endpoint: w.endpoint, bucket: w.bucket, key: w.keyFor(id) });

export interface FileRow { id: string; name: string; content_type: string; size_bytes: number; status: "pending" | "ready"; created_at: string }

async function pendingBytes(tenantId: string, exceptId: string | null = null): Promise<number> {
  const r = await adminPool.query(
    `SELECT COALESCE(sum(size_bytes), 0)::bigint AS n FROM tenant_files WHERE tenant_id = $1 AND status = 'pending' AND ($2::uuid IS NULL OR id <> $2)`, [tenantId, exceptId]);
  return Number(r.rows[0].n);
}

function overQuota(plan: "free" | "pro", used: number, incoming: number): string {
  const label = plan === "pro" ? "Pro" : "Free";
  const upgrade = plan === "free" ? ` Nâng cấp lên Pro để lưu tới ${formatSize(planLimitBytes("pro"))}.` : "";
  return `Vượt dung lượng gói ${label} (${formatSize(planLimitBytes(plan))}): đang dùng ${formatSize(used)}, file này ${formatSize(incoming)}.${upgrade}`;
}

export async function startUpload(user: { id: string; tenantId: string }, input: { name: string; size: number; contentType: string }) {
  if (!Number.isFinite(input.size) || input.size < 0) throw new UploadError("Kích thước file không hợp lệ.");
  if (input.size > MAX_FILE_BYTES) throw new UploadError(`Mỗi file tối đa ${formatSize(MAX_FILE_BYTES)}.`, 413);
  const w = await where(user.tenantId);
  await sweepPending(user.tenantId);
  const u = await usage(user.tenantId);
  const used = u.usedBytes + (await pendingBytes(user.tenantId));
  if (used + input.size > u.limitBytes) throw new UploadError(overQuota(u.plan, used, input.size), 402);
  const id = randomUUID(), name = cleanFileName(input.name);
  await queryTenantScoped(user.tenantId,
    `INSERT INTO tenant_files (id, tenant_id, name, content_type, size_bytes, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, user.tenantId, name, input.contentType.slice(0, 120) || "application/octet-stream", input.size, user.id]);
  const url = presignUrl("PUT", ref(w, id), w.key, { expiresSeconds: PUT_SECONDS });
  return { id, name, upload_url: url, expires_in: PUT_SECONDS };
}

async function loadFile(tenantId: string, id: string): Promise<FileRow> {
  const r = await queryTenantScoped<FileRow>(tenantId, `SELECT id, name, content_type, size_bytes::float8 AS size_bytes, status, created_at FROM tenant_files WHERE id = $1`, [id]);
  if (!r.rows[0]) throw new UploadError("Không tìm thấy file.", 404);
  return r.rows[0];
}

/** The browser says it finished; trust only what the storage reports. */
export async function completeUpload(tenantId: string, id: string): Promise<FileRow> {
  const row = await loadFile(tenantId, id);
  if (row.status === "ready") return row;
  const w = await where(tenantId);
  const head = await signedRequest("HEAD", ref(w, id), w.key);
  if (head.status === 404) throw new UploadError("Chưa thấy file trên kho lưu trữ. Hãy tải lên lại.", 409);
  if (!head.ok) throw new UploadError(`Kho lưu trữ trả lỗi ${head.status}.`, 502);
  const actual = Number(head.headers.get("content-length"));
  if (!Number.isFinite(actual)) throw new UploadError("Không đọc được kích thước file đã tải lên.", 502);
  const u = await usage(tenantId);
  const others = u.usedBytes + (await pendingBytes(tenantId, id));
  if (actual > MAX_FILE_BYTES || others + actual > u.limitBytes) {
    await signedRequest("DELETE", ref(w, id), w.key).catch(() => undefined);
    await queryTenantScoped(tenantId, `DELETE FROM tenant_files WHERE id = $1`, [id]);
    throw new UploadError(overQuota(u.plan, others, actual), 402);
  }
  await queryTenantScoped(tenantId, `UPDATE tenant_files SET status = 'ready', size_bytes = $2, completed_at = now() WHERE id = $1`, [id, actual]);
  return { ...row, size_bytes: actual, status: "ready" };
}

export async function listFiles(tenantId: string): Promise<FileRow[]> {
  await sweepPending(tenantId).catch(() => undefined);
  return (await queryTenantScoped<FileRow>(tenantId,
    `SELECT id, name, content_type, size_bytes::float8 AS size_bytes, status, created_at FROM tenant_files WHERE status = 'ready' ORDER BY created_at DESC LIMIT 500`)).rows;
}

export async function downloadUrl(tenantId: string, id: string): Promise<{ url: string; name: string }> {
  const row = await loadFile(tenantId, id);
  if (row.status !== "ready") throw new UploadError("File chưa tải lên xong.", 409);
  const w = await where(tenantId);
  return { name: row.name, url: presignUrl("GET", ref(w, id), w.key, { expiresSeconds: GET_SECONDS, query: { "response-content-disposition": contentDisposition(row.name) } }) };
}

export async function deleteFile(tenantId: string, id: string): Promise<string> {
  const row = await loadFile(tenantId, id);
  const w = await where(tenantId);
  const res = await signedRequest("DELETE", ref(w, id), w.key);
  if (!res.ok && res.status !== 404) throw new UploadError(`Kho lưu trữ không xoá được file (HTTP ${res.status}).`, 502);
  await queryTenantScoped(tenantId, `DELETE FROM tenant_files WHERE id = $1`, [id]);
  return row.name;
}

/** Uploads that were started and never completed hold quota; drop them after a day. */
export async function sweepPending(tenantId: string): Promise<void> {
  const stale = (await queryTenantScoped<{ id: string }>(tenantId,
    `SELECT id FROM tenant_files WHERE status = 'pending' AND created_at < now() - ($1 || ' hours')::interval LIMIT 50`, [String(PENDING_TTL_HOURS)])).rows;
  if (!stale.length) return;
  const w = await where(tenantId);
  for (const { id } of stale) {
    const res = await signedRequest("DELETE", ref(w, id), w.key).catch(() => null);
    if (res && (res.ok || res.status === 404)) await queryTenantScoped(tenantId, `DELETE FROM tenant_files WHERE id = $1`, [id]);
  }
}
