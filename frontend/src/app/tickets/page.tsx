"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTenant } from "@/lib/useTenant";
import { api, type Ticket, type Device } from "@/lib/api";

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
  const [title, setTitle] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!tenantId) return;
    try {
      const [t, d] = await Promise.all([api.listTickets(tenantId), api.listDevices(tenantId)]);
      setTickets(t);
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
  if (!tenantId) return <p>Select a tenant on the Home page first.</p>;

  async function createTicket() {
    if (!deviceId || !title) return;
    setError(null);
    try {
      await api.createTicket({ tenantId: tenantId!, deviceId, title });
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
        <div className="row">
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.hostname}
              </option>
            ))}
          </select>
          <input placeholder="What's wrong?" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
          <button className="primary" onClick={createTicket} disabled={!deviceId}>
            Create
          </button>
        </div>
        {devices.length === 0 && <p className="muted">No devices enrolled — enroll one before creating a ticket.</p>}
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
