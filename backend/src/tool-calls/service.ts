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

interface TicketContext {
  ticket_id: string;
  tenant_id: string;
  // Exactly one of these two is set — matches the tickets table's CHECK
  // constraint (schema.sql). Neither routes nor the policy engine should ever
  // need to guess which; check target_device_id first, it's the only device
  // path that existed pre-v0.2 and every caller below already assumes it.
  target_device_id: string | null;
  target_platform_connection_id: string | null;
  actions_paused: boolean; // devices.actions_paused OR platform_connections.actions_paused
  target_blocked: boolean; // device revoked, or platform connection not 'active'
  ai_enabled: boolean;
  autonomous_low_risk_enabled: boolean;
  budget_auto_pct_limit: number;
  budget_approval_pct_limit: number;
  absolute_budget_limit_cents: number | null;
}

/** Loads whatever the ticket actually targets (Windows device or marketing
 * platform connection — see tickets table's CHECK constraint) into one shape
 * so the rest of this file doesn't need two parallel code paths. LEFT JOINs
 * both sides and picks whichever is non-null; COALESCE handles the
 * paused/blocked flags so callers get one boolean regardless of target type. */
async function loadTicketContext(ticketId: string): Promise<TicketContext | undefined> {
  const row = await pool.query(
    `SELECT t.id AS ticket_id, t.tenant_id, t.device_id, t.platform_connection_id,
            COALESCE(d.actions_paused, pc.actions_paused, false) AS actions_paused,
            COALESCE(d.cert_revoked_at IS NOT NULL, pc.status IS DISTINCT FROM 'active', false) AS target_blocked,
            tn.ai_enabled, tn.autonomous_low_risk_enabled,
            tn.budget_auto_pct_limit, tn.budget_approval_pct_limit, tn.absolute_budget_limit_cents
     FROM tickets t
     LEFT JOIN devices d ON d.id = t.device_id
     LEFT JOIN platform_connections pc ON pc.id = t.platform_connection_id
     JOIN tenants tn ON tn.id = t.tenant_id
     WHERE t.id = $1`,
    [ticketId],
  );
  const r = row.rows[0];
  if (!r) return undefined;
  return {
    ticket_id: r.ticket_id,
    tenant_id: r.tenant_id,
    target_device_id: r.device_id,
    target_platform_connection_id: r.platform_connection_id,
    actions_paused: r.actions_paused,
    target_blocked: r.target_blocked,
    ai_enabled: r.ai_enabled,
    autonomous_low_risk_enabled: r.autonomous_low_risk_enabled,
    budget_auto_pct_limit: Number(r.budget_auto_pct_limit),
    budget_approval_pct_limit: Number(r.budget_approval_pct_limit),
    absolute_budget_limit_cents: r.absolute_budget_limit_cents === null ? null : Number(r.absolute_budget_limit_cents),
  };
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
  if (ctx.target_blocked) {
    return { outcome: "rejected", reason: ctx.target_device_id ? "device is revoked" : "platform connection is not active" };
  }

  let budgetChange: { currentCents: number; requestedCents: number; absoluteLimitCents: number | null } | undefined;
  if (input.tool === "ads.budget.update") {
    const current = input.params.current_budget_cents;
    const requested = input.params.new_budget_cents;
    if (typeof current !== "number" || typeof requested !== "number") {
      return { outcome: "rejected", reason: "ads.budget.update requires numeric current_budget_cents and new_budget_cents" };
    }
    budgetChange = { currentCents: current, requestedCents: requested, absoluteLimitCents: ctx.absolute_budget_limit_cents };
  }

  const decision = evaluate(input.tool, {
    initiatedBy: input.initiatedBy,
    tenantAiEnabled: ctx.ai_enabled,
    tenantAutonomousLowRiskEnabled: ctx.autonomous_low_risk_enabled,
    deviceActionsPaused: ctx.actions_paused,
    budgetChange,
    tenantBudgetPolicy: budgetChange
      ? { autoPctLimit: ctx.budget_auto_pct_limit, approvalPctLimit: ctx.budget_approval_pct_limit }
      : undefined,
  });

  if (decision.outcome === "rejected") {
    await recordAudit({
      tenantId: ctx.tenant_id,
      actorType: input.initiatedBy === "ai" ? "ai" : "user",
      actorId: input.actorId ?? null,
      eventType: "tool_call.rejected",
      eventData: { tool: input.tool, reason: decision.reason },
      ticketId: input.ticketId,
      deviceId: ctx.target_device_id,
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
      deviceId: ctx.target_device_id,
    });
    return { outcome: "requires_approval", approval: approval.rows[0] };
  }

  // auto_execute
  const call = await pool.query(
    `INSERT INTO tool_calls (ticket_id, device_id, platform_connection_id, tool, risk, params)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.ticketId, ctx.target_device_id, ctx.target_platform_connection_id, input.tool, tool.risk, JSON.stringify(input.params)],
  );
  await recordAudit({
    tenantId: ctx.tenant_id,
    actorType: input.initiatedBy === "ai" ? "ai" : "user",
    actorId: input.actorId ?? null,
    eventType: "tool_call.queued",
    eventData: { tool: input.tool },
    ticketId: input.ticketId,
    deviceId: ctx.target_device_id,
  });
  return { outcome: "auto_execute", toolCall: call.rows[0] };
}
