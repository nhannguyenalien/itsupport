"use client";

import { useLanguage } from "@/lib/i18n";
import type { Approval } from "@/lib/api";

/** Shows a command the way the machine will run it: one argv item per
 * argument, quoted only so a human can read the boundaries. Nothing is run
 * through a shell, so what is displayed is exactly what executes. */
export function quoteArg(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function argvOf(value: unknown): string[] | null {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string") ? value as string[] : null;
}

export const commandLine = (argv: string[]) => argv.map(quoteArg).join(" ");

export function ShellApproval({ approval, busy, onDecide }: { approval: Approval; busy: boolean; onDecide: (approve: boolean) => void }) {
  const { tx } = useLanguage();
  const argv = argvOf(approval.params.argv);
  const verify = argvOf(approval.params.verify_argv);
  const purpose = typeof approval.params.purpose === "string" ? approval.params.purpose : approval.reasoning;
  return (
    <div>
      <p>{tx("Tôi đề xuất chạy một lệnh trên máy này. Lệnh có thể thay đổi máy.")}</p>
      {purpose && <p><strong>{tx("Mục đích:")}</strong> {purpose}</p>}
      {argv ? (
        <>
          <strong>{tx("Lệnh sẽ chạy")}</strong>
          <pre className="shell-command">{commandLine(argv)}</pre>
          <p className="muted">{tx("Chạy đúng như trên, không qua shell. Gồm {count} phần.", { count: argv.length })}</p>
        </>
      ) : <p className="error-text">{tx("Không đọc được lệnh. Hãy từ chối.")}</p>}
      {verify && (
        <>
          <strong>{tx("Lệnh kiểm tra sau khi chạy")}</strong>
          <pre className="shell-command">{commandLine(verify)}</pre>
        </>
      )}
      <p className="muted">{tx("Chỉ đồng ý khi bạn hiểu rõ lệnh. Lệnh hết hạn sau 15 phút nếu máy chưa chạy.")}</p>
      <div className="support-confirm-actions">
        <button className="primary" disabled={busy || !argv} onClick={() => onDecide(true)}>{tx("Đồng ý, chạy lệnh này")}</button>
        <button disabled={busy} onClick={() => onDecide(false)}>{tx("Không đồng ý")}</button>
      </div>
    </div>
  );
}
