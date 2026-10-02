// Thin client for the SchoolsAI Knowledge Worker API (https://apic.schoolsai.work/docs).
// One workspace serves both support tiers; only POST /api/v1/chat is used at
// runtime. /api/v1/operator-chat was evaluated first but returns
// INVALID_MODEL_OUTPUT for every request once any agent tool is registered,
// so tier-2 tool calling is orchestrated here instead (see index.ts).

const DEFAULT_URL = "https://apic.schoolsai.work";
const TIMEOUT_MS = 45_000;

export class SchoolsAiError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = "SchoolsAiError";
  }
}

export function schoolsAiConfigured(): boolean {
  return Boolean(process.env.SCHOOLSAI_API_KEY);
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const key = process.env.SCHOOLSAI_API_KEY;
  if (!key) throw new SchoolsAiError(503, "Trợ lý hỗ trợ chưa được cấu hình (SCHOOLSAI_API_KEY).");
  const base = (process.env.SCHOOLSAI_API_URL ?? DEFAULT_URL).replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(base + path, {
      ...init,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new SchoolsAiError(502, "Không kết nối được tới trợ lý hỗ trợ, vui lòng thử lại.");
  }
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* Non-JSON gateway error. */ }
  if (!res.ok) {
    // Upstream errors are logged by the caller; users only see a generic message
    // with a status that does not blame their own request.
    const detail = (body as { error?: unknown } | null)?.error;
    throw new SchoolsAiError(res.status === 429 ? 429 : 502, typeof detail === "string" ? detail : `SchoolsAI ${res.status}`);
  }
  return body as T;
}

/** One turn on POST /api/v1/chat. SchoolsAI keeps the session history, so the
 * session id is the only conversation state we hold. */
export async function chat(session: string, question: string): Promise<{ reply: string; needsHuman: boolean }> {
  const body = await call<{ reply?: unknown; needsHuman?: unknown }>("/api/v1/chat", {
    method: "POST",
    body: JSON.stringify({ session, question }),
  });
  if (typeof body?.reply !== "string") throw new SchoolsAiError(502, "SchoolsAI trả về phản hồi không hợp lệ.");
  return { reply: body.reply, needsHuman: body.needsHuman === true };
}

export async function patchConfig(fields: Record<string, unknown>): Promise<void> {
  await call("/api/v1/config", { method: "PATCH", body: JSON.stringify(fields) });
}

export async function listKnowledge(): Promise<Array<{ id: string; title?: string }>> {
  const body = await call<{ documents?: Array<{ id: string; title?: string }>; knowledge?: Array<{ id: string; title?: string }> }>("/api/v1/knowledge", { method: "GET" });
  return body.documents ?? body.knowledge ?? [];
}

export async function addKnowledge(title: string, text: string): Promise<void> {
  await call("/api/v1/knowledge", { method: "POST", body: JSON.stringify({ title, text }) });
}

export async function deleteKnowledge(id: string): Promise<void> {
  await call(`/api/v1/knowledge/${encodeURIComponent(id)}`, { method: "DELETE" });
}
