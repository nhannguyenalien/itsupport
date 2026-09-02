import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { getTool } from "../tool-registry/index.js";
import { requestToolCall } from "./service.js";
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

/** Creates the tool_calls rows for a write action's verification chain, right
 * after that write action reports success. Verification steps are themselves
 * dispatched to the agent like any other read call — nothing here assumes the
 * check happens locally in the backend, because the backend has no way to know
 * live device state except by asking the agent. */
async function enqueueVerification(
  parentId: string,
  target: { deviceId: string | null; platformConnectionId: string | null },
  ticketId: string,
  toolName: string,
) {
  const tool = getTool(toolName);
  if (!tool || tool.verification.length === 0) {
    await pool.query(`UPDATE tool_calls SET verification_status = 'not_required' WHERE id = $1`, [parentId]);
    return;
  }
  await pool.query(`UPDATE tool_calls SET verification_status = 'pending' WHERE id = $1`, [parentId]);
  for (const verifyTool of tool.verification) {
    const verifyDef = getTool(verifyTool);
    await pool.query(
      `INSERT INTO tool_calls (ticket_id, device_id, platform_connection_id, tool, risk, params, parent_tool_call_id)
       VALUES ($1, $2, $3, $4, $5, '{}', $6)`,
      [ticketId, target.deviceId, target.platformConnectionId, verifyTool, verifyDef?.risk ?? "read", parentId],
    );
  }
}

/** Rolls up a parent write call's verification_status once ALL of its
 * verification child calls have reported a result. v0.1 simplification: "passed"
 * means every verification tool_call executed successfully (result = 'success').
 * This does NOT yet parse returned values against an expected state (e.g.
 * asserting service.status literally returned "RUNNING") — that needs per-tool
 * result-shape parsing and is a known gap, not an oversight; see registry.json's
 * verification field for the intended per-tool checks. */
async function maybeFinalizeVerification(parentId: string) {
  const children = await pool.query(
    `SELECT result FROM tool_calls WHERE parent_tool_call_id = $1`,
    [parentId],
  );
  if (children.rowCount === 0) return;
  const allReported = children.rows.every((r) => r.result !== null);
  if (!allReported) return;

  const allPassed = children.rows.every((r) => r.result === "success");
  await pool.query(
    `UPDATE tool_calls SET verification_status = $1 WHERE id = $2`,
    [allPassed ? "passed" : "failed", parentId],
  );
}

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
  app.post("/tool-calls/:toolCallId/result", async (req, reply) => {
    const { toolCallId } = toolCallParams.parse(req.params);
    const b = resultBody.parse(req.body);

    const callRow = await pool.query(
      `SELECT * FROM tool_calls WHERE id = $1`,
      [toolCallId],
    );
    if (callRow.rowCount === 0) return reply.code(404).send({ error: "tool call not found" });
    const call = callRow.rows[0];

    await pool.query(
      `UPDATE tool_calls SET executed_at = now(), result = $1, result_data = $2, error_message = $3 WHERE id = $4`,
      [b.result, JSON.stringify(b.resultData ?? {}), b.errorMessage ?? null, toolCallId],
    );

    const ticketRow = await pool.query(`SELECT tenant_id FROM tickets WHERE id = $1`, [call.ticket_id]);
    await recordAudit({
      tenantId: ticketRow.rows[0]?.tenant_id ?? "",
      actorType: "agent",
      eventType: "tool_call.executed",
      eventData: { tool: call.tool, result: b.result },
      ticketId: call.ticket_id,
      deviceId: call.device_id,
    });

    if (call.parent_tool_call_id) {
      // This WAS a verification step — check if its parent is now fully verified.
      await maybeFinalizeVerification(call.parent_tool_call_id);
    } else if (b.result === "success" && call.risk !== "read") {
      // This was a write action that just succeeded — kick off its verification.
      await enqueueVerification(
        toolCallId,
        { deviceId: call.device_id, platformConnectionId: call.platform_connection_id },
        call.ticket_id,
        call.tool,
      );
    }

    reply.send({ ok: true });
  });
}
