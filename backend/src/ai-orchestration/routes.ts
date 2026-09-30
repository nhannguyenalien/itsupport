import { withExecutionLock } from "../db/execution-lock.js";
import { pool } from "../db/pool.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { startWorkflowJob } from "./jobs.js";
import { runAiWorkflow } from "./index.js";

const ticketParams = z.object({ ticketId: z.string().uuid() });

export async function aiOrchestrationRoutes(app: FastifyInstance) {
  // Manual trigger for one diagnostic step — see index.ts for why this isn't
  // an autonomous loop yet. Errors clearly (no OPENAI_API_KEY -> 500 with a
  // real message) rather than pretending to have run when it didn't.
  app.post("/tickets/:ticketId/ai-step", async (req, reply) => {
    const { ticketId } = ticketParams.parse(req.params);
    try {
      const result = startWorkflowJob(ticketId, () => withExecutionLock(ticketId, async () => {
        const active = await pool.query(`SELECT s.id FROM computer_use_sessions s JOIN tickets t ON t.device_id = s.device_id WHERE t.id = $1 AND s.status = 'active'`, [ticketId]);
        if (active.rowCount) throw Object.assign(new Error("Hãy dừng phiên màn hình trước khi chạy chẩn đoán."), { statusCode: 409 });
        return runAiWorkflow(ticketId);
      }), (err) => req.log.error({ err }, "background ai workflow failed"));
      reply.code(202).send(result);
    } catch (err) {
      req.log.error({ err }, "ai-step failed");
      reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
