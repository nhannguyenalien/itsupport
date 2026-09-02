import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import "dotenv/config";
import { pool } from "./db/pool.js";
import { enrollmentRoutes } from "./enrollment/routes.js";
import { deviceRoutes } from "./devices/routes.js";
import { tenantRoutes } from "./tenants/routes.js";
import { ticketRoutes } from "./tickets/routes.js";
import { toolCallRoutes } from "./tool-calls/routes.js";
import { aiOrchestrationRoutes } from "./ai-orchestration/routes.js";
import { oauthRoutes } from "./oauth/routes.js";
import { registryVersion, registryHash, allTools } from "./tool-registry/index.js";

const app = Fastify({ logger: true });

// No auth layer yet (see README gaps) so this is deliberately permissive for
// v0.1 local dev — allow any origin rather than hardcoding the frontend's dev
// port. Revisit once there's a real session/auth story to scope this to.
await app.register(cors, { origin: true });

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
await app.register(deviceRoutes);
await app.register(tenantRoutes);
await app.register(ticketRoutes);
await app.register(toolCallRoutes);
await app.register(aiOrchestrationRoutes);
await app.register(oauthRoutes);

// Devices go offline if the telemetry process stops heartbeating — without
// this sweep, "online" would just mean "was online at some point," making the
// dashboard's online/offline status (Definition of Done #3) meaningless.
const OFFLINE_AFTER_SECONDS = 90; // 3 missed heartbeats at the daemon's default poll cadence
setInterval(() => {
  pool
    .query(
      `UPDATE devices SET status = 'offline'
       WHERE status = 'online' AND last_seen_at < now() - interval '${OFFLINE_AFTER_SECONDS} seconds'`,
    )
    .catch((err) => app.log.error({ err }, "offline sweep failed"));
}, 30_000);

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`listening on :${port} — tool registry v${registryVersion} (${registryHash.slice(0, 8)})`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
