import { adminPool } from "../db/pool.js";
import type { Plan } from "../db-backup/plans.js";

// Monthly AI chat allowance per workspace plan. Counted per calendar month (UTC)
// on the signed-in "account" assistant; the anonymous system tier is not metered.

export function chatLimit(plan: Plan, env: NodeJS.ProcessEnv = process.env): number {
  const fallback = plan === "pro" ? 1000 : 30;
  const n = Number(plan === "pro" ? env.PLAN_PRO_CHATS : env.PLAN_FREE_CHATS);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function currentPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export async function chatUsed(tenantId: string): Promise<number> {
  const r = await adminPool.query(`SELECT count FROM tenant_chat_usage WHERE tenant_id = $1 AND period = $2`, [tenantId, currentPeriod()]);
  return r.rows[0]?.count ?? 0;
}

/** Atomically takes one chat from the month's allowance; false when it is used up. */
export async function consumeChat(tenantId: string, plan: Plan): Promise<boolean> {
  const r = await adminPool.query(
    `INSERT INTO tenant_chat_usage (tenant_id, period, count) VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, period) DO UPDATE SET count = tenant_chat_usage.count + 1
       WHERE tenant_chat_usage.count < $3
     RETURNING count`, [tenantId, currentPeriod(), chatLimit(plan)]);
  return r.rowCount === 1;
}

/** Gives a chat back when the assistant failed before answering. */
export async function refundChat(tenantId: string): Promise<void> {
  await adminPool.query(
    `UPDATE tenant_chat_usage SET count = GREATEST(count - 1, 0) WHERE tenant_id = $1 AND period = $2`, [tenantId, currentPeriod()]);
}
