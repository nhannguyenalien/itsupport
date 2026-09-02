"use client";

import { useEffect, useState } from "react";
import { useTenant } from "@/lib/useTenant";
import { api, type Device } from "@/lib/api";

export default function DevicesPage() {
  const { tenantId, ready } = useTenant();
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!tenantId) return;
    try {
      setDevices(await api.listDevices(tenantId));
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
    // Poll — no push/websocket layer yet, matches the agent's own poll-based
    // pending-call model (see agent/README.md known gaps).
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  if (!ready) return null;
  if (!tenantId) return <p>Select a tenant on the Home page first.</p>;

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div>
      <h1>Devices</h1>
      {error && <div className="card" style={{ color: "#b91c1c" }}>{error}</div>}
      {devices.length === 0 && <p className="muted">No devices enrolled yet.</p>}
      {devices.map((d) => (
        <div className="card" key={d.id}>
          <div className="row">
            <div>
              <strong>{d.hostname}</strong>{" "}
              <span className={d.status === "online" ? "badge badge-online" : "badge badge-offline"}>{d.status}</span>
              {d.actions_paused && <span className="badge badge-risk-medium" style={{ marginLeft: 6 }}>paused</span>}
              {d.revoked && <span className="badge badge-risk-high" style={{ marginLeft: 6 }}>revoked</span>}
              <div className="muted">
                {d.os_version ?? "unknown OS"} · agent {d.agent_version ?? "unknown"} · last seen{" "}
                {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "never"}
              </div>
              <div className="muted">{d.id}</div>
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              {!d.actions_paused ? (
                <button onClick={() => act(() => api.pauseDevice(d.id))}>Pause Device Actions</button>
              ) : (
                <button onClick={() => act(() => api.unpauseDevice(d.id))}>Unpause</button>
              )}
              <button className="danger" disabled={d.revoked} onClick={() => act(() => api.revokeDevice(d.id))}>
                Revoke Device
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
