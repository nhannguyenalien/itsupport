"use client";

import { useEffect, useState } from "react";
import { useTenant } from "@/lib/useTenant";
import { api, type Metrics } from "@/lib/api";

function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(1)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export default function MetricsPage() {
  const { tenantId, ready } = useTenant();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    async function load() {
      try {
        const m = await api.getMetrics(tenantId!);
        if (!cancelled) setMetrics(m);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }
    load();
    // Same poll cadence as the other dashboards — no push layer yet.
    const interval = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tenantId]);

  if (!ready) return null;
  if (!tenantId) return <p>Select a tenant on the Home page first.</p>;

  const tiles: { label: string; value: string; hint?: string }[] = metrics
    ? [
        { label: "Tickets", value: String(metrics.tickets_total) },
        {
          label: "AI-resolved",
          value: String(metrics.tickets_ai_resolved),
          hint:
            metrics.tickets_total > 0
              ? pct(metrics.tickets_ai_resolved / metrics.tickets_total) + " of all tickets"
              : undefined,
        },
        { label: "Escalated", value: String(metrics.tickets_escalated) },
        { label: "Avg resolution time", value: duration(metrics.avg_resolution_seconds) },
        { label: "Remediation success", value: pct(metrics.remediation_success_rate), hint: "verified fixes" },
        { label: "Approval rate", value: pct(metrics.approval_rate), hint: `${metrics.approvals_total} requested` },
        {
          label: "Tool calls / ticket",
          value: metrics.tool_calls_per_ticket === null ? "—" : metrics.tool_calls_per_ticket.toFixed(1),
        },
        { label: "Repeat incidents", value: pct(metrics.repeat_incident_rate), hint: "same device + scenario" },
        {
          label: "AI cost / ticket",
          value: metrics.ai_cost_per_ticket === null ? "—" : `$${metrics.ai_cost_per_ticket.toFixed(3)}`,
          hint: `~$${metrics.ai_estimated_cost_usd.toFixed(2)} total, estimated`,
        },
      ]
    : [];

  return (
    <div>
      <h1>Metrics</h1>
      <p className="muted">
        The pilot ROI view — docs/v0.1-spec.md treats these as a shipped feature, not analytics bolted on later.
      </p>
      {error && (
        <div className="card" style={{ color: "#b91c1c" }}>
          {error}
        </div>
      )}
      {!metrics && !error && <p className="muted">Loading…</p>}

      {metrics && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "0.75rem" }}>
            {tiles.map((t) => (
              <div className="card" key={t.label}>
                <div className="muted" style={{ fontSize: "0.8rem" }}>
                  {t.label}
                </div>
                <div style={{ fontSize: "1.6rem", fontWeight: 600 }}>{t.value}</div>
                {t.hint && (
                  <div className="muted" style={{ fontSize: "0.75rem" }}>
                    {t.hint}
                  </div>
                )}
              </div>
            ))}
          </div>

          <h2 style={{ marginTop: "1.5rem" }}>By tool</h2>
          {metrics.by_tool.length === 0 && <p className="muted">No tool calls recorded yet.</p>}
          {metrics.by_tool.length > 0 && (
            <div className="card" style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left" }}>
                    <th>Tool</th>
                    <th>Calls</th>
                    <th>Succeeded</th>
                    <th>Verified ✓</th>
                    <th>Verified ✗</th>
                    <th>Success rate</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.by_tool.map((row) => (
                    <tr key={row.tool} style={{ borderTop: "1px solid #e5e7eb" }}>
                      <td>
                        <code>{row.tool}</code>
                      </td>
                      <td>{row.calls_total}</td>
                      <td>{row.calls_succeeded}</td>
                      <td>{row.verified_passed}</td>
                      <td>{row.verified_failed}</td>
                      <td>{pct(row.remediation_success_rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
