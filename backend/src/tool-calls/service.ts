import { pool } from "../db/pool.js";
import { getTool, isKnownTool } from "../tool-registry/index.js";
import { evaluate } from "../policy-engine/index.js";
import { recordAudit } from "../audit/index.js";
import { isOAuthPlatform } from "../oauth/providers.js";
import { executeMarketingTool } from "../platform-clients/executor.js";
import type { AiDataPolicy } from "../ai-orchestration/redact.js";
import { looksLikePaymentCardNumber } from "../policy-engine/luhn.js";
import { classifyShell, type ShellVerdict } from "../shell-run/classify.js";

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
  device_platform?: string;
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
  ai_data_policy: AiDataPolicy;
  autonomous_low_risk_enabled: boolean;
  computer_use_autonomous_enabled: boolean;
  budget_auto_pct_limit: number;
  budget_approval_pct_limit: number;
  absolute_budget_limit_cents: number | null;
  shell_run_enabled: boolean; // tenant flag AND device flag (both default off)
}

/** Loads whatever the ticket actually targets (Windows device or marketing
 * platform connection — see tickets table's CHECK constraint) into one shape
 * so the rest of this file doesn't need two parallel code paths. LEFT JOINs
 * both sides and picks whichever is non-null; COALESCE handles the
 * paused/blocked flags so callers get one boolean regardless of target type. */
