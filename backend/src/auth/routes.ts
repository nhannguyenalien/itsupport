import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminPool as pool } from "../db/pool.js";

const registerBody = z.object({ companyName: z.string().trim().min(2).max(100) });
const attemptBody = z.object({ action: z.enum(["login", "register", "password-reset"]) });

export async function authRoutes(app: FastifyInstance) {
  // Firebase applies its own account-level abuse controls. This edge check
  // additionally limits this deployment by source IP before the browser calls
  // Firebase, reducing password spraying and reset-email abuse.
  app.post("/auth/attempt", {
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
  }, async (req, reply) => {
    attemptBody.parse(req.body);
    return reply.code(204).send();
  });

  app.post("/auth/register", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
  }, async (req, reply) => {
    const body = registerBody.parse(req.body);
    if (!req.firebaseUid) return reply.code(401).send({ error: "valid Firebase token required" });

    const token = await import("./firebase.js").then(({ firebaseAuth }) => firebaseAuth.verifyIdToken(
      req.headers.authorization!.slice(7), true,
    ));
    const normalizedEmail = token.email?.trim().toLowerCase();
    if (!normalizedEmail) return reply.code(400).send({ error: "Firebase account has no email" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize registration for one email to avoid duplicate workspaces on retries.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [normalizedEmail]);
      const existing = await client.query(
        `SELECT u.id, u.tenant_id, u.email, u.role, u.firebase_uid, t.name AS tenant_name
         FROM users u JOIN tenants t ON t.id = u.tenant_id
         WHERE u.firebase_uid = $1 OR lower(u.email) = $2
         ORDER BY (u.firebase_uid = $1) DESC NULLS LAST FOR UPDATE OF u`,
        [token.uid, normalizedEmail],
      );
      if (existing.rows[0]) {
        const match = existing.rows[0];
        if (match.firebase_uid && match.firebase_uid !== token.uid) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "email is linked to another account", code: "ACCOUNT_CONFLICT" });
        }
        if (!match.firebase_uid && !token.email_verified) {
          await client.query("ROLLBACK");
          return reply.code(403).send({ error: "verify email before linking an existing workspace", code: "EMAIL_NOT_VERIFIED" });
        }
        if (!match.firebase_uid) {
          await client.query(`UPDATE users SET firebase_uid = $1 WHERE id = $2`, [token.uid, existing.rows[0].id]);
        }
        await client.query("COMMIT");
        const user = existing.rows[0];
        return reply.send({ user: { id: user.id, tenantId: user.tenant_id, tenantName: user.tenant_name, email: user.email, role: user.role } });
      }

      const tenant = await client.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id, name`, [body.companyName]);
      const user = await client.query(
        `INSERT INTO users (tenant_id, email, firebase_uid, role) VALUES ($1, $2, $3, 'admin') RETURNING id, email, role`,
        [tenant.rows[0].id, normalizedEmail, token.uid],
      );
      await client.query("COMMIT");
      return reply.code(201).send({
        user: { ...user.rows[0], tenantId: tenant.rows[0].id, tenantName: tenant.rows[0].name },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") return reply.code(409).send({ error: "email already registered" });
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/auth/me", async (req, reply) => {
    if (!req.authUser) return reply.code(401).send({ error: "authentication required" });
    reply.send({ user: req.authUser });
  });
}
