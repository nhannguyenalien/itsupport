import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, queryTenantScoped, withTenantContext } from "../db/pool.js";
import { getTool } from "../tool-registry/index.js";
import { requestToolCall } from "./service.js";
import { recordToolCallResult } from "./execution.js";
import { recordAudit } from "../audit/index.js";
import { hydrateBackupParams } from "../backup/index.js";
import { classifyShell } from "../shell-run/classify.js";

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

    if (approval.tool === "shell.run") {
      // Flags may have been switched off, and the rules may have changed,
      // since the command was proposed. Re-check before queueing anything.
      const flags = await pool.query(
        `SELECT (tn.shell_run_enabled AND d.shell_run_enabled AND NOT d.actions_paused AND d.cert_revoked_at IS NULL) AS ok
         FROM tickets t JOIN tenants tn ON tn.id = t.tenant_id JOIN devices d ON d.id = t.device_id WHERE t.id = $1`,
        [approval.ticket_id],
      );
      if (flags.rows[0]?.ok !== true) return reply.code(409).send({ error: "shell.run is disabled, paused or revoked for this device" });
      const verdict = classifyShell(Array.isArray(approval.params?.argv) ? approval.params.argv : []);
      if (verdict.class === "deny") return reply.code(409).send({ error: `command is no longer allowed: ${verdict.reason ?? verdict.rule}` });
    }

    const decided = await pool.query(
      `UPDATE approvals SET status = 'approved', decided_by = $1, decided_at = now() WHERE id = $2 AND status = 'pending' RETURNING id`,
      [actorId ?? null, approvalId],
    );

    if (!decided.rowCount) return reply.code(409).send({ error: "approval already decided" });
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
      eventData: { tool: approval.tool, ...(approval.tool === "shell.run" ? { argv: approval.params?.argv } : {}) },
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
      `UPDATE approvals SET status = 'rejected', decided_by = $1, decided_at = now() WHERE id = $2 AND status = 'pending'`,
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
    if (!req.agentTenantId) return reply.code(401).send({ error: "agent tenant context required" });
    // A human approval for shell.run is only good for 15 minutes: a device
    // that was offline must not run a stale command when it comes back.
    await queryTenantScoped(req.agentTenantId,
      `UPDATE tool_calls SET executed_at = now(), result = 'timeout', error_message = 'approval expired before the device ran the command'
       WHERE device_id = $1 AND tool = 'shell.run' AND executed_at IS NULL AND requested_at < now() - interval '15 minutes'`,
      [deviceId],
    );
    const result = await queryTenantScoped(req.agentTenantId,
      `SELECT c.id, c.tool, c.params, c.risk,
              (c.tool = 'shell.run' AND EXISTS (
                 SELECT 1 FROM approvals a WHERE a.id = c.approval_id AND a.status = 'approved'
                   AND a.tool = c.tool AND a.params = c.params)) AS shell_approved
       FROM tool_calls c
       WHERE c.device_id = $1 AND c.executed_at IS NULL
       ORDER BY c.requested_at ASC`,
      [deviceId],
    );
    // __approved exists only here, never in storage: the agent runs a
    // write-class shell.run only when the backend vouches for this exact row.
    const calls = (result.rows as Array<{ id: string; tool: string; params: Record<string, unknown>; risk: string; shell_approved: boolean }>)
      .map(({ shell_approved, ...call }) => shell_approved ? { ...call, params: { ...call.params, __approved: true } } : call);
    reply.header("Cache-Control", "no-store");
    reply.send(await hydrateBackupParams(req.agentTenantId, deviceId, calls));
  });

  // Agent-facing: report execution result. Triggers verification enqueueing for
  // write actions, and rolls up verification status once all checks land.
  // (Marketing tools take a different path — executed synchronously and
  // recorded via the same recordToolCallResult(), see platform-clients/executor.ts —
  // there's no separate agent to poll for those.)
  app.post("/tool-calls/:toolCallId/result", async (req, reply) => {
    const { toolCallId } = toolCallParams.parse(req.params);
    const b = resultBody.parse(req.body);
    if (!req.agentTenantId) return reply.code(401).send({ error: "agent tenant context required" });

    try {
      await withTenantContext(req.agentTenantId, () => recordToolCallResult(toolCallId, b, req.agentTenantId!, "agent"));
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        return reply.code(404).send({ error: "tool call not found" });
      }
      throw err;
    }

    reply.send({ ok: true });
  });
}
