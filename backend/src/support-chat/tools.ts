import { z } from "zod";
import { queryTenantScoped } from "../db/pool.js";

// Tier-2 ("my account") tools. Every query takes the tenant from the
// authenticated session — never from model output — and also carries an
// explicit tenant_id predicate on top of RLS. Model-chosen ids are only ever
// looked up *within* that tenant, so a hallucinated or injected id from
// another workspace resolves to "not found", never to foreign data.
//
// Write actions are never executed here. propose_* tools validate their
// target and return a proposal the user must confirm in the UI, which then
// calls the regular authenticated endpoints (role checks, policy engine,
// approvals and audit all still apply).

export interface Proposal {
  action: "create_ticket" | "run_diagnosis";
  label: string;
  params: Record<string, string>;
}

export interface ToolOutput {
  data: unknown;
  proposal?: Proposal;
}

interface ToolDefinition {
  description: string;
  args: z.ZodTypeAny;
  argsHint: string;
  run: (tenantId: string, args: any) => Promise<ToolOutput>;
}

const uuid = z.string().uuid();
const TICKET_STATUSES = ["open", "diagnosing", "awaiting_approval", "remediating", "resolved", "remediation_failed", "escalated", "closed"] as const;

async function findDevice(tenantId: string, deviceId: string) {
  const result = await queryTenantScoped(tenantId,
    `SELECT id, hostname, platform, status, cert_revoked_at IS NOT NULL AS revoked
     FROM devices WHERE id = $1 AND tenant_id = $2`, [deviceId, tenantId]);
  return result.rows[0] ?? null;
}

