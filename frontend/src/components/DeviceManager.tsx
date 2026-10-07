"use client";

import RemoteSupport from "./RemoteSupport";
import BackupPanel from "./BackupPanel";
import BackupAlertSettings from "./BackupAlertSettings";
import { useLanguage } from "@/lib/i18n";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useTenant } from "@/lib/useTenant";
import { pollWhileVisible } from "@/lib/poll";
import { api, type BackupOverview, type Device, type EnrollmentToken } from "@/lib/api";

type Platform = "windows" | "mac" | "linux";

const PUBLIC_URL = "https://itsupport.schoolsai.work";

export default function DevicesPage() {
  const { tx, locale } = useLanguage();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [chatDevice, setChatDevice] = useState<string | null>(null);
  const [reconnect, setReconnect] = useState(false);
  const { tenantId, ready } = useTenant();
  const [devices, setDevices] = useState<Device[]>([]);
  const [backups, setBackups] = useState<BackupOverview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showInstaller, setShowInstaller] = useState(false);
  const [platform, setPlatform] = useState<Platform>("windows");
  const [enrollment, setEnrollment] = useState<EnrollmentToken | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  const installCommand = useMemo(() => {
    if (!enrollment) return "";
    if (platform === "linux") {
      return `curl -fsSL ${PUBLIC_URL}/downloads/agent/install-linux | bash -s -- '${enrollment.token}'${reconnect ? ' --force-re-enroll' : ''}`;
    }
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
      // Backup health is a secondary signal: never let it break the device list.
      api.listBackups().then(setBackups).catch(() => undefined);
    } catch (e) {
      setError(String(e));
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (/Mac/i.test(navigator.platform)) setPlatform("mac");
    else if (/Linux/i.test(navigator.platform)) setPlatform("linux");
    load();
    // Poll — no push/websocket layer yet, matches the agent's own poll-based
    // pending-call model (see agent/README.md known gaps).
    return pollWhileVisible(load, () => 30_000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  if (!ready) return <p>{tx("Đang tải thiết bị…")}</p>;
  if (!tenantId) return <p>{tx("Vui lòng đăng nhập để xem thiết bị.")}</p>;

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  const updatable = devices.filter((d) => d.update_supported && d.update_available && d.status === "online" &&
    (d.update_state === "none" || d.update_state === "failed"));
  const backupProblems = backups.filter((b) => b.health === "overdue" || b.health === "never" || b.health === "failed");
  const latestVersion = devices.find((d) => d.latest_agent_version)?.latest_agent_version;

  async function updateAgents(targets: Device[]) {
    setError(null);
    const failures: string[] = [];
    for (const d of targets) {
      try { await api.requestAgentUpdate(d.id); }
      catch (e) { failures.push(`${d.hostname}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (failures.length) setError(failures.join("; "));
    await load();
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
      const ticket = await api.createTicket({ tenantId, deviceId: device.id, title: tx("supportDevice", { name: device.hostname }) });
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
        <div><h1>{tx("Thiết bị")}</h1><p className="muted">{tx("Cài agent và quản lý các máy đang kết nối.")}</p></div>
        <button className="primary" onClick={() => { setShowInstaller(true); setEnrollment(null); }}>{tx("+ Thêm máy")}</button>
      </div>
      {error && <div className="card" style={{ color: "#b91c1c" }}>{tx(error)}</div>}
      {showInstaller && (
        <div className="card installer-card">
          <div className="installer-title">
            <div><strong>{tx("Cài agent trong 1 lần dán lệnh")}</strong><p className="muted">{tx("Chọn hệ điều hành của máy cần hỗ trợ.")}</p></div>
            <button aria-label={tx("Đóng")} onClick={() => setShowInstaller(false)}>×</button>
          </div>
          <div className="platform-tabs">
            <button className={platform === "windows" ? "active" : ""} onClick={() => { setPlatform("windows"); setEnrollment(null); }}>Windows</button>
            <button className={platform === "mac" ? "active" : ""} onClick={() => { setPlatform("mac"); setEnrollment(null); }}>macOS</button>
            <button className={platform === "linux" ? "active" : ""} onClick={() => { setPlatform("linux"); setEnrollment(null); }}>Linux</button>
          </div>
          {platform === "linux" && <p className="muted">{tx("linux.installHint")}</p>}
          {platform !== "windows" && <label className="reconnect-option"><input type="checkbox" checked={reconnect} onChange={(e) => setReconnect(e.target.checked)} /> {tx("Máy đã cài nhưng không xuất hiện? Đăng ký lại vào workspace này.")}</label>}
          {!enrollment ? (
            <div className="installer-start">
              <p>{tx("Nhấn nút dưới đây để tạo lệnh cài dùng một lần. Mã tự hết hạn sau 10 phút.")}</p>
              <button className="primary" disabled={creating} onClick={createInstaller}>{creating ? tx("Đang tạo…") : tx("Tạo lệnh cài đặt")}</button>
            </div>
          ) : (
            <div className="installer-command">
              <ol>
                <li>{platform === "windows" ? tx("Mở PowerShell bằng Run as administrator.") : tx("Mở ứng dụng Terminal.")}</li>
                <li>{tx("Nhấn Sao chép, dán vào cửa sổ vừa mở rồi Enter.")}</li>
                <li>{tx("Đợi báo hoàn tất. Thiết bị sẽ tự xuất hiện bên dưới.")}</li>
              </ol>
              <code>{installCommand}</code>
              <div className="installer-actions">
                <button className="primary" onClick={copyCommand}>{copied ? tx("✓ Đã sao chép") : tx("Sao chép lệnh")}</button>
                <button onClick={createInstaller}>{tx("Tạo lệnh mới")}</button>
              </div>
              <p className="installer-warning">{tx("Không gửi lệnh này cho nhiều máy: mã chỉ dùng được một lần và hết hạn lúc")} {new Date(enrollment.expiresAt).toLocaleTimeString(locale)}.</p>
            </div>
          )}
        </div>
      )}
      {updatable.length > 0 && latestVersion && (
        <div className="card update-banner">
          <div><strong>{tx("Có bản cập nhật agent mới ({version})", { version: latestVersion })}</strong>
            <p className="muted">{tx("{count} máy có thể cập nhật. Máy chỉ cập nhật khi bạn bấm nút; dịch vụ hỗ trợ sẽ khởi động lại trong vài giây.", { count: updatable.length })}</p></div>
          <button className="primary" onClick={() => void updateAgents(updatable)}>{tx("Cập nhật tất cả")}</button>
        </div>
      )}
      <BackupAlertSettings />
      {backupProblems.length > 0 && (
        <div className="card update-banner" role="alert">
          <div><strong>{tx("{count} máy có backup cần chú ý", { count: backupProblems.length })}</strong>
            {backupProblems.map((b) => (
              <p className="muted" key={b.device_id}>
                {b.hostname}: {b.health === "failed" ? tx("lần backup gần nhất bị lỗi")
                  : b.health === "never" ? tx("chưa có backup thành công")
                  : tx("quá hạn, lần thành công cuối: {time}", { time: b.last_success_at ? new Date(b.last_success_at).toLocaleString(locale) : "—" })}
                {b.device_status !== "online" && ` (${tx("Ngoại tuyến")})`}
              </p>
            ))}</div>
        </div>
      )}
      {loading && <p className="muted">{tx("Đang kiểm tra kết nối…")}</p>}
      {!loading && !error && devices.length === 0 && <p className="muted">{tx("Chưa có thiết bị. Nhấn “Thêm máy” để bắt đầu.")}</p>}
      {devices.map((d) => (
        <div className="card" key={d.id}>
          <div className="row">
            <div>
              <strong>{d.hostname}</strong>{" "}
              <span className={d.status === "online" ? "badge badge-online" : "badge badge-offline"}>{d.status === "online" ? tx("Đang kết nối") : tx("Ngoại tuyến")}</span>
              {d.actions_paused && <span className="badge badge-risk-medium" style={{ marginLeft: 6 }}>{tx("Tạm dừng")}</span>}
              {d.revoked && <span className="badge badge-risk-high" style={{ marginLeft: 6 }}>{tx("Đã thu hồi")}</span>}
              <div className="muted">
                {d.os_version ?? tx("Không rõ hệ điều hành")} {tx("· agent")} {d.agent_version ?? tx("không rõ")} {tx("· hoạt động lần cuối")}{" "}
                {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString(locale) : tx("chưa có")}
              </div>
              {(d.update_state === "queued" || d.update_state === "installing") && (
                <div className="update-status">{tx("Đang cập nhật lên {version}…", { version: d.latest_agent_version ?? "" })}</div>
              )}
              {d.update_state === "failed" && (
                <div className="update-status update-failed">{tx("Cập nhật chưa thành công.")} {d.update_error}</div>
              )}
              {d.update_available && !d.update_supported && !d.revoked && (
                <div className="update-status">{tx("Agent bản cũ: chạy lại lệnh cài một lần (nút + Thêm máy) để bật cập nhật bằng nút bấm.")}</div>
              )}

            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              {d.update_supported && d.update_available && (d.update_state === "none" || d.update_state === "failed") && (
                <button disabled={d.status !== "online"} title={d.status !== "online" ? tx("Máy đang ngoại tuyến") : undefined} onClick={() => void updateAgents([d])}>
                  {tx("Cập nhật lên {version}", { version: d.latest_agent_version ?? "" })}
                </button>
              )}
              <button className="primary" disabled={d.revoked || d.status !== "online" || !!chatDevice} onClick={() => void openChat(d)}>{chatDevice === d.id ? tx("Đang mở…") : tx("Chat hỗ trợ")}</button>
              <details><summary>{tx("Quản lý")}</summary>
              {!d.actions_paused ? (
                <button onClick={() => act(() => api.pauseDevice(d.id))}>{tx("Tạm dừng")}</button>
              ) : (
                <button onClick={() => act(() => api.unpauseDevice(d.id))}>{tx("Tiếp tục")}</button>
              )}
              <button className="danger" disabled={d.revoked} onClick={() => act(() => api.revokeDevice(d.id))}>{tx("Thu hồi")}</button>
              </details>
            </div>
          </div>
          {!d.revoked && <RemoteSupport deviceId={d.id} />}
          {!d.revoked && (d.platform === "windows" || d.platform === "linux" || d.platform === "mac") && <BackupPanel deviceId={d.id} online={d.status === "online"} platform={d.platform} />}
        </div>
      ))}
    </div>
  );
}
