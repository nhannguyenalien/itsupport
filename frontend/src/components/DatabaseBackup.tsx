"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type DbBackupInfo, type DbBackupRun, type DbBackupSnapshot } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";

function formatBytes(value?: number | string | null) {
  const n = Number(value ?? 0);
  if (!n) return "—";
  return n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export default function DatabaseBackup() {
  const { tx, locale } = useLanguage();
  const [info, setInfo] = useState<DbBackupInfo | null>(null);
  const [denied, setDenied] = useState(false);
  const [runs, setRuns] = useState<DbBackupRun[]>([]);
  const [snaps, setSnaps] = useState<DbBackupSnapshot[] | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [checks, setChecks] = useState<{ name: string; ok: boolean; detail: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState({ enabled: true, repo: "", password: "", keyId: "", keySecret: "", interval: 24, daily: 7, weekly: 4, monthly: 6 });
  const [restore, setRestore] = useState({ snapshot: "", target: "", confirm: "" });

  const load = useCallback(async () => {
    try {
      const data = await api.dbBackup();
      setInfo(data);
      setForm((f) => loaded ? f : ({ ...f, enabled: data.enabled, repo: data.repo, interval: data.interval_hours, daily: data.keep_daily, weekly: data.keep_weekly, monthly: data.keep_monthly }));
      setLoaded(true);
      setRuns(await api.dbBackupRuns());
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 403) setDenied(true); else setMessage({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  }, [loaded]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), info?.running ? 3000 : 10_000);
    return () => clearInterval(timer);
  }, [load, info?.running]);

  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true); setMessage(null);
    try { await action(); setMessage({ text: success, error: false }); await load(); }
    catch (e) { setMessage({ text: e instanceof Error ? e.message : String(e), error: true }); }
    finally { setBusy(false); }
  }

  function envFromForm() {
    const env: Record<string, string> = {};
    if (form.password) env.RESTIC_PASSWORD = form.password;
    const [idKey, secretKey] = form.repo.startsWith("s3:") ? ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
      : form.repo.startsWith("b2:") ? ["B2_ACCOUNT_ID", "B2_ACCOUNT_KEY"] : ["RESTIC_REST_USERNAME", "RESTIC_REST_PASSWORD"];
    if (form.keyId) env[idKey] = form.keyId;
    if (form.keySecret) env[secretKey] = form.keySecret;
    return env;
  }

  const save = () => act(async () => {
    await api.saveDbBackup({ enabled: form.enabled, repo: form.repo.trim(), env: envFromForm(), interval_hours: form.interval, keep_daily: form.daily, keep_weekly: form.weekly, keep_monthly: form.monthly });
    setForm((f) => ({ ...f, password: "", keyId: "", keySecret: "" }));
  }, tx("Đã lưu cài đặt sao lưu database."));

  if (denied) return <div className="card"><h1>{tx("Sao lưu database")}</h1><p className="muted">{tx("Chỉ quản trị nền tảng được dùng mục này. Hãy đặt email của bạn vào biến PLATFORM_ADMIN_EMAILS.")}</p></div>;
  if (!info) return <p className="muted">{message?.text ?? tx("Đang tải…")}</p>;

  const healthLabel: Record<string, string> = {
    ok: tx("Bình thường"), failed: tx("Lần gần nhất bị lỗi"), overdue: tx("Quá hạn"), never: tx("Chưa có bản sao thành công"), disabled: tx("Đang tắt"),
  };
  const kindLabel = { backup: tx("Sao lưu"), verify: tx("Kiểm tra"), restore: tx("Khôi phục") };
  const stateLabel = { running: tx("Đang chạy"), success: tx("Thành công"), error: tx("Lỗi") };
  const when = (v: string | null) => (v ? new Date(v).toLocaleString(locale) : "—");
  const hasPassword = info.env_configured.includes("RESTIC_PASSWORD");

  return (
    <div>
      <h1>{tx("Sao lưu database")}</h1>
      <p className="muted">{tx("Sao lưu toàn bộ database của hệ thống (mọi khách hàng) vào kho restic được mã hoá. Chỉ quản trị nền tảng thấy mục này.")}</p>
      {message && <div className="card" style={{ color: message.error ? "#b91c1c" : undefined }}>{message.text}</div>}

      <div className="card">
        <div className="row">
          <div>
            <span className={info.health === "ok" ? "badge badge-online" : info.health === "disabled" ? "badge badge-offline" : "badge badge-risk-high"}>{healthLabel[info.health]}</span>{" "}
            {info.running && <span className="badge badge-risk-medium">{tx("Đang chạy")}</span>}
            <div className="muted" style={{ marginTop: 6 }}>
              {tx("Lần thành công cuối")}: {when(info.last_success_at)} · {tx("Lần chạy tới")}: {when(info.next_run_at)}
            </div>
            <div className="muted">pg_dump: {info.tools.pgDump ?? tx("chưa cài")} · restic: {info.tools.restic ?? tx("chưa cài")}</div>
            {info.alert_recipients === 0 && <div className="muted">{tx("Chưa có người nhận cảnh báo: đặt PLATFORM_ADMIN_EMAILS và cấu hình email.")}</div>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="primary" disabled={busy || info.running || !info.repo} onClick={() => void act(() => api.runDbBackup(), tx("Đã bắt đầu sao lưu."))}>{tx("Sao lưu ngay")}</button>
            <button disabled={busy} onClick={() => void act(async () => setChecks((await api.testDbBackup()).checks), tx("Đã kiểm tra xong."))}>{tx("Kiểm tra kết nối")}</button>
          </div>
        </div>
        {checks && (
          <ul style={{ marginTop: 10 }}>
            {checks.map((c) => <li key={c.name} style={{ color: c.ok ? undefined : "#b91c1c" }}>{c.ok ? "✓" : "✗"} <strong>{c.name}</strong>: {c.detail}</li>)}
          </ul>
        )}
      </div>

      <div className="card">
        <strong>{tx("Cài đặt")}</strong>
        <div style={{ display: "grid", gap: 8, maxWidth: 640, marginTop: 8 }}>
          <label><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> {tx("Bật sao lưu tự động")}</label>
          <label>{tx("Kho lưu trữ gốc (s3:https://…/bucket, rest:https://…, b2:bucket:path). Bản sao hệ thống nằm ở thư mục platform; mỗi database của khách có thư mục riêng bên dưới.")}
            <input style={{ width: "100%" }} value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })} /></label>
          <label>{tx("Mật khẩu mã hoá bản sao của hệ thống (database của khách dùng mật khẩu riêng do hệ thống sinh)")}
            <input style={{ width: "100%" }} type="password" autoComplete="new-password" value={form.password}
              placeholder={hasPassword ? tx("Đã lưu — để trống nếu giữ nguyên") : ""} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
          <label>{tx("Tài khoản / Access key ID (nếu có)")}
            <input style={{ width: "100%" }} autoComplete="off" value={form.keyId} onChange={(e) => setForm({ ...form, keyId: e.target.value })} /></label>
          <label>{tx("Mật khẩu / Secret key (nếu có)")}
            <input style={{ width: "100%" }} type="password" autoComplete="new-password" value={form.keySecret} onChange={(e) => setForm({ ...form, keySecret: e.target.value })} /></label>
          <div>
            {tx("Chạy mỗi (giờ)")} <input type="number" min={1} max={168} style={{ width: 70 }} value={form.interval} onChange={(e) => setForm({ ...form, interval: Number(e.target.value) })} />
            {" · "}{tx("Giữ theo ngày / tuần / tháng")}{" "}
            <input type="number" min={0} style={{ width: 60 }} value={form.daily} onChange={(e) => setForm({ ...form, daily: Number(e.target.value) })} />{" "}
            <input type="number" min={0} style={{ width: 60 }} value={form.weekly} onChange={(e) => setForm({ ...form, weekly: Number(e.target.value) })} />{" "}
            <input type="number" min={0} style={{ width: 60 }} value={form.monthly} onChange={(e) => setForm({ ...form, monthly: Number(e.target.value) })} />
          </div>
          <div><button className="primary" disabled={busy || !form.repo} onClick={() => void save()}>{tx("Lưu cài đặt")}</button></div>
        </div>
      </div>

      <div className="card">
        <strong>{tx("Lịch sử")}</strong>
        {runs.length === 0 ? <p className="muted">{tx("Chưa có lần chạy nào.")}</p> : (
          <table style={{ width: "100%", marginTop: 8, fontSize: "0.9rem" }}>
            <thead><tr><th align="left">{tx("Bắt đầu")}</th><th align="left">{tx("Loại")}</th><th align="left">{tx("Trạng thái")}</th><th align="right">{tx("Kích thước")}</th><th align="right">{tx("Bảng")}</th><th align="left">{tx("Ghi chú")}</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{when(r.started_at)}</td>
                  <td>{kindLabel[r.kind]}{r.trigger === "schedule" ? ` · ${tx("tự động")}` : ""}</td>
                  <td><span className={r.state === "success" ? "badge badge-online" : r.state === "error" ? "badge badge-risk-high" : "badge badge-offline"}>{stateLabel[r.state]}</span></td>
                  <td align="right">{formatBytes(r.dump_bytes)}</td>
                  <td align="right">{r.tables_found ?? "—"}</td>
                  <td style={{ color: r.error ? "#b91c1c" : undefined }}>{r.error ?? (r.snapshot_id ? r.snapshot_id.slice(0, 8) : "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <strong>{tx("Bản sao và khôi phục")}</strong>
        <p className="muted">{tx("Khôi phục chỉ vào một database KHÁC (ví dụ một nhánh Neon mới), không bao giờ ghi đè database đang chạy. Sau đó bạn chuyển ứng dụng sang database đó nếu cần.")}</p>
        <button disabled={busy || !info.repo} onClick={() => void act(async () => setSnaps(await api.dbBackupSnapshots()), tx("Đã tải danh sách bản sao."))}>{tx("Tải danh sách bản sao")}</button>
        {snaps && (snaps.length === 0 ? <p className="muted">{tx("Repository chưa có bản sao.")}</p> : (
          <div style={{ display: "grid", gap: 8, marginTop: 8, maxWidth: 640 }}>
            <label>{tx("Chọn bản sao")}
              <select style={{ width: "100%" }} value={restore.snapshot} onChange={(e) => setRestore({ ...restore, snapshot: e.target.value })}>
                <option value="">—</option>
                {snaps.map((s) => <option key={s.id} value={s.id}>{new Date(s.time).toLocaleString(locale)} · {s.id} · {formatBytes(s.sizeBytes)}</option>)}
              </select></label>
            <div><button disabled={busy || info.running || !restore.snapshot} onClick={() => void act(() => api.verifyDbBackup(restore.snapshot), tx("Đã bắt đầu kiểm tra bản sao."))}>{tx("Kiểm tra bản sao này")}</button></div>
            <label>{tx("URL database đích (phải là database khác, nên là database trống)")}
              <input style={{ width: "100%" }} type="password" autoComplete="off" placeholder="postgresql://user:pass@host/dbname" value={restore.target} onChange={(e) => setRestore({ ...restore, target: e.target.value })} /></label>
            <label>{tx("Gõ KHOI PHUC để xác nhận")}
              <input style={{ width: "100%" }} value={restore.confirm} onChange={(e) => setRestore({ ...restore, confirm: e.target.value })} /></label>
            <div><button className="primary" disabled={busy || info.running || !restore.snapshot || !restore.target || restore.confirm !== "KHOI PHUC"}
              onClick={() => void act(async () => {
                await api.restoreDbBackup({ snapshot_id: restore.snapshot, target_url: restore.target.trim(), confirm: "KHOI PHUC" });
                setRestore({ snapshot: "", target: "", confirm: "" });
              }, tx("Đã bắt đầu khôi phục. Theo dõi trong mục Lịch sử."))}>{tx("Khôi phục vào database đích")}</button></div>
          </div>
        ))}
      </div>
    </div>
  );
}
