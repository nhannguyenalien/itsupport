"use client";

import { useLanguage } from "@/lib/i18n";
import { useState } from "react";
import { api, type ToolCall } from "@/lib/api";
import { argvOf, commandLine } from "./ShellApproval";

function display(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function ToolActivity({ call }: { call: ToolCall }) {
  const { tx, locale } = useLanguage();
  const status = call.result === "success" ? tx("Hoàn tất") : call.result === "error" ? tx("Có lỗi") : call.result === "timeout" ? tx("Hết thời gian") : tx("Đang chờ kết quả");
  const params = Object.fromEntries(Object.entries(call.params).filter(([key]) => !key.startsWith("__")));
  const [full, setFull] = useState<Record<string, unknown> | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const result = full ?? call.result_data;
  const needsFetch = !!call.result_truncated && !full;
  async function loadResult() {
    if (!needsFetch) return;
    try { setFull((await api.getToolCallResult(call.id)).result_data); setLoadFailed(false); } catch { setLoadFailed(true); }
  }
  const count = result && Object.values(result).find(Array.isArray);
  // shell.run results are command output: show real line breaks, not JSON escapes.
  const shellArgv = call.tool === "shell.run" ? argvOf(call.params.argv) : null;
  const shellOut = shellArgv && result && !needsFetch ? result as { exit_code?: number; timed_out?: boolean; stdout?: string; stderr?: string; stdout_truncated?: boolean } : null;
  return <details className={`tool-activity tool-${call.result ?? "pending"}`} onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) void loadResult(); }}>
    <summary><span aria-hidden="true">{call.result === "success" ? "✓" : call.result ? "!" : "◷"}</span><strong>{call.tool}</strong><span>{status}{Array.isArray(count) ? tx("items", { count: new Intl.NumberFormat(locale).format(count.length) }) : ""}</span><small>{tx("Xem lệnh & kết quả")}</small></summary>
    <div className="tool-detail">
      <p>{call.parent_tool_call_id ? tx("Bước kiểm chứng") : tx("Thao tác trên máy")} · {new Date(call.requested_at).toLocaleTimeString(locale)}</p>
      <strong>{tx("Lệnh / công cụ và tham số đã gửi")}</strong>
      <pre>{shellArgv ? commandLine(shellArgv) : display({ tool: call.tool, params })}</pre>
      <strong>{tx("Kết quả trả về")}</strong>
      {shellOut && <>
        <p>{shellOut.timed_out ? tx("Hết thời gian") : tx("Mã thoát: {code}", { code: String(shellOut.exit_code ?? "?") })}{shellOut.stdout_truncated ? ` · ${tx("Đầu ra đã bị cắt bớt")}` : ""}</p>
        {shellOut.stdout && <pre>{shellOut.stdout}</pre>}
        {shellOut.stderr && <pre className="tool-error">{shellOut.stderr}</pre>}
      </>}
      {!shellOut && <pre>{needsFetch ? (loadFailed ? tx("Có lỗi") : "…") : result !== null ? display(result) : call.result ? tx("Không có nội dung trả về.") : tx("Đang chờ agent trả kết quả…")}</pre>}
      {call.error_message && <pre className="tool-error">{call.error_message}</pre>}
      {call.verification_status !== "not_required" && <p>{tx("Kiểm chứng:")} {tx(({ pending: "Đang chờ", passed: "Đạt", failed: "Không đạt" })[call.verification_status])}</p>}
    </div>
  </details>;
}
