import OpenAI from "openai";
import { pool } from "../db/pool.js";
import { requestToolCall } from "../tool-calls/service.js";
import { recordAudit } from "../audit/index.js";

// Computer-use addendum — docs/v0.1-computer-use-addendum.md. Drives OpenAI's
// Responses API `computer` tool (see agent/internal/tools/desktop_windows.go
// for what actually executes an action on the Windows box). This module NEVER
// executes anything itself — every proposed action still goes through
// requestToolCall() (tool-calls/service.ts), the same policy-engine/approval
// chokepoint every other tool call uses. domain:'windows_desktop' tools are
// risk:'high' (except screenshot/move/wait, risk:'read') so a write action
// always creates an approvals row and waits for a human — see
// policy-engine/index.ts, unmodified for this feature.
//
// The `computer` tool (current API — `computer_use_preview` was confirmed
// retired via a real 404 against the live API) returns a BATCH of actions per
// computer_call (`actions[]`, one shared `call_id`, one `pending_safety_checks`
// for the whole batch) rather than one action at a time. This product's hard
// requirement is per-action human approval, so a batch is walked one action
// at a time — dispatchAction() below is the single place that both "first
// action of a fresh batch" and "next action of an in-progress batch" go
// through — and the model is only called again once every action in the
// batch has individually been approved, executed, and verified.

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is not set — computer-use is wired but has no model to call. " +
        "Same pattern as ai-orchestration/index.ts's regular ai-step.",
    );
  }
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL });
  }
  return client;
}

// Deliberately its own env var, not OPENAI_MODEL — computer-use needs a model
// that actually supports the `computer` tool, which the regular
// chat-completions ai-step model (gpt-4o-mini by default) does not.
// computer-use-preview is retired (confirmed: real 404 from the live API) —
// gpt-5.6-sol is the current model OpenAI's own docs point at for this tool.
const MODEL = process.env.OPENAI_COMPUTER_USE_MODEL ?? "gpt-5.6-sol";

export interface ComputerUseSession {
  id: string;
  tenant_id: string;
  ticket_id: string;
  device_id: string;
  status: "active" | "ended";
  openai_response_id: string | null;
  pending_tool_call_id: string | null;
  pending_approval_id: string | null;
  // In-progress batch state — see the file header comment. All three are
  // null except while working through a multi-action computer_call.
  pending_batch_call_id: string | null;
  pending_batch_remaining: OpenAI.Responses.ComputerActionList | null;
  pending_batch_safety_checks: OpenAI.Responses.ResponseComputerToolCall.PendingSafetyCheck[] | null;
  display_width: number;
  display_height: number;
  environment: "windows" | "mac" | "linux" | "ubuntu" | "browser";
}

async function loadSession(sessionId: string): Promise<ComputerUseSession | undefined> {
  const row = await pool.query<ComputerUseSession>(`SELECT * FROM computer_use_sessions WHERE id = $1`, [sessionId]);
  return row.rows[0];
}

/** Starts a session: creates the row and requests the first screenshot (a
 * read-risk tool, auto-executes — but "auto-execute" for a device tool only
 * means the row is queued for the agent to poll, per the existing polling
 * architecture; there is nothing synchronous to await here). The actual first
 * call to OpenAI happens on the next advanceSession() once that screenshot's
 * result lands — see there for why one function handles both "first call" and
 * "resume" rather than splitting the OpenAI-calling logic in two. */
