"use client";

import Link from "next/link";
import { useLanguage, LanguageSwitcher } from "@/lib/i18n";

function Mark() {
  return <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>;
}

export default function LandingPage() {
  const { tx, locale } = useLanguage();

  return (
    <div className="landing-shell">
      <header className="landing-nav">
        <Link className="landing-brand" href="/" aria-label={tx("homeLabel")}><Mark /><span>AI IT <strong>Support</strong></span></Link>
        <nav className="landing-links" aria-label={tx("landingLabel")}>
          <a href="#features">{tx("landing.navFeatures")}</a><a href="#how">{tx("landing.navHow")}</a><a href="#safety">{tx("landing.navSafety")}</a>
        </nav>
        <div className="nav-actions">
          <LanguageSwitcher />
          <Link className="nav-cta" href="/login">{tx("landing.navOpen")}<span>↗</span></Link>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero-glow" />
          <div className="hero-copy">
            <div className="eyebrow"><span className="pulse-dot" />{tx("landing.eyebrow")}</div>
            <h1>{tx("landing.headline")}</h1>
            <p>{tx("landing.subhead")}</p>
            <div className="hero-actions"><a className="button button-primary" href="#features">{tx("landing.primary")}<span>→</span></a><a className="button button-ghost" href="#how"><span className="play">▶</span>{tx("landing.secondary")}</a></div>
            <div className="trust-row"><span>{tx("landing.trust")}</span><i /> <span>Windows</span><span>macOS</span><span>Linux</span></div>
          </div>

          <div className="product-visual" aria-label={tx("landing.dashboardLabel")}>
            <div className="visual-top"><div className="visual-brand"><Mark /><span>{tx("landing.dashboardLabel")}</span></div><span className="live-pill"><i />{tx("landing.live")}</span></div>
            <div className="metric-grid">
              <div><span>{tx("landing.online")}</span><strong>248</strong><small>↑ 12</small></div>
              <div><span>{tx("landing.resolved")}</span><strong>37</strong><small>94%</small></div>
              <div><span>{tx("landing.response")}</span><strong>{new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "narrow" }).format(1)} {new Intl.NumberFormat(locale, { style: "unit", unit: "second", unitDisplay: "narrow" }).format(42)}</strong><small>↓ 28%</small></div>
            </div>
            <div className="incident-card">
              <div className="device-icon">▣</div><div className="incident-main"><strong>{tx("landing.issue")}</strong><span>WIN-ACCT-014 · Windows 11</span></div><span className="status-dot" />
            </div>
            <div className="diagnosis-flow">
              <div className="flow-line"><span className="flow-icon scanning">✦</span><div><strong>{tx("landing.diagnosing")}</strong><span>{tx("spooler")}</span></div></div>
              <div className="flow-line"><span className="flow-icon">⌁</span><div><strong>{tx("landing.action")}</strong><span>{tx("riskLow")}</span></div><button>{tx("landing.approval")}</button></div>
            </div>
            <div className="visual-log"><span>09:42:18</span><span>service.status</span><span className="success">{tx("success")}</span></div>
          </div>

          <div className="proof-strip"><span>✓ {tx("landing.proof1")}</span><span>✓ {tx("landing.proof2")}</span><span>✓ {tx("landing.proof3")}</span></div>
        </section>

        <section className="landing-section" id="features">
          <div className="section-heading"><span>{tx("landing.sectionEyebrow")}</span><h2>{tx("landing.sectionTitle")}</h2></div>
          <div className="feature-grid">
            {[["01", tx("landing.feature1Title"), tx("landing.feature1Body"), "◎"], ["02", tx("landing.feature2Title"), tx("landing.feature2Body"), "◇"], ["03", tx("landing.feature3Title"), tx("landing.feature3Body"), "✓"]].map(([n, title, body, icon]) => (
              <article className="feature-card" key={n}><span className="feature-number">{n}</span><span className="feature-icon">{icon}</span><h3>{title}</h3><p>{body}</p></article>
            ))}
          </div>
        </section>

        <section className="workflow-section" id="how">
          <div className="workflow-copy"><span>{tx("landing.howEyebrow")}</span><h2>{tx("landing.howTitle")}</h2></div>
          <ol className="workflow-list">
            {[[tx("landing.step1"), tx("landing.step1Body")], [tx("landing.step2"), tx("landing.step2Body")], [tx("landing.step3"), tx("landing.step3Body")], [tx("landing.step4"), tx("landing.step4Body")]].map(([title, body], i) => <li key={title}><span>{String(i + 1).padStart(2, "0")}</span><div><h3>{title}</h3><p>{body}</p></div></li>)}
          </ol>
        </section>

        <section className="safety-section" id="safety"><div className="safety-orbit"><span>AI</span><i /><i /><i /></div><div><span className="section-kicker">{tx("landing.safetyEyebrow")}</span><h2>{tx("landing.safetyTitle")}</h2><p>{tx("landing.safetyBody")}</p></div></section>

        <section className="landing-cta"><div><h2>{tx("landing.ctaTitle")}</h2><p>{tx("landing.ctaBody")}</p></div><Link className="button button-light" href="/login">{tx("landing.cta")}<span>→</span></Link></section>
      </main>
      <footer className="landing-footer"><Link className="landing-brand" href="/"><Mark /><span>AI IT <strong>Support</strong></span></Link><p>{tx("landing.footer")}</p><span>© 2026</span></footer>
    </div>
  );
}
