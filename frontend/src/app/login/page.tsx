"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";
import { createUserWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail, signInWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";
import { api, ApiError } from "@/lib/api";
import { auth } from "@/lib/firebase";

type Mode = "login" | "register" | "forgot";

function friendlyError(reason: unknown): string {
  const code = (reason as { code?: string }).code ?? "";
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return "Bạn đã đóng cửa sổ đăng nhập Google. Hãy thử lại khi sẵn sàng.";
  if (code === "auth/popup-blocked") return "Trình duyệt đã chặn cửa sổ Google. Hãy cho phép cửa sổ bật lên rồi thử lại.";
  if (code === "auth/unauthorized-domain") return "Tên miền này chưa được phép đăng nhập Google. Vui lòng liên hệ quản trị viên.";
  if (code === "auth/operation-not-allowed") return "Đăng nhập Google chưa được bật. Vui lòng liên hệ quản trị viên.";
  if (code === "auth/network-request-failed") return "Không kết nối được Google. Hãy kiểm tra mạng rồi thử lại.";
  if (code === "auth/account-exists-with-different-credential") return "Email này đã có tài khoản. Hãy đăng nhập bằng phương thức đã sử dụng trước đó.";
  if (reason instanceof ApiError && reason.status === 409) return "Email này đã gắn với tài khoản khác. Hãy dùng phương thức đăng nhập cũ hoặc liên hệ quản trị viên.";
  if (reason instanceof ApiError && reason.status === 429) return "Bạn thử quá nhiều lần. Vui lòng đợi ít phút rồi thử lại.";
  if (code.includes("email-already-in-use")) return "Email này đã được đăng ký.";
  if (code.includes("invalid-credential")) return "Email hoặc mật khẩu chưa đúng.";
  if (code.includes("too-many-requests")) return "Bạn thử quá nhiều lần. Vui lòng đợi ít phút rồi thử lại.";
  if (code.includes("weak-password")) return "Mật khẩu cần tối thiểu 8 ký tự.";
  return "Không thể xử lý yêu cầu. Vui lòng thử lại.";
}

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [mode, setMode] = useState<Mode>("login");
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  function enterWorkspace() {
    const next = search.get("next");
    // Backslashes are normalized by browsers and can turn a path into an external URL.
    router.replace(next?.startsWith("/") && !next.startsWith("//") && !/[\\\x00-\x1f]/.test(next) ? next : "/tickets");
    router.refresh();
  }

  async function loginWithGoogle() {
    if (busy) return;
    setError(""); setNotice(""); setBusy(true);
    let signedIn = false;
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      // Open synchronously from the click so popup blockers do not block after an API round trip.
      const credential = await signInWithPopup(auth, provider);
      signedIn = true;
      await api.authAttempt("login");
      try {
        await api.me();
      } catch (reason) {
        if (!(reason instanceof ApiError) || reason.code !== "WORKSPACE_REQUIRED") throw reason;
        const workspaceName = companyName.trim().length >= 2 ? companyName.trim() : `Workspace của ${credential.user.displayName || credential.user.email?.split("@")[0] || "bạn"}`;
        await api.registerWorkspace({ companyName: workspaceName.slice(0, 100) });
        await api.me();
      }
      enterWorkspace();
    } catch (reason) {
      if (signedIn) await signOut(auth).catch(() => {});
      setError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setNotice(""); setBusy(true);
    try {
      await api.authAttempt(mode === "forgot" ? "password-reset" : mode);
      if (mode === "forgot") {
        await sendPasswordResetEmail(auth, email);
        setNotice("Đã gửi liên kết đặt lại mật khẩu. Hãy kiểm tra hộp thư và thư rác.");
        return;
      }
      if (mode === "register") {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        await api.registerWorkspace({ companyName });
        await sendEmailVerification(credential.user);
        setNotice("Tài khoản đã tạo. Hãy mở email xác minh trước khi đăng nhập.");
        setMode("login");
        return;
      }
      const credential = await signInWithEmailAndPassword(auth, email, password);
      if (!credential.user.emailVerified) {
        await sendEmailVerification(credential.user);
        setNotice("Email chưa được xác minh. Mình vừa gửi lại liên kết xác minh.");
        return;
      }
      await api.me();
      enterWorkspace();
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <Link href="/" className="auth-brand">AI IT <strong>Support</strong></Link>
        {mode !== "forgot" && <div className="auth-tabs" role="tablist" aria-label="Chọn hình thức truy cập">
          <button type="button" disabled={busy} className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Đăng nhập</button>
          <button type="button" disabled={busy} className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Đăng ký</button>
        </div>}
        <h1>{mode === "login" ? "Chào mừng bạn quay lại" : mode === "register" ? "Tạo workspace trong một phút" : "Đặt lại mật khẩu"}</h1>
        <p className="auth-subtitle">{mode === "forgot" ? "Nhập email để nhận liên kết đặt lại mật khẩu an toàn." : mode === "login" ? "Đăng nhập để quản lý thiết bị và ticket hỗ trợ." : "Không cần thẻ thanh toán. Bạn sẽ là quản trị viên workspace."}</p>
        {mode !== "forgot" && <>
          <button type="button" className="auth-google" disabled={busy} onClick={loginWithGoogle}>
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 48 48"><path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11c-.5 2.5-1.9 4.6-4 6v5h6.5c3.8-3.5 6.1-8.6 6.1-14.7Z"/><path fill="#34A853" d="M24 44c5.4 0 10-1.8 13.5-4.8l-6.5-5c-1.8 1.2-4.1 1.9-7 1.9-5.2 0-9.7-3.5-11.3-8.2H6v5.2C9.4 39.6 16.2 44 24 44Z"/><path fill="#FBBC05" d="M12.7 27.9a12 12 0 0 1 0-7.8v-5.2H6a20 20 0 0 0 0 18.2l6.7-5.2Z"/><path fill="#EA4335" d="M24 11.9c3 0 5.6 1 7.7 3l5.8-5.8A19.5 19.5 0 0 0 24 4C16.2 4 9.4 8.4 6 14.9l6.7 5.2C14.3 15.4 18.8 11.9 24 11.9Z"/></svg>
            {busy ? "Đang xử lý…" : "Tiếp tục với Google"}
          </button>
          <div className="auth-divider"><span>hoặc dùng email</span></div>
        </>}
        <form onSubmit={submit} className="auth-form">
          {mode === "register" && <label>Tên công ty hoặc đội nhóm<input autoComplete="organization" required minLength={2} value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Ví dụ: SpaceHuge" /></label>}
          <label>Email<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ban@congty.com" /></label>
          {mode !== "forgot" && <label>Mật khẩu<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Tối thiểu 8 ký tự" /></label>}
          {error && <div className="auth-error" role="alert">{error}</div>}
          {notice && <div className="auth-notice" role="status">{notice}</div>}
          <button className="auth-submit" disabled={busy}>{busy ? "Đang xử lý…" : mode === "login" ? "Đăng nhập" : mode === "register" ? "Tạo tài khoản" : "Gửi email đặt lại"}</button>
        </form>
        {mode === "login" && <button className="auth-link-button" disabled={busy} type="button" onClick={() => setMode("forgot")}>Quên mật khẩu?</button>}
        <p className="auth-switch">{mode === "forgot" ? "Đã nhớ mật khẩu?" : mode === "login" ? "Chưa có tài khoản?" : "Đã có tài khoản?"} <button type="button" disabled={busy} onClick={() => setMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "Đăng ký miễn phí" : "Đăng nhập"}</button></p>
      </section>
      <aside className="auth-aside"><span>HỖ TRỢ IT CÓ KIỂM SOÁT</span><h2>Ít ticket lặp lại.<br />Nhiều thời gian cho công việc quan trọng.</h2><ul><li>✓ Phân tích và đề xuất xử lý bằng AI</li><li>✓ Luôn xin duyệt trước thao tác rủi ro</li><li>✓ Dữ liệu tách biệt theo workspace</li></ul></aside>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense fallback={<div className="auth-loading">Đang tải…</div>}><LoginForm /></Suspense>;
}
