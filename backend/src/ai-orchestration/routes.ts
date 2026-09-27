import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runAiWorkflow } from "./index.js";

const ticketParams = z.object({ ticketId: z.string().uuid() });

export async function aiOrchestrationRoutes(app: FastifyInstance) {
  // Manual trigger for one diagnostic step — see index.ts for why this isn't
  // an autonomous loop yet. Errors clearly (no OPENAI_API_KEY -> 500 with a
  // real message) rather than pretending to have run when it didn't.
  app.post("/tickets/:ticketId/ai-step", async (req, reply) => {
    const { ticketId } = ticketParams.parse(req.params);
    try {
      const result = await runAiWorkflow(ticketId);
      reply.send(result);
    } catch (err) {
      req.log.error({ err }, "ai-step failed");
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
