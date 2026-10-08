import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminPool } from "../db/pool.js";
import { recordAudit } from "../audit/index.js";
import { tenantPlan } from "../db-backup/usage.js";
import { BillingError, billingConfigured, createProCheckout, proEntitlement, PRO_PRICE_USD } from "./bgate.js";
import { chatLimit, chatUsed, currentPeriod } from "./quota.js";

const WEBHOOK_TOLERANCE_S = 300;

/** Pulls the workspace's Pro state from BGate and stores it on the tenant. A
 * subscription managed by hand (platform operator sets plan=pro with no expiry)
 * is left alone unless BGate has actually recorded a subscription for it. */
export async function syncTenantPlan(tenantId: string): Promise<void> {
  const e = await proEntitlement(tenantId);
  if (e.active) {
    await adminPool.query(`UPDATE tenants SET plan = 'pro', plan_expires_at = $2 WHERE id = $1`, [tenantId, e.expires_at]);
  } else {
    await adminPool.query(`UPDATE tenants SET plan = 'free', plan_expires_at = NULL WHERE id = $1 AND plan_expires_at IS NOT NULL`, [tenantId]);
  }
}

export function verifySignature(secret: string, timestamp: string, raw: string, signature: string, nowS = Date.now() / 1000): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > WEBHOOK_TOLERANCE_S) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  const given = signature.replace(/^sha256=/, "");
  const a = Buffer.from(expected), b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function billingRoutes(app: FastifyInstance) {
  app.get("/billing/status", async (req) => {
    const user = req.authUser!;
    const plan = await tenantPlan(user.tenantId);
    return {
      enabled: billingConfigured(),
      plan,
      price_usd: Number(PRO_PRICE_USD),
      period: currentPeriod(),
      chats_used: await chatUsed(user.tenantId),
      chats_limit: chatLimit(plan),
      limits: { free: chatLimit("free"), pro: chatLimit("pro") },
    };
  });

  // Admins start the Pro subscription; the customer pays on the Whop checkout page.
  app.post("/billing/checkout", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = req.authUser!;
    if (user.role !== "admin") return reply.code(403).send({ error: "Chỉ quản trị viên mới nâng cấp được gói." });
    if (await tenantPlan(user.tenantId) === "pro") return reply.code(409).send({ error: "Workspace đã ở gói Pro." });
    try {
      const checkout = await createProCheckout(user.tenantId);
      await recordAudit({ tenantId: user.tenantId, actorType: "user", actorId: user.id, eventType: "billing.checkout_created", eventData: { order_id: checkout.order_id ?? null } });
      return { checkout_url: checkout.checkout_url };
    } catch (err) {
      if (err instanceof BillingError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  // Re-reads the subscription from BGate, e.g. right after returning from checkout.
  app.post("/billing/refresh", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = req.authUser!;
    try {
      await syncTenantPlan(user.tenantId);
    } catch (err) {
      if (err instanceof BillingError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
    return { plan: await tenantPlan(user.tenantId) };
  });

  // Public (see auth/plugin.ts): authenticated by the HMAC signature instead.
  // Scoped so the raw body is kept for verification without touching other routes.
  await app.register(async (hooks) => {
    hooks.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    hooks.post("/billing/webhook", async (req, reply) => {
      const secret = process.env.BGATE_WEBHOOK_SECRET;
      if (!secret) return reply.code(503).send({ error: "webhook secret not configured" });
      const raw = req.body as string;
      const h = req.headers;
      const signature = String(h["x-bgate-signature"] ?? ""), timestamp = String(h["x-bgate-timestamp"] ?? ""), eventId = String(h["x-bgate-event-id"] ?? "");
      if (!eventId || !verifySignature(secret, timestamp, raw, signature)) return reply.code(401).send({ error: "invalid signature" });

      const seen = await adminPool.query(`INSERT INTO billing_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id`, [eventId]);
      if (seen.rowCount === 0) return { ok: true, duplicate: true };

      let tenantId: string | undefined;
      try {
        const payload = JSON.parse(raw) as Record<string, unknown>;
        const data = (payload.data ?? payload) as Record<string, unknown>;
        tenantId = z.string().uuid().safeParse(data.user_id ?? payload.user_id).data;
      } catch { /* unparseable body: nothing to sync */ }
      if (!tenantId) return { ok: true, ignored: true };
      try {
        await syncTenantPlan(tenantId);
      } catch (err) {
        // Let BGate retry the delivery.
        await adminPool.query(`DELETE FROM billing_events WHERE event_id = $1`, [eventId]);
        throw err;
      }
      await recordAudit({ tenantId, actorType: "system", actorId: null, eventType: "billing.webhook_synced", eventData: { event_id: eventId } });
      return { ok: true };
    });
  });
}
