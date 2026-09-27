import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { recordAudit } from "../audit/index.js";
import { requestToolCall } from "../tool-calls/service.js";

const tenantParams = z.object({ tenantId: z.string().uuid() });
const actorBody = z.object({ actorId: z.string().uuid().optional() });

export async function tenantRoutes(app: FastifyInstance) {
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

  // Autonomous computer-use mode (docs/v0.1-computer-use-addendum.md) —
  // separate opt-in from the AI kill switch above and from
  // autonomous_low_risk_enabled (which only ever unlocks risk:"low" IT
  // tools). Same enable/disable pair shape as tenant AI above; policy-engine
  // reads this column directly (via tool-calls/service.ts), nothing else to
  // wire up here.
  app.post("/tenants/:tenantId/enable-computer-use-autonomous", async (req, reply) => {
    const { tenantId } = tenantParams.parse(req.params);
    const { actorId } = actorBody.parse(req.body ?? {});

    const result = await pool.query(
      `UPDATE tenants SET computer_use_autonomous_enabled = true WHERE id = $1 RETURNING id`,
      [tenantId],
    );
    if (result.rowCount === 0) return reply.code(404).send({ error: "tenant not found" });

    await recordAudit({ tenantId, actorType: "user", actorId: actorId ?? null, eventType: "tenant.computer_use_autonomous_enabled" });
    reply.send({ ok: true });
  });

  app.post("/tenants/:tenantId/disable-computer-use-autonomous", async (req, reply) => {
    const { tenantId } = tenantParams.parse(req.params);
    const { actorId } = actorBody.parse(req.body ?? {});

    const result = await pool.query(
      `UPDATE tenants SET computer_use_autonomous_enabled = false WHERE id = $1 RETURNING id`,
      [tenantId],
    );
    if (result.rowCount === 0) return reply.code(404).send({ error: "tenant not found" });

    await recordAudit({ tenantId, actorType: "user", actorId: actorId ?? null, eventType: "tenant.computer_use_autonomous_disabled" });
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

  // "Send connect link to device" button (frontend/src/app/connections). Bundles
  // ticket creation + the browser.open_url tool call into one request so the
  // UI doesn't need to know about tickets at all — it just asks "open the
  // consent page for this platform on that device" and gets back whatever the
  // policy engine decided (auto_execute / requires_approval / rejected), same
  // outcomes as any other tool call, nothing special-cased at this layer.
  const sendLinkBody = z.object({
    deviceId: z.string().uuid(),
    platform: z.enum(["google_ads", "meta_ads", "ga4"]),
    externalAccountId: z.string().min(1),
    actorId: z.string().uuid().optional(),
  });
  app.post("/tenants/:tenantId/platform-connections/send-link", async (req, reply) => {
    const { tenantId } = tenantParams.parse(req.params);
    const b = sendLinkBody.parse(req.body);

    const device = await pool.query(`SELECT id FROM devices WHERE id = $1 AND tenant_id = $2`, [b.deviceId, tenantId]);
    if (device.rowCount === 0) return reply.code(404).send({ error: "device not found for this tenant" });

    const ticket = await pool.query(
      `INSERT INTO tickets (tenant_id, device_id, title) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, b.deviceId, `Connect ${b.platform} account (${b.externalAccountId})`],
    );
    const ticketId = ticket.rows[0].id;

    const result = await requestToolCall({
      ticketId,
      initiatedBy: "human",
      tool: "browser.open_url",
      params: { platform: b.platform, external_account_id: b.externalAccountId },
      actorId: b.actorId,
    });

    reply.send({ ticketId, ...result });
  });
}
