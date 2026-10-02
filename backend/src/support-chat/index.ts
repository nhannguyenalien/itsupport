import { createHash } from "node:crypto";
import { queryTenantScoped } from "../db/pool.js";
import { recordAudit } from "../audit/index.js";
import { applyDataPolicy, type AiDataPolicy } from "../ai-orchestration/redact.js";
import type { AuthUser } from "../auth/types.js";
import { chat } from "./schoolsai.js";
import { runSupportTool, toolCatalog, type Proposal } from "./tools.js";

// Two support tiers on ONE SchoolsAI workspace:
//   tier 1 ("system")  — product/how-to advice from the workspace knowledge base,
//                        no account data, also available before login.
//   tier 2 ("account") — advice about the signed-in user's own workspace. The
//                        model asks for data with a `TOOL {...}` line; this
//                        backend runs the tool scoped to req.authUser.tenantId
//                        and feeds the result back, up to MAX_TOOL_ROUNDS.
// Sessions are derived server-side from the authenticated identity, so a
// client can never continue (or read back) another tenant's conversation.

export const MAX_TOOL_ROUNDS = 4;
const MAX_TOOL_RESULT_CHARS = 6000;
const ROLE_PERMISSIONS: Record<AuthUser["role"], string> = {
  admin: "toàn quyền: tạo mã thêm máy, thu hồi/tạm dừng thiết bị, bật/tắt AI, tạo ticket, chạy chẩn đoán, phê duyệt thao tác",
  technician: "tạo ticket, chạy chẩn đoán, phê duyệt/từ chối thao tác, mở hỗ trợ từ xa; không thu hồi/tạm dừng thiết bị hay bật/tắt AI",
  member: "xem thông tin và trao đổi trong ticket; KHÔNG tạo ticket, chạy chẩn đoán hay phê duyệt thao tác — cần nhờ technician/admin",
};
const LANGUAGE_NAMES: Record<string, string> = {
  vi: "tiếng Việt", en: "English", fr: "Français", ko: "한국어", ja: "日本語", es: "Español",
};

export interface ChatTurnInput {
  conversationId: string;
  message: string;
  language?: string;
}

export interface SystemChatResult {
  reply: string;
  needsHuman: boolean;
}

export interface AccountChatResult {
  reply: string;
  toolsUsed: string[];
  proposals: Proposal[];
}

function sessionId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 40)}`;
}

function languageLine(language?: string): string {
  const name = language && LANGUAGE_NAMES[language];
  return name ? `[Trả lời bằng ${name}]\n` : "";
}

export async function runSystemChat(user: AuthUser | null, input: ChatTurnInput): Promise<SystemChatResult> {
  const session = sessionId("sys", user?.id ?? "anonymous", input.conversationId);
  const { reply, needsHuman } = await chat(session, languageLine(input.language) + input.message);
  return { reply, needsHuman };
}

/** Extracts the JSON payload of a `TOOL {...}` directive, or null when the reply
 * is a normal answer. Tolerates code fences and surrounding prose. */
export function parseToolDirective(reply: string): { tool: string; args: unknown } | { invalid: string } | null {
  const marker = reply.search(/\bTOOL\s*\{/);
  if (marker === -1) return null;
  const start = reply.indexOf("{", marker);
  const end = reply.lastIndexOf("}");
  if (end <= start) return { invalid: "JSON không đóng ngoặc" };
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as { tool?: unknown; args?: unknown };
    if (typeof parsed.tool !== "string") return { invalid: 'thiếu trường "tool"' };
    return { tool: parsed.tool, args: parsed.args ?? {} };
  } catch {
    return { invalid: "JSON không hợp lệ" };
  }
}

function accountPrompt(user: AuthUser, input: ChatTurnInput): string {
  return `${languageLine(input.language)}[TRỢ LÝ TÀI KHOẢN — CẤP 2]
Bạn đang hỗ trợ riêng workspace "${user.tenantName}". Vai trò người hỏi: ${user.role} — quyền: ${ROLE_PERMISSIONS[user.role]}. Chỉ nói về dữ liệu của workspace này, lấy qua công cụ bên dưới (backend chạy giúp bạn, dữ liệu luôn mới). Không bịa số liệu, hostname hay mã ticket.
Công cụ:
${toolCatalog(user.role)}
Quy tắc:
- Khi cần dữ liệu, trả lời DUY NHẤT 1 dòng: TOOL {"tool":"<tên>","args":{...}}
- Hành động ghi (tạo ticket, chạy chẩn đoán) chỉ được ĐỀ XUẤT qua công cụ propose_*; người dùng tự bấm xác nhận trên giao diện. Không bao giờ nói là đã làm xong.
- Khi đủ dữ liệu, trả lời ngắn gọn, rõ ràng, không lộ cú pháp TOOL.
Câu hỏi: ${input.message}`;
}

function toolResultPrompt(name: string, data: unknown, question: string): string {
  let json = JSON.stringify(data);
  if (json.length > MAX_TOOL_RESULT_CHARS) json = json.slice(0, MAX_TOOL_RESULT_CHARS) + "…(đã cắt bớt)";
  return `[KẾT QUẢ TOOL ${name}]
${json}
Nếu cần thêm dữ liệu thì gọi TOOL khác; nếu đủ thì trả lời câu hỏi: ${question}`;
}

export async function runAccountChat(user: AuthUser, input: ChatTurnInput): Promise<AccountChatResult> {
  const tenant = await queryTenantScoped(user.tenantId,
    `SELECT ai_enabled, ai_data_policy FROM tenants WHERE id = $1`, [user.tenantId]);
  if (!tenant.rows[0]?.ai_enabled) {
    throw Object.assign(new Error("AI đã bị tắt cho workspace này. Quản trị viên có thể bật lại ở trang Tổng quan."), { statusCode: 409 });
  }
  const policy = tenant.rows[0].ai_data_policy as AiDataPolicy;
  const session = sessionId("acct", user.tenantId, user.id, input.conversationId);

  const toolsUsed: string[] = [];
  const proposals: Proposal[] = [];
  let { reply } = await chat(session, accountPrompt(user, input));

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const directive = parseToolDirective(reply);
    if (!directive) break;
    let name = "invalid";
    let data: unknown;
    if ("invalid" in directive) {
      data = { error: `Lệnh TOOL không hợp lệ (${directive.invalid}). Viết lại đúng 1 dòng TOOL {"tool":"...","args":{...}}.` };
    } else {
      name = directive.tool;
      const output = await runSupportTool(user.tenantId, name, directive.args, user.role);
      toolsUsed.push(name);
      if (output.proposal && !proposals.some((p) => p.action === output.proposal!.action && JSON.stringify(p.params) === JSON.stringify(output.proposal!.params))) {
        proposals.push(output.proposal);
      }
      data = applyDataPolicy(policy, output.data);
    }
    ({ reply } = await chat(session, toolResultPrompt(name, data, input.message)));
  }

  if (parseToolDirective(reply)) {
    reply = "Mình chưa tổng hợp được câu trả lời từ dữ liệu tài khoản. Bạn thử hỏi cụ thể hơn (ví dụ: tên máy hoặc ticket) nhé.";
  }

  await recordAudit({
    tenantId: user.tenantId,
    actorType: "user",
    actorId: user.id,
    eventType: "support_chat.account_turn",
    eventData: { tools: toolsUsed, proposals: proposals.map((p) => p.action) },
  });

  return { reply, toolsUsed, proposals };
}
