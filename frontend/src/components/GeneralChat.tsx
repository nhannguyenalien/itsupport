"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Device, type SupportProposal, type Ticket } from "@/lib/api";
import { executeProposal, proposalKey } from "@/lib/assistantActions";
import { useLanguage } from "@/lib/i18n";

interface Entry {
  role: "user" | "bot" | "error";
  text: string;
  at: string;
  proposals?: SupportProposal[];
}

interface Conversation {
  id: string;
  entries: Entry[];
  // proposalKey -> ticket id of the session it opened
  done: Record<string, string>;
}

const storageKey = (tenantId: string) => `itsupport.generalChat.${tenantId}`;
const fresh = (): Conversation => ({ id: crypto.randomUUID(), entries: [], done: {} });
const ACTIVE = (t: Ticket) => !["resolved", "closed"].includes(t.status);

// "Chat tổng": the account-level assistant (backend tier 2) as a full
// conversation pinned above the device list. It sees every device and session
// in the workspace and can hand a request to any device's AI; each hand-off
// opens a normal per-device session where approvals still apply.
export default function GeneralChat({ tenantId, devices, tickets, onOpenTicket, onSessionCreated }: {
  tenantId: string;
  devices: Device[];
  tickets: Ticket[];
  onOpenTicket: (ticketId: string, deviceId?: string | null) => void;
  onSessionCreated: (ticket: Ticket) => void;
}) {
  const { tx, language, locale } = useLanguage();
  const [conversation, setConversation] = useState<Conversation>(fresh);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(tenantId)) ?? "null");
      if (saved?.id && Array.isArray(saved.entries)) setConversation({ done: {}, ...saved });
    } catch { /* Storage unavailable: start fresh. */ }
    loaded.current = true;
  }, [tenantId]);

  useEffect(() => {
    if (loaded.current) {
      try { localStorage.setItem(storageKey(tenantId), JSON.stringify({ ...conversation, entries: conversation.entries.slice(-60) })); } catch { /* Session-only history. */ }
    }
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation, tenantId, busy]);

  const online = devices.filter((d) => d.status === "online" && !d.revoked).length;
  const active = tickets.filter(ACTIVE).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const hostname = (deviceId: string | null) => devices.find((d) => d.id === deviceId)?.hostname ?? tx("thiết bị");

  const append = (entry: Omit<Entry, "at">) =>
    setConversation((c) => ({ ...c, entries: [...c.entries, { ...entry, at: new Date().toISOString() }] }));

  async function ask(message: string) {
    const text = message.trim();
    if (!text || busy) return;
    setDraft("");
    setBusy(true);
    append({ role: "user", text });
    try {
      const result = await api.supportChat("account", { conversationId: conversation.id, message: text, language });
      append({ role: "bot", text: result.reply.replace(/\*\*/g, ""), proposals: result.proposals });
    } catch (error) {
      append({ role: "error", text: error instanceof Error ? error.message : tx("Trợ lý hỗ trợ gặp lỗi, vui lòng thử lại.") });
    } finally {
      setBusy(false);
    }
  }

  async function run(proposals: SupportProposal[]) {
    for (const proposal of proposals) {
      const key = proposalKey(proposal);
      if (conversation.done[key]) continue;
      setActing(key);
      try {
        const { ticketId, ticket } = await executeProposal(proposal, tenantId);
        setConversation((c) => ({ ...c, done: { ...c.done, [key]: ticketId } }));
        if (ticket) onSessionCreated(ticket);
        if (proposals.length === 1) onOpenTicket(ticketId, ticket?.device_id ?? proposal.params.deviceId);
      } catch (error) {
        append({ role: "error", text: `${proposal.params.hostname ?? ""} ${error instanceof Error ? error.message : tx("Không thực hiện được thao tác.")}`.trim() });
      }
    }
    setActing(null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void ask(draft);
  }

  const suggestions = [
    tx("Tổng quan tất cả máy và các phiên đang mở"),
    tx("Máy nào đang ngoại tuyến?"),
    tx("Kiểm tra dung lượng ổ đĩa trên tất cả các máy"),
    tx("Tóm tắt kết quả các phiên chat gần đây"),
  ];

  return (
    <section className="support-chat-shell general-chat">
      <header className="general-overview">
        <button type="button" className="general-stats" aria-expanded={showSessions} onClick={() => setShowSessions((v) => !v)}>
          <span><strong>{devices.length}</strong> {tx("máy")}</span>
          <span><i className="machine-dot online" /> <strong>{online}</strong> {tx("đang kết nối")}</span>
          <span><strong>{active.length}</strong> {tx("phiên đang mở")}</span>
          <small>{showSessions ? "▴" : "▾"}</small>
        </button>
        {showSessions && (
          <ul className="general-sessions">
            {active.length === 0 && <li className="muted">{tx("Không có phiên nào đang mở.")}</li>}
            {active.slice(0, 12).map((t) => (
              <li key={t.id}><button type="button" onClick={() => onOpenTicket(t.id, t.device_id)}>
                <strong>{hostname(t.device_id)}</strong><span>{t.title}</span><time>{new Date(t.created_at).toLocaleDateString(locale)}</time>
              </button></li>
            ))}
          </ul>
        )}
      </header>

      <main className="support-chat-messages" aria-live="polite">
        {conversation.entries.length === 0 && (
          <div className="support-welcome">
            <span>✦</span>
            <h2>{tx("Chat tổng cho tất cả máy")}</h2>
            <p>{tx("Hỏi về mọi máy và mọi phiên chat trong tài khoản, hoặc giao việc cho một hay nhiều máy cùng lúc. Thao tác sửa vẫn cần bạn duyệt trong phiên của từng máy.")}</p>
            <div className="general-suggestions">
              {suggestions.map((s) => <button key={s} type="button" onClick={() => void ask(s)} disabled={busy}>{s}</button>)}
            </div>
          </div>
        )}
        {conversation.entries.map((entry, index) => {
          const pending = (entry.proposals ?? []).filter((p) => !conversation.done[proposalKey(p)]);
          return (
            <div key={index} className={`support-message ${entry.role === "user" ? "from-user" : "from-support"} ${entry.role === "error" ? "general-error" : ""}`}>
              {entry.role !== "user" && <span className="support-avatar">✦</span>}
              <div>
                <p>{entry.text}</p>
                {entry.proposals && entry.proposals.length > 0 && (
                  <div className="general-proposals">
                    {entry.proposals.map((p) => {
                      const key = proposalKey(p);
                      const ticketId = conversation.done[key];
                      return ticketId
                        ? <button key={key} type="button" className="general-done" onClick={() => onOpenTicket(ticketId, p.params.deviceId)}>✓ {p.label} · {tx("Mở phiên")}</button>
                        : <button key={key} type="button" className="primary" disabled={acting !== null} onClick={() => void run([p])}>{acting === key ? tx("Đang thực hiện…") : `${tx("Xác nhận")}: ${p.label}`}</button>;
                    })}
                    {pending.length > 1 && (
                      <button type="button" className="general-all" disabled={acting !== null} onClick={() => void run(pending)}>{tx("Thực hiện tất cả ({count})", { count: pending.length })}</button>
                    )}
                  </div>
                )}
                <time>{new Date(entry.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</time>
              </div>
            </div>
          );
        })}
        {busy && <div className="support-message from-support support-typing"><span className="support-avatar">✦</span><div><i /><i /><i /><span>{tx("Đang tổng hợp từ các máy…")}</span></div></div>}
        <div ref={endRef} />
      </main>

      <form className="support-composer" onSubmit={submit}>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={1} maxLength={4000} disabled={busy}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
          placeholder={tx("Hỏi về tất cả máy, hoặc giao việc cho các máy…")} aria-label={tx("Tin nhắn chat tổng")} />
        <button className="primary" type="submit" disabled={busy || !draft.trim()}>{tx("Gửi")}</button>
      </form>
      <p className="support-hint">{tx("Chat tổng chỉ đề xuất; mỗi việc giao cho máy mở một phiên riêng và thao tác sửa vẫn cần duyệt.")}</p>
    </section>
  );
}

export function resetGeneralChat(tenantId: string) {
  try { localStorage.removeItem(storageKey(tenantId)); } catch { /* nothing stored */ }
}
