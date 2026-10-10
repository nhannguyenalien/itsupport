import { getTool, type ToolRisk } from "../tool-registry/index.js";
import type { AiDataPolicy } from "../ai-orchestration/redact.js";

export type PolicyDecision =
  | { outcome: "auto_execute" }
  | { outcome: "requires_approval" }
  | { outcome: "rejected"; reason: string };

export interface PolicyContext {
  initiatedBy: "ai" | "human";
  tenantAiEnabled: boolean;
  tenantAutonomousLowRiskEnabled: boolean;
  deviceActionsPaused: boolean;
  // Computer-use addendum (docs/v0.1-computer-use-addendum.md) — needed to
  // gate domain:"windows_desktop" tools off entirely for a tenant that opted
  // out of screenshots, since pixel data can't be redacted the way text
  // results are (see ai-orchestration/redact.ts).
  tenantAiDataPolicy: AiDataPolicy;
  // Autonomous computer-use mode (docs/v0.1-computer-use-addendum.md) —
  // separate opt-in from tenantAutonomousLowRiskEnabled below (that one only
  // ever unlocks risk:"low" tools; computer-use writes are risk:"high" by
  // design). Only meaningful for domain:"windows_desktop" write tools.
  computerUseAutonomousEnabled: boolean;
  // Set true only for desktop.type calls whose text contains a Luhn-valid
  // card-number-length digit run (tool-calls/service.ts computes this via
  // luhn.ts before calling evaluate() — the same "compute special-case
  // context in service.ts, consume it here" pattern as budgetChange below).
  // Unconditional hard block regardless of computerUseAutonomousEnabled.
  looksLikePaymentCardNumber?: boolean;
  // docs/v0.3-linux-shell-addendum.md — required for shell.run, absent for every
  // other tool. `enabled` is tenant flag AND device flag; `class` comes from
  // shell-run/classify.ts (the agent re-classifies independently).
  shell?: { enabled: boolean; class: "read" | "write" | "deny"; reason?: string };
  // v0.2 marketing-ops — only relevant (and only required) for ads.budget.update.
  // Absent for every v0.1 Windows tool call, and for every other marketing tool.
  budgetChange?: {
    currentCents: number;
    requestedCents: number;
    absoluteLimitCents: number | null; // tenants.absolute_budget_limit_cents
  };
  tenantBudgetPolicy?: {
    autoPctLimit: number; // tenants.budget_auto_pct_limit
    approvalPctLimit: number; // tenants.budget_approval_pct_limit
  };
}

/**
 * The 4-level policy engine referenced in the spec, keyed off each tool's `risk`
 * in registry.json (read / low / medium / high). This is the ONLY place that
 * decides auto-execute vs. approval vs. reject — routes must call this rather
 * than re-deriving the logic, so a future policy change is a one-file edit.
 *
 * v0.1 rules (see docs/v0.1-spec.md "Autonomy default: OFF for writes"):
 *  - read:            always auto-execute. Ignores device pause (spec: pausing a
 *                      device blocks WRITE actions, not diagnosis).
 *  - low/medium/high: blocked outright if the device is paused.
 *                      otherwise requires human approval UNLESS risk === 'low'
 *                      AND the tenant has explicitly opted into autonomous
 *                      low-risk remediation. medium/high NEVER auto-execute in
 *                      v0.1, even with that opt-in — only low does. Exception:
 *                      domain:"windows_desktop" (computer-use) risk:"high"
 *                      tools auto-execute if the tenant separately opted into
 *                      computerUseAutonomousEnabled — UNLESS the action looks
 *                      like it's typing a real card number (Luhn check), which
 *                      always requires approval regardless of that opt-in. See
 *                      docs/v0.1-computer-use-addendum.md.
 *  - AI-initiated calls are rejected outright if the tenant has disabled AI
 *    (kill switch). Human-initiated calls (e.g. a technician manually running a
 *    read tool from the dashboard) are unaffected by that switch.
 */
