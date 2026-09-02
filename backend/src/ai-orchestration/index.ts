import OpenAI from "openai";
import { pool } from "../db/pool.js";
import { allTools } from "../tool-registry/index.js";
import { allToolsAsOpenAiFunctions } from "./schema.js";
import { applyDataPolicy, type AiDataPolicy } from "./redact.js";
import { requestToolCall } from "../tool-calls/service.js";
import { recordAudit } from "../audit/index.js";

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is not set — AI orchestration is wired but has no model to call. " +
        "This is expected in v0.1 until a real key is provided; see docs/v0.1-spec.md status.",
    );
  }
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL, // optional — lets this point at any OpenAI-compatible endpoint
    });
  }
  return client;
}

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const SYSTEM_PROMPT = `You are an AI operations agent — either an AI Windows support agent diagnosing a
real Windows machine, or an AI marketing operations agent diagnosing an ads/tracking/analytics/CRM
account — using ONLY the tools provided to you for this ticket's target (shown below). You have no other
way to observe or affect it. Never claim something is fixed without verifying it: after any
state-changing tool call succeeds, the platform automatically re-checks the result via that tool's
verification chain — wait for that before telling the user it's resolved.

Rules:
- Prefer read tools first to understand the actual state before proposing a fix.
- When you call a state-changing tool, it may be held for human approval before it runs — that is
  expected and not an error; explain your reasoning so the approver has context.
- If a tool call fails or verification fails, try a different diagnosis or escalate — do not repeat
  the same failed action.
- Keep responses to the user concise and grounded in what the tools actually returned.`;

// Either a Windows device or a v0.2 marketing platform connection — exactly
// one, same as the tickets table's CHECK constraint. describeTarget() below is
// the one place that turns whichever it is into prompt text, so the two
// domains don't need their own parallel prompt-building code.
interface TicketTarget {
  device: { id: string; hostname: string; os_version: string | null } | null;
  platform: { id: string; platform: string; external_account_id: string } | null;
}

function describeTarget(t: TicketTarget): string {
  if (t.device) return `Device: ${t.device.hostname} (${t.device.os_version ?? "unknown OS"})`;
  if (t.platform) return `Platform account: ${t.platform.platform} / ${t.platform.external_account_id}`;
  throw new Error("ticket has neither a device nor a platform_connection target — should be impossible (see schema CHECK)");
}

interface TenantRow {
  id: string;
  ai_data_policy: AiDataPolicy;
  autonomous_low_risk_enabled: boolean;
}

async function loadTicketForOrchestration(ticketId: string) {
  const ticketRes = await pool.query(
    `SELECT t.*,
            d.id AS device_id, d.hostname, d.os_version,
            pc.id AS platform_connection_id, pc.platform, pc.external_account_id,
            tn.id AS tenant_id, tn.ai_data_policy, tn.autonomous_low_risk_enabled
     FROM tickets t
     LEFT JOIN devices d ON d.id = t.device_id
     LEFT JOIN platform_connections pc ON pc.id = t.platform_connection_id
     JOIN tenants tn ON tn.id = t.tenant_id
     WHERE t.id = $1`,
    [ticketId],
  );
  if (ticketRes.rowCount === 0) return null;
  const row = ticketRes.rows[0];

  const messages = await pool.query(
    `SELECT author_type, body FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC LIMIT 50`,
    [ticketId],
  );
  const toolCalls = await pool.query(
    `SELECT tool, params, result, result_data, error_message, verification_status
     FROM tool_calls WHERE ticket_id = $1 AND parent_tool_call_id IS NULL ORDER BY requested_at ASC LIMIT 20`,
    [ticketId],
  );

  const target: TicketTarget = {
    device: row.device_id ? { id: row.device_id, hostname: row.hostname, os_version: row.os_version } : null,
    platform: row.platform_connection_id
      ? { id: row.platform_connection_id, platform: row.platform, external_account_id: row.external_account_id }
      : null,
  };

  return {
    ticket: row as { id: string; title: string; status: string; tenant_id: string; ai_data_policy: AiDataPolicy },
    target,
    tenant: { id: row.tenant_id, ai_data_policy: row.ai_data_policy, autonomous_low_risk_enabled: row.autonomous_low_risk_enabled } as TenantRow,
    messages: messages.rows as { author_type: string; body: string }[],
    toolCalls: toolCalls.rows as {
      tool: string;
      params: unknown;
      result: string | null;
      result_data: unknown;
      error_message: string | null;
      verification_status: string;
    }[],
  };
}

