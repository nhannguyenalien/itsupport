"use client";

import RemoteSupport from "./RemoteSupport";
import { useLanguage } from "@/lib/i18n";

import { FormEvent, useEffect, useRef, useState } from "react";
import { ToolActivity } from "./ToolActivity";
import { api, ApiError, type Approval, type TicketDetail } from "@/lib/api";

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
    "printer.spooler_reset": "Tôi đề xuất khởi động lại dịch vụ in và xóa các lệnh in bị kẹt. Các lệnh in đang chờ sẽ bị hủy. Bạn có đồng ý không?",
    "startup.disable": "Tôi đề xuất tắt một ứng dụng tự chạy khi khởi động để máy nhanh hơn. Có thể bật lại bất cứ lúc nào. Bạn có đồng ý không?",
    "startup.enable": "Tôi đề xuất bật lại ứng dụng tự chạy khi khởi động. Bạn có đồng ý không?",
    "windows_update.clear_cache": "Tôi đề xuất xóa bộ nhớ đệm tải về của Windows Update để sửa lỗi cập nhật và giải phóng dung lượng. Windows sẽ tự tải lại phần cần thiết. Bạn có đồng ý không?",
  };
  if (approval.tool.startsWith("desktop.")) return "Tôi cần thao tác trên màn hình máy để tiếp tục xử lý. Bạn có đồng ý không?";
  return questions[approval.tool] ?? "Tôi đã tìm thấy một bước có thể thay đổi máy của bạn. Bạn có đồng ý để tôi tiếp tục không?";
}

function friendlyError(value: unknown): string {
  if (value instanceof ApiError) {
    if (value.status === 401) return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
    if (value.status < 500) return value.message;
  }
  const message = String(value);
  if (message.includes("401") || message.includes("403")) return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
  if (message.includes("Failed to fetch")) return "Không thể kết nối tới dịch vụ hỗ trợ. Vui lòng thử lại sau ít phút.";
  return "Có lỗi xảy ra khi xử lý yêu cầu. Vui lòng thử lại.";
}

