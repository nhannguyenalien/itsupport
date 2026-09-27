const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(public status: number, public code: string | undefined, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { auth } = await import("./firebase");
  const token = await auth.currentUser?.getIdToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    let code: string | undefined;
    try { code = JSON.parse(body).code; } catch { /* Non-JSON proxy error. */ }
    throw new ApiError(res.status, code, `${init?.method ?? "GET"} ${path} -> ${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface AuthUser {
  id: string;
  tenantId: string;
  tenantName: string;
  email: string;
  role: "admin" | "technician" | "member";
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

export interface EnrollmentToken {
  tokenId: string;
  token: string;
  expiresAt: string;
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
  computer_use_autonomous_enabled: boolean;
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

export interface ComputerUseSession {
  id: string;
  tenant_id: string;
  ticket_id: string;
  device_id: string;
  status: "active" | "ended";
  openai_response_id: string | null;
  pending_tool_call_id: string | null;
  pending_approval_id: string | null;
  display_width: number;
  display_height: number;
  environment: "windows" | "mac" | "linux" | "ubuntu" | "browser";
}

export interface ToolDefinition {
  tool: string;
  risk: "read" | "low" | "medium" | "high";
  params: string[];
  verification: string[];
}

export interface ToolMetric {
  tool: string;
  calls_total: number;
  calls_succeeded: number;
  verified_passed: number;
  verified_failed: number;
  remediation_success_rate: number | null;
}

export interface Metrics {
  tenant_id: string;
  tickets_total: number;
  tickets_ai_resolved: number;
  tickets_escalated: number;
  avg_resolution_seconds: number | null;
  approvals_total: number;
  approvals_granted: number;
  approval_rate: number | null;
  tool_calls_per_ticket: number | null;
  remediation_success_rate: number | null;
  repeat_incident_rate: number | null;
  ai_estimated_cost_usd: number;
  ai_cost_per_ticket: number | null;
  by_tool: ToolMetric[];
}

export const api = {
  authAttempt: (action: "login" | "register" | "password-reset") =>
    request<void>("/auth/attempt", { method: "POST", body: JSON.stringify({ action }) }),
  me: () => request<{ user: AuthUser }>(`/auth/me`),
  registerWorkspace: (body: { companyName: string }) =>
    request<{ user: AuthUser }>(`/auth/register`, { method: "POST", body: JSON.stringify(body) }),
  listTools: () => request<{ version: number; tools: ToolDefinition[] }>(`/tool-registry`),

  getTenant: (tenantId: string) => request<Tenant>(`/tenants/${tenantId}`),
  disableAi: (tenantId: string) => request(`/tenants/${tenantId}/disable-ai`, { method: "POST", body: "{}" }),
  enableAi: (tenantId: string) => request(`/tenants/${tenantId}/enable-ai`, { method: "POST", body: "{}" }),
  // Autonomous computer-use mode (docs/v0.1-computer-use-addendum.md) —
  // separate opt-in from the AI kill switch above.
  enableComputerUseAutonomous: (tenantId: string) =>
    request(`/tenants/${tenantId}/enable-computer-use-autonomous`, { method: "POST", body: "{}" }),
  disableComputerUseAutonomous: (tenantId: string) =>
    request(`/tenants/${tenantId}/disable-computer-use-autonomous`, { method: "POST", body: "{}" }),

  getMetrics: (tenantId: string) => request<Metrics>(`/metrics?tenantId=${tenantId}`),

  listDevices: (tenantId: string) => request<Device[]>(`/devices?tenantId=${tenantId}`),
  createEnrollmentToken: (tenantId: string) =>
    request<EnrollmentToken>(`/enrollment-tokens`, { method: "POST", body: JSON.stringify({ tenantId }) }),
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

  // Bounded autonomous diagnostic workflow. It stops at approval boundaries,
  // completion, timeout, or its server-side safety step limit.
  runAiStep: (ticketId: string) =>
    request<{ action: "message" | "tool_call_requested" | "no_op"; detail: string; steps: number; stoppedBecause: string }>(`/tickets/${ticketId}/ai-step`, {
      method: "POST",
      body: "{}",
    }),

  // Computer-use addendum (docs/v0.1-computer-use-addendum.md) — every
  // desktop.* action this proposes still goes through the same
  // approve/reject flow as any other write tool (see the ticket page's
  // pending-approvals card).
  startComputerUseSession: (ticketId: string) =>
    request<ComputerUseSession>(`/tickets/${ticketId}/computer-use/start`, { method: "POST", body: "{}" }),
  advanceComputerUseSession: (sessionId: string) =>
    request<ComputerUseSession>(`/computer-use-sessions/${sessionId}/advance`, { method: "POST", body: "{}" }),
  // Not a fetch() — used directly as an <img src>. Not authenticated (matches
  // the rest of this API — see the file-level comment above).
  screenshotUrl: (screenshotId: string) => `${API_URL}/screenshots/${screenshotId}`,

  listPlatformConnections: (tenantId: string) => request<PlatformConnection[]>(`/tenants/${tenantId}/platform-connections`),
  sendConnectLinkToDevice: (
    tenantId: string,
    body: { deviceId: string; platform: "google_ads" | "meta_ads" | "ga4"; externalAccountId: string },
  ) =>
    request<{ ticketId: string; outcome: string; reason?: string }>(`/tenants/${tenantId}/platform-connections/send-link`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  // Not a fetch() — this navigates the browser to the backend, which redirects
  // it again to the platform's real consent page. See oauth/routes.ts.
  connectPlatformUrl: (platform: string, tenantId: string, externalAccountId: string) =>
    `${API_URL}/oauth/${platform}/connect?tenantId=${tenantId}&externalAccountId=${encodeURIComponent(externalAccountId)}`,
};
