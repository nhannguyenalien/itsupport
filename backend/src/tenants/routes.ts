import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { recordAudit } from "../audit/index.js";

const tenantParams = z.object({ tenantId: z.string().uuid() });
const actorBody = z.object({ actorId: z.string().uuid().optional() });

export async function tenantRoutes(app: FastifyInstance) {
  app.post("/tenants", async (req, reply) => {
    const body = z.object({ name: z.string().min(1) }).parse(req.body);
    const result = await pool.query(
      `INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, ai_enabled, ai_data_policy, autonomous_low_risk_enabled`,
      [body.name],
    );
    reply.code(201).send(result.rows[0]);
  });

  app.get("/tenants/:tenantId", async (req, reply) => {
    const { tenantId } = tenantParams.parse(req.params);
    const result = await pool.query(`SELECT * FROM tenants WHERE id = $1`, [tenantId]);
    if (result.rowCount === 0) return reply.code(404).send({ error: "tenant not found" });
    reply.send(result.rows[0]);
  });

  // Day-one control #3: Disable Tenant AI. Policy engine rejects every
  // AI-initiated tool call outright once this is set (see policy-engine/index.ts)
  // — human-initiated actions (technician working the dashboard directly) are
  // unaffected, this only cuts the AI's ability to act.
  app.post("/tenants/:tenantId/disable-ai", async (req, reply) => {
    const { tenantId } = tenantParams.parse(req.params);
    const { actorId } = actorBody.parse(req.body ?? {});

    const result = await pool.query(
      `UPDATE tenants SET ai_enabled = false WHERE id = $1 RETURNING id`,
      [tenantId],
    );
    if (result.rowCount === 0) return reply.code(404).send({ error: "tenant not found" });

    await recordAudit({ tenantId, actorType: "user", actorId: actorId ?? null, eventType: "tenant.ai_disabled" });
    reply.send({ ok: true });
  });

  app.post("/tenants/:tenantId/enable-ai", async (req, reply) => {
    const { tenantId } = tenantParams.parse(req.params);
    const { actorId } = actorBody.parse(req.body ?? {});

    const result = await pool.query(
      `UPDATE tenants SET ai_enabled = true WHERE id = $1 RETURNING id`,
      [tenantId],
    );
    if (result.rowCount === 0) return reply.code(404).send({ error: "tenant not found" });

    await recordAudit({ tenantId, actorType: "user", actorId: actorId ?? null, eventType: "tenant.ai_enabled" });
    reply.send({ ok: true });
  });

  // v0.2 marketing-ops. Ciphertext columns are never selected here or
  // anywhere outside oauth/routes.ts and the (not-yet-built) platform API
  // client layer — this is the one place a dashboard needs to render "which
  // accounts are connected," not "what the token is."
  app.get("/tenants/:tenantId/platform-connections", async (req, reply) => {
    const { tenantId } = tenantParams.parse(req.params);
    const result = await pool.query(
      `SELECT id, platform, external_account_id, status, scopes, connected_at, last_used_at, last_error, actions_paused
       FROM platform_connections WHERE tenant_id = $1 ORDER BY connected_at DESC`,
      [tenantId],
    );
    reply.send(result.rows);
  });
}
