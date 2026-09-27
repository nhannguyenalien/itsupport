"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Language = "vi" | "en";

const copy = {
  vi: {
    navFeatures: "Tính năng", navHow: "Cách hoạt động", navSafety: "An toàn", navOpen: "Mở hệ thống",
    eyebrow: "Hỗ trợ IT tự động, có kiểm soát",
    headline: "Xử lý sự cố IT nhanh hơn. Đội ngũ nhẹ đầu hơn.",
    subhead: "Trợ lý AI chẩn đoán, đề xuất và xử lý sự cố trên thiết bị — với phê duyệt của con người cho mọi thao tác quan trọng.",
    primary: "Khám phá nền tảng", secondary: "Xem cách hoạt động", trust: "Thiết kế cho đội IT hiện đại",
    proof1: "Quan sát theo thời gian thực", proof2: "Phê duyệt trước khi thay đổi", proof3: "Nhật ký kiểm toán đầy đủ",
    dashboardLabel: "TRUNG TÂM VẬN HÀNH", online: "Thiết bị online", resolved: "Đã xử lý hôm nay", response: "Phản hồi trung bình",
    live: "Trực tuyến", issue: "Máy tính phòng Kế toán", diagnosing: "AI đang chẩn đoán…", action: "Đề xuất: khởi động lại dịch vụ in", approval: "Chờ phê duyệt",
    sectionEyebrow: "Một quy trình liền mạch", sectionTitle: "Từ tín hiệu đầu tiên đến khi sự cố được giải quyết",
    feature1Title: "Chẩn đoán có ngữ cảnh", feature1Body: "Tổng hợp trạng thái thiết bị, dịch vụ và lịch sử ticket để tìm đúng nguyên nhân.",
    feature2Title: "Tự động hóa an toàn", feature2Body: "Tác vụ thay đổi hệ thống luôn đi qua chính sách và bước phê duyệt rõ ràng.",
    feature3Title: "Kiểm chứng kết quả", feature3Body: "Không chỉ chạy lệnh — hệ thống kiểm tra lại kết quả trước khi đóng ticket.",
    howEyebrow: "Con người giữ quyền quyết định", howTitle: "AI làm phần lặp lại. Kỹ thuật viên xử lý điều quan trọng.",
    step1: "Phát hiện", step1Body: "Thiết bị gửi telemetry và tạo tín hiệu khi có bất thường.",
    step2: "Chẩn đoán", step2Body: "AI dùng công cụ chỉ đọc để khoanh vùng nguyên nhân.",
    step3: "Phê duyệt & xử lý", step3Body: "Kỹ thuật viên duyệt hành động; agent thực thi với quyền tách biệt.",
    step4: "Xác minh", step4Body: "Kết quả được kiểm tra và ghi lại đầy đủ trong audit log.",
    safetyEyebrow: "An toàn từ kiến trúc", safetyTitle: "Tự động hóa không đồng nghĩa với mất kiểm soát.",
    safetyBody: "Kill switch theo tenant, phân loại rủi ro, phê duyệt từng thao tác và nhật ký bất biến giúp đội ngũ kiểm soát mọi quyết định của AI.",
    ctaTitle: "Sẵn sàng giảm tải cho đội IT?", ctaBody: "Bắt đầu từ những ticket lặp lại và mở rộng tự động hóa theo mức độ tin cậy của bạn.", cta: "Mở dashboard",
    footer: "AI IT Support — vận hành thông minh, kiểm soát rõ ràng.",
  },
  en: {
    navFeatures: "Features", navHow: "How it works", navSafety: "Safety", navOpen: "Open platform",
    eyebrow: "Controlled, autonomous IT support", headline: "Resolve IT issues faster. Give your team room to breathe.",
    subhead: "An AI support agent that diagnoses, proposes, and resolves device issues — with human approval for every meaningful change.",
    primary: "Explore the platform", secondary: "See how it works", trust: "Built for modern IT teams",
    proof1: "Real-time visibility", proof2: "Approval before changes", proof3: "Complete audit trail",
    dashboardLabel: "OPERATIONS CENTER", online: "Devices online", resolved: "Resolved today", response: "Average response",
    live: "Live", issue: "Accounting workstation", diagnosing: "AI is diagnosing…", action: "Proposed: restart print service", approval: "Awaiting approval",
    sectionEyebrow: "One connected workflow", sectionTitle: "From the first signal to a verified resolution",
    feature1Title: "Context-aware diagnosis", feature1Body: "Correlate device health, services, and ticket history to identify the real cause.",
    feature2Title: "Safe automation", feature2Body: "System-changing actions always pass through policy and a clear approval step.",
    feature3Title: "Verified outcomes", feature3Body: "The platform does not just run commands — it checks the result before closing a ticket.",
    howEyebrow: "People stay in control", howTitle: "AI handles the repetitive work. Technicians handle what matters.",
    step1: "Detect", step1Body: "Device telemetry creates a signal as soon as something looks wrong.",
    step2: "Diagnose", step2Body: "AI uses read-only tools to narrow down the root cause.",
    step3: "Approve & resolve", step3Body: "A technician approves the action; a separated agent executes it.",
    step4: "Verify", step4Body: "The result is checked and recorded in the audit trail.",
    safetyEyebrow: "Safe by architecture", safetyTitle: "Automation should never mean losing control.",
    safetyBody: "Tenant kill switches, risk tiers, per-action approvals, and a complete audit trail keep your team in charge of every AI decision.",
    ctaTitle: "Ready to take the pressure off IT?", ctaBody: "Start with repetitive tickets and expand automation at your own pace.", cta: "Open dashboard",
    footer: "AI IT Support — intelligent operations, clear control.",
  },
} as const;

