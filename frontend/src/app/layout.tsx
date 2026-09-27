import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { TopNav } from "./TopNav";
import { AuthGate } from "./AuthGate";

export const metadata: Metadata = {
  title: "AI IT Support — Intelligent IT operations",
  description: "AI-powered IT support that diagnoses, proposes, resolves, and verifies device issues with people in control.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>
        <AuthGate>
          <TopNav />
          <div className="main">{children}</div>
        </AuthGate>
      </body>
    </html>
  );
}
