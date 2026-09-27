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

/** Computer-use addendum (docs/v0.1-computer-use-addendum.md): a
 * desktop.screenshot result carries a base64 PNG in resultData.image_base64.
 * That never belongs in tool_calls.result_data or audit_log.event_data (both
 * JSONB, no size cap, read constantly) — move the bytes into
 * computer_use_screenshots and replace resultData with a small {screenshot_id}
 * reference before the caller persists it. No-op (returns resultData
 * unchanged) for every other tool, and for a desktop.screenshot call that
 * somehow reports no image (error/timeout result) — nothing to extract. */
async function extractScreenshotIfAny(ticketId: string, tool: string, resultData: unknown): Promise<unknown> {
  if (tool !== "desktop.screenshot") return resultData;
  const imageBase64 = (resultData as Record<string, unknown> | undefined)?.image_base64;
  if (typeof imageBase64 !== "string" || !imageBase64) return resultData;

  const session = await pool.query(
    `SELECT id FROM computer_use_sessions WHERE ticket_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    [ticketId],
  );
  if (session.rowCount === 0) return resultData; // no active session — nothing to attach it to, leave as-is

  const stored = await pool.query(
    `INSERT INTO computer_use_screenshots (session_id, image_data) VALUES ($1, $2) RETURNING id`,
    [session.rows[0].id, Buffer.from(imageBase64, "base64")],
  );
  return { screenshot_id: stored.rows[0].id };
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
  tenantId: string,
  actorType: "agent" | "system" = "agent",
): Promise<void> {
  const callRow = await pool.query(`SELECT * FROM tool_calls WHERE id = $1`, [toolCallId]);
  if (callRow.rowCount === 0) throw new Error(`tool call ${toolCallId} not found`);
  const call = callRow.rows[0];

  const resultData = await extractScreenshotIfAny(call.ticket_id, call.tool, input.resultData);

  await pool.query(
    `UPDATE tool_calls SET executed_at = now(), result = $1, result_data = $2, error_message = $3 WHERE id = $4`,
    [input.result, JSON.stringify(resultData ?? {}), input.errorMessage ?? null, toolCallId],
  );

  await recordAudit({
    tenantId,
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
