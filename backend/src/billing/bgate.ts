import { randomUUID } from "node:crypto";

// Client for the BGate billing router (https://billing.schoolsai.work/docs/).
// Payments run through Whop as a monthly automatic subscription; BGate is the
// source of truth for whether a workspace's Pro subscription is active.

export const PRO_PRODUCT = process.env.BGATE_PRO_PRODUCT ?? "itsupport-pro";
export const PRO_PRICE_USD = process.env.BGATE_PRO_PRICE ?? "9";

const baseUrl = () => (process.env.BGATE_API_URL ?? "https://billing.schoolsai.work").replace(/\/+$/, "");

export function billingConfigured(): boolean {
  return Boolean(process.env.BGATE_API_KEY);
}

export class BillingError extends Error {
  constructor(message: string, readonly statusCode = 502) { super(message); }
}

async function call<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<T> {
  const key = process.env.BGATE_API_KEY;
  if (!key) throw new BillingError("Thanh toán chưa được cấu hình.", 503);
  const headers: Record<string, string> = { "X-API-Key": key, "Content-Type": "application/json" };
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new BillingError("Không kết nối được cổng thanh toán, vui lòng thử lại.");
  }
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const detail = (body as { error?: string; message?: string } | null);
    throw new BillingError(detail?.error ?? detail?.message ?? `Cổng thanh toán trả về lỗi ${res.status}.`);
  }
  return body as T;
}

export interface Checkout { checkout_url: string; order_id?: string }

/** `userId` is the workspace (tenant) id, so a subscription belongs to the workspace, not a person. */
export async function createProCheckout(userId: string): Promise<Checkout> {
  const out = await call<Record<string, unknown>>("/api/v1/checkout", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: JSON.stringify({
      product: PRO_PRODUCT, user_id: userId, provider: "whop",
      amount: PRO_PRICE_USD, currency: "USD", billing_interval: "monthly", renewal_mode: "automatic",
    }),
  });
  const url = out.checkout_url ?? (out.data as { checkout_url?: string } | undefined)?.checkout_url;
  if (typeof url !== "string") throw new BillingError("Cổng thanh toán không trả về liên kết thanh toán.");
  return { checkout_url: url, order_id: typeof out.order_id === "string" ? out.order_id : undefined };
}

export interface Entitlement { active: boolean; expires_at: string | null }

export async function proEntitlement(userId: string): Promise<Entitlement> {
  const out = await call<{ active?: boolean; expires_at?: string | null }>(
    `/api/v1/entitlements/${encodeURIComponent(userId)}/${encodeURIComponent(PRO_PRODUCT)}`);
  return { active: out.active === true, expires_at: out.expires_at ?? null };
}
