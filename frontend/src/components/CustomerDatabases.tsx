"use client";

import { useCallback, useEffect, useState } from "react";
import { pollWhileVisible } from "@/lib/poll";
import { api, type CustomerDbList, type CustomerDbRun, type CustomerDbTarget, type DbBackupSnapshot } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";

function formatBytes(value?: number | string | null) {
  const n = Number(value ?? 0);
  if (!n) return "—";
  return n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function Target({ t, reload }: { t: CustomerDbTarget; reload: () => Promise<void> }) {
  const { tx, locale } = useLanguage();
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<CustomerDbRun[]>([]);
  const [snaps, setSnaps] = useState<DbBackupSnapshot[] | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [restore, setRestore] = useState({ snapshot: "", target: "", confirm: "" });
  const [confirmDelete, setConfirmDelete] = useState("");

  const loadRuns = useCallback(async () => { try { setRuns(await api.customerDbRuns(t.id)); } catch { /* shown on the next poll */ } }, [t.id]);
  useEffect(() => {
    if (!open) return;
    void loadRuns();
    return pollWhileVisible(loadRuns, () => (t.running ? 3000 : 30_000));
  }, [open, loadRuns, t.running]);

  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true); setMessage(null);
    try { await action(); setMessage({ text: success, error: false }); await reload(); await loadRuns(); }
    catch (e) { setMessage({ text: e instanceof Error ? e.message : String(e), error: true }); }
    finally { setBusy(false); }
  }

  const when = (v: string | null) => (v ? new Date(v).toLocaleString(locale) : "—");
  const healthLabel: Record<string, string> = { ok: tx("Bình thường"), failed: tx("Lần gần nhất bị lỗi"), overdue: tx("Quá hạn"), never: tx("Chưa có bản sao thành công"), disabled: tx("Đang tạm dừng") };
  const kindLabel = { backup: tx("Sao lưu"), verify: tx("Kiểm tra"), restore: tx("Khôi phục") };
  const stateLabel = { running: tx("Đang chạy"), success: tx("Thành công"), error: tx("Lỗi") };
  const everyLabel: Record<number, string> = { 6: tx("6 giờ"), 12: tx("12 giờ"), 24: tx("Hằng ngày"), 48: tx("2 ngày"), 168: tx("Hằng tuần") };

  return (
    <div className="card">
      <div className="row">
        <div>
          <strong>{t.name}</strong>{" "}
          <span className={t.health === "ok" ? "badge badge-online" : t.health === "disabled" ? "badge badge-offline" : "badge badge-risk-high"}>{healthLabel[t.health]}</span>{" "}
          {t.running && <span className="badge badge-risk-medium">{tx("Đang chạy")}</span>}
          <div className="muted">{t.source_label}</div>
          <div className="muted">{tx("Lần thành công cuối")}: {when(t.last_success_at)} · {tx("Lần chạy tới")}: {when(t.next_run_at)}</div>
          {t.last_error && <div style={{ color: "#b91c1c" }}>{t.last_error}</div>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <button className="primary" disabled={busy || t.running} onClick={() => void act(() => api.runCustomerDb(t.id), tx("Đã bắt đầu sao lưu."))}>{tx("Sao lưu ngay")}</button>
          <button disabled={busy} onClick={() => setOpen(!open)}>{open ? tx("Thu gọn") : tx("Chi tiết")}</button>
        </div>
      </div>
      {message && <p style={{ color: message.error ? "#b91c1c" : undefined }}>{message.text}</p>}

      {open && (
        <div style={{ marginTop: 12, display: "grid", gap: 14 }}>
          <div>
            <label>{tx("Tần suất")}{" "}
              <select value={t.interval_hours} disabled={busy} onChange={(e) => void act(() => api.updateCustomerDb(t.id, { interval_hours: Number(e.target.value) }), tx("Đã cập nhật."))}>
                {[6, 12, 24, 48, 168].map((h) => <option key={h} value={h}>{everyLabel[h]}</option>)}
              </select></label>{" "}
            <button disabled={busy} onClick={() => void act(() => api.updateCustomerDb(t.id, { enabled: !t.enabled }), t.enabled ? tx("Đã tạm dừng.") : tx("Đã bật lại."))}>{t.enabled ? tx("Tạm dừng") : tx("Bật lại")}</button>
          </div>

          <div>
            <strong>{tx("Lịch sử")}</strong>
            {runs.length === 0 ? <p className="muted">{tx("Chưa có lần chạy nào.")}</p> : (
              <table style={{ width: "100%", marginTop: 6, fontSize: "0.9rem" }}>
                <thead><tr><th align="left">{tx("Bắt đầu")}</th><th align="left">{tx("Loại")}</th><th align="left">{tx("Trạng thái")}</th><th align="right">{tx("Kích thước")}</th><th align="right">{tx("Bảng")}</th><th align="left">{tx("Ghi chú")}</th></tr></thead>
                <tbody>{runs.map((r) => (
                  <tr key={r.id}>
                    <td>{when(r.started_at)}</td>
                    <td>{kindLabel[r.kind]}{r.trigger === "schedule" ? ` · ${tx("tự động")}` : ""}</td>
                    <td><span className={r.state === "success" ? "badge badge-online" : r.state === "error" ? "badge badge-risk-high" : "badge badge-offline"}>{stateLabel[r.state]}</span></td>
                    <td align="right">{formatBytes(r.dump_bytes)}</td>
                    <td align="right">{r.tables_found ?? "—"}</td>
                    <td style={{ color: r.error ? "#b91c1c" : undefined }}>{r.error ?? (r.snapshot_id ? r.snapshot_id.slice(0, 8) : "")}</td>
                  </tr>))}</tbody>
              </table>
            )}
          </div>

          <div>
            <strong>{tx("Bản sao và khôi phục")}</strong>
            <p className="muted">{tx("Khôi phục chỉ vào một database KHÁC (ví dụ một nhánh Neon mới), không bao giờ ghi đè database nguồn.")}</p>
            <button disabled={busy} onClick={() => void act(async () => setSnaps(await api.customerDbSnapshots(t.id)), tx("Đã tải danh sách bản sao."))}>{tx("Tải danh sách bản sao")}</button>
            {snaps && (snaps.length === 0 ? <p className="muted">{tx("Chưa có bản sao nào.")}</p> : (
              <div style={{ display: "grid", gap: 8, marginTop: 8, maxWidth: 640 }}>
                <label>{tx("Chọn bản sao")}
                  <select style={{ width: "100%" }} value={restore.snapshot} onChange={(e) => setRestore({ ...restore, snapshot: e.target.value })}>
                    <option value="">—</option>
                    {snaps.map((s) => <option key={s.id} value={s.id}>{new Date(s.time).toLocaleString(locale)} · {s.id} · {formatBytes(s.sizeBytes)}</option>)}
                  </select></label>
                <div><button disabled={busy || t.running || !restore.snapshot} onClick={() => void act(() => api.verifyCustomerDb(t.id, restore.snapshot), tx("Đã bắt đầu kiểm tra bản sao."))}>{tx("Kiểm tra bản sao này")}</button></div>
                <label>{tx("URL database đích (phải là database khác, nên là database trống)")}
                  <input style={{ width: "100%" }} type="password" autoComplete="off" placeholder="postgresql://user:pass@host/dbname?sslmode=require" value={restore.target} onChange={(e) => setRestore({ ...restore, target: e.target.value })} /></label>
                <label>{tx("Gõ KHOI PHUC để xác nhận")}
                  <input style={{ width: "100%" }} value={restore.confirm} onChange={(e) => setRestore({ ...restore, confirm: e.target.value })} /></label>
                <div><button className="primary" disabled={busy || t.running || !restore.snapshot || !restore.target || restore.confirm !== "KHOI PHUC"}
                  onClick={() => void act(async () => {
                    await api.restoreCustomerDb(t.id, { snapshot_id: restore.snapshot, target_url: restore.target.trim(), confirm: "KHOI PHUC" });
                    setRestore({ snapshot: "", target: "", confirm: "" });
                  }, tx("Đã bắt đầu khôi phục. Theo dõi trong mục Lịch sử."))}>{tx("Khôi phục vào database đích")}</button></div>
              </div>
            ))}
          </div>

          <div>
            <strong>{tx("Xoá")}</strong>
            <p className="muted">{tx("Xoá database khỏi danh sách và XOÁ VĨNH VIỄN mọi bản sao đã lưu. Không thể hoàn tác.")}</p>
            <label>{tx("Gõ XOA để xác nhận")} <input value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} style={{ width: 120 }} /></label>{" "}
            <button className="danger" disabled={busy || t.running || confirmDelete !== "XOA"} onClick={() => void act(() => api.deleteCustomerDb(t.id), tx("Đã xoá."))}>{tx("Xoá vĩnh viễn")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CustomerDatabases() {
  const { tx } = useLanguage();
  const [data, setData] = useState<CustomerDbList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", url: "" });
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await api.customerDbs()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => {
    void load();
    return pollWhileVisible(load, () => (data?.targets.some((x) => x.running) ? 3000 : 30_000));
  }, [load, data?.targets]);

  async function add() {
    setAdding(true); setError(null); setNotice(null);
    try {
      const created = await api.addCustomerDb({ name: form.name.trim(), url: form.url.trim() });
      setForm({ name: "", url: "" });
      setNotice(tx("Đã kết nối {label} ({tables} bảng). Bản sao đầu tiên đang chạy; sau đó hệ thống tự sao lưu theo lịch.", { label: created.label, tables: created.tables }));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setAdding(false); }
  }

  if (!data) return <p className="muted">{error ?? tx("Đang tải…")}</p>;
  const full = data.targets.length >= data.limits.max_targets;
  const pct = Math.min(100, Math.round((data.used_bytes / Math.max(1, data.limit_bytes)) * 100));
  const planName = data.plan === "pro" ? "Pro" : "Free";

  return (
    <div>
      <h1>{tx("Database của bạn")}</h1>
      <p className="muted">{tx("Dán URL PostgreSQL của database cần bảo vệ. Hệ thống tự kiểm tra kết nối, sao lưu ngay và sau đó sao lưu theo lịch, lưu vào kho mã hoá của hệ thống.")}</p>
      {error && <div className="card" style={{ color: "#b91c1c" }}>{error}</div>}
      {notice && <div className="card">{notice}</div>}
      <div className="card">
        <strong>{tx("Gói {plan}", { plan: planName })}</strong>{" "}
        <span className="muted">{tx("Đã dùng {used} / {limit}", { used: formatBytes(data.used_bytes), limit: formatBytes(data.limit_bytes) })}</span>
        <div style={{ height: 8, background: "#e5e7eb", borderRadius: 4, marginTop: 8 }} aria-hidden="true">
          <div style={{ width: `${pct}%`, height: 8, borderRadius: 4, background: pct >= 90 ? "#dc2626" : "#16a34a" }} />
        </div>
        {data.plan === "free" && <p className="muted" style={{ marginBottom: 0 }}>{tx("Nâng cấp lên Pro để sao lưu nhiều dữ liệu hơn. Hãy liên hệ quản trị viên.")}</p>}
      </div>
      {!data.storage_ready && <div className="card" style={{ color: "#b91c1c" }}>{tx("Hệ thống chưa cấu hình kho lưu trữ. Hãy liên hệ quản trị viên.")}</div>}

      <div className="card">
        <strong>{tx("Thêm database")}</strong>
        <div style={{ display: "grid", gap: 8, maxWidth: 640, marginTop: 8 }}>
          <label>{tx("Tên gợi nhớ")}
            <input style={{ width: "100%" }} maxLength={80} placeholder={tx("Ví dụ: Database bán hàng")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>{tx("URL PostgreSQL")}
            <input style={{ width: "100%" }} type="password" autoComplete="off" placeholder="postgresql://user:password@host/dbname?sslmode=require" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></label>
          <p className="muted">{tx("Yêu cầu: database truy cập được từ Internet qua TLS (có ?sslmode=require), tối đa {count} database, tổng dung lượng theo gói của bạn. URL được mã hoá khi lưu và không hiển thị lại.", { count: data.limits.max_targets })}</p>
          <div><button className="primary" disabled={adding || full || !data.storage_ready || !form.name.trim() || !form.url.trim()} onClick={() => void add()}>{adding ? tx("Đang kiểm tra kết nối…") : tx("Thêm và sao lưu ngay")}</button>
            {full && <span className="muted"> {tx("Đã đạt giới hạn.")}</span>}</div>
        </div>
      </div>

      {data.targets.length === 0 && <p className="muted">{tx("Chưa có database nào.")}</p>}
      {data.targets.map((t) => <Target key={t.id} t={t} reload={load} />)}
    </div>
  );
}
