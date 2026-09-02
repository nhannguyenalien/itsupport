// Thin fetch wrapper. No auth layer yet — matches the backend, which also has
// none (see backend/README gaps). This talks to whatever NEXT_PUBLIC_API_URL
// points at, with no session/cookie handling; anyone who can reach the
// dashboard can act as any tenant they type in. Fine for a local dev skeleton,
// not for anything further than that — flagged, not hidden.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface Device {
  id: string;
  hostname: string;
  os_version: string | null;
  agent_version: string | null;
  status: "online" | "offline" | "unknown";
  last_seen_at: string | null;
  actions_paused: boolean;
  revoked: boolean;
}

export interface Ticket {
  id: string;
  tenant_id: string;
  device_id: string | null;
  platform_connection_id: string | null;
  title: string;
  status: string;
  scenario: string | null;
  created_at: string;
  resolved_at: string | null;
  closed_at: string | null;
}

export interface TicketMessage {
  id: string;
  author_type: "user" | "ai" | "system" | "technician";
  body: string;
  created_at: string;
}

export interface ToolCall {
  id: string;
  tool: string;
  risk: string;
  params: Record<string, unknown>;
  result: "success" | "error" | "timeout" | null;
  result_data: Record<string, unknown> | null;
  error_message: string | null;
  verification_status: "not_required" | "pending" | "passed" | "failed";
  requested_at: string;
  executed_at: string | null;
  parent_tool_call_id: string | null;
}

export interface Approval {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  proposed_by_ai: boolean;
  reasoning: string | null;
  status: "pending" | "approved" | "rejected" | "expired";
  created_at: string;
}

export interface TicketDetail extends Ticket {
  messages: TicketMessage[];
  toolCalls: ToolCall[];
  approvals: Approval[];
}

export interface Tenant {
  id: string;
  name: string;
  ai_enabled: boolean;
  ai_data_policy: string;
  autonomous_low_risk_enabled: boolean;
}

export interface PlatformConnection {
  id: string;
  platform: "google_ads" | "meta_ads" | "ga4" | "gtm" | "crm_generic";
  external_account_id: string;
  status: "active" | "expired" | "revoked" | "error";
  scopes: string[];
  connected_at: string;
  last_used_at: string | null;
  last_error: string | null;
  actions_paused: boolean;
}

export interface ToolDefinition {
  tool: string;
  risk: "read" | "low" | "medium" | "high";
  params: string[];
  verification: string[];
}

export const api = {
  listTools: () => request<{ version: number; tools: ToolDefinition[] }>(`/tool-registry`),

  getTenant: (tenantId: string) => request<Tenant>(`/tenants/${tenantId}`),
  createTenant: (name: string) => request<Tenant>(`/tenants`, { method: "POST", body: JSON.stringify({ name }) }),
  disableAi: (tenantId: string) => request(`/tenants/${tenantId}/disable-ai`, { method: "POST", body: "{}" }),
  enableAi: (tenantId: string) => request(`/tenants/${tenantId}/enable-ai`, { method: "POST", body: "{}" }),

  listDevices: (tenantId: string) => request<Device[]>(`/devices?tenantId=${tenantId}`),
  revokeDevice: (deviceId: string) => request(`/devices/${deviceId}/revoke`, { method: "POST", body: "{}" }),
  pauseDevice: (deviceId: string) => request(`/devices/${deviceId}/pause`, { method: "POST", body: "{}" }),
  unpauseDevice: (deviceId: string) => request(`/devices/${deviceId}/unpause`, { method: "POST", body: "{}" }),

  listTickets: (tenantId: string) => request<Ticket[]>(`/tickets?tenantId=${tenantId}`),
  getTicket: (ticketId: string) => request<TicketDetail>(`/tickets/${ticketId}`),
  createTicket: (body: { tenantId: string; deviceId?: string; platformConnectionId?: string; title: string; scenario?: string }) =>
    request<Ticket>(`/tickets`, { method: "POST", body: JSON.stringify(body) }),
  addMessage: (ticketId: string, body: { authorType: string; body: string }) =>
    request<TicketMessage>(`/tickets/${ticketId}/messages`, { method: "POST", body: JSON.stringify(body) }),

  approveApproval: (approvalId: string) => request(`/approvals/${approvalId}/approve`, { method: "POST", body: "{}" }),
  rejectApproval: (approvalId: string) => request(`/approvals/${approvalId}/reject`, { method: "POST", body: "{}" }),

  requestToolCall: (ticketId: string, body: { initiatedBy: "ai" | "human"; tool: string; params: Record<string, unknown>; reasoning?: string }) =>
    request(`/tickets/${ticketId}/tool-calls`, { method: "POST", body: JSON.stringify(body) }),

  getTakeoverLink: (ticketId: string) => request<{ url: string }>(`/tickets/${ticketId}/takeover-link`),

  listPlatformConnections: (tenantId: string) => request<PlatformConnection[]>(`/tenants/${tenantId}/platform-connections`),
  // Not a fetch() — this navigates the browser to the backend, which redirects
  // it again to the platform's real consent page. See oauth/routes.ts.
  connectPlatformUrl: (platform: string, tenantId: string, externalAccountId: string) =>
    `${API_URL}/oauth/${platform}/connect?tenantId=${tenantId}&externalAccountId=${encodeURIComponent(externalAccountId)}`,
};
