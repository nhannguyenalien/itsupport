import { pool } from "../db/pool.js";
import { getTool } from "../tool-registry/index.js";
import { recordAudit } from "../audit/index.js";

/** Creates the tool_calls rows for a write action's verification chain, right
 * after that write action reports success. Verification steps are themselves
 * dispatched like any other read call — nothing here assumes the check
 * happens locally, because neither the backend nor this process has any way
 * to know live state except by asking (the Windows agent, or a platform API). */
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
 * verification child calls have reported a result. v0.1/v0.2 simplification:
 * "passed" means every verification tool_call executed successfully (result =
 * 'success'). Doesn't yet parse returned values against an expected state —
 * known gap, see registry.json's verification field for intended per-tool
 * checks. */
async function maybeFinalizeVerification(parentId: string) {
  const children = await pool.query(`SELECT result FROM tool_calls WHERE parent_tool_call_id = $1`, [parentId]);
  if (children.rowCount === 0) return;
  const allReported = children.rows.every((r) => r.result !== null);
  if (!allReported) return;

  const allPassed = children.rows.every((r) => r.result === "success");
  await pool.query(`UPDATE tool_calls SET verification_status = $1 WHERE id = $2`, [allPassed ? "passed" : "failed", parentId]);
}

export interface ToolCallResultInput {
  result: "success" | "error" | "timeout";
  // JSONB accepts any valid JSON, not just objects — some platform-client
  // calls legitimately return an array (e.g. a list of campaigns).
  resultData?: unknown;
  errorMessage?: string;
}

/** The single place a tool_calls row's outcome gets recorded, regardless of
 * WHO ran it — the Windows agent reporting back via POST
 * /tool-calls/:id/result (routes.ts), or a marketing tool executed
 * synchronously in-process (platform-clients/executor.ts). Both call this so
 * verification enqueueing/rollup and the audit trail behave identically
 * either way — there's no separate "marketing tool audit path" to drift out
 * of sync with the device one. actorType distinguishes the two in the audit
 * log without needing two functions. */
export async function recordToolCallResult(
  toolCallId: string,
  input: ToolCallResultInput,
  actorType: "agent" | "system" = "agent",
): Promise<void> {
  const callRow = await pool.query(`SELECT * FROM tool_calls WHERE id = $1`, [toolCallId]);
  if (callRow.rowCount === 0) throw new Error(`tool call ${toolCallId} not found`);
  const call = callRow.rows[0];

  await pool.query(
    `UPDATE tool_calls SET executed_at = now(), result = $1, result_data = $2, error_message = $3 WHERE id = $4`,
    [input.result, JSON.stringify(input.resultData ?? {}), input.errorMessage ?? null, toolCallId],
  );

  const ticketRow = await pool.query(`SELECT tenant_id FROM tickets WHERE id = $1`, [call.ticket_id]);
  await recordAudit({
    tenantId: ticketRow.rows[0]?.tenant_id ?? "",
    actorType,
    eventType: "tool_call.executed",
    eventData: { tool: call.tool, result: input.result },
    ticketId: call.ticket_id,
    deviceId: call.device_id,
  });

  if (call.parent_tool_call_id) {
    await maybeFinalizeVerification(call.parent_tool_call_id);
  } else if (input.result === "success" && call.risk !== "read") {
    await enqueueVerification(
      toolCallId,
      { deviceId: call.device_id, platformConnectionId: call.platform_connection_id },
      call.ticket_id,
      call.tool,
    );
  }
}
