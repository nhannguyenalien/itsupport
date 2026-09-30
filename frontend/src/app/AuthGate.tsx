"use client";

import { useLanguage } from "@/lib/i18n";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { api } from "@/lib/api";
import { auth } from "@/lib/firebase";

export function AuthGate({ children }: { children: ReactNode }) {
  const { tx } = useLanguage();
  const pathname = usePathname();
  const router = useRouter();
  const publicPage = pathname === "/" || pathname === "/login";
  const [checkedPath, setCheckedPath] = useState<string | null>(publicPage ? pathname : null);

  useEffect(() => {
    if (publicPage) {
      setCheckedPath(pathname);
      return;
    }
    let active = true;
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!active) return;
      if (!user || !user.emailVerified) {
        setCheckedPath(null);
        router.replace(`/login?next=${encodeURIComponent(pathname)}`);
        return;
      }
      try {
        await api.me();
        if (active) setCheckedPath(pathname);
      } catch {
        if (active) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      }
    });
    return () => { active = false; unsubscribe(); };
  }, [pathname, publicPage, router]);

  if (!publicPage && checkedPath !== pathname) return <div className="auth-loading">{tx("Đang kiểm tra phiên đăng nhập…")}</div>;
  return children;
}
