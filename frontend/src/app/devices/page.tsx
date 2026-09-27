"use client";

import { useEffect, useMemo, useState } from "react";
import { useTenant } from "@/lib/useTenant";
import { api, type Device, type EnrollmentToken } from "@/lib/api";

type Platform = "windows" | "mac";

const PUBLIC_URL = "https://itsupport.schoolsai.work";

export default function DevicesPage() {
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
      return `curl -fsSL ${PUBLIC_URL}/downloads/agent/install-macos | /bin/zsh -s -- '${enrollment.token}'`;
    }
    return `$env:SUPPORT_ENROLL_TOKEN='${enrollment.token}'; irm '${PUBLIC_URL}/downloads/agent/install-windows' | iex`;
  }, [enrollment, platform]);

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
      {devices.length === 0 && <p className="muted">Chưa có thiết bị. Nhấn “Thêm máy” để bắt đầu.</p>}
      {devices.map((d) => (
        <div className="card" key={d.id}>
          <div className="row">
            <div>
              <strong>{d.hostname}</strong>{" "}
              <span className={d.status === "online" ? "badge badge-online" : "badge badge-offline"}>{d.status}</span>
              {d.actions_paused && <span className="badge badge-risk-medium" style={{ marginLeft: 6 }}>paused</span>}
              {d.revoked && <span className="badge badge-risk-high" style={{ marginLeft: 6 }}>revoked</span>}
              <div className="muted">
                {d.os_version ?? "Không rõ hệ điều hành"} · agent {d.agent_version ?? "không rõ"} · hoạt động lần cuối{" "}
                {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "chưa có"}
              </div>
              <div className="muted">{d.id}</div>
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              {!d.actions_paused ? (
                <button onClick={() => act(() => api.pauseDevice(d.id))}>Tạm dừng</button>
              ) : (
                <button onClick={() => act(() => api.unpauseDevice(d.id))}>Tiếp tục</button>
              )}
              <button className="danger" disabled={d.revoked} onClick={() => act(() => api.revokeDevice(d.id))}>
                Thu hồi
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
