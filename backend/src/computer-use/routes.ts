import { withExecutionLock } from "../db/execution-lock.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { startSession, advanceSession, stopSession } from "./index.js";

const ticketParams = z.object({ ticketId: z.string().uuid() });
const sessionParams = z.object({ sessionId: z.string().uuid() });
const screenshotParams = z.object({ screenshotId: z.string().uuid() });

export async function computerUseRoutes(app: FastifyInstance) {
  // Start a computer-use session for a device ticket. See docs/v0.1-computer-use-addendum.md.
  app.post("/tickets/:ticketId/computer-use/start", async (req, reply) => {
    const { ticketId } = ticketParams.parse(req.params);
    try {
      const session = await withExecutionLock(ticketId, () => startSession(ticketId));
      reply.code(201).send(session);
    } catch (err) {
      req.log.error({ err }, "computer-use start failed");
      reply.code((err as { statusCode?: number }).statusCode ?? 400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Manual trigger, same posture as POST /tickets/:id/ai-step — advances the
  // session by one step IF its current pending action has resolved, otherwise
  // returns the session unchanged (caller just polls again).
  app.post("/computer-use-sessions/:sessionId/advance", async (req, reply) => {
    const { sessionId } = sessionParams.parse(req.params);
    try {
      const session = await withSessionLock(sessionId, () => advanceSession(sessionId));
      reply.send(session);
    } catch (err) {
      req.log.error({ err }, "computer-use advance failed");
      reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/computer-use-sessions/:sessionId/stop", async (req, reply) => {
    const { sessionId } = sessionParams.parse(req.params);
    const marked = await pool.query(`UPDATE computer_use_sessions SET stop_requested = true WHERE id = $1 RETURNING *`, [sessionId]);
    if (!marked.rowCount) return reply.code(404).send({ error: "session not found" });
    try { reply.send(await withSessionLock(sessionId, () => stopSession(sessionId))); }
    catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 409) throw error;
      reply.code(202).send(marked.rows[0]);
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

async function withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const session = await pool.query(`SELECT ticket_id FROM computer_use_sessions WHERE id = $1`, [sessionId]);
  if (!session.rowCount) throw Object.assign(new Error("session not found"), { statusCode: 404 });
  return withExecutionLock(session.rows[0].ticket_id, run);
}
