import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runAccountChat, runSystemChat } from "./index.js";
import { SchoolsAiError, schoolsAiConfigured } from "./schoolsai.js";

const turnBody = z.object({
  conversationId: z.string().uuid(),
  message: z.string().trim().min(1).max(4000),
  language: z.enum(["vi", "en", "fr", "ko", "ja", "es"]).optional(),
});

function sendFailure(req: { log: { error: (o: object, m: string) => void } }, reply: { code: (c: number) => { send: (b: unknown) => unknown } }, err: unknown) {
  req.log.error({ err }, "support chat failed");
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  const message = err instanceof SchoolsAiError
    ? (status === 429 ? "Trợ lý đang quá tải, vui lòng thử lại sau ít phút." : status === 503 ? err.message : "Trợ lý hỗ trợ tạm thời không phản hồi, vui lòng thử lại.")
    : status < 500 && err instanceof Error ? err.message : "Trợ lý hỗ trợ gặp lỗi, vui lòng thử lại.";
  return reply.code(status).send({ error: message });
}

export async function supportChatRoutes(app: FastifyInstance) {
  // Public (see auth/plugin.ts) so the widget can render its availability before login.
  app.get("/support-chat/status", async () => ({ enabled: schoolsAiConfigured() }));

  // Tier 1 — whole-system advice. Public, so it is rate limited per IP and never
  // touches tenant data.
  app.post("/support-chat/system", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = turnBody.parse(req.body);
    try {
      return await runSystemChat(null, body);
    } catch (err) {
      return sendFailure(req, reply, err);
    }
  });

  // Tier 2 — the signed-in user's own workspace, with tenant-scoped tools.
  app.post("/support-chat/account", { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = turnBody.parse(req.body);
    try {
      return await runAccountChat(req.authUser!, body);
    } catch (err) {
      return sendFailure(req, reply, err);
    }
  });
}
