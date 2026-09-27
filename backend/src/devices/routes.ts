import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { queryTenantScoped } from "../db/pool.js";
import { recordAudit } from "../audit/index.js";

const listQuery = z.object({ tenantId: z.string().uuid() });
const deviceParams = z.object({ deviceId: z.string().uuid() });
const actorBody = z.object({ actorId: z.string().uuid().optional() });

export async function deviceRoutes(app: FastifyInstance) {
  // Agent-facing: telemetry process calls this periodically. This is what
  // "Dashboard shows online/offline" (Definition of Done #3) is actually built
  // on — status flips to 'online' here; the offline sweep in index.ts flips
  // devices back to 'offline' after ~3 missed heartbeats.
  app.post("/devices/:deviceId/heartbeat", async (req, reply) => {
    const { deviceId } = deviceParams.parse(req.params);
    if (!req.agentTenantId) return reply.code(401).send({ error: "agent tenant context required" });
    const result = await queryTenantScoped(req.agentTenantId,
      `UPDATE devices SET last_seen_at = now(), status = 'online' WHERE id = $1 RETURNING id`,
      [deviceId],
    );
    if (result.rowCount === 0) return reply.code(404).send({ error: "device not found" });
    reply.send({ ok: true });
  });

  app.get("/devices", async (req, reply) => {
    const { tenantId } = listQuery.parse(req.query);
    const result = await queryTenantScoped(req.authUser!.tenantId,
      `SELECT id, hostname, platform, os_version, agent_version, status, last_seen_at,
              actions_paused, cert_revoked_at IS NOT NULL AS revoked
       FROM devices WHERE tenant_id = $1 ORDER BY hostname`,
      [tenantId],
    );
    reply.send(result.rows);
  });

  // Day-one control #1: Revoke Device. Kills mTLS trust — cert_revoked_at set,
  // agent's next connection attempt must be rejected at the TLS layer once real
  // cert issuance/verification lands (see enrollment/routes.ts TODO).
  app.post("/devices/:deviceId/revoke", async (req, reply) => {
    const { deviceId } = deviceParams.parse(req.params);
    const { actorId } = actorBody.parse(req.body ?? {});

    const result = await queryTenantScoped(req.authUser!.tenantId,
      `UPDATE devices SET cert_revoked_at = now() WHERE id = $1 RETURNING tenant_id`,
      [deviceId],
    );
    if (result.rowCount === 0) return reply.code(404).send({ error: "device not found" });

    await recordAudit({
      tenantId: result.rows[0].tenant_id,
      actorType: "user",
      actorId: actorId ?? null,
      eventType: "device.revoked",
      deviceId,
    });
    reply.send({ ok: true });
  });

  // Day-one control #2: Pause Device Actions. Read tools keep working (policy
  // engine ignores this flag for risk === 'read'); every write tool is rejected
  // outright regardless of tenant autonomy settings, see policy-engine/index.ts.
  app.post("/devices/:deviceId/pause", async (req, reply) => {
    const { deviceId } = deviceParams.parse(req.params);
    const { actorId } = actorBody.parse(req.body ?? {});

    const result = await queryTenantScoped(req.authUser!.tenantId,
      `UPDATE devices SET actions_paused = true WHERE id = $1 RETURNING tenant_id`,
      [deviceId],
    );
    if (result.rowCount === 0) return reply.code(404).send({ error: "device not found" });

    await recordAudit({
      tenantId: result.rows[0].tenant_id,
      actorType: "user",
      actorId: actorId ?? null,
      eventType: "device.actions_paused",
      deviceId,
    });
    reply.send({ ok: true });
  });

  app.post("/devices/:deviceId/unpause", async (req, reply) => {
    const { deviceId } = deviceParams.parse(req.params);
    const { actorId } = actorBody.parse(req.body ?? {});

    const result = await queryTenantScoped(req.authUser!.tenantId,
      `UPDATE devices SET actions_paused = false WHERE id = $1 RETURNING tenant_id`,
      [deviceId],
    );
    if (result.rowCount === 0) return reply.code(404).send({ error: "device not found" });

    await recordAudit({
      tenantId: result.rows[0].tenant_id,
      actorType: "user",
      actorId: actorId ?? null,
      eventType: "device.actions_unpaused",
      deviceId,
    });
    reply.send({ ok: true });
  });
}