function buildMessages(ctx: NonNullable<Awaited<ReturnType<typeof loadTicketForOrchestration>>>): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const toolHistory = ctx.toolCalls
    .map((tc) => {
      // Data-privacy preprocessing: docs/v0.1-spec.md "Data privacy v0.1" —
      // redact before this ever reaches the prompt, not after.
      const redacted = applyDataPolicy(ctx.tenant.ai_data_policy, tc.result_data);
      const outcome = tc.result ? `${tc.result}${tc.error_message ? `: ${tc.error_message}` : ""}` : "pending";
      return `- ${tc.tool}(${JSON.stringify(tc.params)}) -> ${outcome}` +
        (tc.result_data ? ` | data: ${JSON.stringify(redacted)}` : "") +
        (tc.verification_status !== "not_required" ? ` | verification: ${tc.verification_status}` : "");
    })
    .join("\n");

  const chatHistory: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = ctx.messages.map((m) => ({
    role: m.author_type === "ai" ? "assistant" : "user",
    content: `[${m.author_type}] ${m.body}`,
  }));

  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Ticket: "${ctx.ticket.title}" (status: ${ctx.ticket.status})\n` +
        `${describeTarget(ctx.target)}\n\n` +
        `Tool calls so far:\n${toolHistory || "(none yet)"}`,
    },
    ...chatHistory,
  ];
}

export interface AiStepResult {
  action: "message" | "tool_call_requested" | "no_op";
  detail: string;
}

/** Runs ONE step of the diagnostic loop: gathers context, asks the model for
 * either a message or a tool call, and — critically — dispatches any tool call
 * through requestToolCall() (tool-calls/service.ts), the exact same
 * policy-engine/approval path a human clicking the manual form goes through.
 * There is no separate "AI fast path" that skips approval. Not a loop that
 * runs to completion on its own in v0.1 — one step per call, triggered by
 * POST /tickets/:id/ai-step; a real autonomous loop (poll new tickets, keep
 * stepping until resolved/escalated) is unbuilt, flagged in README not hidden. */
export async function runAiStep(ticketId: string): Promise<AiStepResult> {
  const ctx = await loadTicketForOrchestration(ticketId);
  if (!ctx) throw new Error("ticket not found");

  const openai = getClient(); // throws clearly if no API key — caller surfaces this as an error, not a fake result

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: buildMessages(ctx),
    // Scope the function-calling tool list to what's actually relevant to this
    // ticket's target — a Windows ticket never sees marketing tools and vice
    // versa, and a marketing ticket only sees tools for the platform it's
    // actually connected to (or cross-platform "any" ones). Keeps the
    // function-calling context tight regardless of how big registry.json
    // grows, and stops the model from ever proposing a tool with no way to
    // execute against this ticket's target.
    tools: allToolsAsOpenAiFunctions(
      allTools().filter((t) =>
        ctx.target.device
          ? t.domain !== "marketing"
          : t.domain === "marketing" && (!t.platform || t.platform === "any" || t.platform === ctx.target.platform!.platform),
      ),
    ),
    tool_choice: "auto",
  });

  const choice = response.choices[0];
  const toolCall = choice.message.tool_calls?.[0];

  await recordAudit({
    tenantId: ctx.tenant.id,
    actorType: "ai",
    eventType: "ai_step.completed",
    eventData: { model: MODEL, hasToolCall: Boolean(toolCall) },
    ticketId,
    deviceId: ctx.target.device?.id ?? null,
  });

  if (toolCall && toolCall.type === "function") {
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(toolCall.function.arguments || "{}");
    } catch {
      // Model returned malformed JSON args — record what it said as a message
      // rather than silently dropping it or crashing the step.
      await pool.query(
        `INSERT INTO ticket_messages (ticket_id, author_type, body) VALUES ($1, 'ai', $2)`,
        [ticketId, `Tried to call ${toolCall.function.name} but produced invalid arguments: ${toolCall.function.arguments}`],
      );
      return { action: "no_op", detail: "malformed tool arguments from model" };
    }

    const result = await requestToolCall({
      ticketId,
      initiatedBy: "ai",
      tool: toolCall.function.name,
      params,
      reasoning: choice.message.content ?? undefined,
    });

    const summary =
      result.outcome === "auto_execute"
        ? `Ran ${toolCall.function.name} (${JSON.stringify(params)}).`
        : result.outcome === "requires_approval"
          ? `Proposed ${toolCall.function.name} (${JSON.stringify(params)}) — awaiting approval.`
          : result.outcome === "rejected"
            ? `Tried ${toolCall.function.name} but it was rejected: ${result.reason}`
            : `Tried ${toolCall.function.name} but the ticket could not be found.`;

    await pool.query(`INSERT INTO ticket_messages (ticket_id, author_type, body) VALUES ($1, 'ai', $2)`, [ticketId, summary]);
    return { action: "tool_call_requested", detail: summary };
  }

  const text = choice.message.content ?? "(no response)";
  await pool.query(`INSERT INTO ticket_messages (ticket_id, author_type, body) VALUES ($1, 'ai', $2)`, [ticketId, text]);
  return { action: "message", detail: text };
}
