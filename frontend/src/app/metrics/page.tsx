"use client";

import { useLanguage } from "@/lib/i18n";

import { useEffect, useState } from "react";
import { useTenant } from "@/lib/useTenant";
import { pollWhileVisible } from "@/lib/poll";
import { api, type Metrics } from "@/lib/api";

export default function MetricsPage() {
  const { tx, locale } = useLanguage();
  const number = (value: number, digits = 0) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  const money = (value: number, digits = 2) => new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  const pct = (value: number | null) => value === null ? "—" : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(value);
  function duration(seconds: number | null) {
    if (seconds === null) return "—";
    const unit = seconds < 90 ? "second" : seconds < 5400 ? "minute" : "hour";
    const value = unit === "second" ? seconds : unit === "minute" ? seconds / 60 : seconds / 3600;
    return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: unit === "second" ? 0 : 1 }).format(value);
  }
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
    const stop = pollWhileVisible(load, () => 60_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [tenantId]);

  if (!ready) return null;
  if (!tenantId) return <p>{tx("Select a tenant on the Home page first.")}</p>;

  const tiles: { label: string; value: string; hint?: string }[] = metrics
    ? [
        { label: tx("Tickets"), value: number(metrics.tickets_total) },
        {
          label: tx("AI-resolved"),
          value: number(metrics.tickets_ai_resolved),
          hint:
            metrics.tickets_total > 0
              ? pct(metrics.tickets_ai_resolved / metrics.tickets_total) + tx(" of all tickets")
              : undefined,
        },
        { label: tx("Escalated"), value: number(metrics.tickets_escalated) },
        { label: tx("Avg resolution time"), value: duration(metrics.avg_resolution_seconds) },
        { label: tx("Remediation success"), value: pct(metrics.remediation_success_rate), hint: tx("verified fixes") },
        { label: tx("Approval rate"), value: pct(metrics.approval_rate), hint: tx("requested", { count: number(metrics.approvals_total) }) },
        {
          label: tx("Tool calls / ticket"),
          value: metrics.tool_calls_per_ticket === null ? "—" : number(metrics.tool_calls_per_ticket, 1),
        },
        { label: tx("Repeat incidents"), value: pct(metrics.repeat_incident_rate), hint: tx("same device + scenario") },
        {
          label: tx("AI cost / ticket"),
          value: metrics.ai_cost_per_ticket === null ? "—" : money(metrics.ai_cost_per_ticket, 3),
          hint: tx("estimatedTotal", { cost: money(metrics.ai_estimated_cost_usd) }),
        },
      ]
    : [];

  return (
    <div>
      <h1>{tx("Metrics")}</h1>
      <p className="muted">{tx("The pilot ROI view — docs/v0.1-spec.md treats these as a shipped feature, not analytics bolted on later.")}</p>
      {error && (
        <div className="card" style={{ color: "#b91c1c" }}>
          {tx(error)}
        </div>
      )}
      {!metrics && !error && <p className="muted">{tx("Loading…")}</p>}

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

          <h2 style={{ marginTop: "1.5rem" }}>{tx("By tool")}</h2>
          {metrics.by_tool.length === 0 && <p className="muted">{tx("No tool calls recorded yet.")}</p>}
          {metrics.by_tool.length > 0 && (
            <div className="card" style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left" }}>
                    <th>{tx("Tool")}</th>
                    <th>{tx("Calls")}</th>
                    <th>{tx("Succeeded")}</th>
                    <th>{tx("Verified ✓")}</th>
                    <th>{tx("Verified ✗")}</th>
                    <th>{tx("Success rate")}</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.by_tool.map((row) => (
                    <tr key={row.tool} style={{ borderTop: "1px solid #e5e7eb" }}>
                      <td>
                        <code>{row.tool}</code>
                      </td>
                      <td>{number(row.calls_total)}</td>
                      <td>{number(row.calls_succeeded)}</td>
                      <td>{number(row.verified_passed)}</td>
                      <td>{number(row.verified_failed)}</td>
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
