"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";
import { api, type Approval, type TicketDetail } from "@/lib/api";

const statusText: Record<string, string> = {
  open: "Sẵn sàng hỗ trợ", diagnosing: "Đang kiểm tra", awaiting_approval: "Cần bạn xác nhận",
  remediating: "Đang xử lý", resolved: "Đã xử lý xong", remediation_failed: "Chưa xử lý được",
  escalated: "Đã chuyển kỹ thuật viên", closed: "Đã đóng",
};

function approvalQuestion(approval: Approval): string {
  const questions: Record<string, string> = {
    "temp.clean": "Tôi đã kiểm tra xong và đề xuất dọn các tệp tạm để giải phóng dung lượng. Bạn có đồng ý không?",
    "process.kill": "Tôi đề xuất đóng chương trình đang gây sự cố. Dữ liệu chưa lưu trong chương trình đó có thể bị mất. Bạn có đồng ý không?",
    "service.restart": "Tôi đề xuất khởi động lại dịch vụ đang gặp lỗi. Máy có thể gián đoạn trong chốc lát. Bạn có đồng ý không?",
    "network.flush_dns": "Tôi đề xuất làm mới kết nối tên miền trên máy. Bạn có đồng ý không?",
    "printer.clear_queue": "Tôi đề xuất xóa các lệnh in đang bị kẹt. Bạn có đồng ý không?",
  };
  if (approval.tool.startsWith("desktop.")) return "Tôi cần thao tác trên màn hình máy để tiếp tục xử lý. Bạn có đồng ý không?";
  return questions[approval.tool] ?? "Tôi đã tìm thấy một bước có thể thay đổi máy của bạn. Bạn có đồng ý để tôi tiếp tục không?";
}

function friendlyError(value: unknown): string {
  const message = String(value);
  if (message.includes("401") || message.includes("403")) return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
  if (message.includes("Failed to fetch")) return "Không thể kết nối tới dịch vụ hỗ trợ. Vui lòng thử lại sau ít phút.";
  return "Có lỗi xảy ra khi xử lý yêu cầu. Vui lòng thử lại.";
}

export default function TicketDetailPage() {
  const { id: ticketId } = useParams<{ id: string }>();
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  async function load(silent = false) {
    try { setTicket(await api.getTicket(ticketId)); if (!silent) setError(null); }
    catch (e) { if (!silent) setError(friendlyError(e)); }
  }

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(true), 3000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [ticket?.messages.length, ticket?.approvals.length, busy]);

  async function askAi() { await api.runAiStep(ticketId); await load(true); }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const body = message.trim();
    if (!body || busy) return;
    setBusy(true); setError(null); setMessage("");
    try {
      await api.addMessage(ticketId, { authorType: "user", body });
      await load(true);
      await askAi();
    } catch (e) { setMessage(body); setError(friendlyError(e)); }
    finally { setBusy(false); }
  }

  async function decide(approvalId: string, approve: boolean) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (approve) await api.approveApproval(approvalId); else await api.rejectApproval(approvalId);
      await load(true);
      await askAi();
    } catch (e) { setError(friendlyError(e)); }
    finally { setBusy(false); }
  }

  if (!ticket) return <div className="support-loading">Đang mở cuộc trò chuyện…</div>;

  const messages = ticket.messages.filter((item) => item.author_type !== "system");
  const approvals = ticket.approvals.filter((item) => item.status === "pending");
  const isWorking = busy || ticket.toolCalls.some((item) => item.result === null);

  return (
    <section className="support-chat-shell">
      <header className="support-chat-header">
        <Link href="/tickets" className="support-back" aria-label="Quay lại danh sách yêu cầu">←</Link>
        <div>
          <h1>{ticket.title}</h1>
          <p><span className={`support-status-dot ${isWorking ? "working" : ""}`} />{isWorking ? "Đang xử lý yêu cầu…" : (statusText[ticket.status] ?? "Đang hỗ trợ")}</p>
        </div>
      </header>

      <main className="support-chat-messages" aria-live="polite">
        {messages.length === 0 && <div className="support-welcome"><span>✦</span><h2>Xin chào, tôi có thể giúp gì cho bạn?</h2><p>Hãy mô tả vấn đề bằng lời bình thường. Tôi sẽ tự kiểm tra và chọn cách xử lý phù hợp.</p></div>}
        {messages.map((item) => (
          <div key={item.id} className={`support-message ${item.author_type === "user" ? "from-user" : "from-support"}`}>
            {item.author_type !== "user" && <span className="support-avatar">✦</span>}
            <div><p>{item.body}</p><time>{new Date(item.created_at).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}</time></div>
          </div>
        ))}
        {approvals.map((approval) => (
          <div key={approval.id} className="support-message from-support support-confirmation">
            <span className="support-avatar">✦</span>
            <div><p>{approvalQuestion(approval)}</p><div className="support-confirm-actions"><button className="primary" onClick={() => void decide(approval.id, true)} disabled={busy}>Đồng ý, tiếp tục</button><button onClick={() => void decide(approval.id, false)} disabled={busy}>Không đồng ý</button></div></div>
          </div>
        ))}
        {isWorking && <div className="support-message from-support support-typing"><span className="support-avatar">✦</span><div><i /><i /><i /><span>Đang kiểm tra và xử lý…</span></div></div>}
        <div ref={endRef} />
      </main>

      {error && <div className="support-error">{error}</div>}
      <form className="support-composer" onSubmit={sendMessage}>
        <textarea value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Nhập vấn đề bạn đang gặp…" rows={1} disabled={busy || approvals.length > 0} aria-label="Tin nhắn hỗ trợ" />
        <button className="primary" type="submit" disabled={busy || approvals.length > 0 || !message.trim()} aria-label="Gửi tin nhắn">Gửi</button>
      </form>
      <p className="support-hint">Nhấn Enter để gửi · Mọi thay đổi quan trọng đều cần bạn xác nhận</p>
    </section>
  );
}
