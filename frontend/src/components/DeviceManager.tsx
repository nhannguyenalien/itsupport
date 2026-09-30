"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useTenant } from "@/lib/useTenant";
import { api, type Device, type EnrollmentToken } from "@/lib/api";

type Platform = "windows" | "mac";

const PUBLIC_URL = "https://itsupport.schoolsai.work";

export default function DevicesPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [chatDevice, setChatDevice] = useState<string | null>(null);
  const [reconnect, setReconnect] = useState(false);
  const { tenantId, ready } = useTenant();
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showInstaller, setShowInstaller] = useState(false);
  const [platform, setPlatform] = useState<Platform>("windows");
  const [enrollment, setEnrollment] = useState<EnrollmentToken | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  const installCommand = useMemo(() => {
    if (!enrollment) return "";
    if (platform === "mac") {
      return `curl -fsSL ${PUBLIC_URL}/downloads/agent/install-macos | /bin/zsh -s -- '${enrollment.token}'${reconnect ? ' --force-re-enroll' : ''}`;
    }
    return `$env:SUPPORT_ENROLL_TOKEN='${enrollment.token}'; irm '${PUBLIC_URL}/downloads/agent/install-windows' | iex`;
  }, [enrollment, platform, reconnect]);

  async function load() {
    if (!tenantId) return;
    try {
      setDevices(await api.listDevices(tenantId));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (/Mac/i.test(navigator.platform)) setPlatform("mac");
    load();
    // Poll — no push/websocket layer yet, matches the agent's own poll-based
    // pending-call model (see agent/README.md known gaps).
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  if (!ready) return <p>Đang tải thiết bị…</p>;
  if (!tenantId) return <p>Vui lòng đăng nhập để xem thiết bị.</p>;

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function createInstaller() {
    if (!tenantId) return;
    setError(null);
    setCopied(false);
    setCreating(true);
    try {
      setEnrollment(await api.createEnrollmentToken(tenantId));
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  async function openChat(device: Device) {
    if (!tenantId || chatDevice) return;
    setChatDevice(device.id); setError(null);
    try {
      const ticket = await api.createTicket({ tenantId, deviceId: device.id, title: `Hỗ trợ ${device.hostname}` });
      router.push(`/tickets/${ticket.id}`);
    } catch (e) { setError(String(e)); setChatDevice(null); }
  }

  async function copyCommand() {
    await navigator.clipboard.writeText(installCommand);
    setCopied(true);
  }

  return (
    <div>
      <div className="devices-heading">
        <div><h1>Thiết bị</h1><p className="muted">Cài agent và quản lý các máy đang kết nối.</p></div>
        <button className="primary" onClick={() => { setShowInstaller(true); setEnrollment(null); }}>+ Thêm máy</button>
      </div>
      {error && <div className="card" style={{ color: "#b91c1c" }}>{error}</div>}
      {showInstaller && (
        <div className="card installer-card">
          <div className="installer-title">
            <div><strong>Cài agent trong 1 lần dán lệnh</strong><p className="muted">Chọn hệ điều hành của máy cần hỗ trợ.</p></div>
            <button aria-label="Đóng" onClick={() => setShowInstaller(false)}>×</button>
          </div>
          <div className="platform-tabs">
            <button className={platform === "windows" ? "active" : ""} onClick={() => { setPlatform("windows"); setEnrollment(null); }}>Windows</button>
            <button className={platform === "mac" ? "active" : ""} onClick={() => { setPlatform("mac"); setEnrollment(null); }}>macOS</button>
          </div>
          {platform === "mac" && <label className="reconnect-option"><input type="checkbox" checked={reconnect} onChange={(e) => setReconnect(e.target.checked)} /> Máy đã cài nhưng không xuất hiện? Đăng ký lại vào workspace này.</label>}
          {!enrollment ? (
            <div className="installer-start">
              <p>Nhấn nút dưới đây để tạo lệnh cài dùng một lần. Mã tự hết hạn sau 10 phút.</p>
              <button className="primary" disabled={creating} onClick={createInstaller}>{creating ? "Đang tạo…" : "Tạo lệnh cài đặt"}</button>
            </div>
          ) : (
            <div className="installer-command">
              <ol>
                <li>{platform === "windows" ? "Mở PowerShell bằng Run as administrator." : "Mở ứng dụng Terminal."}</li>
                <li>Nhấn Sao chép, dán vào cửa sổ vừa mở rồi Enter.</li>
                <li>Đợi báo hoàn tất. Thiết bị sẽ tự xuất hiện bên dưới.</li>
              </ol>
              <code>{installCommand}</code>
              <div className="installer-actions">
                <button className="primary" onClick={copyCommand}>{copied ? "✓ Đã sao chép" : "Sao chép lệnh"}</button>
                <button onClick={createInstaller}>Tạo lệnh mới</button>
              </div>
              <p className="installer-warning">Không gửi lệnh này cho nhiều máy: mã chỉ dùng được một lần và hết hạn lúc {new Date(enrollment.expiresAt).toLocaleTimeString()}.</p>
            </div>
          )}
        </div>
      )}
      {loading && <p className="muted">Đang kiểm tra kết nối…</p>}
      {!loading && !error && devices.length === 0 && <p className="muted">Chưa có thiết bị. Nhấn “Thêm máy” để bắt đầu.</p>}
      {devices.map((d) => (
        <div className="card" key={d.id}>
          <div className="row">
            <div>
              <strong>{d.hostname}</strong>{" "}
              <span className={d.status === "online" ? "badge badge-online" : "badge badge-offline"}>{d.status === "online" ? "Đang kết nối" : "Ngoại tuyến"}</span>
              {d.actions_paused && <span className="badge badge-risk-medium" style={{ marginLeft: 6 }}>Tạm dừng</span>}
              {d.revoked && <span className="badge badge-risk-high" style={{ marginLeft: 6 }}>Đã thu hồi</span>}
              <div className="muted">
                {d.os_version ?? "Không rõ hệ điều hành"} · agent {d.agent_version ?? "không rõ"} · hoạt động lần cuối{" "}
                {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "chưa có"}
              </div>

            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button className="primary" disabled={d.revoked || d.status !== "online" || !!chatDevice} onClick={() => void openChat(d)}>{chatDevice === d.id ? "Đang mở…" : "Chat hỗ trợ"}</button>
              <details><summary>Quản lý</summary>
              {!d.actions_paused ? (
                <button onClick={() => act(() => api.pauseDevice(d.id))}>Tạm dừng</button>
              ) : (
                <button onClick={() => act(() => api.unpauseDevice(d.id))}>Tiếp tục</button>
              )}
              <button className="danger" disabled={d.revoked} onClick={() => act(() => api.revokeDevice(d.id))}>
                Thu hồi
              </button>
              </details>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
