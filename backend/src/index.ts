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

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`listening on :${port} — tool registry v${registryVersion} (${registryHash.slice(0, 8)})`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
