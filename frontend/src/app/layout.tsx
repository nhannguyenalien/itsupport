import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata = { title: "AI Windows Support Agent" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="topnav">
          <Link href="/">Home</Link>
          <Link href="/devices">Devices</Link>
          <Link href="/connections">Connections</Link>
          <Link href="/tickets">Tickets</Link>
          <Link href="/metrics">Metrics</Link>
        </nav>
        <main className="main">{children}</main>
      </body>
    </html>
  );
}
