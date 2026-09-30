import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { queryTenantScoped } from "../db/pool.js";
import { recordAudit } from "../audit/index.js";

import { meshNodeId } from "../remote-support/links.js";
import { meshTransport } from "../remote-support/client.js";
import { normalizeNodeId, verifyNode, withRemoteLock, remoteDevice, supportShares, activeShare, remoteStatus } from "../remote-support/access.js";

import { remoteInstall } from "../remote-support/install.js";

const listQuery = z.object({ tenantId: z.string().uuid() });
const deviceParams = z.object({ deviceId: z.string().uuid() });
const actorBody = z.object({ actorId: z.string().uuid().optional() });

export async function deviceRoutes(app: FastifyInstance) {
  app.get("/devices/:deviceId/remote-install", async (req, reply) => {
    const { deviceId } = deviceParams.parse(req.params);
    if (!req.agentTenantId || req.agentDeviceId !== deviceId) return reply.code(401).send({ error: "agent identity required" });
    const result = await queryTenantScoped(req.agentTenantId,
      `SELECT platform FROM devices WHERE id = $1 AND cert_revoked_at IS NULL`, [deviceId]);
    const platform = result.rows[0]?.platform;
    if (!platform) return reply.code(404).send({ error: "device unavailable" });
    if (!["mac", "windows"].includes(platform)) return reply.code(400).send({ error: "unsupported platform" });
    const config = remoteInstall(req.agentTenantId, platform);
    if (!config) return reply.code(503).send({ error: "Remote support is not configured for this workspace" });
    return reply.header("Cache-Control", "no-store").send(config);
  });
  app.post("/devices/:deviceId/remote-register", async (req, reply) => {
    const { deviceId } = deviceParams.parse(req.params);
    if (!req.agentTenantId || req.agentDeviceId !== deviceId) return reply.code(401).send({ error: "agent identity required" });
    const nodeId = normalizeNodeId(z.object({ nodeId: meshNodeId }).parse(req.body).nodeId);
    return withRemoteLock("node:" + nodeId, () => withRemoteLock(deviceId, async () => {
      const device = await remoteDevice(req.agentTenantId!, deviceId);
      if (device.cert_revoked_at) return reply.code(404).send({ error: "device unavailable" });
      // Never silently rebind an existing device while a support session may exist.
      if (device.meshcentral_device_id && normalizeNodeId(device.meshcentral_device_id) !== nodeId) return reply.code(409).send({ error: "device already linked" });
      await verifyNode(req.agentTenantId!, nodeId);
      const duplicate = await queryTenantScoped(req.agentTenantId!, 'SELECT id FROM devices WHERE meshcentral_device_id = $1 AND id <> $2', [nodeId, deviceId]);
      if (duplicate.rowCount) return reply.code(409).send({ error: "remote agent already linked" });
      await queryTenantScoped(req.agentTenantId!, 'UPDATE devices SET meshcentral_device_id = $2 WHERE id = $1 AND cert_revoked_at IS NULL', [deviceId, nodeId]);
      return { ok: true };
    }));
  });

  app.get("/devices/:deviceId/remote-support", async (req, reply) => {
    const { deviceId } = deviceParams.parse(req.params);
    reply.header("Cache-Control", "no-store");
    return remoteStatus(req.authUser!.tenantId, deviceId, req.authUser!.role !== "member");
  });

  app.put("/devices/:deviceId/remote-support", async (req, reply) => {
    const { deviceId } = deviceParams.parse(req.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const user = req.authUser!;
    return withRemoteLock(deviceId, async () => {
      const device = await remoteDevice(user.tenantId, deviceId);
      if (!device.meshcentral_device_id || device.cert_revoked_at) return reply.code(409).send({ error: "remote agent not ready" });
      const nodeId = normalizeNodeId(device.meshcentral_device_id);
      await verifyNode(user.tenantId, nodeId);
      const shares = await supportShares(nodeId, deviceId);
      if (enabled && !activeShare(shares)) {
        await meshTransport.command({ action: "createDeviceShareLink", nodeid: nodeId,
          guestname: "ITSupport:" + deviceId, p: 1 | 2, consent: 8 | 16 | 64, expire: 60 });
      } else if (!enabled) {
        for (const share of shares) await meshTransport.command({ action: "removeDeviceShare", nodeid: nodeId, publicid: share.publicid });
      }
      let status = await remoteStatus(user.tenantId, deviceId, user.role !== "member");
      for (let attempt = 0; status.enabled !== enabled && attempt < 3; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        status = await remoteStatus(user.tenantId, deviceId, user.role !== "member");
      }
      if (status.enabled !== enabled) throw Object.assign(new Error("Remote support state was not confirmed; retry"), { statusCode: 503 });
      await recordAudit({ tenantId: user.tenantId, actorType: "user", actorId: user.id,
        eventType: enabled ? "device.remote_support_enabled" : "device.remote_support_disabled", deviceId });
      reply.header("Cache-Control", "no-store");
      return status;
    });
  });

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
