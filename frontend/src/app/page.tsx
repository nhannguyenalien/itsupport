"use client";

import { useEffect, useState } from "react";
import { useTenant } from "@/lib/useTenant";
import { api, type Tenant } from "@/lib/api";

export default function HomePage() {
  const { tenantId, setTenantId, ready } = useTenant();
  const [input, setInput] = useState("");
  const [newTenantName, setNewTenantName] = useState("");
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    api
      .getTenant(tenantId)
      .then(setTenant)
      .catch((e) => setError(String(e)));
  }, [tenantId]);

  if (!ready) return null;

  async function createTenant() {
    setError(null);
    try {
      const t = await api.createTenant(newTenantName || "New Tenant");
      setTenantId(t.id);
      setTenant(t);
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleAi() {
    if (!tenant) return;
    try {
      if (tenant.ai_enabled) await api.disableAi(tenant.id);
      else await api.enableAi(tenant.id);
      setTenant(await api.getTenant(tenant.id));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div>
      <h1>AI Windows Support Agent</h1>
      <p className="muted">v0.1 — no auth yet, tenant selection is local-only.</p>

      {!tenantId && (
        <div className="card">
          <h3>Select a tenant</h3>
          <div className="row">
            <input placeholder="tenant UUID" value={input} onChange={(e) => setInput(e.target.value)} style={{ flex: 1 }} />
            <button className="primary" onClick={() => setTenantId(input)}>
              Use tenant
            </button>
          </div>
          <hr style={{ margin: "1rem 0", border: "none", borderTop: "1px solid #e5e7eb" }} />
          <div className="row">
            <input placeholder="name for a new tenant" value={newTenantName} onChange={(e) => setNewTenantName(e.target.value)} style={{ flex: 1 }} />
            <button onClick={createTenant}>Create tenant</button>
          </div>
        </div>
      )}

      {error && <div className="card" style={{ color: "#b91c1c" }}>{error}</div>}

      {tenant && (
        <div className="card">
          <div className="row">
            <div>
              <strong>{tenant.name}</strong>
              <div className="muted">{tenant.id}</div>
            </div>
            <button className="danger" onClick={() => setTenantId("")}>
              Switch tenant
            </button>
          </div>
          <hr style={{ margin: "1rem 0", border: "none", borderTop: "1px solid #e5e7eb" }} />
          <div className="row">
            <div>
              <div>
                AI status:{" "}
                <span className={tenant.ai_enabled ? "badge badge-online" : "badge badge-offline"}>
                  {tenant.ai_enabled ? "enabled" : "disabled"}
                </span>
              </div>
              <div className="muted">Disabling blocks every AI-initiated tool call at the policy engine — kill switch, see docs/v0.1-spec.md.</div>
            </div>
            <button className={tenant.ai_enabled ? "danger" : "primary"} onClick={toggleAi}>
              {tenant.ai_enabled ? "Disable Tenant AI" : "Enable Tenant AI"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
