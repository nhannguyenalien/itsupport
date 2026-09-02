"use client";

import { useEffect, useState } from "react";
import { useTenant } from "@/lib/useTenant";
import { api, type PlatformConnection } from "@/lib/api";

const PLATFORMS: { value: PlatformConnection["platform"]; label: string; placeholder: string }[] = [
  { value: "google_ads", label: "Google Ads", placeholder: "Customer ID, e.g. 123-456-7890" },
  { value: "meta_ads", label: "Meta Ads", placeholder: "Ad account ID, e.g. act_1234567890" },
  { value: "ga4", label: "Google Analytics (GA4)", placeholder: "Property ID, e.g. 123456789" },
];

export default function ConnectionsPage() {
  const { tenantId, ready } = useTenant();
  const [connections, setConnections] = useState<PlatformConnection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<PlatformConnection["platform"]>("google_ads");
  const [externalAccountId, setExternalAccountId] = useState("");

  async function load() {
    if (!tenantId) return;
    try {
      setConnections(await api.listPlatformConnections(tenantId));
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  if (!ready) return null;
  if (!tenantId) return <p>Select a tenant on the Home page first.</p>;

  const selected = PLATFORMS.find((p) => p.value === platform)!;

  function connect() {
    if (!tenantId || !externalAccountId.trim()) return;
    // Real navigation, not a fetch — the backend redirects this tab to the
    // platform's own login/consent page (see oauth/routes.ts). Requires that
    // platform's OAuth app credentials to be configured on the backend; if
    // they're not, the backend answers with a clear error instead of a dead
    // redirect (see backend/.env.example known gaps).
    window.location.href = api.connectPlatformUrl(platform, tenantId, externalAccountId.trim());
  }

  return (
    <div>
      <h1>Platform Connections</h1>
      <p className="muted">
        Marketing-ops tools (docs/v0.2-marketing-ops-spec.md) act through whichever accounts are connected here. The AI never
        sees your platform login — connecting redirects you to that platform&apos;s own consent page and the backend stores
        only the resulting token, encrypted.
      </p>
      {error && <div className="card" style={{ color: "#b91c1c" }}>{error}</div>}

      <div className="card">
        <h3>Connect an account</h3>
        <div className="row" style={{ marginBottom: "0.5rem" }}>
          <select value={platform} onChange={(e) => setPlatform(e.target.value as PlatformConnection["platform"])}>
            {PLATFORMS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            placeholder={selected.placeholder}
            value={externalAccountId}
            onChange={(e) => setExternalAccountId(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={connect}>
            Connect
          </button>
        </div>
        <p className="muted" style={{ fontSize: "0.8rem" }}>
          Account discovery ("list my accounts and pick one") needs a working platform API client, which isn&apos;t built yet
          — enter the ID directly for now (visible in that platform&apos;s own dashboard URL/settings).
        </p>
      </div>

      <div className="card">
        <h3>Connected accounts</h3>
        {connections.length === 0 && <p className="muted">None yet.</p>}
        {connections.map((c) => (
          <div key={c.id} className="row" style={{ borderBottom: "1px solid #f3f4f6", padding: "0.4rem 0" }}>
            <div>
              <strong>{c.platform}</strong> — {c.external_account_id}
              <span
                className={c.status === "active" ? "badge badge-online" : "badge badge-risk-high"}
                style={{ marginLeft: 6 }}
              >
                {c.status}
              </span>
              {c.actions_paused && (
                <span className="badge badge-risk-medium" style={{ marginLeft: 6 }}>
                  paused
                </span>
              )}
              <div className="muted">
                connected {new Date(c.connected_at).toLocaleString()} · scopes: {c.scopes.join(", ") || "none"}
              </div>
              {c.last_error && <div style={{ color: "#b91c1c" }}>{c.last_error}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
