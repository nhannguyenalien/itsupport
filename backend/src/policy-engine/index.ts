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

  if (tool.risk === "low" && ctx.tenantAutonomousLowRiskEnabled) {
    return { outcome: "auto_execute" };
  }

  return { outcome: "requires_approval" };
}

export function riskOf(toolName: string): ToolRisk | undefined {
  return getTool(toolName)?.risk;
}
