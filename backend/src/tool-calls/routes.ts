import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { getTool } from "../tool-registry/index.js";
import { requestToolCall } from "./service.js";
import { recordToolCallResult } from "./execution.js";
import { recordAudit } from "../audit/index.js";

const requestBody = z.object({
  initiatedBy: z.enum(["ai", "human"]),
  tool: z.string().min(1),
  params: z.record(z.unknown()).default({}),
  reasoning: z.string().optional(), // AI's stated justification, shown to the human approver
  actorId: z.string().uuid().optional(),
});

const ticketParams = z.object({ ticketId: z.string().uuid() });
const approvalParams = z.object({ approvalId: z.string().uuid() });
const toolCallParams = z.object({ toolCallId: z.string().uuid() });
const deviceParams = z.object({ deviceId: z.string().uuid() });

const resultBody = z.object({
  result: z.enum(["success", "error", "timeout"]),
  resultData: z.record(z.unknown()).optional(),
  errorMessage: z.string().optional(),
});

export async function toolCallRoutes(app: FastifyInstance) {
  // Request a tool call. Read tools execute immediately (queued for the agent
  // to pick up). Write tools either auto-execute (low-risk + tenant opted in) or
  // create an approval and wait — see policy-engine/index.ts for the full rule.
  app.post("/tickets/:ticketId/tool-calls", async (req, reply) => {
    const { ticketId } = ticketParams.parse(req.params);
    const b = requestBody.parse(req.body);

    const result = await requestToolCall({ ticketId, ...b });

    if (result.outcome === "not_found") return reply.code(404).send({ error: "ticket not found" });
    if (result.outcome === "rejected") return reply.code(403).send({ error: result.reason });
    if (result.outcome === "requires_approval") return reply.code(202).send(result);
    reply.code(201).send(result);
  });

  app.post("/approvals/:approvalId/approve", async (req, reply) => {
    const { approvalId } = approvalParams.parse(req.params);
    const { actorId } = z.object({ actorId: z.string().uuid().optional() }).parse(req.body ?? {});

    const approvalRow = await pool.query(
      `SELECT a.*, t.tenant_id, t.device_id, t.platform_connection_id FROM approvals a
       JOIN tickets t ON t.id = a.ticket_id
       WHERE a.id = $1 AND a.status = 'pending'`,
      [approvalId],
    );
    if (approvalRow.rowCount === 0) return reply.code(404).send({ error: "pending approval not found" });
    const approval = approvalRow.rows[0];
    const tool = getTool(approval.tool)!;

    await pool.query(
      `UPDATE approvals SET status = 'approved', decided_by = $1, decided_at = now() WHERE id = $2`,
      [actorId ?? null, approvalId],
    );

    const call = await pool.query(
      `INSERT INTO tool_calls (ticket_id, device_id, platform_connection_id, tool, risk, params, approval_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [approval.ticket_id, approval.device_id, approval.platform_connection_id, approval.tool, tool.risk, approval.params, approvalId],
    );

    await recordAudit({
      tenantId: approval.tenant_id,
      actorType: "user",
      actorId: actorId ?? null,
      eventType: "approval.granted",
      eventData: { tool: approval.tool },
      ticketId: approval.ticket_id,
      deviceId: approval.device_id,
    });

    reply.send({ toolCall: call.rows[0] });
  });

  app.post("/approvals/:approvalId/reject", async (req, reply) => {
    const { approvalId } = approvalParams.parse(req.params);
    const { actorId } = z.object({ actorId: z.string().uuid().optional() }).parse(req.body ?? {});

    const approvalRow = await pool.query(
      `SELECT a.*, t.tenant_id, t.device_id FROM approvals a
       JOIN tickets t ON t.id = a.ticket_id
       WHERE a.id = $1 AND a.status = 'pending'`,
      [approvalId],
    );
    if (approvalRow.rowCount === 0) return reply.code(404).send({ error: "pending approval not found" });
    const approval = approvalRow.rows[0];

    await pool.query(
      `UPDATE approvals SET status = 'rejected', decided_by = $1, decided_at = now() WHERE id = $2`,
      [actorId ?? null, approvalId],
    );

    await recordAudit({
      tenantId: approval.tenant_id,
      actorType: "user",
      actorId: actorId ?? null,
      eventType: "approval.rejected",
      eventData: { tool: approval.tool },
      ticketId: approval.ticket_id,
      deviceId: approval.device_id,
    });

    reply.send({ ok: true });
  });

  // Agent-facing: poll for work. v0.1 uses polling deliberately — it's the
  // simplest thing that lets the DB model + policy engine be exercised
  // end-to-end before building the real persistent-connection daemon. Swapping
  // this for a push channel later doesn't change anything upstream of this file.
  app.get("/devices/:deviceId/tool-calls/pending", async (req, reply) => {
    const { deviceId } = deviceParams.parse(req.params);
    const result = await pool.query(
      `SELECT id, tool, params, risk FROM tool_calls
       WHERE device_id = $1 AND executed_at IS NULL
       ORDER BY requested_at ASC`,
      [deviceId],
    );
    reply.send(result.rows);
  });

  // Agent-facing: report execution result. Triggers verification enqueueing for
  // write actions, and rolls up verification status once all checks land.
  // (Marketing tools take a different path — executed synchronously and
  // recorded via the same recordToolCallResult(), see platform-clients/executor.ts —
  // there's no separate agent to poll for those.)
  app.post("/tool-calls/:toolCallId/result", async (req, reply) => {
    const { toolCallId } = toolCallParams.parse(req.params);
    const b = resultBody.parse(req.body);

    try {
      await recordToolCallResult(toolCallId, b, "agent");
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        return reply.code(404).send({ error: "tool call not found" });
      }
      throw err;
    }

    reply.send({ ok: true });
  });
}
