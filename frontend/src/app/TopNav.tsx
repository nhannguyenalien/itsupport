"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";

// Hidden on the customer-facing view (docs/v0.1-computer-use-addendum.md,
// frontend/src/app/tickets/[id]/customer/page.tsx) — that page is opened on
// the customer's own machine and must not surface links into the internal
// technician dashboard (Devices, Connections, Metrics, the full Tickets
// list). There's only one root layout in this app (no route-group split), so
// this is a client-side pathname check rather than two separate layouts.
export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  if (pathname.startsWith("/tickets") || pathname === "/devices" || pathname === "/" || pathname === "/login" || pathname?.endsWith("/customer")) return null;

  async function logout() {
    await signOut(auth);
    router.replace("/login");
    router.refresh();
  }

  return (
    <nav className="topnav">
      <Link href="/tickets" aria-current={pathname.startsWith("/tickets") ? "page" : undefined}>Hỗ trợ</Link>
      <Link href="/devices" aria-current={pathname === "/devices" ? "page" : undefined}>Thiết bị</Link>
      <details className="nav-more" key={pathname}>
        <summary>Thêm</summary>
        <div className="nav-more-menu">
          <Link href="/dashboard">Tổng quan</Link>
          <Link href="/connections">Kết nối dịch vụ</Link>
          <Link href="/metrics">Thống kê</Link>
        </div>
      </details>
      <button className="topnav-logout" onClick={logout}>Đăng xuất</button>
    </nav>
  );
}
