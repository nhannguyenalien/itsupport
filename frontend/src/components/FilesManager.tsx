"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type TenantFileList } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";

function formatBytes(value?: number | null) {
  const n = Number(value ?? 0);
  if (!n) return "0 KB";
  return n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** The browser sends the bytes straight to storage; XHR is used only for progress events. */
function putFile(url: string, file: File, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("network"));
    xhr.send(file);
  });
}

export default function FilesManager() {
  const { tx, locale } = useLanguage();
  const [data, setData] = useState<TenantFileList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ name: string; percent: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try { setData(await api.files()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setError(null); setNotice(null);
    for (const file of Array.from(files)) {
      try {
        const started = await api.startFileUpload({ name: file.name, size: file.size, content_type: file.type || "application/octet-stream" });
        setProgress({ name: file.name, percent: 0 });
        try { await putFile(started.upload_url, file, (f) => setProgress({ name: file.name, percent: Math.round(f * 100) })); }
        catch { throw new Error(tx("Tải lên thất bại. Kiểm tra kết nối mạng rồi thử lại.")); }
        await api.completeFileUpload(started.id);
        setNotice(tx("Đã tải lên {name}.", { name: file.name }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        break;
      }
    }
    setProgress(null);
    if (input.current) input.current.value = "";
    await load();
  }

  async function download(id: string) {
    try { window.location.assign((await api.fileDownload(id)).url); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(tx("Xoá file {name}? Không thể hoàn tác.", { name }))) return;
    try { await api.deleteFile(id); setNotice(tx("Đã xoá {name}.", { name })); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  if (!data) return <p className="muted">{error ?? tx("Đang tải…")}</p>;
  const pct = Math.min(100, Math.round((data.used_bytes / Math.max(1, data.limit_bytes)) * 100));
  const planName = data.plan === "pro" ? "Pro" : "Free";

  return (
    <div>
      <h1>{tx("Tệp của bạn")}</h1>
      <p className="muted">{tx("Tải file từ máy tính lên kho mã hoá của hệ thống. File tính vào dung lượng gói của bạn, mỗi file tối đa {size}.", { size: formatBytes(data.max_file_bytes) })}</p>
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
        <label>{tx("Chọn file để tải lên")}{" "}
          <input ref={input} type="file" multiple disabled={!data.storage_ready || !!progress} onChange={(e) => void upload(e.target.files)} /></label>
        {progress && (
          <div style={{ marginTop: 8 }} role="status">
            {tx("Đang tải lên {name}… {percent}%", { name: progress.name, percent: progress.percent })}
            <div style={{ height: 6, background: "#e5e7eb", borderRadius: 3, marginTop: 4 }} aria-hidden="true">
              <div style={{ width: `${progress.percent}%`, height: 6, borderRadius: 3, background: "#2563eb" }} />
            </div>
          </div>
        )}
      </div>

      <div className="card">
        {data.files.length === 0 ? <p className="muted" style={{ margin: 0 }}>{tx("Chưa có file nào.")}</p> : (
          <table style={{ width: "100%" }}>
            <thead><tr><th align="left">{tx("Tên file")}</th><th align="right">{tx("Kích thước")}</th><th align="left">{tx("Ngày tải lên")}</th><th /></tr></thead>
            <tbody>
              {data.files.map((f) => (
                <tr key={f.id}>
                  <td style={{ wordBreak: "break-all" }}>{f.name}</td>
                  <td align="right">{formatBytes(f.size_bytes)}</td>
                  <td>{new Date(f.created_at).toLocaleString(locale)}</td>
                  <td align="right" style={{ whiteSpace: "nowrap" }}>
                    <button onClick={() => void download(f.id)}>{tx("Tải xuống")}</button>{" "}
                    <button onClick={() => void remove(f.id, f.name)}>{tx("Xoá")}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
