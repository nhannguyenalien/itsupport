"use client";

import { useLanguage } from "@/lib/i18n";

import { useEffect, useState } from "react";
import { useTenant } from "@/lib/useTenant";
import { api, type PlatformConnection, type Device } from "@/lib/api";

type OAuthPlatform = "google_ads" | "meta_ads" | "ga4";

const PLATFORMS: { value: OAuthPlatform; label: string; placeholder: string }[] = [
  { value: "google_ads", label: "Google Ads", placeholder: "Customer ID, e.g. 123-456-7890" },
  { value: "meta_ads", label: "Meta Ads", placeholder: "Ad account ID, e.g. act_1234567890" },
  { value: "ga4", label: "Google Analytics (GA4)", placeholder: "Property ID, e.g. 123456789" },
];

export default function ConnectionsPage() {
  const { tx, locale } = useLanguage();
  const { tenantId, ready } = useTenant();
  const [connections, setConnections] = useState<PlatformConnection[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [messageVariables, setMessageVariables] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [platform, setPlatform] = useState<OAuthPlatform>("google_ads");
  const [externalAccountId, setExternalAccountId] = useState("");
  const [deviceId, setDeviceId] = useState("");

  async function load() {
    if (!tenantId) return;
    try {
      const [c, d] = await Promise.all([api.listPlatformConnections(tenantId), api.listDevices(tenantId)]);
      setConnections(c);
      setDevices(d);
      if (!deviceId && d[0]) setDeviceId(d[0].id);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  if (!ready) return null;
  if (!tenantId) return <p>{tx("Select a tenant on the Home page first.")}</p>;

  const selected = PLATFORMS.find((p) => p.value === platform)!;

  function connect() {
    if (!tenantId || !externalAccountId.trim()) return;
    // Real navigation, not a fetch — the backend redirects THIS tab to the
    // platform's own login/consent page (see oauth/routes.ts). Requires that
    // platform's OAuth app credentials to be configured on the backend; if
    // they're not, the backend answers with a clear error instead of a dead
    // redirect (see backend/.env.example known gaps).
    window.location.href = api.connectPlatformUrl(platform, tenantId, externalAccountId.trim());
  }

  async function sendToDevice() {
    if (!tenantId || !deviceId || !externalAccountId.trim()) return;
    setError(null);
    setNotice(null);
    setMessageVariables({});
    try {
      const result = await api.sendConnectLinkToDevice(tenantId, { deviceId, platform, externalAccountId: externalAccountId.trim() });
      if (result.outcome === "auto_execute") {
        setNotice("Sent — the browser should open on that device shortly (agent polls for work; not instant).");
      } else if (result.outcome === "requires_approval") {
        setMessageVariables({ ticket: result.ticketId ?? "—" });
        setNotice("heldApproval");
      } else {
        setMessageVariables({ reason: result.reason ?? result.outcome });
        setError("notSent");
      }
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div>
      <h1>{tx("Platform Connections")}</h1>
      <p className="muted">{tx("Marketing-ops tools (docs/v0.2-marketing-ops-spec.md) act through whichever accounts are connected here. The AI never sees your platform login — connecting redirects you to that platform's own consent page and the backend stores only the resulting token, encrypted.")}</p>
      {error && <div className="card" style={{ color: "#b91c1c" }}>{tx(error, messageVariables)}</div>}
      {notice && <div className="card" style={{ color: "#166534" }}>{tx(notice, messageVariables)}</div>}

      <div className="card">
        <h3>{tx("Connect an account")}</h3>
        <div className="row" style={{ marginBottom: "0.5rem" }}>
          <select value={platform} onChange={(e) => setPlatform(e.target.value as OAuthPlatform)}>
            {PLATFORMS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            placeholder={tx(selected.placeholder)}
            value={externalAccountId}
            onChange={(e) => setExternalAccountId(e.target.value)}
            style={{ flex: 1 }}
          />
        </div>
        <div className="row" style={{ marginBottom: "0.5rem" }}>
          <button className="primary" onClick={connect} disabled={!externalAccountId.trim()}>{tx("Connect in this browser")}</button>
          <span className="muted">{tx("or")}</span>
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={devices.length === 0}>
            {devices.length === 0 && <option>{tx("no devices enrolled")}</option>}
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.hostname}
              </option>
            ))}
          </select>
          <button onClick={sendToDevice} disabled={!deviceId || !externalAccountId.trim()}>{tx("Send link to that device's browser")}</button>
        </div>
        <p className="muted" style={{ fontSize: "0.8rem" }}>{tx("\"Send to device\" opens the consent page in the enrolled Windows agent's own default browser — useful when that machine is already logged into the platform account. The agent never clicks Allow itself; a human at that machine still has to. Account discovery (\"list my accounts and pick one\") needs a working platform API client, which isn't built yet — enter the ID directly for now (visible in that platform's own dashboard URL/settings).")}</p>
      </div>

      <div className="card">
        <h3>{tx("Connected accounts")}</h3>
        {connections.length === 0 && <p className="muted">{tx("None yet.")}</p>}
        {connections.map((c) => (
          <div key={c.id} className="row" style={{ borderBottom: "1px solid #f3f4f6", padding: "0.4rem 0" }}>
            <div>
              <strong>{PLATFORMS.find((p) => p.value === c.platform)?.label ?? c.platform}</strong> — {c.external_account_id}
              <span
                className={c.status === "active" ? "badge badge-online" : "badge badge-risk-high"}
                style={{ marginLeft: 6 }}
              >
                {tx("connectionStatus." + c.status)}
              </span>
              {c.actions_paused && (
                <span className="badge badge-risk-medium" style={{ marginLeft: 6 }}>{tx("paused")}</span>
              )}
              <div className="muted">{tx("connected")} {new Date(c.connected_at).toLocaleString(locale)} {tx("· scopes:")} {c.scopes.join(", ") || tx("none")}
              </div>
              {c.last_error && <div style={{ color: "#b91c1c" }}>{c.last_error}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
