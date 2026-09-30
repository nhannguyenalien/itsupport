import { referenceHistory, DOCUMENT_INSTRUCTIONS, type Attachment } from "../documents/index.js";
import OpenAI from "openai";
import { pool } from "../db/pool.js";
import { allTools } from "../tool-registry/index.js";
import { allToolsAsOpenAiFunctions, fromOpenAiToolName } from "./schema.js";
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
      timeout: 45_000,
      maxRetries: 1,
      baseURL: process.env.OPENAI_BASE_URL, // optional — lets this point at any OpenAI-compatible endpoint
    });
  }
  return client;
}

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const SYSTEM_PROMPT = `You are an AI operations agent — either an AI Windows, macOS or Linux support agent diagnosing a
real Windows machine, or an AI marketing operations agent diagnosing an ads/tracking/analytics/CRM
account — using ONLY the tools provided to you for this ticket's target (shown below). You have no other
way to observe or affect it. Never claim something is fixed without verifying it: after any
state-changing tool call succeeds, the platform automatically re-checks the result via that tool's
verification chain — wait for that before telling the user it's resolved.

Rules:
- Reply in the same language as the user's latest substantive message. If it is Vietnamese, every
  user-facing sentence must be Vietnamese (tool identifiers may remain unchanged).
- Never expose or repeat internal role labels such as [ai], [user], [system], or [technician] in
  the user-facing response.
- The current tool-call and approval state in the newest system context is the source of truth.
  Never repeat an older assistant claim that an approval is pending after it has been approved,
  rejected, executed, or verified.
- Disk free space is NOT reclaimable space. Low free space does not prevent reclaiming
  20–30 GB. Only scanned candidates can support an estimate; a temp scan is not a full-disk scan.
- On macOS, only disk.usage, process.list and temp.scan are available. temp.clean is NOT
  supported by the installed agent. Explain this limitation before asking for approval;
  never offer to delete files, or recommend indiscriminate deletion of a temp directory.
- On Linux, disk.usage, system.info, process.list and service.status are available read-only diagnostics.
  service.restart is supported for application services with human approval and subsequent verification.
  Infrastructure services (SSH, networking, Proxmox/VMs, containers and the support agent) are protected.
  Never offer arbitrary shell commands, file deletion or unsupported Linux actions. Use system.info
  for CPU utilization, load averages and RAM. Load average is not CPU percent; compare it
  with cpu_count. Disk usage covers the requested filesystem, not every VM/storage pool.
  Terminal access for technicians is separate from these AI diagnostic tools.
- Reuse completed results for the current user request. Do not repeat the same read check.
- Prefer read tools first to understand the actual state before proposing a fix.
- When you call a state-changing tool, it may be held for human approval before it runs — that is
  expected and not an error; explain your reasoning so the approver has context.
- If a tool call fails or verification fails, try a different diagnosis or escalate — do not repeat
  the same failed action.
- A normal text response ENDS the workflow. Never use a text response to promise a later action
  (for example "I will check next" or "please wait"). If any requested check or action can still be
  performed with an available tool, call that tool now. Only return normal text when the request is
  genuinely complete, blocked by a pending human approval, or impossible with the available tools.
- Keep responses to the user concise and grounded in what the tools actually returned.`;

const DARWIN_AGENT_TOOLS = new Set(["disk.usage", "process.list", "temp.scan"]);

const LINUX_AGENT_TOOLS = new Set(["disk.usage", "system.info", "process.list", "service.status", "service.restart"]);

function deviceSupportsTool(platform: string, tool: string): boolean {
  const normalizedPlatform = platform.toLowerCase();
  if (normalizedPlatform === "mac" || normalizedPlatform === "darwin") return DARWIN_AGENT_TOOLS.has(tool);
  // The production agent's full IT support toolset is implemented on Windows.
  // Unknown/legacy Windows version strings are intentionally treated as Windows
  // so an older enrolled device is not silently stripped of its capabilities.
  if (normalizedPlatform === "linux") return LINUX_AGENT_TOOLS.has(tool);
  return true;
}

// Either a Windows device or a v0.2 marketing platform connection — exactly
// one, same as the tickets table's CHECK constraint. describeTarget() below is
// the one place that turns whichever it is into prompt text, so the two
// domains don't need their own parallel prompt-building code.
interface TicketTarget {
  device: { id: string; hostname: string; platform: string; os_version: string | null } | null;
  platform: { id: string; platform: string; external_account_id: string } | null;
}

