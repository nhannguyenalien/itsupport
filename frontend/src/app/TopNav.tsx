"use client";

import { useLanguage, LanguageSwitcher } from "@/lib/i18n";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";

// Hidden on the customer-facing view (docs/v0.1-computer-use-addendum.md,
// frontend/src/app/tickets/[id]/customer/page.tsx) — that page is opened on
// the customer's own machine and must not surface links into the internal
// technician dashboard (Devices, Connections, Metrics, the full Tickets
// list). There's only one root layout in this app (no route-group split), so
// this is a client-side pathname check rather than two separate layouts.
export function TopNav() {
  const { tx } = useLanguage();
  const pathname = usePathname();
  const router = useRouter();
  // Shown only to the platform operator (the server enforces it as well).
  const [platformAdmin, setPlatformAdmin] = useState(false);
  useEffect(() => { api.me().then(({ user }) => setPlatformAdmin(!!user.platformAdmin)).catch(() => undefined); }, []);
  if (pathname === "/devices" || pathname.endsWith("/customer")) return <div className="locale-toolbar"><LanguageSwitcher /></div>;
  if (pathname.startsWith("/tickets") || pathname === "/devices" || pathname === "/" || pathname === "/login" || pathname?.endsWith("/customer")) return null;

  async function logout() {
    await signOut(auth);
    router.replace("/login");
    router.refresh();
  }

  return (
    <nav className="topnav">
      <Link href="/tickets" aria-current={pathname.startsWith("/tickets") ? "page" : undefined}>{tx("Hỗ trợ")}</Link>
      <Link href="/devices" aria-current={pathname === "/devices" ? "page" : undefined}>{tx("Thiết bị")}</Link>
      <details className="nav-more" key={pathname}>
        <summary>{tx("Thêm")}</summary>
        <div className="nav-more-menu">
          <Link href="/dashboard">{tx("Tổng quan")}</Link>
          <Link href="/connections">{tx("Kết nối dịch vụ")}</Link>
          <Link href="/metrics">{tx("Thống kê")}</Link>
          <Link href="/databases">{tx("Database của bạn")}</Link>
          {platformAdmin && <Link href="/platform/database">{tx("Sao lưu database")}</Link>}
          <Link href="/account">{tx("Tài khoản")}</Link>
        </div>
      </details>
      <LanguageSwitcher />
      <button className="topnav-logout" onClick={logout}>{tx("Đăng xuất")}</button>
    </nav>
  );
}
