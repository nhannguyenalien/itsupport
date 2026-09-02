"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTenant } from "@/lib/useTenant";
import { api, type Ticket, type Device, type PlatformConnection } from "@/lib/api";

const STATUS_BADGE: Record<string, string> = {
  open: "badge-risk-low",
  diagnosing: "badge-risk-low",
  awaiting_approval: "badge-risk-medium",
  remediating: "badge-risk-medium",
  resolved: "badge-online",
  remediation_failed: "badge-risk-high",
  escalated: "badge-risk-high",
  closed: "badge-offline",
};

export default function TicketsPage() {
  const { tenantId, ready } = useTenant();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [connections, setConnections] = useState<PlatformConnection[]>([]);
  const [targetType, setTargetType] = useState<"device" | "platform">("device");
  const [title, setTitle] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [platformConnectionId, setPlatformConnectionId] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!tenantId) return;
    try {
      const [t, d, c] = await Promise.all([api.listTickets(tenantId), api.listDevices(tenantId), api.listPlatformConnections(tenantId)]);
      setTickets(t);
      setDevices(d);
      setConnections(c);
      if (!deviceId && d[0]) setDeviceId(d[0].id);
      if (!platformConnectionId && c[0]) setPlatformConnectionId(c[0].id);
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

  async function createTicket() {
    const targetId = targetType === "device" ? deviceId : platformConnectionId;
    if (!targetId || !title) return;
    setError(null);
    try {
      await api.createTicket(
        targetType === "device"
          ? { tenantId: tenantId!, deviceId, title }
          : { tenantId: tenantId!, platformConnectionId, title },
      );
      setTitle("");
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div>
      <h1>Tickets</h1>
      {error && <div className="card" style={{ color: "#b91c1c" }}>{error}</div>}

      <div className="card">
        <h3>New ticket</h3>
        <div className="row" style={{ marginBottom: "0.5rem" }}>
          <select value={targetType} onChange={(e) => setTargetType(e.target.value as "device" | "platform")}>
            <option value="device">Windows device</option>
            <option value="platform">Marketing platform</option>
          </select>
          {targetType === "device" ? (
            <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.hostname}
                </option>
              ))}
            </select>
          ) : (
            <select value={platformConnectionId} onChange={(e) => setPlatformConnectionId(e.target.value)}>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.platform} / {c.external_account_id}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="row">
          <input placeholder="What's wrong?" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
          <button className="primary" onClick={createTicket} disabled={targetType === "device" ? !deviceId : !platformConnectionId}>
            Create
          </button>
        </div>
        {targetType === "device" && devices.length === 0 && (
          <p className="muted">No devices enrolled — enroll one before creating a ticket.</p>
        )}
        {targetType === "platform" && connections.length === 0 && (
          <p className="muted">
            No platform accounts connected — <a href="/connections">connect one</a> before creating a ticket.
          </p>
        )}
      </div>

      {tickets.map((t) => (
        <Link key={t.id} href={`/tickets/${t.id}`} style={{ textDecoration: "none", color: "inherit" }}>
          <div className="card">
            <div className="row">
              <div>
                <strong>{t.title}</strong>
                <div className="muted">{new Date(t.created_at).toLocaleString()}</div>
              </div>
              <span className={`badge ${STATUS_BADGE[t.status] ?? "badge-offline"}`}>{t.status}</span>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
