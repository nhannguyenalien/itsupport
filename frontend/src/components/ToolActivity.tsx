"use client";

import { useLanguage } from "@/lib/i18n";
import type { ToolCall } from "@/lib/api";

function display(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function ToolActivity({ call }: { call: ToolCall }) {
  const { tx, locale } = useLanguage();
  const status = call.result === "success" ? tx("Hoàn tất") : call.result === "error" ? tx("Có lỗi") : call.result === "timeout" ? tx("Hết thời gian") : tx("Đang chờ kết quả");
  const params = Object.fromEntries(Object.entries(call.params).filter(([key]) => !key.startsWith("__")));
  const result = call.result_data;
  const count = result && Object.values(result).find(Array.isArray);
  return <details className={`tool-activity tool-${call.result ?? "pending"}`}>
    <summary><span aria-hidden="true">{call.result === "success" ? "✓" : call.result ? "!" : "◷"}</span><strong>{call.tool}</strong><span>{status}{Array.isArray(count) ? tx("items", { count: new Intl.NumberFormat(locale).format(count.length) }) : ""}</span><small>{tx("Xem lệnh & kết quả")}</small></summary>
    <div className="tool-detail">
      <p>{call.parent_tool_call_id ? tx("Bước kiểm chứng") : tx("Thao tác trên máy")} · {new Date(call.requested_at).toLocaleTimeString(locale)}</p>
      <strong>{tx("Lệnh / công cụ và tham số đã gửi")}</strong>
      <pre>{display({ tool: call.tool, params })}</pre>
      <strong>{tx("Kết quả trả về")}</strong>
      <pre>{result !== null ? display(result) : call.result ? tx("Không có nội dung trả về.") : tx("Đang chờ agent trả kết quả…")}</pre>
      {call.error_message && <pre className="tool-error">{call.error_message}</pre>}
      {call.verification_status !== "not_required" && <p>{tx("Kiểm chứng:")} {tx(({ pending: "Đang chờ", passed: "Đạt", failed: "Không đạt" })[call.verification_status])}</p>}
    </div>
  </details>;
}
