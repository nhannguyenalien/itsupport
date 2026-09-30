"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
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
      const [t, d] = await Promise.all([api.listTickets(tenantId), api.listDevices(tenantId)]);
      setTickets(t);
      const available = d.filter((item) => !item.revoked);
      setDevices(available);
      if (!deviceId && available[0]) setDeviceId((available.find((item) => item.status === "online") ?? available[0]).id);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally { setLoading(false); }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  useEffect(() => {
    if (!tenantId || targetType !== "platform") return;
    api.listPlatformConnections(tenantId).then((items) => {
      setConnections(items);
      if (items[0]) setPlatformConnectionId(items[0].id);
    }).catch((e) => setError(String(e)));
  }, [tenantId, targetType]);

  if (!ready) return <p>Đang mở hỗ trợ…</p>;
  if (!tenantId) return <p>Vui lòng đăng nhập để bắt đầu.</p>;

  async function createTicket() {
    const targetId = targetType === "device" ? deviceId : platformConnectionId;
    if (!targetId || creating) return;
    setCreating(true);
    setError(null);
    try {
      const ticket = await api.createTicket(
        targetType === "device"
          ? { tenantId: tenantId!, deviceId, title: title.trim() || "Hỗ trợ máy tính" }
          : { tenantId: tenantId!, platformConnectionId, title: title.trim() || "Hỗ trợ dịch vụ" },
      );
      router.push(`/tickets/${ticket.id}`);
    } catch (e) {
      setError(String(e));
      setCreating(false);
    }
  }

  return (
    <div>
      <h1>Hỗ trợ</h1><p className="muted">Chọn máy, mở chat và mô tả điều bạn cần. Trợ lý sẽ kiểm tra cùng bạn.</p>
      {error && <div className="card" style={{ color: "#b91c1c" }}>{error}</div>}

      <div className="card">
        <h3>Bắt đầu trò chuyện</h3>
        <div className="row" style={{ marginBottom: "0.5rem" }}>
          <details><summary>Hỗ trợ dịch vụ khác</summary><select aria-label="Loại hỗ trợ" value={targetType} onChange={(e) => setTargetType(e.target.value as "device" | "platform")}>
            <option value="device">Máy tính</option>
            <option value="platform">Dịch vụ đã kết nối</option>
          </select></details>
          {targetType === "device" ? (
            <select aria-label="Máy cần hỗ trợ" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.hostname} · {d.status === "online" ? "Đang kết nối" : "Ngoại tuyến"}
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
          <input placeholder="Tên cuộc trò chuyện (không bắt buộc)" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
          <button className="primary" onClick={createTicket} disabled={creating || loading || (targetType === "device" ? !deviceId : !platformConnectionId)}>
            {creating ? "Đang mở…" : "Mở chat"}
          </button>
        </div>
        {!loading && targetType === "device" && devices.length === 0 && (
          <p className="muted">Chưa có máy kết nối. <Link href="/devices">Thêm máy để bắt đầu</Link>.</p>
        )}
        {targetType === "platform" && connections.length === 0 && (
          <p className="muted">
            Chưa có dịch vụ nào. <Link href="/connections">Kết nối dịch vụ</Link> để bắt đầu.
          </p>
        )}
      </div>

      <h2>Trò chuyện gần đây</h2>
      {loading && <p className="muted">Đang tải…</p>}
      {!loading && tickets.length === 0 && <p className="muted">Cuộc trò chuyện của bạn sẽ xuất hiện ở đây.</p>}
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