export function evaluate(toolName: string, ctx: PolicyContext): PolicyDecision {
  const tool = getTool(toolName);
  if (!tool) {
    // Must never happen if callers validate against the registry first, but the
    // policy engine itself refuses unknown tools too — defense in depth, same
    // principle as the agent-side compile-time allowlist rejecting unknown tools.
    return { outcome: "rejected", reason: `unknown tool "${toolName}"` };
  }

  if (ctx.initiatedBy === "ai" && !ctx.tenantAiEnabled) {
    return { outcome: "rejected", reason: "tenant AI is disabled" };
  }

  if (tool.domain === "windows_desktop" && ctx.tenantAiDataPolicy === "no_screenshots") {
    // Checked before the "read always auto-executes" shortcut below —
    // desktop.screenshot is itself risk:"read" and must not slip past this.
    return { outcome: "rejected", reason: "tenant's AI data policy (no_screenshots) blocks computer-use tools" };
  }

  if (toolName === "shell.run") return evaluateShell(ctx);

  if (tool.risk === "read") {
    return { outcome: "auto_execute" };
  }

  // From here on, tool.risk is low/medium/high — a write action.
  if (ctx.deviceActionsPaused) {
    return { outcome: "rejected", reason: "device actions are paused" };
  }

  // Autonomous computer-use mode (docs/v0.1-computer-use-addendum.md) — a
  // separate opt-in from the general risk==="low" autonomy check below, since
  // every computer-use write action is risk:"high" by design. The payment
  // hard-block is unconditional: even an autonomous tenant still needs a
  // human to approve a desktop.type that looks like a real card number.
  if (tool.domain === "windows_desktop" && tool.risk === "high") {
    if (ctx.looksLikePaymentCardNumber) {
      return { outcome: "requires_approval" };
    }
    if (ctx.computerUseAutonomousEnabled) {
      return { outcome: "auto_execute" };
    }
  }

  if (toolName === "ads.budget.update") {
    return evaluateBudgetChange(ctx);
  }

  if (tool.risk === "low" && ctx.tenantAutonomousLowRiskEnabled) {
    return { outcome: "auto_execute" };
  }

  return { outcome: "requires_approval" };
}

/**
 * shell.run (docs/v0.3-linux-shell-addendum.md): the per-command class decides.
 * read auto-executes (like any read tool it ignores the pause flag), write
 * always needs a human — tenant autonomy never promotes it — and deny is
 * rejected outright. Disabled tenant/device means nothing runs at all.
 */
function evaluateShell(ctx: PolicyContext): PolicyDecision {
  if (!ctx.shell) return { outcome: "rejected", reason: "shell.run context missing" };
  if (!ctx.shell.enabled) return { outcome: "rejected", reason: "shell.run is not enabled for this tenant and device" };
  if (ctx.shell.class === "deny") return { outcome: "rejected", reason: ctx.shell.reason ?? "this command is never allowed" };
  if (ctx.shell.class === "read") return { outcome: "auto_execute" };
  if (ctx.deviceActionsPaused) return { outcome: "rejected", reason: "device actions are paused" };
  return { outcome: "requires_approval" };
}

/**
 * docs/v0.2-marketing-ops-spec.md section 12's literal example only states three
 * bands explicitly — decrease<=10% auto, increase 10-25% approval, increase >25%
 * never offered. It doesn't state a band for "decrease beyond 10%" or "increase
 * <=10%" by name, so this fills those gaps by the most defensible reading:
 * any change (either direction) within autoPctLimit is auto (spending LESS is
 * never treated as more dangerous than spending the same), any increase beyond
 * approvalPctLimit is rejected outright (never auto, never even offered as an
 * approval — a hard ceiling, unlike ordinary "high risk" IT tools which still
 * get an approval path), and everything else needs a human. Confirm this
 * interpretation with the user rather than assuming it's exactly what they meant.
 */
function evaluateBudgetChange(ctx: PolicyContext): PolicyDecision {
  if (!ctx.budgetChange || !ctx.tenantBudgetPolicy) {
    // Missing context is a caller bug (service.ts must always supply this for
    // ads.budget.update), not something to silently default past.
    return { outcome: "rejected", reason: "budget policy context missing for ads.budget.update" };
  }
  const { currentCents, requestedCents, absoluteLimitCents } = ctx.budgetChange;
  const { autoPctLimit, approvalPctLimit } = ctx.tenantBudgetPolicy;

  if (absoluteLimitCents !== null && requestedCents > absoluteLimitCents) {
    return { outcome: "rejected", reason: `requested budget exceeds the tenant's absolute limit (${absoluteLimitCents} cents)` };
  }
  if (currentCents <= 0) {
    return { outcome: "rejected", reason: "current budget is zero or unknown — cannot compute a percentage change" };
  }

  const pctChange = ((requestedCents - currentCents) / currentCents) * 100;
  const isIncrease = pctChange > 0;

  if (Math.abs(pctChange) <= autoPctLimit) {
    return ctx.tenantAutonomousLowRiskEnabled
      ? { outcome: "auto_execute" }
      : { outcome: "requires_approval" }; // same autonomy opt-in gate as every other "low" tool
  }
  if (!isIncrease) {
    // Any decrease beyond autoPctLimit: never rejected (spending less is never
    // the dangerous direction) but not auto either — human confirms the size.
    return { outcome: "requires_approval" };
  }
  if (pctChange <= approvalPctLimit) {
    return { outcome: "requires_approval" };
  }
  return { outcome: "rejected", reason: `budget increase of ${pctChange.toFixed(1)}% exceeds the ${approvalPctLimit}% approval ceiling — not offered, needs a human acting outside this system` };
}

export function riskOf(toolName: string): ToolRisk | undefined {
  return getTool(toolName)?.risk;
}
