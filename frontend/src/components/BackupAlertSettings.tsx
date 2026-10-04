"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";

// Admin-only: where backup alert emails go. Hidden entirely for other roles
// (the API answers 403), so it never shows a form that cannot be saved.
export default function BackupAlertSettings() {
  const { tx } = useLanguage();
  const [visible, setVisible] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [emails, setEmails] = useState("");
  const [mailConfigured, setMailConfigured] = useState(true);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.backupAlertSettings().then((s) => {
      setEnabled(s.enabled); setEmails(s.emails.join("\n")); setMailConfigured(s.mail_configured); setVisible(true);
    }).catch(() => undefined);
  }, []);

  if (!visible) return null;
  const parsed = () => emails.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);

  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true); setMessage(null);
    try { await action(); setMessage({ text: success, error: false }); }
    catch (e) { setMessage({ text: e instanceof Error ? e.message : String(e), error: true }); }
    finally { setBusy(false); }
  }

  return (
    <details className="card">
      <summary><strong>{tx("Email cảnh báo backup")}</strong></summary>
      {!mailConfigured && <p style={{ color: "#b91c1c" }}>{tx("Server chưa cấu hình SMTP nên chưa gửi được email.")}</p>}
      <div style={{ display: "grid", gap: 8, maxWidth: 520, marginTop: 8 }}>
        <label><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {tx("Gửi email khi backup quá hạn hoặc lỗi")}</label>
        <label>{tx("Người nhận (mỗi dòng một địa chỉ, tối đa 10)")}
          <textarea style={{ width: "100%" }} rows={3} value={emails} onChange={(e) => setEmails(e.target.value)} /></label>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="primary" disabled={busy} onClick={() => void act(async () => {
            const saved = await api.saveBackupAlertSettings({ enabled, emails: parsed() });
            setEmails(saved.emails.join("\n"));
          }, tx("Đã lưu cài đặt email."))}>{tx("Lưu")}</button>
          <button disabled={busy || !mailConfigured} onClick={() => void act(() => api.testBackupAlert(), tx("Đã gửi email thử tới các địa chỉ đã lưu."))}>{tx("Gửi email thử")}</button>
        </div>
        {message && <p style={{ color: message.error ? "#b91c1c" : undefined }}>{message.text}</p>}
      </div>
    </details>
  );
}
