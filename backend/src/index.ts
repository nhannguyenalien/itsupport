import { backupRoutes } from "./backup/routes.js";
import { dbBackupRoutes } from "./db-backup/routes.js";
import { uploadRoutes } from "./uploads/routes.js";
import { customerDbBackupRoutes } from "./db-backup/customer-routes.js";
import { failInterruptedRuns as failInterruptedCustomerRuns, tick as customerDbBackupTick } from "./db-backup/customer-service.js";
import { failInterruptedRuns, tick as dbBackupTick } from "./db-backup/service.js";
import { backupAlertTick, backupSchedulerTick } from "./backup/index.js";
import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import "dotenv/config";
import { adminPool, pool } from "./db/pool.js";
import { enrollmentRoutes } from "./enrollment/routes.js";
import { deviceRoutes } from "./devices/routes.js";
import { tenantRoutes } from "./tenants/routes.js";
import { ticketRoutes } from "./tickets/routes.js";
import { toolCallRoutes } from "./tool-calls/routes.js";
import { aiOrchestrationRoutes } from "./ai-orchestration/routes.js";
import { computerUseRoutes } from "./computer-use/routes.js";
import { oauthRoutes } from "./oauth/routes.js";
import { metricsRoutes } from "./metrics/routes.js";
import { supportChatRoutes } from "./support-chat/routes.js";
import { registryVersion, registryHash, allTools } from "./tool-registry/index.js";
import { authRoutes } from "./auth/routes.js";
import { registerAuth } from "./auth/plugin.js";
import { ensureAuthSchema } from "./db/ensure-auth-schema.js";

const app = Fastify({ logger: true });

const allowedOrigins = (process.env.CORS_ORIGINS ?? process.env.FRONTEND_URL ?? "http://localhost:3001")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
await app.register(cors, { origin: allowedOrigins, credentials: true });
await app.register(rateLimit, { global: false });
await ensureAuthSchema();
await registerAuth(app);

// Every route validates request bodies/params with zod .parse() — without
// this, a validation failure (bad UUID, missing field, our own .refine()
// checks like "exactly one of deviceId/platformConnectionId") surfaces as an
// uncaught exception -> Fastify's default 500 handler, not a 400. Discovered
// via real testing (POST /tickets with both device and platform set), not
// theoretical.
app.setErrorHandler((err: FastifyError | ZodError, _req, reply) => {
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: "validation failed", details: err.issues });
  }
  // Fastify itself throws typed errors with a correct statusCode (e.g. empty
  // JSON body, payload too large) — respect that instead of blanket-500ing,
  // which would turn a client mistake into a misleading "internal server error".
  if (typeof err.statusCode === "number" && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ error: err.message });
  }
  app.log.error(err);
  reply.code(500).send({ error: "internal server error" });
});

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { ok: true, registryVersion, registryHash };
});

// Read-only mirror of registry.json for the frontend (e.g. populating a "which
// tool" dropdown) — keeps the tool list itself single-sourced instead of
// duplicated into frontend code.
app.get("/tool-registry", async () => ({ version: registryVersion, tools: allTools() }));

await app.register(enrollmentRoutes);
await app.register(authRoutes);
await app.register(deviceRoutes);
await app.register(tenantRoutes);
await app.register(ticketRoutes);
await app.register(toolCallRoutes);
await app.register(aiOrchestrationRoutes);
await app.register(computerUseRoutes);
await app.register(oauthRoutes);
await app.register(metricsRoutes);
await app.register(supportChatRoutes);
await app.register(backupRoutes);
await app.register(dbBackupRoutes);
await app.register(customerDbBackupRoutes);
await app.register(uploadRoutes);

// Devices go offline if the telemetry process stops heartbeating — without
// this sweep, "online" would just mean "was online at some point," making the
// dashboard's online/offline status (Definition of Done #3) meaningless.
const OFFLINE_AFTER_SECONDS = 90; // 3 missed heartbeats at the daemon's default poll cadence
setInterval(() => {
  adminPool
    .query(
      `UPDATE devices SET status = 'offline'
       WHERE status = 'online' AND last_seen_at < now() - interval '${OFFLINE_AFTER_SECONDS} seconds'`,
    )
    .catch((err) => app.log.error({ err }, "offline sweep failed"));
}, 30_000);

// Proactive backups: queue due backup.run calls and status polls (backup/index.ts).
setInterval(() => {
  backupSchedulerTick().catch((err) => app.log.error({ err }, "backup scheduler failed"));
}, 60_000);
setInterval(() => {
  backupAlertTick().catch((err) => app.log.error({ err }, "backup alert sweep failed"));
}, 30 * 60_000);

// Platform database backup (db-backup/): resume cleanly after a restart, then
// check every minute whether a backup is due or an alert is needed.
failInterruptedRuns().catch((err) => app.log.error({ err }, "could not reset interrupted database backups"));
setInterval(() => {
  dbBackupTick().catch((err) => app.log.error({ err }, "database backup scheduler failed"));
}, 60_000);

// Customer database backups (db-backup/customer-*): same rhythm as above.
failInterruptedCustomerRuns().catch((err) => app.log.error({ err }, "could not reset interrupted customer database backups"));
setInterval(() => {
  customerDbBackupTick().catch((err) => app.log.error({ err }, "customer database backup scheduler failed"));
}, 60_000);

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`listening on :${port} — tool registry v${registryVersion} (${registryHash.slice(0, 8)})`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
