// Service plans for customer database backups. The cap is on the TOTAL size of a
// workspace's source databases (pg_database_size), so a Free workspace can protect
// 1 GB of data across all its databases, a Pro workspace 20 GB.

export type Plan = "free" | "pro";
export const PLANS: readonly Plan[] = ["free", "pro"];

export function isPlan(value: unknown): value is Plan {
  return value === "free" || value === "pro";
}

const GB = 2 ** 30;

/** Bytes a workspace on `plan` may back up in total. Overridable per deployment. */
export function planLimitBytes(plan: Plan, env: NodeJS.ProcessEnv = process.env): number {
  const gb = plan === "pro" ? Number(env.PLAN_PRO_DB_GB ?? 20) : Number(env.PLAN_FREE_DB_GB ?? 1);
  return Math.floor((Number.isFinite(gb) && gb > 0 ? gb : plan === "pro" ? 20 : 1) * GB);
}

export function formatSize(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;
  if (bytes >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(bytes >= 100 * 2 ** 20 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface QuotaResult { ok: boolean; message?: string }

/** Would adding `incoming` bytes to what the workspace already backs up (`used`,
 * counting every OTHER database) stay within its plan? */
export function checkQuota(plan: Plan, used: number, incoming: number, env: NodeJS.ProcessEnv = process.env): QuotaResult {
  const limit = planLimitBytes(plan, env);
  if (used + incoming <= limit) return { ok: true };
  const label = plan === "pro" ? "Pro" : "Free";
  const upgrade = plan === "free" ? ` Nâng cấp lên Pro để sao lưu tới ${formatSize(planLimitBytes("pro", env))}.` : "";
  return {
    ok: false,
    message: `Vượt dung lượng gói ${label} (${formatSize(limit)}): các database khác đang dùng ${formatSize(used)}, database này ${formatSize(incoming)}.${upgrade}`,
  };
}
