import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { estimateCostUsd } from "../ai-orchestration/pricing.js";

// docs/v0.1-spec.md "Metrics (feature, not an afterthought)" — the ROI story
// for pilot/sales conversations. The per-tenant aggregates live as SQL views
// (schema.sql: metrics_tickets / metrics_tool_calls / metrics_approvals) so
// the numbers can't drift from the source rows; this route stitches them
// together with the few KPIs that need cross-table math (tool_calls_per_ticket,
// repeat_incident_rate) and a token-based AI cost estimate.

const metricsQuery = z.object({ tenantId: z.string().uuid() });

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function metricsRoutes(app: FastifyInstance) {
  app.get("/metrics", async (req, reply) => {
    const { tenantId } = metricsQuery.parse(req.query);

    const tenant = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
    if (tenant.rowCount === 0) return reply.code(404).send({ error: "tenant not found" });

    const [tickets, approvals, remediation, perTicket, repeat, aiTokens, aiTicketCount, byTool] = await Promise.all([
      pool.query(
        `SELECT tickets_total, tickets_ai_resolved, tickets_escalated, avg_resolution_seconds
         FROM metrics_tickets WHERE tenant_id = $1`,
        [tenantId],
      ),
      pool.query(
        `SELECT approvals_total, approvals_granted, approval_rate
         FROM metrics_approvals WHERE tenant_id = $1`,
        [tenantId],
      ),
      // Tenant-wide remediation success: of every write action whose
      // verification chain has resolved, what fraction passed.
      pool.query(
        `SELECT round(
                  count(*) FILTER (WHERE tc.verification_status = 'passed')::numeric
                  / NULLIF(count(*) FILTER (WHERE tc.verification_status IN ('passed','failed')), 0), 4
                ) AS rate
         FROM tool_calls tc JOIN tickets t ON t.id = tc.ticket_id
         WHERE t.tenant_id = $1`,
        [tenantId],
      ),
      // Top-level tool calls only (verification children excluded) per ticket
      // that had any.
      pool.query(
        `SELECT count(*)::float8 / NULLIF(count(DISTINCT tc.ticket_id), 0) AS per_ticket
         FROM tool_calls tc JOIN tickets t ON t.id = tc.ticket_id
         WHERE t.tenant_id = $1 AND tc.parent_tool_call_id IS NULL`,
        [tenantId],
      ),
      // Repeat incidents: same device + same scenario resolved more than once.
      pool.query(
        `WITH resolved AS (
           SELECT row_number() OVER (PARTITION BY device_id, scenario ORDER BY resolved_at) AS rn
           FROM tickets
           WHERE tenant_id = $1 AND status = 'resolved'
             AND device_id IS NOT NULL AND scenario IS NOT NULL
         )
         SELECT round(count(*) FILTER (WHERE rn > 1)::numeric / NULLIF(count(*), 0), 4) AS rate
         FROM resolved`,
        [tenantId],
      ),
      // AI token usage recorded on each ai_step.completed audit event
      // (ai-orchestration/index.ts), grouped by model for pricing.
      pool.query(
        `SELECT event_data->>'model' AS model,
                sum(COALESCE((event_data->>'promptTokens')::bigint, 0)) AS prompt_tokens,
                sum(COALESCE((event_data->>'completionTokens')::bigint, 0)) AS completion_tokens
         FROM audit_log
         WHERE tenant_id = $1 AND event_type = 'ai_step.completed'
         GROUP BY event_data->>'model'`,
        [tenantId],
      ),
      pool.query(
        `SELECT count(DISTINCT ticket_id) AS n FROM audit_log
         WHERE tenant_id = $1 AND event_type = 'ai_step.completed' AND ticket_id IS NOT NULL`,
        [tenantId],
      ),
      pool.query(
        `SELECT tool, calls_total, calls_succeeded, verified_passed, verified_failed, remediation_success_rate
         FROM metrics_tool_calls WHERE tenant_id = $1 ORDER BY calls_total DESC`,
        [tenantId],
      ),
    ]);

    const t = tickets.rows[0] ?? {};
    const a = approvals.rows[0] ?? {};

    let aiCostUsd = 0;
    for (const row of aiTokens.rows) {
      aiCostUsd += estimateCostUsd(row.model, Number(row.prompt_tokens), Number(row.completion_tokens));
    }
    const aiTickets = Number(aiTicketCount.rows[0]?.n ?? 0);

    reply.send({
      tenant_id: tenantId,
      tickets_total: Number(t.tickets_total ?? 0),
      tickets_ai_resolved: Number(t.tickets_ai_resolved ?? 0),
      tickets_escalated: Number(t.tickets_escalated ?? 0),
      avg_resolution_seconds: numOrNull(t.avg_resolution_seconds),
      approvals_total: Number(a.approvals_total ?? 0),
      approvals_granted: Number(a.approvals_granted ?? 0),
      approval_rate: numOrNull(a.approval_rate),
      tool_calls_per_ticket: numOrNull(perTicket.rows[0]?.per_ticket),
      remediation_success_rate: numOrNull(remediation.rows[0]?.rate),
      repeat_incident_rate: numOrNull(repeat.rows[0]?.rate),
      ai_estimated_cost_usd: Number(aiCostUsd.toFixed(4)),
      ai_cost_per_ticket: aiTickets > 0 ? Number((aiCostUsd / aiTickets).toFixed(4)) : null,
      by_tool: byTool.rows,
    });
  });
}
