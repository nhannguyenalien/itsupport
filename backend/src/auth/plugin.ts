import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { adminPool, pool, runWithRequestContext, setTenantContext } from "../db/pool.js";
import { firebaseAuth } from "./firebase.js";

const PUBLIC_EXACT = new Set(["/health", "/enrollment/register", "/auth/attempt"]);

function isPublicRoute(req: FastifyRequest): boolean {
  const path = req.url.split("?")[0];
  return PUBLIC_EXACT.has(path) || (req.method === "GET" && /^\/oauth\/[^/]+\/callback$/.test(path));
}

function bearerToken(req: FastifyRequest): string | null {
  const value = req.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

function isAgentRoute(req: FastifyRequest): boolean {
  const path = req.url.split("?")[0];
  return (
    (req.method === "POST" && /^\/devices\/[^/]+\/heartbeat$/.test(path)) ||
    (req.method === "GET" && /^\/devices\/[^/]+\/remote-install$/.test(path)) ||
    (req.method === "POST" && /^\/devices\/[^/]+\/remote-register$/.test(path)) ||
    (req.method === "GET" && /^\/devices\/[^/]+\/tool-calls\/pending$/.test(path)) ||
    (req.method === "POST" && /^\/tool-calls\/[^/]+\/result$/.test(path))
  );
}

function verifiedClientCertificateSerial(req: FastifyRequest): string | null {
  const value = req.headers["x-agent-cert-serial"];
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value).toString(16);
  } catch {
    return null;
  }
}

async function ownsResource(req: FastifyRequest, tenantId: string): Promise<boolean> {
  const path = req.url.split("?")[0];
  const checks: Array<[RegExp, string]> = [
    [/^\/devices\/([^/]+)(?:\/|$)/, `SELECT 1 FROM devices WHERE id = $1 AND tenant_id = $2`],
    [/^\/tickets\/([^/]+)(?:\/|$)/, `SELECT 1 FROM tickets WHERE id = $1 AND tenant_id = $2`],
    [/^\/approvals\/([^/]+)(?:\/|$)/, `SELECT 1 FROM approvals a JOIN tickets t ON t.id = a.ticket_id WHERE a.id = $1 AND t.tenant_id = $2`],
    [/^\/computer-use-sessions\/([^/]+)(?:\/|$)/, `SELECT 1 FROM computer_use_sessions WHERE id = $1 AND tenant_id = $2`],
    [/^\/screenshots\/([^/]+)(?:\/|$)/, `SELECT 1 FROM computer_use_screenshots s JOIN computer_use_sessions c ON c.id = s.session_id WHERE s.id = $1 AND c.tenant_id = $2`],
  ];
  for (const [pattern, sql] of checks) {
    const match = path.match(pattern);
    if (match) return (await pool.query(sql, [match[1], tenantId])).rowCount === 1;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.deviceId === "string" &&
      (await pool.query(`SELECT 1 FROM devices WHERE id = $1 AND tenant_id = $2`, [body.deviceId, tenantId])).rowCount !== 1) return false;
  if (typeof body.platformConnectionId === "string" &&
      (await pool.query(`SELECT 1 FROM platform_connections WHERE id = $1 AND tenant_id = $2`, [body.platformConnectionId, tenantId])).rowCount !== 1) return false;
  return true;
}

function requiredRole(req: FastifyRequest): "admin" | "technician" | null {
  const path = req.url.split("?")[0];
  if (req.method === "PUT" && /^\/devices\/[^/]+\/remote-support$/.test(path)) return null;
  if (req.method === "GET" || path.startsWith("/auth/")) return null;
  if (/^\/tenants\/[^/]+\/(?:enable|disable)-/.test(path)) return "admin";
  if (/^\/devices\/[^/]+\/(?:revoke|pause|unpause)$/.test(path)) return "admin";
  if (path === "/enrollment-tokens" || /^\/oauth\/[^/]+\/connect$/.test(path)) return "admin";
  return "technician";
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", (_req, _reply, done) => {
    runWithRequestContext(done);
  });
  app.decorateRequest("authUser", null);
  app.decorateRequest("firebaseUid", null);
  app.decorateRequest("agentDeviceId", null);
  app.decorateRequest("agentTenantId", null);
  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (isPublicRoute(req)) return;
    if (isAgentRoute(req)) {
      const serial = verifiedClientCertificateSerial(req);
      const token = bearerToken(req);
      if (!serial && !token) return reply.code(401).send({ error: "agent authentication required" });
      const credential = serial ?? createHash("sha256").update(token!).digest("hex");
      let sql = `SELECT id, tenant_id FROM devices WHERE ${serial ? "cert_serial" : "agent_token_hash"} = $1 AND cert_revoked_at IS NULL`;
      const params: unknown[] = [credential];
      const deviceMatch = path.match(/^\/devices\/([^/]+)/);
      if (deviceMatch) { sql += ` AND id = $2`; params.push(deviceMatch[1]); }
      const callMatch = path.match(/^\/tool-calls\/([^/]+)\/result$/);
      if (callMatch) { sql += ` AND id = (SELECT device_id FROM tool_calls WHERE id = $2)`; params.push(callMatch[1]); }
      const result = await adminPool.query(sql, params);
      if (result.rowCount !== 1) return reply.code(401).send({ error: "invalid or revoked agent credential" });
      req.agentDeviceId = result.rows[0].id;
      req.agentTenantId = result.rows[0].tenant_id;
      setTenantContext(result.rows[0].tenant_id);
      return;
    }

    const rawToken = bearerToken(req);
    if (!rawToken) return reply.code(401).send({ error: "authentication required" });
    try {
      const token = await firebaseAuth.verifyIdToken(rawToken, true);
      req.firebaseUid = token.uid;
      if (path === "/auth/register") return;
      if (!token.email_verified) return reply.code(403).send({ error: "email verification required", code: "EMAIL_NOT_VERIFIED" });
      const result = await adminPool.query(
        `SELECT u.id, u.tenant_id, u.email, u.role, t.name AS tenant_name
         FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.firebase_uid = $1`,
        [token.uid],
      );
      const user = result.rows[0];
      if (!user) return reply.code(403).send({ error: "workspace registration required", code: "WORKSPACE_REQUIRED" });
      req.authUser = { id: user.id, tenantId: user.tenant_id, tenantName: user.tenant_name, email: user.email, role: user.role };
      setTenantContext(user.tenant_id);
    } catch {
      return reply.code(401).send({ error: "invalid or expired authentication token" });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
      body.actorId = req.authUser.id;
      body.createdBy = req.authUser.id;
    }
    const source = { ...(req.query as object ?? {}), ...(req.params as object ?? {}), ...(req.body as object ?? {}) } as Record<string, unknown>;
    if (typeof source.tenantId === "string" && source.tenantId !== req.authUser.tenantId) return reply.code(403).send({ error: "this resource belongs to another workspace" });
    if (!(await ownsResource(req, req.authUser.tenantId))) return reply.code(404).send({ error: "resource not found" });
    const role = requiredRole(req);
    if (role === "admin" && req.authUser.role !== "admin") return reply.code(403).send({ error: "administrator access required" });
    if (role === "technician" && req.authUser.role === "member") return reply.code(403).send({ error: "technician access required" });
  });
}
