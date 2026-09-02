import { randomBytes, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { recordAudit } from "../audit/index.js";

const TOKEN_TTL_MINUTES = 10;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const createTokenBody = z.object({
  tenantId: z.string().uuid(),
  createdBy: z.string().uuid().optional(),
});

const registerBody = z.object({
  token: z.string().min(1),
  hostname: z.string().min(1),
  publicKey: z.string().min(1),
  osVersion: z.string().optional(),
  agentVersion: z.string().optional(),
});

export async function enrollmentRoutes(app: FastifyInstance) {
  // Admin/dashboard-initiated: mint a one-time, short-lived enrollment token.
  // The raw token is returned exactly once here and never stored — only its
  // hash lives in the DB, so a DB read alone can't be used to enroll a device.
  app.post("/enrollment-tokens", async (req, reply) => {
    const body = createTokenBody.parse(req.body);
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000);

    const result = await pool.query(
      `INSERT INTO enrollment_tokens (tenant_id, token_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [body.tenantId, tokenHash, body.createdBy ?? null, expiresAt],
    );

    await recordAudit({
      tenantId: body.tenantId,
      actorType: "user",
      actorId: body.createdBy ?? null,
      eventType: "enrollment_token.created",
      eventData: { tokenId: result.rows[0].id, expiresAt },
    });

    reply.code(201).send({
      tokenId: result.rows[0].id,
      token: rawToken, // one-time exposure — caller must hand this to the agent now
      expiresAt,
    });
  });

  // Agent-initiated: exchange a valid enrollment token + locally-generated
  // public key for a device record. Real mTLS cert issuance (a proper X.509 CA
  // signing a device cert off this public key) is NOT implemented yet — this
  // returns a placeholder cert_serial so the enrollment *flow* (token
  // verification, one-time consumption, device creation) is real and testable
  // end-to-end, while PKI issuance is built out separately. Do not treat the
  // returned "cert" as a real credential yet.
  app.post("/enrollment/register", async (req, reply) => {
    const body = registerBody.parse(req.body);
    const tokenHash = hashToken(body.token);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const tokenRow = await client.query(
        `SELECT id, tenant_id, expires_at, used_at
         FROM enrollment_tokens
         WHERE token_hash = $1
         FOR UPDATE`,
        [tokenHash],
      );

      if (tokenRow.rowCount === 0) {
        await client.query("ROLLBACK");
        return reply.code(401).send({ error: "invalid enrollment token" });
      }
      const t = tokenRow.rows[0];
      if (t.used_at) {
        await client.query("ROLLBACK");
        return reply.code(401).send({ error: "enrollment token already used" });
      }
      if (new Date(t.expires_at).getTime() < Date.now()) {
        await client.query("ROLLBACK");
        return reply.code(401).send({ error: "enrollment token expired" });
      }

      const certSerial = `stub-${randomBytes(16).toString("hex")}`; // TODO: real CA issuance

      const deviceRow = await client.query(
        `INSERT INTO devices (tenant_id, hostname, os_version, agent_version, public_key, cert_serial, cert_issued_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, now(), 'online')
         RETURNING id`,
        [t.tenant_id, body.hostname, body.osVersion ?? null, body.agentVersion ?? null, body.publicKey, certSerial],
      );
      const deviceId = deviceRow.rows[0].id;

      await client.query(
        `UPDATE enrollment_tokens SET used_at = now(), used_by_device = $1 WHERE id = $2`,
        [deviceId, t.id],
      );

      await client.query("COMMIT");

      await recordAudit({
        tenantId: t.tenant_id,
        actorType: "agent",
        eventType: "device.enrolled",
        eventData: { hostname: body.hostname },
        deviceId,
      });

      reply.code(201).send({ deviceId, certSerial });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}