export async function startSession(ticketId: string): Promise<ComputerUseSession> {
  const ticketRow = await pool.query(
    `SELECT t.tenant_id, t.device_id, d.platform
     FROM tickets t LEFT JOIN devices d ON d.id = t.device_id
     WHERE t.id = $1`,
    [ticketId],
  );
  if (ticketRow.rowCount === 0) throw new Error("ticket not found");
  const { tenant_id, device_id, platform } = ticketRow.rows[0];
  if (!device_id) throw new Error("computer-use requires a device-targeted ticket");

  // Multi-OS computer-use addendum (docs/v0.1-computer-use-addendum.md) —
  // devices.platform ('windows'|'mac'|'linux') and the computer_use_preview
  // tool's `environment` enum happen to share the same three string values,
  // so this is a direct pass-through, not a lookup table.
  const sessionRow = await pool.query<ComputerUseSession>(
    `INSERT INTO computer_use_sessions (tenant_id, ticket_id, device_id, environment) VALUES ($1, $2, $3, $4) RETURNING *`,
    [tenant_id, ticketId, device_id, platform],
  );
  const session: ComputerUseSession = sessionRow.rows[0];

  const result = await requestToolCall({
    ticketId,
    initiatedBy: "ai",
    tool: "desktop.screenshot",
    params: {},
    reasoning: "Computer-use: initial screenshot to start the session",
  });

  if (result.outcome !== "auto_execute") {
    // Most likely rejected — tenant's ai_data_policy is 'no_screenshots', or
    // the device is revoked/paused. End the session immediately rather than
    // leaving a session row that can never progress.
    const reason = result.outcome === "rejected" ? result.reason : "could not request the initial screenshot";
    await pool.query(`UPDATE computer_use_sessions SET status = 'ended', updated_at = now() WHERE id = $1`, [session.id]);
    await recordAudit({
      tenantId: tenant_id,
      actorType: "system",
      eventType: "computer_use.session_start_failed",
      eventData: { reason },
      ticketId,
      deviceId: device_id,
    });
    throw new Error(`could not start computer-use session: ${reason}`);
  }

  const updated = await pool.query<ComputerUseSession>(
    `UPDATE computer_use_sessions SET pending_tool_call_id = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [(result.toolCall as { id: string }).id, session.id],
  );
  await recordAudit({
    tenantId: tenant_id,
    actorType: "ai",
    eventType: "computer_use.session_started",
    eventData: {},
    ticketId,
    deviceId: device_id,
  });

  // Customer-facing status/chat view (docs/v0.1-computer-use-addendum.md) —
  // system-triggered once here, never something the AI decides to call
  // itself (that's why it's excluded from the regular ai-orchestration tool
  // list, see ai-orchestration/index.ts's domain filter). Best-effort: a
  // failure here (e.g. the tenant somehow rejects it) shouldn't abort the
  // computer-use session itself — opening a status page for the customer is
  // not a precondition for the AI actually doing its job.
  const customerViewResult = await requestToolCall({
    ticketId,
    initiatedBy: "ai",
    tool: "desktop.open_customer_view",
    params: {},
    reasoning: "Computer-use: opening the customer-facing status/chat view",
  });
  await recordAudit({
    tenantId: tenant_id,
    actorType: "system",
    eventType: "computer_use.customer_view_requested",
    eventData: { outcome: customerViewResult.outcome },
    ticketId,
    deviceId: device_id,
  });

  return updated.rows[0];
}

type ResolvedScreenshot = { ready: true; screenshotId: string; priorCallId: string | null; safetyChecks: unknown[] } | { ready: false };

/** Figures out whether the action/tool-call the session is currently waiting
 * on has produced a screenshot yet, and if so, which one to send back to
 * OpenAI. Returns `{ready:false}` (no error — just "check again on the next
 * poll") for every "still waiting" state: pending approval, approved-but-not-
 * yet-executed-by-the-agent, or verification still pending. Mutates the
 * session row's pending_* columns when a wait resolves into a new wait (e.g.
 * requesting a follow-up screenshot for move/wait, which produce no
 * screenshot of their own). */
async function resolvePendingScreenshot(session: ComputerUseSession): Promise<ResolvedScreenshot> {
  // No prior action at all — this only happens once, right after startSession,
  // where pending_tool_call_id already points at the initial desktop.screenshot.
  let toolCallId = session.pending_tool_call_id;

  if (!toolCallId && session.pending_approval_id) {
    const approvalRow = await pool.query(`SELECT status FROM approvals WHERE id = $1`, [session.pending_approval_id]);
    const status = approvalRow.rows[0]?.status;
    if (status === "pending") return { ready: false };
    if (status === "rejected" || status === "expired") {
      // A human declined the proposed action. v0.1 MVP: stop rather than ask
      // the model to try something else blind — see docs/v0.1-computer-use-addendum.md.
      await endSession(session, "technician rejected the proposed action");
      return { ready: false };
    }
    // approved — routes.ts's /approvals/:id/approve inserts the tool_calls row synchronously.
    const callRow = await pool.query(`SELECT id FROM tool_calls WHERE approval_id = $1`, [session.pending_approval_id]);
    toolCallId = callRow.rows[0]?.id ?? null;
    if (!toolCallId) return { ready: false }; // shouldn't happen, but "not ready" is the safe read
    await pool.query(
      `UPDATE computer_use_sessions SET pending_tool_call_id = $1, pending_approval_id = NULL, updated_at = now() WHERE id = $2`,
      [toolCallId, session.id],
    );
  }

  if (!toolCallId) return { ready: false };

  const callRow = await pool.query(`SELECT * FROM tool_calls WHERE id = $1`, [toolCallId]);
  const call = callRow.rows[0];
  if (!call || call.executed_at === null) return { ready: false }; // agent hasn't reported a result yet

  if (call.result !== "success") {
    await endSession(session, `${call.tool} failed on the device: ${call.error_message ?? call.result}`);
    return { ready: false };
  }

  const priorCallId = (call.params?.__openai_call_id as string | undefined) ?? null;
  const safetyChecks = (call.params?.__openai_safety_checks as unknown[] | undefined) ?? [];

  if (call.tool === "desktop.screenshot") {
    const screenshotId = call.result_data?.screenshot_id as string | undefined;
    if (!screenshotId) return { ready: false }; // genuinely shouldn't happen — agent reported success with no image
    return { ready: true, screenshotId, priorCallId, safetyChecks };
  }

  if (call.tool === "desktop.move" || call.tool === "desktop.wait") {
    // These carry no screenshot of their own (registry.json verification:[])
    // but OpenAI's protocol still expects a screenshot back for every
    // computer_call — request one explicitly and wait one more tick.
    const shot = await requestToolCall({
      ticketId: session.ticket_id,
      initiatedBy: "ai",
      tool: "desktop.screenshot",
      params: { __openai_call_id: priorCallId, __openai_safety_checks: safetyChecks },
      reasoning: `Computer-use: refreshing view after ${call.tool}`,
    });
    if (shot.outcome === "auto_execute") {
      await pool.query(`UPDATE computer_use_sessions SET pending_tool_call_id = $1, updated_at = now() WHERE id = $2`, [
        (shot.toolCall as { id: string }).id,
        session.id,
      ]);
    } else {
      await endSession(session, "could not refresh the screenshot after move/wait");
    }
    return { ready: false };
  }

  // A write action (click/double_click/drag/keypress/type/scroll) — the
  // deterministic verification chain (registry.json's ["desktop.screenshot"])
  // is the post-action screenshot. execution.ts rolls verification_status up
  // to passed/failed once that child call reports.
  if (call.verification_status === "pending") return { ready: false };
  if (call.verification_status === "failed") {
    await endSession(session, `post-action screenshot verification failed for ${call.tool}`);
    return { ready: false };
  }
  const child = await pool.query(
    `SELECT result_data FROM tool_calls WHERE parent_tool_call_id = $1 AND tool = 'desktop.screenshot'`,
    [toolCallId],
  );
  const screenshotId = child.rows[0]?.result_data?.screenshot_id as string | undefined;
  if (!screenshotId) return { ready: false };
  return { ready: true, screenshotId, priorCallId, safetyChecks };
}

/** Every call site of this function represents "the AI couldn't finish —
 * a human is needed" (verification failure, device-reported execution
 * failure, a technician rejection, an unrecognized action, or the model's
 * own ESCALATE: message — see the final-message handling in
 * advanceSession()). Autonomous computer-use mode
 * (docs/v0.1-computer-use-addendum.md) means most actions no longer pause
 * for a human mid-flight, so this is the fallback path that actually
 * delivers "technician steps in when the AI can't handle it" — hence
 * flipping the ticket to 'escalated' here, once, rather than requiring every
 * call site to remember to do it. See endSessionResolved() for the one path
 * that does NOT escalate (the model's own RESOLVED: message). */
async function endSession(session: ComputerUseSession, reason: string): Promise<void> {
  await pool.query(
    `UPDATE computer_use_sessions SET status = 'ended', pending_tool_call_id = NULL, pending_approval_id = NULL,
     pending_batch_call_id = NULL, pending_batch_remaining = NULL, pending_batch_safety_checks = NULL, updated_at = now()
     WHERE id = $1`,
    [session.id],
  );
  await pool.query(`UPDATE tickets SET status = 'escalated' WHERE id = $1 AND status NOT IN ('resolved', 'closed')`, [session.ticket_id]);
  await pool.query(`INSERT INTO ticket_messages (ticket_id, author_type, body) VALUES ($1, 'system', $2)`, [
    session.ticket_id,
    `Computer-use session ended: ${reason}`,
  ]);
  await recordAudit({
    tenantId: session.tenant_id,
    actorType: "system",
    eventType: "computer_use.session_ended",
    eventData: { reason, escalated: true },
    ticketId: session.ticket_id,
    deviceId: session.device_id,
  });
}

/** The one session-ending path that does NOT escalate the ticket — the model
 * itself reported the issue resolved (its final message was prefixed
 * `RESOLVED:`, see advanceSession()). Deliberately separate from
 * endSession() rather than a boolean flag: the two cases mean opposite things
 * for the ticket, and a shared function with an easy-to-miss param is exactly
 * how "forgot to escalate" bugs happen. */
async function endSessionResolved(session: ComputerUseSession, message: string): Promise<void> {
  await pool.query(
    `UPDATE computer_use_sessions SET status = 'ended', pending_tool_call_id = NULL, pending_approval_id = NULL,
     pending_batch_call_id = NULL, pending_batch_remaining = NULL, pending_batch_safety_checks = NULL, updated_at = now()
     WHERE id = $1`,
    [session.id],
  );
  await pool.query(`INSERT INTO ticket_messages (ticket_id, author_type, body) VALUES ($1, 'ai', $2)`, [session.ticket_id, message]);
  await recordAudit({
    tenantId: session.tenant_id,
    actorType: "ai",
    eventType: "computer_use.session_ended",
    eventData: { reason: "model reported resolved", escalated: false },
    ticketId: session.ticket_id,
    deviceId: session.device_id,
  });
}

function toolForAction(action: OpenAI.Responses.ResponseComputerToolCall["action"]): { tool: string; params: Record<string, unknown> } | null {
  if (!action) return null;
  switch (action.type) {
    case "click":
      return { tool: "desktop.click", params: { x: action.x, y: action.y, button: action.button } };
    case "double_click":
      return { tool: "desktop.double_click", params: { x: action.x, y: action.y } };
    case "drag":
      return { tool: "desktop.drag", params: { path: action.path } };
    case "keypress":
      return { tool: "desktop.keypress", params: { keys: action.keys } };
    case "move":
      return { tool: "desktop.move", params: { x: action.x, y: action.y } };
    case "scroll":
      return { tool: "desktop.scroll", params: { x: action.x, y: action.y, scroll_x: action.scroll_x, scroll_y: action.scroll_y } };
    case "type":
      return { tool: "desktop.type", params: { text: action.text } };
    case "wait":
      return { tool: "desktop.wait", params: {} };
    case "screenshot":
      return { tool: "desktop.screenshot", params: {} };
    default:
      return null;
  }
}

function describeAction(tool: string, params: Record<string, unknown>): string {
  switch (tool) {
    case "desktop.click":
      return `Computer-use: click (${params.button}) at (${params.x}, ${params.y})`;
    case "desktop.double_click":
      return `Computer-use: double-click at (${params.x}, ${params.y})`;
    case "desktop.drag":
      return `Computer-use: drag along ${JSON.stringify(params.path)}`;
    case "desktop.keypress":
      return `Computer-use: press ${JSON.stringify(params.keys)}`;
    case "desktop.type":
      return `Computer-use: type ${JSON.stringify(params.text)}`;
    case "desktop.scroll":
      return `Computer-use: scroll at (${params.x}, ${params.y}) by (${params.scroll_x}, ${params.scroll_y})`;
    default:
      return `Computer-use: ${tool}`;
  }
}

/** The single place that requests approval/execution for ONE computer-use
 * action, whether it's the first action of a batch the model just returned
 * (responseId is the new response.id) or the next queued action of a batch
 * already in progress (responseId is just session.openai_response_id,
 * unchanged — no new model call happened this tick). `remaining` is the rest
 * of the batch AFTER this action (possibly empty); `batchSafetyChecks` is the
 * whole batch's pending_safety_checks, carried along unchanged until the
 * batch is exhausted and echoed back once. Always leaves the session's
 * pending_* columns describing exactly what to resolve next — the caller
 * just reloads and returns. */
async function dispatchAction(
  session: ComputerUseSession,
  responseId: string,
  action: NonNullable<OpenAI.Responses.ResponseComputerToolCall["action"]>,
  callId: string,
  remaining: OpenAI.Responses.ComputerActionList,
  batchSafetyChecks: OpenAI.Responses.ResponseComputerToolCall.PendingSafetyCheck[],
): Promise<void> {
  const mapped = toolForAction(action);
  if (!mapped) {
    await endSession(session, "unrecognized computer-use action type from the model");
    return;
  }

  // __openai_safety_checks is left empty here on purpose — safety checks are
  // batch-level now (see file header), stashed separately in
  // pending_batch_safety_checks and only echoed back once, on the
  // end-of-batch response, not per action.
  const params = { ...mapped.params, __openai_call_id: callId, __openai_safety_checks: [] };
  const result = await requestToolCall({
    ticketId: session.ticket_id,
    initiatedBy: "ai",
    tool: mapped.tool,
    params,
    reasoning: describeAction(mapped.tool, mapped.params),
  });

  if (result.outcome === "requires_approval" || result.outcome === "auto_execute") {
    const pendingApprovalId = result.outcome === "requires_approval" ? (result.approval as { id: string }).id : null;
    const pendingToolCallId = result.outcome === "auto_execute" ? (result.toolCall as { id: string }).id : null;
    await pool.query(
      `UPDATE computer_use_sessions SET
         openai_response_id = $1, pending_approval_id = $2, pending_tool_call_id = $3,
         pending_batch_call_id = $4, pending_batch_remaining = $5, pending_batch_safety_checks = $6,
         updated_at = now()
       WHERE id = $7`,
      [
        responseId,
        pendingApprovalId,
        pendingToolCallId,
        callId,
        JSON.stringify(remaining),
        JSON.stringify(batchSafetyChecks),
        session.id,
      ],
    );
  } else {
    const reason = result.outcome === "rejected" ? result.reason : "ticket not found";
    await pool.query(`UPDATE computer_use_sessions SET openai_response_id = $1, updated_at = now() WHERE id = $2`, [responseId, session.id]);
    await endSession(session, `proposed action was rejected: ${reason}`);
    return;
  }

  await recordAudit({
    tenantId: session.tenant_id,
    actorType: "ai",
    eventType: "computer_use.action_proposed",
    eventData: { tool: mapped.tool, outcome: result.outcome },
    ticketId: session.ticket_id,
    deviceId: session.device_id,
  });
}

/** Advances a session by exactly one step, IF the action it's currently
 * waiting on has resolved — otherwise a no-op (caller just polls again, same
 * posture as the rest of this app's 4s ticket-page polling). Mirrors
 * ai-orchestration/index.ts's runAiStep in spirit ("one step per call, no
 * autonomous loop") but the step boundary here is "one resolved screenshot",
 * not "one HTTP trigger", because a computer-use step genuinely can't proceed
 * until the previous action's result is known. */
export async function advanceSession(sessionId: string): Promise<ComputerUseSession> {
  const session = await loadSession(sessionId);
  if (!session) throw new Error("computer-use session not found");
  if (session.status === "ended") return session;

  const resolved = await resolvePendingScreenshot(session);
  if (!resolved.ready) return (await loadSession(sessionId))!; // may have changed (new pending id, or ended) — return fresh

  // Mid-batch: the action that just resolved wasn't the last one in the
  // current computer_call's actions[] — dispatch the next queued one instead
  // of calling the model again. No screenshot/OpenAI call needed for this —
  // resolved.ready only confirms the JUST-FINISHED action succeeded, which is
  // exactly the gate for moving on to the next one in the same batch.
  if (session.pending_batch_remaining && session.pending_batch_remaining.length > 0) {
    const [nextAction, ...rest] = session.pending_batch_remaining;
    await dispatchAction(
      session,
      session.openai_response_id!, // unchanged — no new model call this tick
      nextAction,
      session.pending_batch_call_id!,
      rest,
      session.pending_batch_safety_checks ?? [],
    );
    return (await loadSession(sessionId))!;
  }

  // Batch exhausted (or this was a single-action call, which is a batch of
  // one) — take the end-of-batch screenshot and either resume or start.
  const screenshotRow = await pool.query(`SELECT image_data FROM computer_use_screenshots WHERE id = $1`, [resolved.screenshotId]);
  const imageBase64 = (screenshotRow.rows[0]?.image_data as Buffer).toString("base64");
  const outputScreenshot: OpenAI.Responses.ResponseComputerToolCallOutputScreenshot = {
    type: "computer_screenshot",
    image_url: `data:image/png;base64,${imageBase64}`,
  };

  const openai = getClient();
  // The current `computer` tool takes no display_width/display_height/
  // environment fields (unlike the retired computer_use_preview tool) —
  // dimensions are inferred from the screenshot itself; environment context
  // moves into the prompt text below instead.
  const tool: OpenAI.Responses.ComputerTool = { type: "computer" };

  let response: OpenAI.Responses.Response;
  if (!session.openai_response_id || !resolved.priorCallId) {
    // First call of the session — no prior computer_call to answer, so the
    // screenshot goes in as a normal input image alongside instructions,
    // per OpenAI's computer-use guide.
    const ticketRow = await pool.query(`SELECT title FROM tickets WHERE id = $1`, [session.ticket_id]);
    response = await openai.responses.create({
      model: MODEL,
      tools: [tool],
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `You are remotely assisting with a support ticket on a ${session.environment} desktop: ` +
                `"${ticketRow.rows[0]?.title ?? "untitled"}". You can see the customer's screen below. Some ` +
                `tenants run this autonomously — your action may execute immediately with no human review, so ` +
                `treat every click/type/keypress/scroll/drag as if it will actually happen. Always pause and ` +
                `explain before anything irreversible (deleting a file, uninstalling software, or anything ` +
                `you cannot undo) — do not just do it. When you are done, respond with a message instead of ` +
                `another action, and start that message with exactly "RESOLVED:" if you fixed the issue, or ` +
                `"ESCALATE:" if you are stuck, unsure, or this needs a human's judgment.`,
            },
            { type: "input_image", image_url: outputScreenshot.image_url!, detail: "auto" },
          ],
        },
      ],
    });
  } else {
    // call_id and safety checks are batch-level (see file header) — pulled
    // from the session's pending_batch_* columns, NOT resolved.priorCallId/
    // safetyChecks (those reflect the just-finished individual action, whose
    // own __openai_safety_checks stash is always [] by design — see
    // dispatchAction). They happen to hold the same call_id either way (every
    // action in a batch is stamped with the shared id), but safety checks are
    // only ever captured at the batch level, so this is the one that's
    // actually correct.
    const outputItem: OpenAI.Responses.ResponseInputItem.ComputerCallOutput = {
      type: "computer_call_output",
      call_id: session.pending_batch_call_id ?? resolved.priorCallId!,
      output: outputScreenshot,
      acknowledged_safety_checks:
        session.pending_batch_safety_checks && session.pending_batch_safety_checks.length
          ? (session.pending_batch_safety_checks as unknown as OpenAI.Responses.ResponseComputerToolCallOutputItem.AcknowledgedSafetyCheck[])
          : undefined,
    };
    response = await openai.responses.create({
      model: MODEL,
      previous_response_id: session.openai_response_id,
      tools: [tool],
      input: [outputItem],
    });
  }

  await recordAudit({
    tenantId: session.tenant_id,
    actorType: "ai",
    eventType: "computer_use.step_completed",
    eventData: { model: MODEL, responseId: response.id },
    ticketId: session.ticket_id,
    deviceId: session.device_id,
  });

  const computerCall = response.output.find((item): item is OpenAI.Responses.ResponseComputerToolCall => item.type === "computer_call");

  if (!computerCall) {
    // No further action proposed — the model responded with a message
    // instead of another action. Persist the response id first (same
    // pattern dispatchAction uses for its own rejected-outcome branch) since
    // endSession()/endSessionResolved() below don't touch that column.
    await pool.query(`UPDATE computer_use_sessions SET openai_response_id = $1, updated_at = now() WHERE id = $2`, [response.id, session.id]);

    // Autonomous computer-use mode (docs/v0.1-computer-use-addendum.md): the
    // prompt requires a RESOLVED:/ESCALATE: prefix so this file — not free-
    // text parsing — decides whether the ticket gets flagged for a
    // technician. Anything that doesn't match either prefix is treated as
    // ESCALATE: an ambiguous ending must never be read as success.
    const text = response.output_text || "(computer-use session ended with no final message)";
    if (text.startsWith("RESOLVED:")) {
      await endSessionResolved(session, text);
    } else if (text.startsWith("ESCALATE:")) {
      await endSession(session, text);
    } else {
      await endSession(session, `model ended without a RESOLVED:/ESCALATE: prefix (treated as escalate): ${text}`);
    }
    return (await loadSession(sessionId))!;
  }

  // Normalize to a batch: a lone `action` is a batch of one, `actions[]` is
  // the current API's real shape. Either way, only the FIRST action gets
  // dispatched now — the rest sits in pending_batch_remaining until each
  // prior one resolves (see the mid-batch branch above).
  const rawActions: OpenAI.Responses.ComputerActionList =
    computerCall.actions && computerCall.actions.length > 0 ? computerCall.actions : computerCall.action ? [computerCall.action] : [];

  if (rawActions.length === 0) {
    await endSession(session, "model returned a computer_call with no action(s)");
    return (await loadSession(sessionId))!;
  }

  const [firstAction, ...restActions] = rawActions;
  await dispatchAction(session, response.id, firstAction, computerCall.call_id, restActions, computerCall.pending_safety_checks);

  return (await loadSession(sessionId))!;
}
