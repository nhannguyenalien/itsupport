"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { api, type SupportProposal, type SupportTier } from "@/lib/api";
import { auth } from "@/lib/firebase";
import { useLanguage } from "@/lib/i18n";

interface ChatEntry {
  role: "user" | "bot" | "error";
  text: string;
  proposals?: SupportProposal[];
  needsHuman?: boolean;
}

interface Conversation {
  id: string;
  entries: ChatEntry[];
}

const STORAGE_KEY = "itsupport.supportChat";

function freshConversation(): Conversation {
  return { id: crypto.randomUUID(), entries: [] };
}

function loadConversations(): Record<SupportTier, Conversation> {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved?.system?.id && saved?.account?.id) return saved;
  } catch { /* Storage unavailable: start a new conversation. */ }
  return { system: freshConversation(), account: freshConversation() };
}

export const OPEN_ASSISTANT_EVENT = "itsupport:open-assistant";

// Floating two-tier support assistant. Tier "system" answers how the product
// works (also before login); tier "account" answers about the signed-in
// workspace. Account proposals (create ticket, run diagnosis) only execute
// when the user clicks them, through the regular authenticated endpoints.
export function SupportChat() {
  const { tx, language } = useLanguage();
  const pathname = usePathname();
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [tier, setTier] = useState<SupportTier>("system");
  const [conversations, setConversations] = useState<Record<SupportTier, Conversation>>(() => ({ system: freshConversation(), account: freshConversation() }));
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setConversations(loadConversations());
    api.supportChatStatus().then(({ enabled }) => setEnabled(enabled)).catch(() => setEnabled(false));
    return onAuthStateChanged(auth, (user) => setSignedIn(Boolean(user?.emailVerified)));
  }, []);

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(conversations)); } catch { /* Session-only history. */ }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [conversations, tier, open]);

  useEffect(() => { if (!signedIn) setTier("system"); }, [signedIn]);

  useEffect(() => {
    const openAssistant = () => setOpen(true);
    window.addEventListener(OPEN_ASSISTANT_EVENT, openAssistant);
    return () => window.removeEventListener(OPEN_ASSISTANT_EVENT, openAssistant);
  }, []);

  // Never shown on the customer's own machine view (see TopNav for the same rule).
  if (!enabled || pathname?.endsWith("/customer")) return null;

  const conversation = conversations[tier];
  const append = (target: SupportTier, entry: ChatEntry) =>
    setConversations((current) => ({ ...current, [target]: { ...current[target], entries: [...current[target].entries, entry] } }));

  async function send(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;
    const target = tier;
    setDraft("");
    setBusy(true);
    append(target, { role: "user", text: message });
    try {
      const result = await api.supportChat(target, { conversationId: conversations[target].id, message, language });
      append(target, { role: "bot", text: result.reply, proposals: result.proposals, needsHuman: result.needsHuman });
    } catch (error) {
      append(target, { role: "error", text: error instanceof Error ? error.message : tx("Trợ lý hỗ trợ gặp lỗi, vui lòng thử lại.") });
    } finally {
      setBusy(false);
    }
  }

  async function runProposal(proposal: SupportProposal) {
    const key = proposal.action + JSON.stringify(proposal.params);
    setActing(key);
    try {
      if (proposal.action === "create_ticket") {
        const { user } = await api.me();
        const ticket = await api.createTicket({ tenantId: user.tenantId, deviceId: proposal.params.deviceId, title: proposal.params.title });
        append("account", { role: "bot", text: tx("Đã tạo ticket. Đang mở…") });
        router.push(`/tickets/${ticket.id}`);
      } else {
        await api.runAiStep(proposal.params.ticketId);
        append("account", { role: "bot", text: tx("Đã bắt đầu chẩn đoán. Đang mở ticket…") });
        router.push(`/tickets/${proposal.params.ticketId}`);
      }
    } catch (error) {
      append("account", { role: "error", text: error instanceof Error ? error.message : tx("Không thực hiện được thao tác.") });
    } finally {
      setActing(null);
    }
  }

  function reset() {
    setConversations((current) => ({ ...current, [tier]: freshConversation() }));
  }

  // The ticket workspace has its own composer in that corner; it opens the
  // assistant from the sidebar instead of a floating button.
  if (!open) {
    if (pathname?.startsWith("/tickets")) return null;
    return <button type="button" className="assistant-launcher" onClick={() => setOpen(true)} aria-label={tx("Mở trợ lý hỗ trợ")}>
      <span aria-hidden="true">?</span> {tx("Trợ lý")}
    </button>;
  }

  return (
    <section className="assistant-panel" aria-label={tx("Trợ lý hỗ trợ")}>
      <header className="assistant-header">
        <div className="assistant-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tier === "system"} onClick={() => setTier("system")}>{tx("Hệ thống")}</button>
          {signedIn && <button type="button" role="tab" aria-selected={tier === "account"} onClick={() => setTier("account")}>{tx("Tài khoản của tôi")}</button>}
        </div>
        <button type="button" className="assistant-icon" onClick={reset} title={tx("Cuộc trò chuyện mới")} aria-label={tx("Cuộc trò chuyện mới")}>↺</button>
        <button type="button" className="assistant-icon" onClick={() => setOpen(false)} aria-label={tx("Đóng")}>×</button>
      </header>
      <div className="assistant-messages" ref={listRef} aria-live="polite">
        {conversation.entries.length === 0 && <p className="assistant-hint">
          {tier === "system"
            ? tx("Hỏi về cách dùng hệ thống: thêm máy, ticket, phê duyệt, hỗ trợ từ xa…")
            : tx("Hỏi về chính tài khoản của bạn: máy nào đang offline, ticket nào đang chờ, tạo ticket mới…")}
        </p>}
        {conversation.entries.map((entry, index) => (
          <div key={index} className={`assistant-entry assistant-${entry.role}`}>
            <div className="assistant-bubble">{entry.text.replace(/\*\*/g, "")}</div>
            {entry.needsHuman && <p className="assistant-note">{tx("Cần kỹ thuật viên hỗ trợ thêm — hãy tạo ticket ở mục Hỗ trợ.")}</p>}
            {entry.proposals?.map((proposal) => {
              const key = proposal.action + JSON.stringify(proposal.params);
              return <button key={key} type="button" className="primary assistant-action" disabled={acting !== null} onClick={() => runProposal(proposal)}>
                {acting === key ? tx("Đang thực hiện…") : `${tx("Xác nhận")}: ${proposal.label}`}
              </button>;
            })}
          </div>
        ))}
        {busy && <div className="assistant-entry assistant-bot"><div className="assistant-bubble assistant-typing">{tx("Đang trả lời…")}</div></div>}
      </div>
      <form className="assistant-form" onSubmit={send}>
        <input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={4000} placeholder={tx("Nhập câu hỏi…")} aria-label={tx("Nhập câu hỏi…")} disabled={busy} />
        <button type="submit" className="primary" disabled={busy || !draft.trim()}>{tx("Gửi")}</button>
      </form>
    </section>
  );
}
