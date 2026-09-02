import { getTool, type ToolRisk } from "../tool-registry/index.js";

export type PolicyDecision =
  | { outcome: "auto_execute" }
  | { outcome: "requires_approval" }
  | { outcome: "rejected"; reason: string };

export interface PolicyContext {
  initiatedBy: "ai" | "human";
  tenantAiEnabled: boolean;
  tenantAutonomousLowRiskEnabled: boolean;
  deviceActionsPaused: boolean;
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
 *                      v0.1, even with that opt-in — only low does.
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

  if (tool.risk === "read") {
    return { outcome: "auto_execute" };
  }

  // From here on, tool.risk is low/medium/high — a write action.
  if (ctx.deviceActionsPaused) {
    return { outcome: "rejected", reason: "device actions are paused" };
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
