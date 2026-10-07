"use client";

import { useCallback, useEffect, useState } from "react";
import { pollWhileVisible } from "@/lib/poll";
import { api, type BackupInfo, type BackupSnapshots } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";

const DEFAULTS = {
  windows: { paths: "C:\\Users\\", excludes: "*.tmp\n$RECYCLE.BIN\nAppData\\Local\\Temp", restoreTarget: "C:\\Restore\\2026-10-04" },
  mac: { paths: "/Users", excludes: "*.tmp\n.Trash\nLibrary/Caches\n.DS_Store", restoreTarget: "/Users/Shared/Restore-2026-10-05" },
  linux: { paths: "/data/coolify\n/var/lib/docker/volumes", excludes: "*.tmp\n*.log", restoreTarget: "/restore/2026-10-04" },
};

// "container:user:database" per line; user defaults to postgres, an empty
// database means every database (pg_dumpall).
function parseDumps(text: string) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
    const [container, user = "", database = ""] = line.split(":").map((x) => x.trim());
    return { container, user: user || "postgres", database };
  });
}

function formatBytes(n?: number) {
  if (!n) return "0 MB";
  return n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : `${(n / (1 << 20)).toFixed(1)} MB`;
}

export default function BackupPanel({ deviceId, online, platform }: { deviceId: string; online: boolean; platform: "windows" | "linux" | "mac" }) {
  const { tx, locale } = useLanguage();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    enabled: true, storage: "custom" as "custom" | "system", repo: "", password: "", keyId: "", keySecret: "",
    paths: DEFAULTS[platform].paths, excludes: DEFAULTS[platform].excludes, dumps: "",
    interval: 24, daily: 7, weekly: 4, monthly: 6, vss: platform === "windows",
  });
  const [loadedPolicy, setLoadedPolicy] = useState(false);
  const [snaps, setSnaps] = useState<BackupSnapshots | null>(null);
  const [restore, setRestore] = useState({ snapshot: "", target: "", include: "", confirm: false });

  const load = useCallback(async () => {
    try {
      const data = await api.backupInfo(deviceId);
      setInfo(data);
      const p = data.policy;
      if (p) setForm((f) => loadedPolicy ? f : ({
        ...f, enabled: p.enabled, storage: p.storage ?? "custom", repo: p.repo, paths: p.paths.join("\n"), excludes: p.excludes.join("\n"), dumps: (p.db_dumps ?? []).map((d) => `${d.container}:${d.user}:${d.database}`).join("\n"),
        interval: p.interval_hours, daily: p.keep_daily, weekly: p.keep_weekly, monthly: p.keep_monthly, vss: p.use_vss,
      }));
      // A workspace without a policy yet starts on the system storage when it is available.
      if (!p && data.system_storage_ready && !loadedPolicy) setForm((f) => ({ ...f, storage: "system" }));
      setLoadedPolicy(true);
      if (data.policy) setSnaps(await api.backupSnapshots(deviceId).catch(() => null));
    } catch (e) { setMessage({ text: e instanceof Error ? e.message : String(e), error: true }); }
  }, [deviceId, loadedPolicy]);

  useEffect(() => {
    if (!open) return;
    void load();
    return pollWhileVisible(load, () => 30_000);
  }, [open, load]);

  function envFromForm() {
    const env: Record<string, string> = {};
    if (form.password) env.RESTIC_PASSWORD = form.password;
    const [idKey, secretKey] = form.repo.startsWith("s3:") ? ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
      : form.repo.startsWith("b2:") ? ["B2_ACCOUNT_ID", "B2_ACCOUNT_KEY"] : ["RESTIC_REST_USERNAME", "RESTIC_REST_PASSWORD"];
    if (form.keyId) env[idKey] = form.keyId;
    if (form.keySecret) env[secretKey] = form.keySecret;
    return env;
  }

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true); setMessage(null);
    try { await action(); setMessage({ text: success, error: false }); await load(); }
    catch (e) { setMessage({ text: e instanceof Error ? e.message : String(e), error: true }); }
    finally { setBusy(false); }
  }

  const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
  const save = () => run(async () => {
    await api.saveBackupPolicy(deviceId, {
      enabled: form.enabled, storage: form.storage, repo: form.storage === "system" ? "" : form.repo.trim(), env: form.storage === "system" ? {} : envFromForm(), paths: lines(form.paths), excludes: lines(form.excludes),
      interval_hours: form.interval, keep_daily: form.daily, keep_weekly: form.weekly, keep_monthly: form.monthly, use_vss: platform === "windows" && form.vss, db_dumps: platform === "linux" ? parseDumps(form.dumps) : [],
    });
    setForm((f) => ({ ...f, password: "", keyId: "", keySecret: "" }));
  }, tx("Đã lưu chính sách backup."));

  const status = info?.status;
  const stateLabel = { idle: tx("Chưa chạy"), running: tx("Đang chạy"), success: tx("Thành công"), error: tx("Lỗi") };
  const hasPassword = info?.policy?.env_configured.includes("RESTIC_PASSWORD");
  const num = (key: "interval" | "daily" | "weekly" | "monthly") => (
    <input type="number" min={key === "interval" ? 1 : 0} value={form[key]} style={{ width: 70 }}
      onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })} />
  );

  return (
    <details style={{ marginTop: 12 }} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary><strong>{tx("Backup (restic)")}</strong></summary>
      {info && !info.supported && <p className="muted">{tx("Backup chủ động chỉ hỗ trợ máy Windows, macOS và Linux có agent từ phiên bản {version}. Hãy cập nhật agent trước.", { version: info.min_agent_version })}</p>}
      {message && <p style={{ color: message.error ? "#b91c1c" : undefined }}>{message.text}</p>}
      {status && (
        <div className="muted" style={{ margin: "8px 0" }}>
          <span className={status.state === "success" ? "badge badge-online" : status.state === "error" ? "badge badge-risk-high" : "badge badge-offline"}>{stateLabel[status.state]}</span>{" "}
          {status.finished_at && <>{tx("Hoàn tất lúc")} {new Date(status.finished_at).toLocaleString(locale)} · </>}
          {status.state === "success" && tx("Dữ liệu mới: {size} · tổng {total}", { size: formatBytes(status.bytes_added), total: formatBytes(status.bytes_total) })}
          {status.state === "running" && status.step && <> · {status.step}</>}
          {!status.restic_installed && <div>{tx("restic sẽ được tải về ở lần chạy đầu tiên.")}</div>}
          {status.error && <div style={{ color: "#b91c1c" }}>{status.error}</div>}
        </div>
      )}
      {info && !status && <p className="muted">{tx("Chưa có kết quả backup.")}</p>}
      {info?.supported && (
        <div style={{ display: "grid", gap: 8, maxWidth: 640 }}>
          <label><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> {tx("Bật backup tự động")}</label>
          <fieldset style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 8 }}>
            <legend>{tx("Nơi lưu bản sao")}</legend>
            <label style={{ display: "block" }}><input type="radio" name={`storage-${deviceId}`} checked={form.storage === "system"} disabled={!info.system_storage_ready}
              onChange={() => setForm({ ...form, storage: "system" })} /> {tx("Kho của hệ thống (khuyên dùng): không cần nhập gì, tính vào dung lượng gói của bạn")}</label>
            <label style={{ display: "block" }}><input type="radio" name={`storage-${deviceId}`} checked={form.storage === "custom"}
              onChange={() => setForm({ ...form, storage: "custom" })} /> {tx("Kho riêng của tôi (S3, B2, rest-server…)")}</label>
            {!info.system_storage_ready && <p className="muted">{tx("Kho của hệ thống chưa được cấu hình. Hãy liên hệ quản trị viên hoặc dùng kho riêng.")}</p>}
          </fieldset>
          {form.storage === "system" && (
            <>
              <p className="muted">{tx("Gói {plan}: đã dùng {used} / {limit}.", { plan: info.quota.plan === "pro" ? "Pro" : "Free", used: formatBytes(info.quota.used_bytes), limit: formatBytes(info.quota.limit_bytes) })}</p>
              {info.quota.over && <p style={{ color: "#b91c1c" }}>{tx("Đã vượt dung lượng gói: các lần backup mới tạm dừng cho tới khi bạn giải phóng dung lượng hoặc nâng cấp.")}</p>}
              {!info.system_agent_ok && <p style={{ color: "#b91c1c" }}>{tx("Dùng kho của hệ thống cần agent {version} trở lên. Hãy cập nhật agent trước.", { version: info.system_min_agent_version })}</p>}
            </>
          )}
          {form.storage === "custom" && (
            <>
          <label>{tx("Repository (rest:https://…, s3:https://…, b2:bucket:path)")}
              <input style={{ width: "100%" }} value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })} /></label>
            <label>{tx("Mật khẩu mã hoá repository")}
              <input style={{ width: "100%" }} type="password" autoComplete="new-password" value={form.password}
              placeholder={hasPassword ? tx("Đã lưu — để trống nếu giữ nguyên") : ""} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
            <label>{tx("Tài khoản / Access key ID (nếu có)")}
              <input style={{ width: "100%" }} autoComplete="off" value={form.keyId} onChange={(e) => setForm({ ...form, keyId: e.target.value })} /></label>
            <label>{tx("Mật khẩu / Secret key (nếu có)")}
              <input style={{ width: "100%" }} type="password" autoComplete="new-password" value={form.keySecret} onChange={(e) => setForm({ ...form, keySecret: e.target.value })} /></label>
            </>
          )}
          <label>{tx("Thư mục cần backup (mỗi dòng một đường dẫn)")}
            <textarea style={{ width: "100%" }} rows={3} value={form.paths} onChange={(e) => setForm({ ...form, paths: e.target.value })} /></label>
          <label>{tx("Loại trừ (mỗi dòng một mẫu)")}
            <textarea style={{ width: "100%" }} rows={3} value={form.excludes} onChange={(e) => setForm({ ...form, excludes: e.target.value })} /></label>
          <div>{tx("Chạy mỗi (giờ)")} {num("interval")} · {tx("Giữ theo ngày / tuần / tháng")} {num("daily")} {num("weekly")} {num("monthly")}</div>
          {platform === "linux" && (
            <>
              <div><button disabled={busy} onClick={() => { setForm({ ...form, paths: DEFAULTS.linux.paths, excludes: DEFAULTS.linux.excludes, vss: false }); setMessage({ text: tx("Đã điền mẫu Coolify. Kiểm tra và sửa lại trước khi lưu."), error: false }); }}>{tx("Mẫu Coolify")}</button></div>
              <label>{tx("Database Postgres trong Docker (mỗi dòng: container:user:database — bỏ trống database để dump tất cả)")}
                <textarea style={{ width: "100%" }} rows={3} placeholder="postgres-abc123:postgres:appdb" value={form.dumps} onChange={(e) => setForm({ ...form, dumps: e.target.value })} /></label>
              <p className="muted">{tx("Hệ thống dump database trước mỗi lần backup rồi đưa file dump vào snapshot.")}</p>
            </>
          )}
          {platform === "windows" && <label><input type="checkbox" checked={form.vss} onChange={(e) => setForm({ ...form, vss: e.target.checked })} /> {tx("Dùng VSS (backup cả file đang mở)")}</label>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="primary" disabled={busy || !form.repo} onClick={() => void save()}>{tx("Lưu chính sách")}</button>
            <button disabled={busy || !online || !info.policy?.enabled || status?.state === "running"} onClick={() => void run(() => api.runBackup(deviceId), tx("Đã gửi yêu cầu, máy sẽ xử lý trong vài giây."))}>{tx("Chạy ngay")}</button>
            <button disabled={busy || !online} onClick={() => void run(() => api.refreshBackup(deviceId), tx("Đã gửi yêu cầu, máy sẽ xử lý trong vài giây."))}>{tx("Làm mới trạng thái")}</button>
          </div>
          <details>
            <summary><strong>{tx("Khôi phục dữ liệu")}</strong></summary>
            <p className="muted">{tx("Dữ liệu được giải nén vào một thư mục mới, trống trên máy — không ghi đè file hiện có. Chỉ quản trị viên được khôi phục.")}</p>
            {status?.restore && (
              <p className="muted">
                <span className={status.restore.state === "success" ? "badge badge-online" : status.restore.state === "error" ? "badge badge-risk-high" : "badge badge-offline"}>{stateLabel[status.restore.state]}</span>{" "}
                {status.restore.target} {status.restore.state === "success" && `· ${formatBytes(status.restore.bytes_restored)}`}
                {status.restore.error && <span style={{ color: "#b91c1c" }}> {status.restore.error}</span>}
              </p>
            )}
            <button disabled={busy || !online || snaps?.state === "pending"} onClick={() => void run(() => api.requestBackupSnapshots(deviceId), tx("Đã gửi yêu cầu, máy sẽ xử lý trong vài giây."))}>{tx("Tải danh sách snapshot")}</button>
            {snaps?.state === "pending" && <p className="muted">{tx("Đang chờ máy trả danh sách…")}</p>}
            {snaps?.state === "error" && <p style={{ color: "#b91c1c" }}>{snaps.error}</p>}
            {snaps?.state === "ready" && (snaps.snapshots.length === 0 ? <p className="muted">{tx("Repository chưa có snapshot.")}</p> : (
              <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                <label>{tx("Chọn snapshot")}
                  <select style={{ width: "100%" }} value={restore.snapshot} onChange={(e) => setRestore({ ...restore, snapshot: e.target.value })}>
                    <option value="">—</option>
                    {snaps.snapshots.map((x) => <option key={x.id} value={x.id}>{new Date(x.time).toLocaleString(locale)} · {x.id} · {x.paths.join(", ")}</option>)}
                  </select></label>
                <label>{tx("Thư mục đích (phải mới hoặc trống)")}
                  <input style={{ width: "100%" }} placeholder={DEFAULTS[platform].restoreTarget} value={restore.target} onChange={(e) => setRestore({ ...restore, target: e.target.value })} /></label>
                <label>{tx("Chỉ khôi phục các đường dẫn này (tuỳ chọn, mỗi dòng một đường dẫn)")}
                  <textarea style={{ width: "100%" }} rows={2} value={restore.include} onChange={(e) => setRestore({ ...restore, include: e.target.value })} /></label>
                <label><input type="checkbox" checked={restore.confirm} onChange={(e) => setRestore({ ...restore, confirm: e.target.checked })} /> {tx("Tôi xác nhận khôi phục snapshot này vào thư mục đích trên máy {name}.", { name: deviceId.slice(0, 8) })}</label>
                <div><button className="primary" disabled={busy || !online || !restore.snapshot || !restore.target || !restore.confirm || status?.restore_state === "running"}
                  onClick={() => void run(async () => {
                    await api.restoreBackup(deviceId, { snapshot_id: restore.snapshot, target: restore.target.trim(), include: lines(restore.include), confirm: true });
                    setRestore({ snapshot: "", target: "", include: "", confirm: false });
                  }, tx("Đã gửi yêu cầu khôi phục. Theo dõi trạng thái phía trên."))}>{tx("Khôi phục")}</button></div>
              </div>
            ))}
          </details>
        </div>
      )}
    </details>
  );
}