async function loadTicketContext(ticketId: string): Promise<TicketContext | undefined> {
  const row = await pool.query(
    `SELECT t.id AS ticket_id, t.tenant_id, t.device_id, t.platform_connection_id, d.platform AS device_platform,
            COALESCE(d.actions_paused, pc.actions_paused, false) AS actions_paused,
            COALESCE(d.cert_revoked_at IS NOT NULL, pc.status IS DISTINCT FROM 'active', false) AS target_blocked,
            tn.ai_enabled, tn.ai_data_policy, tn.autonomous_low_risk_enabled, tn.computer_use_autonomous_enabled,
            tn.budget_auto_pct_limit, tn.budget_approval_pct_limit, tn.absolute_budget_limit_cents,
            (tn.shell_run_enabled AND COALESCE(d.shell_run_enabled, false)) AS shell_run_enabled
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
    device_platform: r.device_platform,
    tenant_id: r.tenant_id,
    target_device_id: r.device_id,
    target_platform_connection_id: r.platform_connection_id,
    actions_paused: r.actions_paused,
    target_blocked: r.target_blocked,
    ai_enabled: r.ai_enabled,
    ai_data_policy: r.ai_data_policy,
    autonomous_low_risk_enabled: r.autonomous_low_risk_enabled,
    computer_use_autonomous_enabled: r.computer_use_autonomous_enabled,
    budget_auto_pct_limit: Number(r.budget_auto_pct_limit),
    budget_approval_pct_limit: Number(r.budget_approval_pct_limit),
    absolute_budget_limit_cents: r.absolute_budget_limit_cents === null ? null : Number(r.absolute_budget_limit_cents),
    shell_run_enabled: r.shell_run_enabled === true,
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
  if (tool.domain === "agent") {
    // Agent updates only come from the device page's update button.
    return { outcome: "rejected", reason: "Agent updates are started from the Devices page" };
  }
  // "__"-prefixed params are reserved for the backend (e.g. __approved, set
  // only on the pending-call response for a human-approved shell.run).
  if (Object.keys(input.params).some((key) => key.startsWith("__"))) {
    return { outcome: "rejected", reason: "parameter names starting with __ are reserved" };
  }
  let shellVerdict: ShellVerdict | undefined;
  if (input.tool === "shell.run") {
    const checked = validateShellParams(input.params);
    if ("error" in checked) return { outcome: "rejected", reason: checked.error };
    shellVerdict = checked.verdict;
  }
  if (input.tool.startsWith("package.") &&
      (typeof input.params.package_name !== "string" || !/^[a-z0-9][a-z0-9+.-]{1,127}$/.test(input.params.package_name))) {
    return { outcome: "rejected", reason: "package_name must be one exact Linux repository package name" };
  }

  const ctx = await loadTicketContext(input.ticketId);
  if (!ctx) return { outcome: "not_found" };
  if (tool.domain === "linux" && ctx.device_platform?.toLowerCase() !== "linux") {
    return { outcome: "rejected", reason: "This tool requires a Linux device" };
  }
  if (tool.domain === "windows" && ["mac", "linux"].includes(ctx.device_platform?.toLowerCase() ?? "")) {
    return { outcome: "rejected", reason: "This tool requires a Windows device" };
  }
  if (ctx.target_blocked) {
    return { outcome: "rejected", reason: ctx.target_device_id ? "device is revoked" : "platform connection is not active" };
  }

  // A human approval must never be enough to terminate a critical Windows
  // process. Resolve the requested PID from the latest process.list result
  // and reject it before an approval/tool-call row can be created. The agent
  // independently enforces the same denylist as a second line of defence.
  if (input.tool === "process.kill") {
    const pid = Number(input.params.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return { outcome: "rejected", reason: "process.kill yêu cầu PID là một số nguyên dương" };
    }
    const latestProcesses = await pool.query(
      `SELECT result_data FROM tool_calls
       WHERE ticket_id = $1 AND tool = 'process.list' AND result = 'success'
       ORDER BY executed_at DESC NULLS LAST LIMIT 1`,
      [input.ticketId],
    );
    const processes = latestProcesses.rows[0]?.result_data?.processes;
    const process = Array.isArray(processes)
      ? processes.find((item: Record<string, unknown>) => Number(item.pid) === pid)
      : undefined;
    const name = typeof process?.name === "string" ? process.name.toLowerCase() : "";
    const protectedProcesses = new Set([
      "system", "registry", "smss.exe", "csrss.exe", "wininit.exe", "services.exe",
      "lsass.exe", "winlogon.exe", "svchost.exe", "dwm.exe", "fontdrvhost.exe",
    ]);
    if (pid <= 4 || protectedProcesses.has(name)) {
      return { outcome: "rejected", reason: `Không thể dừng tiến trình Windows được bảo vệ${name ? `: ${name}` : ""}` };
    }
  }

  // browser.open_url (v0.2 OAuth-assist): the url the agent will open is
  // ALWAYS computed here, never taken from the caller — a compromised or
  // careless caller must not be able to make an enrolled device's browser
  // open an arbitrary link. Requires a device target (the tool has no
  // meaning against a platform_connection — there's no Windows agent polling
  // for platform-targeted calls to run it).
  if (input.tool === "browser.open_url") {
    if (!ctx.target_device_id) {
      return { outcome: "rejected", reason: "browser.open_url requires a device-targeted ticket" };
    }
    const platform = input.params.platform;
    const externalAccountId = input.params.external_account_id;
    if (typeof platform !== "string" || !isOAuthPlatform(platform)) {
      return { outcome: "rejected", reason: `browser.open_url requires a known platform, got ${JSON.stringify(platform)}` };
    }
    if (typeof externalAccountId !== "string" || !externalAccountId) {
      return { outcome: "rejected", reason: "browser.open_url requires a non-empty external_account_id" };
    }
    const base = process.env.OAUTH_REDIRECT_BASE_URL;
    if (!base) {
      return { outcome: "rejected", reason: "OAUTH_REDIRECT_BASE_URL is not configured on the backend" };
    }
    input.params = {
      platform,
      external_account_id: externalAccountId,
      url: `${base.replace(/\/$/, "")}/oauth/${platform}/connect?tenantId=${ctx.tenant_id}&externalAccountId=${encodeURIComponent(externalAccountId)}`,
    };
  }

  // desktop.open_customer_view — same never-trust-the-caller principle as
  // browser.open_url above: the url is always computed here from the
  // frontend's own base URL + this ticket's id, never taken from the caller.
  // System-triggered only (computer-use/index.ts's startSession()), never
  // something the AI model itself decides to call.
  if (input.tool === "desktop.open_customer_view") {
    if (!ctx.target_device_id) {
      return { outcome: "rejected", reason: "desktop.open_customer_view requires a device-targeted ticket" };
    }
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3001";
    input.params = { url: `${frontendUrl.replace(/\/$/, "")}/tickets/${input.ticketId}/customer` };
  }

  // Autonomous computer-use mode (docs/v0.1-computer-use-addendum.md) — the
  // Luhn check runs here, not inside policy-engine/index.ts, following the
  // same "compute special-case context in service.ts" shape as
  // ads.budget.update below. Unconditional hard block: even a tenant with
  // computer_use_autonomous_enabled still needs a human to approve typing
  // something that looks like a real card number.
  let typedTextLooksLikeCardNumber = false;
  if (input.tool === "desktop.type" && typeof input.params.text === "string") {
    typedTextLooksLikeCardNumber = looksLikePaymentCardNumber(input.params.text);
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

  const auditExtra = shellVerdict
    ? { argv: input.params.argv, class: shellVerdict.class, rule: shellVerdict.rule }
    : {};
  const decision = evaluate(input.tool, {
    initiatedBy: input.initiatedBy,
    tenantAiEnabled: ctx.ai_enabled,
    tenantAiDataPolicy: ctx.ai_data_policy,
    tenantAutonomousLowRiskEnabled: ctx.autonomous_low_risk_enabled,
    computerUseAutonomousEnabled: ctx.computer_use_autonomous_enabled,
    looksLikePaymentCardNumber: typedTextLooksLikeCardNumber,
    deviceActionsPaused: ctx.actions_paused,
    shell: shellVerdict ? { enabled: ctx.shell_run_enabled, class: shellVerdict.class, reason: shellVerdict.reason } : undefined,
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
      eventData: { tool: input.tool, reason: decision.reason, ...auditExtra },
      ticketId: input.ticketId,
      deviceId: ctx.target_device_id,
    });
    return { outcome: "rejected", reason: decision.reason };
  }

  if (decision.outcome === "requires_approval") {
    const approval = await pool.query(
      `INSERT INTO approvals (ticket_id, tool, params, proposed_by_ai, reasoning)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.ticketId, input.tool, JSON.stringify(input.params), input.initiatedBy === "ai",
        input.reasoning ?? (input.tool === "shell.run" ? String(input.params.purpose) : null)],
    );
    await recordAudit({
      tenantId: ctx.tenant_id,
      actorType: input.initiatedBy === "ai" ? "ai" : "user",
      actorId: input.actorId ?? null,
      eventType: "approval.requested",
      eventData: { tool: input.tool, risk: tool.risk, ...auditExtra },
      ticketId: input.ticketId,
      deviceId: ctx.target_device_id,
    });
    return { outcome: "requires_approval", approval: approval.rows[0] };
  }

  // auto_execute
  const call = await pool.query(
    `INSERT INTO tool_calls (ticket_id, device_id, platform_connection_id, tool, risk, params)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    // A read-class shell.run is stored as risk "read" so it is not treated as
    // a state change (no verification chain); a write-class one never gets here.
    [input.ticketId, ctx.target_device_id, ctx.target_platform_connection_id, input.tool, shellVerdict?.class === "read" ? "read" : tool.risk, JSON.stringify(input.params)],
  );
  await recordAudit({
    tenantId: ctx.tenant_id,
    actorType: input.initiatedBy === "ai" ? "ai" : "user",
    actorId: input.actorId ?? null,
    eventType: "tool_call.queued",
    eventData: { tool: input.tool, ...auditExtra },
    ticketId: input.ticketId,
    deviceId: ctx.target_device_id,
  });

  // Marketing tools have no separate device to poll for work — the backend
  // has direct API access via the tenant's stored token, so it just runs the
  // call right here. Windows tools stay async (the agent polls
  // /devices/:id/tool-calls/pending and reports back), unaffected. Errors are
  // caught inside executeMarketingTool and recorded on the row, never thrown
  // here — this function's return value describes the ADMISSION decision,
  // not execution outcome; check the tool_calls row (or re-fetch the ticket)
  // for what actually happened.
  if (ctx.target_platform_connection_id) {
    await executeMarketingTool(call.rows[0].id, input.tool, input.params, ctx.target_platform_connection_id, ctx.tenant_id);
  }

  return { outcome: "auto_execute", toolCall: call.rows[0] };
}

const SHELL_PARAM_KEYS = new Set(["argv", "purpose", "verify_argv"]);

/** shell.run input checks that must hold before classification matters:
 * exact shape (no extra keys), a purpose for the approver, and — for any
 * command that is not read-only — a read-only verify_argv so success is
 * proven by the machine, never by the model's say-so. */
function validateShellParams(params: Record<string, unknown>): { verdict: ShellVerdict } | { error: string } {
  const isArgv = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (Object.keys(params).some((key) => !SHELL_PARAM_KEYS.has(key))) {
    return { error: "shell.run accepts only argv, purpose and verify_argv" };
  }
  if (!isArgv(params.argv) || params.argv.length === 0) return { error: "argv must be a non-empty array of strings" };
  if (typeof params.purpose !== "string" || params.purpose.trim() === "" || params.purpose.length > 300) {
    return { error: "purpose must be one short sentence for the approver" };
  }
  const verdict = classifyShell(params.argv);
  if (verdict.class === "write") {
    if (!isArgv(params.verify_argv) || params.verify_argv.length === 0) {
      return { error: "a command that is not read-only must include verify_argv (a read-only command that proves it worked)" };
    }
    if (classifyShell(params.verify_argv).class !== "read") return { error: "verify_argv must itself be a read-only command" };
  } else if (params.verify_argv !== undefined && !isArgv(params.verify_argv)) {
    return { error: "verify_argv must be an array of strings" };
  }
  return { verdict };
}