function describeTarget(t: TicketTarget): string {
  if (t.device) return `Device: ${t.device.hostname} (${t.device.platform}; ${t.device.os_version ?? "version unknown"})`;
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
            d.id AS device_id, d.hostname, d.platform AS device_platform, d.os_version,
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
    `SELECT author_type, body, attachments, created_at FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [ticketId],
  );
  const toolCalls = await pool.query(
    `SELECT tool, params, result, result_data, error_message, verification_status, requested_at
     FROM tool_calls WHERE ticket_id = $1 AND parent_tool_call_id IS NULL ORDER BY requested_at DESC LIMIT 20`,
    [ticketId],
  );
  const approvals = await pool.query(
    `SELECT tool, params, status, reasoning, decided_at
     FROM approvals WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [ticketId],
  );

  const target: TicketTarget = {
    device: row.device_id
      ? { id: row.device_id, hostname: row.hostname, platform: row.device_platform, os_version: row.os_version }
      : null,
    platform: row.platform_connection_id
      ? { id: row.platform_connection_id, platform: row.platform, external_account_id: row.external_account_id }
      : null,
  };

  return {
    ticket: row as { id: string; title: string; status: string; tenant_id: string; ai_data_policy: AiDataPolicy },
    target,
    tenant: { id: row.tenant_id, ai_data_policy: row.ai_data_policy, autonomous_low_risk_enabled: row.autonomous_low_risk_enabled } as TenantRow,
    messages: messages.rows.reverse() as { author_type: string; body: string; attachments: Attachment[]; created_at: Date }[],
    toolCalls: toolCalls.rows.reverse() as {
      tool: string;
      requested_at: Date;
      params: unknown;
      result: string | null;
      result_data: unknown;
      error_message: string | null;
      verification_status: string;
    }[],
    approvals: approvals.rows.reverse() as {
      tool: string;
      params: unknown;
      status: "pending" | "approved" | "rejected";
      reasoning: string | null;
      decided_at: string | null;
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

  const chatHistory: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = referenceHistory(ctx.messages).map((m) => ({
    role: m.author_type === "ai" ? "assistant" : "user",
    content: String(applyDataPolicy(ctx.tenant.ai_data_policy, m.content)),
  }));
  const approvalHistory = ctx.approvals
    .map((a) => `- ${a.tool}(${JSON.stringify(a.params)}) -> ${a.status}${a.decided_at ? ` at ${a.decided_at}` : ""}`)
    .join("\n");

  return [
    { role: "system", content: SYSTEM_PROMPT + "\n" + DOCUMENT_INSTRUCTIONS },
    ...chatHistory,
    {
      role: "user",
      content:
        `Ticket: "${ctx.ticket.title}" (status: ${ctx.ticket.status})\n` +
        `${describeTarget(ctx.target)}\n\n` +
        `CURRENT AUTHORITATIVE STATE (newer than any chat message above):\n` +
        `Tool calls:\n${toolHistory || "(none yet)"}\n\n` +
        `Approvals:\n${approvalHistory || "(none)"}\n\n` +
        `Use this state, not old assistant status messages, when deciding what remains to do.`,
    },
  ];
}

export interface AiStepResult {
  action: "message" | "tool_call_requested" | "continue" | "no_op";
  detail: string;
}

export interface AiWorkflowResult extends AiStepResult {
  steps: number;
  stoppedBecause: "completed" | "approval_required" | "execution_timeout" | "step_limit" | "rejected";
}

/** Runs one step of the diagnostic loop: gathers context, asks the model for
 * either a message or a tool call, and — critically — dispatches any tool call
 * through requestToolCall() (tool-calls/service.ts), the exact same
 * policy-engine/approval path a human clicking the manual form goes through.
 * There is no separate "AI fast path" that skips approval. runAiWorkflow()
 * composes these safe single steps into a bounded one-click workflow. */
export async function runAiStep(ticketId: string): Promise<AiStepResult> {
  const ctx = await loadTicketForOrchestration(ticketId);
  if (!ctx) throw new Error("ticket not found");

  const latestUser = [...ctx.messages].reverse().find(m => m.author_type === "user");
  const checked = new Set(ctx.toolCalls.filter(call => latestUser &&
    new Date(call.requested_at) >= new Date(latestUser.created_at)).map(call => call.tool));
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
      allTools().filter((t) => !(t.risk === "read" && checked.has(t.tool))).filter((t) =>
        ctx.target.device
          // windows_desktop (computer-use addendum) tools are excluded here on
          // purpose: they're driven through the separate Responses API
          // computer_use_preview loop in ../computer-use/index.ts, not Chat
          // Completions function-calling — this model must never see them as
          // callable functions, it has no way to act on a computer_call result.
          ? t.domain !== "marketing" && t.domain !== "windows_desktop" &&
            deviceSupportsTool(ctx.target.device.platform, t.tool)
          : t.domain === "marketing" && (!t.platform || t.platform === "any" || t.platform === ctx.target.platform!.platform),
      ),
    ),
    tool_choice: "auto",
    parallel_tool_calls: false,
  });

  const choice = response.choices[0];
  const toolCall = choice.message.tool_calls?.[0];

  await recordAudit({
    tenantId: ctx.tenant.id,
    actorType: "ai",
    eventType: "ai_step.completed",
    // Token counts feed GET /metrics' ai_cost_per_ticket estimate — capture
    // them here where response.usage is in hand, since nothing persists the
    // raw completion.
    eventData: {
      model: MODEL,
      hasToolCall: Boolean(toolCall),
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
    },
    ticketId,
    deviceId: ctx.target.device?.id ?? null,
  });

  if (toolCall && toolCall.type === "function") {
    // toolCall.function.name comes back through the OpenAI-safe alphabet
    // (schema.ts's toOpenAiToolName) — convert back to our real "."-separated
    // tool name before it touches anything that looks it up in the registry.
    const toolName = fromOpenAiToolName(toolCall.function.name);
    if (checked.has(toolName) && allTools().some(t => t.tool === toolName && t.risk === "read")) {
      return { action: "continue", detail: "Đã có kết quả kiểm tra; sử dụng kết quả hiện có." };
    }
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(toolCall.function.arguments || "{}");
    } catch {
      // Model returned malformed JSON args — record what it said as a message
      // rather than silently dropping it or crashing the step.
      await pool.query(
        `INSERT INTO ticket_messages (ticket_id, author_type, body) VALUES ($1, 'ai', $2)`,
        [ticketId, `AI không thể tạo tham số hợp lệ cho ${toolName}; tác vụ chưa được thực hiện.`],
      );
      return { action: "no_op", detail: "AI tạo tham số không hợp lệ." };
    }

    const result = await requestToolCall({
      ticketId,
      initiatedBy: "ai",
      tool: toolName,
      params,
      reasoning: choice.message.content ?? undefined,
    });

    const summary =
      result.outcome === "auto_execute"
        ? `Đã gửi tác vụ ${toolName} tới thiết bị và đang chờ kết quả.`
        : result.outcome === "requires_approval"
          ? `Đã đề xuất tác vụ ${toolName}; cần bạn phê duyệt trước khi thực hiện.`
          : result.outcome === "rejected"
            ? `Tác vụ ${toolName} đã bị chặn: ${result.reason}`
            : `Không tìm thấy yêu cầu hỗ trợ để chạy ${toolName}.`;

    await pool.query(`INSERT INTO ticket_messages (ticket_id, author_type, body) VALUES ($1, 'ai', $2)`, [ticketId, summary]);
    return { action: "tool_call_requested", detail: summary };
  }

  const text = (choice.message.content ?? "AI chưa trả về nội dung.").replace(/^\s*\[(?:ai|assistant|system)\]\s*/i, "");
  // Models occasionally end a turn with a promise to perform another check
  // instead of issuing the tool call. Do not persist that misleading text or
  // stop the one-click workflow: immediately give the model another turn.
  const deferredAction = /(?:tôi|mình|chúng tôi)\s+sẽ|hãy\s+chờ|chờ\s+(?:một|trong|tôi)|i(?:'|’)ll\s+(?:check|run|scan|do)|please\s+wait|next,?\s+i(?:'|’)ll/i;
  if (deferredAction.test(text)) {
    return { action: "continue", detail: "AI còn bước cần thực hiện; tiếp tục tự động." };
  }
  await pool.query(`INSERT INTO ticket_messages (ticket_id, author_type, body) VALUES ($1, 'ai', $2)`, [ticketId, text]);
  return { action: "message", detail: text };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPendingExecutions(ticketId: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await pool.query(
      `SELECT NOT EXISTS(
         SELECT 1 FROM tool_calls
         WHERE ticket_id = $1
           AND parent_tool_call_id IS NULL
           AND (result IS NULL OR verification_status = 'pending')
       ) AS settled`,
      [ticketId],
    );
    if (result.rows[0]?.settled) return true;
    await delay(1000);
  }
  return false;
}