export default function TicketChat({ ticketId }: { ticketId: string }) {
  const { tx, locale } = useLanguage();
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(10);
  const [message, setMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [screenMode, setScreenMode] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [paused, setPaused] = useState(false);
  const advancing = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [localBusy, setBusy] = useState(false);
  const busy = localBusy || ticket?.aiWorkflow?.status === "running";
  const [messageSaved, setMessageSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  async function load(silent = false) {
    try { setTicket(await api.getTicket(ticketId)); if (!silent) setError(null); }
    catch (e) { setError(friendlyError(e)); }
  }

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(true), 3000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [ticket?.messages.length, ticket?.approvals.length, busy]);

  const sessionId = ticket?.computerUseSession?.id;
  useEffect(() => {
    if (!sessionId || paused) return;
    let disposed = false;
    const timer = window.setInterval(async () => {
      if (advancing.current) return;
      advancing.current = true;
      try { await api.advanceComputerUseSession(sessionId); if (!disposed) await load(true); }
      catch (e) {
        if (!disposed && !(e instanceof ApiError && e.status === 409)) { setPaused(true); setError(friendlyError(e)); }
      } finally { advancing.current = false; }
    }, 3000);
    return () => { disposed = true; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, paused]);

  async function askAi() {
    if (ticket?.computerUseSession) { setPaused(false); return; }
    if (screenMode) { await api.startComputerUseSession(ticketId); setPaused(false); }
    else await api.runAiStep(ticketId);
    await load(true);
  }

  async function stopScreen() {
    if (!sessionId) return;
    try { await api.stopComputerUseSession(sessionId); setPaused(false); await load(true); }
    catch (e) { setError(friendlyError(e)); }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const body = message.trim();
    if ((!body && !file) || busy || sessionId) return;
    setBusy(true); setError(null); setMessageSaved(false);
    let saved = false;
    try {
      const attachments = file ? [{ name: file.name, base64: await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(tx("Không đọc được tệp.")));
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.readAsDataURL(file);
      }) }] : [];
      await api.addMessage(ticketId, { authorType: "user", body, attachments });
      saved = true; setMessage(""); setFile(null); if (fileInput.current) fileInput.current.value = "";
      await load(true);
      await askAi();
    } catch (e) { setMessageSaved(saved); setError(friendlyError(e)); }
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

  if (!ticket) return <div className="support-loading">{error ? tx(error) : tx("Đang mở cuộc trò chuyện…")}{error && <button onClick={() => void load()}>{tx("Thử lại")}</button>}</div>;

  const timeline = [
    ...ticket.messages.map((item) => ({ kind: "message" as const, item, at: item.created_at })),
    ...ticket.toolCalls.map((item) => ({ kind: "tool" as const, item, at: item.requested_at })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const messages = ticket.messages;
  const messageEvents = timeline.filter((event) => event.kind === "message");
  const hiddenMessageCount = Math.max(0, messageEvents.length - visibleMessageCount);
  const firstVisibleMessage = messageEvents[hiddenMessageCount];
  const visibleTimeline = hiddenMessageCount && firstVisibleMessage
    ? timeline.slice(timeline.indexOf(firstVisibleMessage))
    : timeline;
  const approvals = ticket.approvals.filter((item) => item.status === "pending");
  const workflowError = ticket.aiWorkflow?.status === "failed" ? "ai.failed" :
    ["execution_timeout", "step_limit", "rejected"].includes(ticket.aiWorkflow?.stoppedBecause ?? "") ? "ai.incomplete" : null;
  const displayError = error ?? workflowError;
  const isWorking = busy || (!!sessionId && !paused && approvals.length === 0);

  return (
    <section className="support-chat-shell">
      <header className="support-chat-header">
        <div className="support-chat-title">
          <h1>{ticket.title}</h1>
          <p><span className={`support-status-dot ${isWorking ? "working" : ""}`} />{isWorking ? tx("Đang xử lý yêu cầu…") : tx(statusText[ticket.status] ?? "Đang hỗ trợ")}</p>
        </div>
        {ticket.device_id && <RemoteSupport deviceId={ticket.device_id} compact />}
      </header>

      <main className="support-chat-messages" aria-live="polite">
        {messages.length === 0 && <div className="support-welcome"><span>✦</span><h2>{tx("Xin chào, tôi có thể giúp gì cho bạn?")}</h2><p>{tx("Hãy mô tả vấn đề bằng lời bình thường. Tôi sẽ tự kiểm tra và chọn cách xử lý phù hợp.")}</p></div>}
        {hiddenMessageCount > 0 && <button type="button" onClick={() => setVisibleMessageCount((count) => count + 10)}>{tx("chat.older", { count: hiddenMessageCount })}</button>}
        {visibleTimeline.map((event) => {
          if (event.kind === "tool") return <ToolActivity key={event.item.id} call={event.item} />;
          const item = event.item;
          return (
          <div key={item.id} className={`support-message ${item.author_type === "user" ? "from-user" : "from-support"}`}>
            {item.author_type !== "user" && <span className="support-avatar">✦</span>}
            <div><p>{item.body}</p>{item.attachments?.map((attachment, index) => <details key={index}><summary>📎 {attachment.name} · {Math.ceil(attachment.size / 1024)} {tx("KB")}</summary><pre style={{ whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto" }}>{attachment.text}</pre></details>)}<time>{new Date(item.created_at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</time></div>
          </div>
        ); })}
        {approvals.map((approval) => (
          <div key={approval.id} className="support-message from-support support-confirmation">
            <span className="support-avatar">✦</span>
            <div><p>{tx(approvalQuestion(approval))}</p>{approval.reasoning && <p>{approval.reasoning}</p>}<details><summary>{tx("Xem thao tác cụ thể:")} {approval.tool}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(Object.fromEntries(Object.entries(approval.params).filter(([key]) => !key.startsWith("__"))), null, 2)}</pre></details><div className="support-confirm-actions"><button className="primary" onClick={() => void decide(approval.id, true)} disabled={busy}>{tx("Đồng ý, tiếp tục")}</button><button onClick={() => void decide(approval.id, false)} disabled={busy}>{tx("Không đồng ý")}</button></div></div>
          </div>
        ))}
        {isWorking && <div className="support-message from-support support-typing"><span className="support-avatar">✦</span><div><i /><i /><i /><span>{tx("Đang kiểm tra và xử lý…")}</span></div></div>}
        <div ref={endRef} />
      </main>

      {displayError && <div className="support-error">{messageSaved && tx("Tin nhắn đã lưu. Chọn Thử lại để tiếp tục xử lý. ")}{tx(displayError)} <button disabled={busy} onClick={() => { setError(null); setPaused(false); setBusy(true); void askAi().catch((e) => setError(friendlyError(e))).finally(() => setBusy(false)); }}>{tx("Thử lại")}</button></div>}
      {showOptions && <div className="support-options"><div className="support-chat-controls">
        {sessionId ? <><span>{ticket.computerUseSession?.stop_requested ? tx("Đang dừng phiên…") : paused ? tx("Phiên màn hình đang tạm dừng do lỗi") : tx("Phiên web/màn hình đang mở")}</span><button type="button" onClick={() => void stopScreen()}>{tx("Dừng phiên")}</button><small>{tx("Thao tác đã gửi xuống máy có thể hoàn tất. Đóng trang sẽ tạm ngừng gửi bước tiếp theo.")}</small></> : <label><input type="checkbox" checked={screenMode} disabled={busy} onChange={(e) => setScreenMode(e.target.checked)} /> {tx("Thao tác web/màn hình trên máy đã kết nối")}</label>}
        {!sessionId && <button type="button" disabled={busy || approvals.length > 0} onClick={() => { setBusy(true); setError(null); void askAi().catch((e) => setError(friendlyError(e))).finally(() => setBusy(false)); }}>{tx("Tiếp tục hỗ trợ")}</button>}
        <label>{tx("Đính kèm tài liệu")} <input ref={fileInput} type="file" accept=".pdf,.docx,.txt,.md" disabled={busy || !!sessionId} onChange={(e) => {
          const selected = e.target.files?.[0] ?? null;
          if (selected && selected.size > 5 * 1024 * 1024) { setError("Tệp không được vượt quá 5 MB."); e.target.value = ""; setFile(null); return; }
          setFile(selected);
        }} /></label>
        {file && <button type="button" onClick={() => { setFile(null); if (fileInput.current) fileInput.current.value = ""; }}>{tx("Bỏ tệp")}</button>}
        <small>{tx("PDF có chữ, DOCX, TXT, MD · tối đa 5 MB và 60.000 ký tự/tệp · nội dung được gửi cho AI để xử lý yêu cầu.")}</small>
      </div></div>}
      <form className="support-composer" onSubmit={sendMessage}>
        <button type="button" className={`composer-more ${showOptions ? "active" : ""}`} aria-expanded={showOptions} onClick={() => setShowOptions((v) => !v)} title={tx("Tùy chọn · đính kèm & thao tác màn hình")} aria-label={tx("Tùy chọn · đính kèm & thao tác màn hình")}>＋</button>
        {file && <span className="composer-file" title={file.name}>📎 {file.name}</span>}
        <textarea value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={tx("Nhập vấn đề bạn đang gặp…")} rows={1} disabled={busy || approvals.length > 0 || !!sessionId} aria-label={tx("Tin nhắn hỗ trợ")} />
        <button className="primary" type="submit" disabled={busy || approvals.length > 0 || !!sessionId || (!message.trim() && !file)} aria-label={tx("Gửi tin nhắn")}>{tx("Gửi")}</button>
      </form>
      <p className="support-hint">{tx("Nhấn Enter để gửi · Thao tác tuân theo quyền hỗ trợ của đơn vị · Không tự nhập mật khẩu hoặc mã OTP vào chat")}</p>
    </section>
  );
}