export const supportTools: Record<string, ToolDefinition> = {
  account_overview: {
    description: "Tổng quan tài khoản: số thiết bị online/offline, ticket đang mở, phê duyệt đang chờ",
    args: z.object({}).passthrough(),
    argsHint: "{}",
    run: async (tenantId) => {
      const [devices, tickets, approvals, tenant] = await Promise.all([
        queryTenantScoped(tenantId,
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE status = 'online' AND cert_revoked_at IS NULL)::int AS online,
                  count(*) FILTER (WHERE cert_revoked_at IS NOT NULL)::int AS revoked
           FROM devices WHERE tenant_id = $1`, [tenantId]),
        queryTenantScoped(tenantId,
          `SELECT status, count(*)::int AS count FROM tickets WHERE tenant_id = $1 GROUP BY status`, [tenantId]),
        queryTenantScoped(tenantId,
          `SELECT count(*)::int AS pending FROM approvals a JOIN tickets t ON t.id = a.ticket_id
           WHERE t.tenant_id = $1 AND a.status = 'pending'`, [tenantId]),
        queryTenantScoped(tenantId, `SELECT name, ai_enabled FROM tenants WHERE id = $1`, [tenantId]),
      ]);
      return {
        data: {
          workspace: tenant.rows[0]?.name,
          ai_enabled: tenant.rows[0]?.ai_enabled,
          devices: devices.rows[0],
          tickets_by_status: Object.fromEntries(tickets.rows.map((r) => [r.status, r.count])),
          pending_approvals: approvals.rows[0]?.pending ?? 0,
        },
      };
    },
  },

  list_devices: {
    description: "Liệt kê thiết bị (hostname, hệ điều hành, online/offline, lần cuối kết nối)",
    args: z.object({ status: z.enum(["online", "offline", "all"]).default("all") }),
    argsHint: '{"status":"online|offline|all"}',
    run: async (tenantId, { status }) => {
      const result = await queryTenantScoped(tenantId,
        `SELECT id, hostname, platform, os_version, agent_version, status, last_seen_at, actions_paused,
                cert_revoked_at IS NOT NULL AS revoked
         FROM devices WHERE tenant_id = $1 AND ($2 = 'all' OR status = $2)
         ORDER BY hostname LIMIT 50`, [tenantId, status]);
      return { data: { count: result.rowCount, devices: result.rows } };
    },
  },

  list_tickets: {
    description: "Liệt kê ticket gần nhất, lọc theo trạng thái (active = chưa xong)",
    args: z.object({ status: z.enum(["active", "all", ...TICKET_STATUSES]).default("active") }),
    argsHint: '{"status":"active|all|open|resolved|escalated|awaiting_approval|..."}',
    run: async (tenantId, { status }) => {
      const result = await queryTenantScoped(tenantId,
        `SELECT t.id, t.title, t.status, t.created_at, t.resolved_at, d.hostname AS device
         FROM tickets t LEFT JOIN devices d ON d.id = t.device_id
         WHERE t.tenant_id = $1 AND (
           $2 = 'all' OR t.status = $2 OR ($2 = 'active' AND t.status NOT IN ('resolved', 'closed')))
         ORDER BY t.created_at DESC LIMIT 20`, [tenantId, status]);
      return { data: { count: result.rowCount, tickets: result.rows } };
    },
  },

  get_ticket: {
    description: "Chi tiết 1 ticket: tin nhắn gần nhất, công cụ đã chạy, phê duyệt",
    args: z.object({ ticket_id: uuid }),
    argsHint: '{"ticket_id":"<uuid>"}',
    run: async (tenantId, { ticket_id }) => {
      const ticket = await queryTenantScoped(tenantId,
        `SELECT t.id, t.title, t.status, t.created_at, t.resolved_at, d.hostname AS device, d.platform
         FROM tickets t LEFT JOIN devices d ON d.id = t.device_id
         WHERE t.id = $1 AND t.tenant_id = $2`, [ticket_id, tenantId]);
      if (!ticket.rowCount) return { data: { error: "Không tìm thấy ticket trong tài khoản này." } };
      const [messages, toolCalls, approvals] = await Promise.all([
        queryTenantScoped(tenantId,
          `SELECT author_type, left(body, 600) AS body, created_at FROM ticket_messages
           WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 8`, [ticket_id]),
        queryTenantScoped(tenantId,
          `SELECT tool, risk, result, error_message, verification_status, requested_at FROM tool_calls
           WHERE ticket_id = $1 AND parent_tool_call_id IS NULL ORDER BY requested_at DESC LIMIT 10`, [ticket_id]),
        queryTenantScoped(tenantId,
          `SELECT tool, status, reasoning, created_at FROM approvals WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 5`, [ticket_id]),
      ]);
      return {
        data: {
          ticket: ticket.rows[0],
          recent_messages: messages.rows.reverse(),
          tool_calls: toolCalls.rows,
          approvals: approvals.rows,
        },
      };
    },
  },

  get_metrics: {
    description: "Số liệu hiệu quả: tổng ticket, AI tự xử lý, chuyển kỹ thuật viên, thời gian xử lý trung bình",
    args: z.object({}).passthrough(),
    argsHint: "{}",
    run: async (tenantId) => {
      const [tickets, approvals] = await Promise.all([
        queryTenantScoped(tenantId,
          `SELECT tickets_total, tickets_ai_resolved, tickets_escalated, round(avg_resolution_seconds) AS avg_resolution_seconds
           FROM metrics_tickets WHERE tenant_id = $1`, [tenantId]),
        queryTenantScoped(tenantId,
          `SELECT approvals_total, approvals_granted, approval_rate FROM metrics_approvals WHERE tenant_id = $1`, [tenantId]),
      ]);
      return { data: { ...(tickets.rows[0] ?? { tickets_total: 0 }), ...(approvals.rows[0] ?? {}) } };
    },
  },

  propose_create_ticket: {
    description: "ĐỀ XUẤT tạo ticket hỗ trợ cho 1 thiết bị (người dùng phải bấm xác nhận, bạn không tự tạo được)",
    args: z.object({ device_id: uuid, title: z.string().trim().min(3).max(200) }),
    argsHint: '{"device_id":"<uuid từ list_devices>","title":"mô tả ngắn sự cố"}',
    run: async (tenantId, { device_id, title }) => {
      const device = await findDevice(tenantId, device_id);
      if (!device) return { data: { error: "Không tìm thấy thiết bị trong tài khoản này." } };
      if (device.revoked) return { data: { error: "Thiết bị đã bị thu hồi, không thể tạo ticket." } };
      return {
        data: { proposed: true, note: "Đã hiển thị nút xác nhận cho người dùng. Chưa có gì được tạo." },
        proposal: { action: "create_ticket", label: `Tạo ticket "${title}" cho ${device.hostname}`, params: { deviceId: device.id, title } },
      };
    },
  },

  propose_run_diagnosis: {
    description: "ĐỀ XUẤT chạy chẩn đoán AI cho 1 ticket đang mở (người dùng phải bấm xác nhận)",
    args: z.object({ ticket_id: uuid }),
    argsHint: '{"ticket_id":"<uuid>"}',
    run: async (tenantId, { ticket_id }) => {
      const ticket = await queryTenantScoped(tenantId,
        `SELECT id, title, status, device_id FROM tickets WHERE id = $1 AND tenant_id = $2`, [ticket_id, tenantId]);
      const row = ticket.rows[0];
      if (!row) return { data: { error: "Không tìm thấy ticket trong tài khoản này." } };
      if (!row.device_id) return { data: { error: "Ticket này không gắn với thiết bị nên không chạy chẩn đoán thiết bị được." } };
      if (["resolved", "closed"].includes(row.status)) return { data: { error: "Ticket đã đóng." } };
      return {
        data: { proposed: true, note: "Đã hiển thị nút xác nhận cho người dùng. Chẩn đoán chưa chạy." },
        proposal: { action: "run_diagnosis", label: `Chạy chẩn đoán AI cho "${row.title}"`, params: { ticketId: row.id } },
      };
    },
  },
};

export function toolCatalog(): string {
  return Object.entries(supportTools)
    .map(([name, tool]) => `- ${name} ${tool.argsHint}: ${tool.description}`)
    .join("\n");
}

export async function runSupportTool(tenantId: string, name: string, rawArgs: unknown): Promise<ToolOutput> {
  const tool = supportTools[name];
  if (!tool) return { data: { error: `Không có công cụ "${name}". Chỉ dùng các công cụ trong danh sách.` } };
  const parsed = tool.args.safeParse(rawArgs ?? {});
  if (!parsed.success) return { data: { error: "Tham số không hợp lệ", details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
  return tool.run(tenantId, parsed.data);
}
