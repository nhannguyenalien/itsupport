import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db/pool.js";
import type { AuthUser } from "./types.js";

export const SESSION_COOKIE = "support_session";
const SESSION_DAYS = 30;

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(header?: string): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(";").map((part) => {
    const [name, ...value] = part.trim().split("=");
    return [decodeURIComponent(name), decodeURIComponent(value.join("="))];
  }));
}

function cookieOptions(maxAge: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function createSession(userId: string, reply: FastifyReply): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await pool.query(
    `INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, digest(token), expiresAt],
  );
  reply.header("set-cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieOptions(SESSION_DAYS * 86_400)}`);
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) await pool.query(`DELETE FROM auth_sessions WHERE token_hash = $1`, [digest(token)]);
  reply.header("set-cookie", `${SESSION_COOKIE}=; ${cookieOptions(0)}`);
}

export async function getSessionUser(req: FastifyRequest): Promise<AuthUser | null> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const result = await pool.query(
    `SELECT u.id, u.tenant_id, u.email, u.role, t.name AS tenant_name
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     JOIN tenants t ON t.id = u.tenant_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [digest(token)],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  void pool.query(`UPDATE auth_sessions SET last_seen_at = now() WHERE token_hash = $1`, [digest(token)]);
  return { id: row.id, tenantId: row.tenant_id, email: row.email, role: row.role, tenantName: row.tenant_name };
}
