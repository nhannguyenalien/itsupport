import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { startSession, advanceSession } from "./index.js";

const ticketParams = z.object({ ticketId: z.string().uuid() });
const sessionParams = z.object({ sessionId: z.string().uuid() });
const screenshotParams = z.object({ screenshotId: z.string().uuid() });

export async function computerUseRoutes(app: FastifyInstance) {
  // Start a computer-use session for a device ticket. See docs/v0.1-computer-use-addendum.md.
  app.post("/tickets/:ticketId/computer-use/start", async (req, reply) => {
    const { ticketId } = ticketParams.parse(req.params);
    try {
      const session = await startSession(ticketId);
      reply.code(201).send(session);
    } catch (err) {
      req.log.error({ err }, "computer-use start failed");
      reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Manual trigger, same posture as POST /tickets/:id/ai-step — advances the
  // session by one step IF its current pending action has resolved, otherwise
  // returns the session unchanged (caller just polls again).
  app.post("/computer-use-sessions/:sessionId/advance", async (req, reply) => {
    const { sessionId } = sessionParams.parse(req.params);
    try {
      const session = await advanceSession(sessionId);
      reply.send(session);
    } catch (err) {
      req.log.error({ err }, "computer-use advance failed");
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Serves a captured screenshot's raw bytes — referenced by id from a
  // desktop.screenshot tool_calls row's result_data.screenshot_id.
  app.get("/screenshots/:screenshotId", async (req, reply) => {
    const { screenshotId } = screenshotParams.parse(req.params);
    const row = await pool.query(`SELECT image_data FROM computer_use_screenshots WHERE id = $1`, [screenshotId]);
    if (row.rowCount === 0) return reply.code(404).send({ error: "screenshot not found" });
    reply.type("image/png").send(row.rows[0].image_data);
  });
}
