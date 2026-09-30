"use client";

import { useLanguage } from "@/lib/i18n";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, type TicketDetail } from "@/lib/api";

// Customer-facing status/chat view (docs/v0.1-computer-use-addendum.md) —
// opened automatically on the customer's own machine by
// desktop.open_customer_view when a computer-use session starts. Deliberately
// a SEPARATE page from the technician view (../page.tsx), not a stripped-down
// mode of it: no Approve/Reject buttons, no RiskBadge, no raw tool-call JSON —
// approval decisions stay with the technician, this page only ever reads the
// same GET /tickets/:id data and lets the customer send a plain chat message
// (POST /tickets/:id/messages with authorType:"user", the exact same endpoint
// the technician page's own chat box already uses).

/** Plain-English summary of what's happening right now — no tool names, no
 * JSON, just enough for someone who isn't IT staff to follow along. */
function describeCurrentActivity(ticket: TicketDetail): string {
  if (ticket.aiWorkflow?.status === "running") return "Đang kiểm tra và xử lý…";
  if (ticket.aiWorkflow?.status === "failed") return "ai.failed";
  if (["execution_timeout", "step_limit", "rejected"].includes(ticket.aiWorkflow?.stoppedBecause ?? "")) return "ai.incomplete";
  if (ticket.aiWorkflow?.stoppedBecause === "completed") return "Sẵn sàng hỗ trợ";
  if (ticket.status === "resolved" || ticket.status === "closed") {
    return "This issue has been resolved.";
  }
  if (ticket.status === "escalated") {
    return "This has been handed to a support technician for a closer look.";
  }
  if (ticket.approvals.some((a) => a.status === "pending")) {
    return "A technician is reviewing the next step before it runs on your computer.";
  }
  if (ticket.toolCalls.some((tc) => tc.executed_at === null)) {
    return "The AI is currently working on your issue.";
  }
  return "The AI is diagnosing your issue.";
}

export default function CustomerTicketPage() {
  const { tx } = useLanguage();
  const params = useParams<{ id: string }>();
  const ticketId = params.id;

  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messageBody, setMessageBody] = useState("");

  async function load() {
    try {
      setTicket(await api.getTicket(ticketId));
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId]);

  if (!ticket) return <p className="muted">{tx("Loading…")}</p>;

  async function sendMessage() {
    if (!messageBody.trim()) return;
    try {
      await api.addMessage(ticketId, { authorType: "user", body: messageBody });
      setMessageBody("");
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div>
      <h1>{ticket.title}</h1>
      {error && (
        <div className="card" style={{ color: "#b91c1c" }}>
          {tx(error)}
        </div>
      )}

      <div className="card" style={{ background: "#eff6ff", borderColor: "#bfdbfe" }}>
        <strong>{tx(describeCurrentActivity(ticket))}</strong>
      </div>

      <div className="card">
        <h3>{tx("Chat")}</h3>
        {ticket.messages.length === 0 && <p className="muted">{tx("No messages yet.")}</p>}
        {ticket.messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.author_type}`}>
            <div className="muted" style={{ fontSize: "0.75rem" }}>
              {m.author_type === "ai" ? tx("Support AI") : m.author_type === "technician" ? tx("Technician") : m.author_type === "user" ? tx("You") : tx("System")}
            </div>
            {m.body}
          </div>
        ))}
        <div className="row" style={{ marginTop: "0.75rem" }}>
          <input
            placeholder={tx("Type a message…")}
            value={messageBody}
            onChange={(e) => setMessageBody(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={sendMessage}>{tx("Send")}</button>
        </div>
      </div>
    </div>
  );
}
