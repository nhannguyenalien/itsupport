import Fastify from "fastify";
import "dotenv/config";
import { pool } from "./db/pool.js";
import { enrollmentRoutes } from "./enrollment/routes.js";
import { deviceRoutes } from "./devices/routes.js";
import { tenantRoutes } from "./tenants/routes.js";
import { ticketRoutes } from "./tickets/routes.js";
import { toolCallRoutes } from "./tool-calls/routes.js";
import { registryVersion, registryHash } from "./tool-registry/index.js";

const app = Fastify({ logger: true });

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { ok: true, registryVersion, registryHash };
});

await app.register(enrollmentRoutes);
await app.register(deviceRoutes);
await app.register(tenantRoutes);
await app.register(ticketRoutes);
await app.register(toolCallRoutes);

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
