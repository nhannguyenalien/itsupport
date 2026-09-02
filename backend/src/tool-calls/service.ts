import { pool } from "../db/pool.js";
import { getTool, isKnownTool } from "../tool-registry/index.js";
import { evaluate } from "../policy-engine/index.js";
import { recordAudit } from "../audit/index.js";

export interface RequestToolCallInput {
  ticketId: string;
  initiatedBy: "ai" | "human";
  tool: string;
  params: Record<string, unknown>;
  reasoning?: string;
  actorId?: string;
}

export type RequestToolCallResult =
  | { outcome: "rejected"; reason: string }
  | { outcome: "requires_approval"; approval: Record<string, unknown> }
  | { outcome: "auto_execute"; toolCall: Record<string, unknown> }
  | { outcome: "not_found" };

async function loadTicketContext(ticketId: string) {
  const row = await pool.query(
    `SELECT t.id AS ticket_id, t.tenant_id, t.device_id,
            d.actions_paused, d.cert_revoked_at IS NOT NULL AS device_revoked,
            tn.ai_enabled, tn.autonomous_low_risk_enabled
     FROM tickets t
     JOIN devices d ON d.id = t.device_id
     JOIN tenants tn ON tn.id = t.tenant_id
     WHERE t.id = $1`,
    [ticketId],
  );
  return row.rows[0] as
    | {
        ticket_id: string;
        tenant_id: string;
        device_id: string;
        actions_paused: boolean;
        device_revoked: boolean;
        ai_enabled: boolean;
        autonomous_low_risk_enabled: boolean;
      }
    | undefined;
}

/** The single implementation behind POST /tickets/:id/tool-calls — extracted
 * so both the HTTP route and the AI orchestrator (which needs to request tool
 * calls as part of its diagnostic loop, not just humans clicking a form) go
 * through EXACTLY the same policy-engine/approval/audit logic. The
 * orchestrator must never have its own shortcut path that skips approval. */
export async function requestToolCall(input: RequestToolCallInput): Promise<RequestToolCallResult> {
  if (!isKnownTool(input.tool)) {
    return { outcome: "rejected", reason: `unknown tool "${input.tool}"` };
  }
  const tool = getTool(input.tool)!;

  const ctx = await loadTicketContext(input.ticketId);
  if (!ctx) return { outcome: "not_found" };
  if (ctx.device_revoked) return { outcome: "rejected", reason: "device is revoked" };

  const decision = evaluate(input.tool, {
    initiatedBy: input.initiatedBy,
    tenantAiEnabled: ctx.ai_enabled,
    tenantAutonomousLowRiskEnabled: ctx.autonomous_low_risk_enabled,
    deviceActionsPaused: ctx.actions_paused,
  });

  if (decision.outcome === "rejected") {
    await recordAudit({
      tenantId: ctx.tenant_id,
      actorType: input.initiatedBy === "ai" ? "ai" : "user",
      actorId: input.actorId ?? null,
      eventType: "tool_call.rejected",
      eventData: { tool: input.tool, reason: decision.reason },
      ticketId: input.ticketId,
      deviceId: ctx.device_id,
    });
    return { outcome: "rejected", reason: decision.reason };
  }

  if (decision.outcome === "requires_approval") {
    const approval = await pool.query(
      `INSERT INTO approvals (ticket_id, tool, params, proposed_by_ai, reasoning)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.ticketId, input.tool, JSON.stringify(input.params), input.initiatedBy === "ai", input.reasoning ?? null],
    );
    await recordAudit({
      tenantId: ctx.tenant_id,
      actorType: input.initiatedBy === "ai" ? "ai" : "user",
      actorId: input.actorId ?? null,
      eventType: "approval.requested",
      eventData: { tool: input.tool, risk: tool.risk },
      ticketId: input.ticketId,
      deviceId: ctx.device_id,
    });
    return { outcome: "requires_approval", approval: approval.rows[0] };
  }

  // auto_execute
  const call = await pool.query(
    `INSERT INTO tool_calls (ticket_id, device_id, tool, risk, params)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.ticketId, ctx.device_id, input.tool, tool.risk, JSON.stringify(input.params)],
  );
  await recordAudit({
    tenantId: ctx.tenant_id,
    actorType: input.initiatedBy === "ai" ? "ai" : "user",
    actorId: input.actorId ?? null,
    eventType: "tool_call.queued",
    eventData: { tool: input.tool },
    ticketId: input.ticketId,
    deviceId: ctx.device_id,
  });
  return { outcome: "auto_execute", toolCall: call.rows[0] };
}
