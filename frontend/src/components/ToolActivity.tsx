import type { ToolCall } from "@/lib/api";

function display(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function ToolActivity({ call }: { call: ToolCall }) {
  const status = call.result === "success" ? "Hoàn tất" : call.result === "error" ? "Có lỗi" : call.result === "timeout" ? "Hết thời gian" : "Đang chờ kết quả";
  const params = Object.fromEntries(Object.entries(call.params).filter(([key]) => !key.startsWith("__")));
  const result = call.result_data;
  const count = result && Object.values(result).find(Array.isArray);
  return <details className={`tool-activity tool-${call.result ?? "pending"}`}>
    <summary><span aria-hidden="true">{call.result === "success" ? "✓" : call.result ? "!" : "◷"}</span><strong>{call.tool}</strong><span>{status}{Array.isArray(count) ? ` · ${count.length} mục` : ""}</span><small>Xem lệnh & kết quả</small></summary>
    <div className="tool-detail">
      <p>{call.parent_tool_call_id ? "Bước kiểm chứng" : "Thao tác trên máy"} · {new Date(call.requested_at).toLocaleTimeString("vi-VN")}</p>
      <strong>Lệnh / công cụ và tham số đã gửi</strong>
      <pre>{display({ tool: call.tool, params })}</pre>
      <strong>Kết quả trả về</strong>
      <pre>{result !== null ? display(result) : call.result ? "Không có nội dung trả về." : "Đang chờ agent trả kết quả…"}</pre>
      {call.error_message && <pre className="tool-error">{call.error_message}</pre>}
      {call.verification_status !== "not_required" && <p>Kiểm chứng: {({ pending: "Đang chờ", passed: "Đạt", failed: "Không đạt" })[call.verification_status]}</p>}
    </div>
  </details>;
}