function Mark() {
  return <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>;
}

export default function LandingPage() {
  const [language, setLanguage] = useState<Language>("vi");
  const t = copy[language];

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return (
    <div className="landing-shell">
      <header className="landing-nav">
        <Link className="landing-brand" href="/" aria-label="AI IT Support home"><Mark /><span>AI IT <strong>Support</strong></span></Link>
        <nav className="landing-links" aria-label="Landing page">
          <a href="#features">{t.navFeatures}</a><a href="#how">{t.navHow}</a><a href="#safety">{t.navSafety}</a>
        </nav>
        <div className="nav-actions">
          <div className="language-switch" aria-label="Language">
            <button className={language === "vi" ? "active" : ""} onClick={() => setLanguage("vi")} aria-pressed={language === "vi"}>VI</button>
            <button className={language === "en" ? "active" : ""} onClick={() => setLanguage("en")} aria-pressed={language === "en"}>EN</button>
          </div>
          <Link className="nav-cta" href="/login">{t.navOpen}<span>↗</span></Link>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero-glow" />
          <div className="hero-copy">
            <div className="eyebrow"><span className="pulse-dot" />{t.eyebrow}</div>
            <h1>{t.headline}</h1>
            <p>{t.subhead}</p>
            <div className="hero-actions"><a className="button button-primary" href="#features">{t.primary}<span>→</span></a><a className="button button-ghost" href="#how"><span className="play">▶</span>{t.secondary}</a></div>
            <div className="trust-row"><span>{t.trust}</span><i /> <span>Windows</span><span>macOS</span><span>Linux</span></div>
          </div>

          <div className="product-visual" aria-label={t.dashboardLabel}>
            <div className="visual-top"><div className="visual-brand"><Mark /><span>{t.dashboardLabel}</span></div><span className="live-pill"><i />{t.live}</span></div>
            <div className="metric-grid">
              <div><span>{t.online}</span><strong>248</strong><small>↑ 12</small></div>
              <div><span>{t.resolved}</span><strong>37</strong><small>94%</small></div>
              <div><span>{t.response}</span><strong>1m 42s</strong><small>↓ 28%</small></div>
            </div>
            <div className="incident-card">
              <div className="device-icon">▣</div><div className="incident-main"><strong>{t.issue}</strong><span>WIN-ACCT-014 · Windows 11</span></div><span className="status-dot" />
            </div>
            <div className="diagnosis-flow">
              <div className="flow-line"><span className="flow-icon scanning">✦</span><div><strong>{t.diagnosing}</strong><span>Spooler service stopped unexpectedly</span></div></div>
              <div className="flow-line"><span className="flow-icon">⌁</span><div><strong>{t.action}</strong><span>Risk level: Low · Reversible</span></div><button>{t.approval}</button></div>
            </div>
            <div className="visual-log"><span>09:42:18</span><span>service.status</span><span className="success">✓ SUCCESS</span></div>
          </div>

          <div className="proof-strip"><span>✓ {t.proof1}</span><span>✓ {t.proof2}</span><span>✓ {t.proof3}</span></div>
        </section>

        <section className="landing-section" id="features">
          <div className="section-heading"><span>{t.sectionEyebrow}</span><h2>{t.sectionTitle}</h2></div>
          <div className="feature-grid">
            {[["01", t.feature1Title, t.feature1Body, "◎"], ["02", t.feature2Title, t.feature2Body, "◇"], ["03", t.feature3Title, t.feature3Body, "✓"]].map(([n, title, body, icon]) => (
              <article className="feature-card" key={n}><span className="feature-number">{n}</span><span className="feature-icon">{icon}</span><h3>{title}</h3><p>{body}</p></article>
            ))}
          </div>
        </section>

        <section className="workflow-section" id="how">
          <div className="workflow-copy"><span>{t.howEyebrow}</span><h2>{t.howTitle}</h2></div>
          <ol className="workflow-list">
            {[[t.step1, t.step1Body], [t.step2, t.step2Body], [t.step3, t.step3Body], [t.step4, t.step4Body]].map(([title, body], i) => <li key={title}><span>{String(i + 1).padStart(2, "0")}</span><div><h3>{title}</h3><p>{body}</p></div></li>)}
          </ol>
        </section>

        <section className="safety-section" id="safety"><div className="safety-orbit"><span>AI</span><i /><i /><i /></div><div><span className="section-kicker">{t.safetyEyebrow}</span><h2>{t.safetyTitle}</h2><p>{t.safetyBody}</p></div></section>

        <section className="landing-cta"><div><h2>{t.ctaTitle}</h2><p>{t.ctaBody}</p></div><Link className="button button-light" href="/login">{t.cta}<span>→</span></Link></section>
      </main>
      <footer className="landing-footer"><Link className="landing-brand" href="/"><Mark /><span>AI IT <strong>Support</strong></span></Link><p>{t.footer}</p><span>© 2026</span></footer>
    </div>
  );
}