async function hasPendingExecution(ticketId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT EXISTS(
       SELECT 1 FROM tool_calls
       WHERE ticket_id = $1
         AND parent_tool_call_id IS NULL
         AND (result IS NULL OR verification_status = 'pending')
     ) AS pending`,
    [ticketId],
  );
  return Boolean(result.rows[0]?.pending);
}

/** Deterministically queue explicit, safe diagnostic requests before asking
 * the model to summarize. This prevents a probabilistic model turn from
 * silently skipping one of several checks the user named. */
async function queueExplicitReadChecks(ticketId: string): Promise<void> {
  const ctx = await loadTicketForOrchestration(ticketId);
  if (!ctx?.target.device) return;
  const latestUserMessage = [...ctx.messages].reverse().find((message) => message.author_type === "user")?.body ?? "";
  const requested = [
    { tool: "disk.usage", pattern: /dung\s*lượng|ổ\s*đĩa|disk\s*(?:space|usage)/i },
    { tool: "system.info", pattern: /quá\s*tải|qua\s*tai|\bcpu\b|\bram\b|bộ\s*nhớ|overload|memory|system\s*(?:load|info)|load\s*average/i },
    { tool: "process.list", pattern: /tiến\s*trình|process(?:es)?/i },
    { tool: "temp.scan", pattern: /tệp\s*tạm|file\s*tạm|temporary\s*files?|temp(?:orary)?\s*(?:scan|files?)/i },
  ];
  const latestUser = [...ctx.messages].reverse().find(message => message.author_type === "user");
  const alreadyRequested = new Set(ctx.toolCalls.filter(call => latestUser &&
    new Date(call.requested_at) >= new Date(latestUser.created_at)).map(call => call.tool));
  for (const check of requested) {
    if (!check.pattern.test(latestUserMessage) || alreadyRequested.has(check.tool)) continue;
    if (!deviceSupportsTool(ctx.target.device.platform, check.tool)) continue;
    await requestToolCall({
      ticketId,
      initiatedBy: "ai",
      tool: check.tool,
      params: {},
      reasoning: "Người dùng đã yêu cầu rõ kiểm tra chỉ-đọc này.",
    });
  }
}

/** Run read/diagnostic steps continuously from one user click. The workflow
 * deliberately stops at a human approval boundary; after approval the UI
 * starts another bounded workflow automatically. */
export async function runAiWorkflow(ticketId: string, maxSteps = 10): Promise<AiWorkflowResult> {
  let last: AiStepResult = { action: "no_op", detail: "Không có bước nào được thực hiện." };
  await queueExplicitReadChecks(ticketId);
  for (let step = 1; step <= maxSteps; step += 1) {
    // An approval creates the tool call before the UI resumes this workflow.
    // Wait for that execution + verification first, so the model never sees a
    // just-approved action as if it were still waiting for approval.
    if (await hasPendingExecution(ticketId)) {
      if (!(await waitForPendingExecutions(ticketId, 20_000))) {
        return { ...last, steps: step - 1, stoppedBecause: "execution_timeout" };
      }
    }
    last = await runAiStep(ticketId);
    if (last.action === "message") return { ...last, steps: step, stoppedBecause: "completed" };
    if (last.action === "no_op") return { ...last, steps: step, stoppedBecause: "rejected" };
    if (last.action === "continue") continue;

    const state = await pool.query(
      `SELECT EXISTS(SELECT 1 FROM approvals WHERE ticket_id = $1 AND status = 'pending') AS pending_approval`,
      [ticketId],
    );
    if (state.rows[0]?.pending_approval) {
      return { ...last, steps: step, stoppedBecause: "approval_required" };
    }
    if (!(await waitForPendingExecutions(ticketId, 20_000))) {
      return { ...last, steps: step, stoppedBecause: "execution_timeout" };
    }
  }
  return { ...last, steps: maxSteps, stoppedBecause: "step_limit" };
}
