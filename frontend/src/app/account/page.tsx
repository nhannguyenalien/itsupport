"use client";

import { useLanguage } from "@/lib/i18n";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { EmailAuthProvider, GoogleAuthProvider, linkWithCredential, reauthenticateWithCredential, reauthenticateWithPopup, updatePassword, type User } from "firebase/auth";
import { auth } from "@/lib/firebase";

function friendlyError(reason: unknown): string {
  const code = (reason as { code?: string }).code ?? "";
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return "Bạn đã đóng cửa sổ đăng nhập Google. Hãy thử lại khi sẵn sàng.";
  if (code === "auth/popup-blocked") return "Trình duyệt đã chặn cửa sổ Google. Hãy cho phép cửa sổ bật lên rồi thử lại.";
  if (code === "auth/wrong-password" || code === "auth/invalid-credential") return "Mật khẩu hiện tại chưa đúng.";
  if (code === "auth/weak-password") return "Mật khẩu cần tối thiểu 8 ký tự.";
  if (code === "auth/too-many-requests") return "Bạn thử quá nhiều lần. Vui lòng đợi ít phút rồi thử lại.";
  if (code === "auth/network-request-failed") return "Không kết nối được Google. Hãy kiểm tra mạng rồi thử lại.";
  return "Không thể xử lý yêu cầu. Vui lòng thử lại.";
}

export default function AccountPage() {
  const { tx } = useLanguage();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const user = auth.currentUser;
  const providers = user?.providerData.map((p) => p.providerId) ?? [];
  const hasGoogle = providers.includes("google.com");
  const hasPassword = providers.includes("password");
  // A Google-verified identity replaces the old password: the user re-proves
  // ownership of the Google account instead of typing a password they may never have set.
  const needsOldPassword = hasPassword && !hasGoogle;

  async function applyPassword(current: User) {
    if (hasPassword) await updatePassword(current, newPassword);
    else await linkWithCredential(current, EmailAuthProvider.credential(current.email!, newPassword));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = auth.currentUser;
    if (!current || !current.email) return;
    setError(""); setNotice("");
    if (newPassword !== confirmPassword) { setError("Mật khẩu xác nhận không khớp."); return; }
    setBusy(true);
    try {
      if (needsOldPassword) {
        await reauthenticateWithCredential(current, EmailAuthProvider.credential(current.email, currentPassword));
      }
      try {
        await applyPassword(current);
      } catch (reason) {
        if ((reason as { code?: string }).code !== "auth/requires-recent-login" || !hasGoogle) throw reason;
        await reauthenticateWithPopup(current, new GoogleAuthProvider());
        await applyPassword(current);
      }
      await current.reload();
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      setNotice(hasPassword ? "Đã đổi mật khẩu." : "Đã tạo mật khẩu. Từ nay bạn có thể đăng nhập bằng email và mật khẩu.");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-panel">
      <h1>{tx("Tài khoản")}</h1>
      <p className="auth-subtitle">{user?.email}</p>
      <h2>{hasPassword ? tx("Đổi mật khẩu") : tx("Tạo mật khẩu")}</h2>
      {hasGoogle && <p className="auth-subtitle">{tx("Bạn đã đăng nhập bằng Google nên không cần nhập mật khẩu cũ.")}</p>}
      <form onSubmit={submit} className="auth-form">
        {needsOldPassword && <label>{tx("Mật khẩu hiện tại")}<input type="password" autoComplete="current-password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></label>}
        <label>{tx("Mật khẩu mới")}<input type="password" autoComplete="new-password" required minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder={tx("Tối thiểu 8 ký tự")} /></label>
        <label>{tx("Nhập lại mật khẩu mới")}<input type="password" autoComplete="new-password" required minLength={8} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} /></label>
        {error && <div className="auth-error" role="alert">{tx(error)}</div>}
        {notice && <div className="auth-notice" role="status">{tx(notice)}</div>}
        <button className="auth-submit" disabled={busy}>{busy ? tx("Đang xử lý…") : hasPassword ? tx("Đổi mật khẩu") : tx("Tạo mật khẩu")}</button>
      </form>
      <p className="auth-switch"><Link href="/tickets">{tx("Quay lại hỗ trợ")}</Link></p>
    </main>
  );
}
