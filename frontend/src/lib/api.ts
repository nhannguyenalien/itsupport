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
    let message = `Yêu cầu thất bại (${res.status}).`;
    try { const parsed = JSON.parse(body); code = parsed.code; if (typeof parsed.error === "string") message = parsed.error; } catch { /* Non-JSON proxy error. */ }
    throw new ApiError(res.status, code, message);
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
  platformAdmin?: boolean;
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
  platform?: "windows" | "mac" | "linux";
  // Click-to-update (backend/src/devices/agent-updates.ts).
  update_supported?: boolean;
  latest_agent_version?: string | null;
  update_available?: boolean;
  update_state?: "none" | "queued" | "installing" | "failed";
  update_error?: string | null;
}

export interface BackupPolicy {
  enabled: boolean;
  repo: string;
  paths: string[];
  excludes: string[];
  interval_hours: number;
  keep_daily: number;
  keep_weekly: number;
  keep_monthly: number;
  use_vss: boolean;
  limit_upload_kbps: number;
  db_dumps: { container: string; user: string; database: string }[];
  last_run_requested_at: string | null;
  env_configured: string[];
}

export interface BackupStatus {
  restic_installed: boolean;
  restic_version?: string;
  state: "idle" | "running" | "success" | "error";
  step?: string;
  started_at?: string;
  finished_at?: string;
  snapshot_id?: string;
  files_new?: number;
  bytes_added?: number;
  bytes_total?: number;
  error?: string;
  restore_state?: "idle" | "running" | "success" | "error";
  restore?: {
    state: "running" | "success" | "error";
    snapshot_id?: string;
    target?: string;
    finished_at?: string;
    files_restored?: number;
    bytes_restored?: number;
    error?: string;
  };
}

export type DbBackupHealth = "disabled" | "ok" | "failed" | "overdue" | "never";
export interface DbBackupInfo {
  enabled: boolean; repo: string; interval_hours: number; keep_daily: number; keep_weekly: number; keep_monthly: number;
  env_configured: string[]; health: DbBackupHealth; last_success_at: string | null; next_run_at: string | null; running: boolean;
  tools: { pgDump: string | null; restic: string | null }; alert_recipients: number;
}
export interface DbBackupRun {
  id: string; kind: "backup" | "verify" | "restore"; trigger: "schedule" | "manual"; state: "running" | "success" | "error";
  started_at: string; finished_at: string | null; requested_by: string | null; snapshot_id: string | null;
  bytes_added: string | null; dump_bytes: string | null; tables_found: number | null; error: string | null;
}
export interface DbBackupSnapshot { id: string; time: string; sizeBytes: number | null }
export interface DbBackupSettingsInput {
  enabled: boolean; repo: string; env: Record<string, string>;
  interval_hours: number; keep_daily: number; keep_weekly: number; keep_monthly: number;
}

export interface BackupSnapshot { id: string; time: string; hostname: string; paths: string[] }
export interface BackupSnapshots {
  state: "none" | "pending" | "ready" | "error";
  fetched_at?: string;
  error?: string;
  snapshots: BackupSnapshot[];
}

export type BackupHealth = "disabled" | "unsupported" | "running" | "ok" | "failed" | "overdue" | "never";

export interface BackupOverview {
  device_id: string;
  hostname: string;
  device_status: string;
  health: BackupHealth;
  last_success_at: string | null;
  interval_hours: number | null;
}

export interface BackupInfo {
  supported: boolean;
  min_agent_version: string;
  policy: BackupPolicy | null;
  status: BackupStatus | null;
  status_at: string | null;
}

export interface BackupPolicyInput {
  enabled: boolean;
  repo: string;
  env: Record<string, string>;
  paths: string[];
  excludes: string[];
  interval_hours: number;
  keep_daily: number;
  keep_weekly: number;
  keep_monthly: number;
  use_vss: boolean;
  db_dumps: { container: string; user: string; database: string }[];
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
  attachments?: { name: string; size: number; text: string }[];
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
  aiWorkflow?: { status: "running" | "finished" | "failed"; stoppedBecause?: string } | null;
  computerUseSession: ComputerUseSession | null;
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
  stop_requested: boolean;
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

export type SupportTier = "system" | "account";

export interface SupportProposal {
  action: "create_ticket" | "run_diagnosis" | "device_task";
  label: string;
  params: Record<string, string>;
}

export interface SupportChatReply {
  reply: string;
  needsHuman?: boolean;
  toolsUsed?: string[];
  proposals?: SupportProposal[];
}

export const api = {
  authAttempt: (action: "login" | "register" | "password-reset") =>
    request<void>("/auth/attempt", { method: "POST", body: JSON.stringify({ action }) }),
  me: () => request<{ user: AuthUser }>(`/auth/me`),
  registerWorkspace: (body: { companyName: string }) =>
    request<{ user: AuthUser }>(`/auth/register`, { method: "POST", body: JSON.stringify(body) }),
  // Two-tier support chatbot (backend/src/support-chat): "system" works before
  // login; "account" answers from the signed-in workspace via scoped tools.
  supportChatStatus: () => request<{ enabled: boolean }>(`/support-chat/status`),
  supportChat: (tier: SupportTier, body: { conversationId: string; message: string; language?: string }) =>
    request<SupportChatReply>(`/support-chat/${tier}`, { method: "POST", body: JSON.stringify(body) }),
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

  remoteSupport: (deviceId: string) => request<{ mode: "terminal" | "desktop-terminal"; ready: boolean; enabled: boolean; expiresAt: string | null; url: string | null; terminalUrl: string | null }>(`/devices/${deviceId}/remote-support`),
  setRemoteSupport: (deviceId: string, enabled: boolean) => request<{ mode: "terminal" | "desktop-terminal"; ready: boolean; enabled: boolean; expiresAt: string | null; url: string | null; terminalUrl: string | null }>(`/devices/${deviceId}/remote-support`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  listDevices: (tenantId: string) => request<Device[]>(`/devices?tenantId=${tenantId}`),
  createEnrollmentToken: (tenantId: string) =>
    request<EnrollmentToken>(`/enrollment-tokens`, { method: "POST", body: JSON.stringify({ tenantId }) }),
  requestAgentUpdate: (deviceId: string) =>
    request<{ version: string }>(`/devices/${deviceId}/agent-update`, { method: "POST", body: "{}" }),
  backupAlertSettings: () => request<{ enabled: boolean; emails: string[]; mail_configured: boolean }>(`/backup-alerts`),
  saveBackupAlertSettings: (body: { enabled: boolean; emails: string[] }) =>
    request<{ enabled: boolean; emails: string[]; mail_configured: boolean }>(`/backup-alerts`, { method: "PUT", body: JSON.stringify(body) }),
  testBackupAlert: () => request<{ sent: number }>(`/backup-alerts/test`, { method: "POST", body: "{}" }),
  dbBackup: () => request<DbBackupInfo>(`/platform/db-backup`),
  saveDbBackup: (body: DbBackupSettingsInput) => request<{ ok: true }>(`/platform/db-backup`, { method: "PUT", body: JSON.stringify(body) }),
  testDbBackup: () => request<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }>(`/platform/db-backup/test`, { method: "POST", body: "{}" }),
  runDbBackup: () => request<{ runId: string }>(`/platform/db-backup/run`, { method: "POST", body: "{}" }),
  dbBackupRuns: () => request<DbBackupRun[]>(`/platform/db-backup/runs`),
  dbBackupSnapshots: () => request<DbBackupSnapshot[]>(`/platform/db-backup/snapshots`),
  verifyDbBackup: (snapshotId: string) => request<{ runId: string }>(`/platform/db-backup/verify`, { method: "POST", body: JSON.stringify({ snapshot_id: snapshotId }) }),
  restoreDbBackup: (body: { snapshot_id: string; target_url: string; confirm: "KHOI PHUC" }) =>
    request<{ runId: string }>(`/platform/db-backup/restore`, { method: "POST", body: JSON.stringify(body) }),
  listBackups: () => request<BackupOverview[]>(`/backups`),
  requestBackupSnapshots: (deviceId: string) => request(`/devices/${deviceId}/backup/snapshots`, { method: "POST", body: "{}" }),
  backupSnapshots: (deviceId: string) => request<BackupSnapshots>(`/devices/${deviceId}/backup/snapshots`),
  restoreBackup: (deviceId: string, body: { snapshot_id: string; target: string; include: string[]; confirm: true }) =>
    request(`/devices/${deviceId}/backup/restore`, { method: "POST", body: JSON.stringify(body) }),
  backupInfo: (deviceId: string) => request<BackupInfo>(`/devices/${deviceId}/backup`),
  saveBackupPolicy: (deviceId: string, body: BackupPolicyInput) =>
    request<BackupPolicy>(`/devices/${deviceId}/backup`, { method: "PUT", body: JSON.stringify(body) }),
  runBackup: (deviceId: string) => request(`/devices/${deviceId}/backup/run`, { method: "POST", body: "{}" }),
  refreshBackup: (deviceId: string) => request(`/devices/${deviceId}/backup/refresh`, { method: "POST", body: "{}" }),
  revokeDevice: (deviceId: string) => request(`/devices/${deviceId}/revoke`, { method: "POST", body: "{}" }),
  pauseDevice: (deviceId: string) => request(`/devices/${deviceId}/pause`, { method: "POST", body: "{}" }),
  unpauseDevice: (deviceId: string) => request(`/devices/${deviceId}/unpause`, { method: "POST", body: "{}" }),

  listTickets: (tenantId: string) => request<Ticket[]>(`/tickets?tenantId=${tenantId}`),
  getTicket: (ticketId: string) => request<TicketDetail>(`/tickets/${ticketId}`),
  createTicket: (body: { tenantId: string; deviceId?: string; platformConnectionId?: string; title: string; scenario?: string }) =>
    request<Ticket>(`/tickets`, { method: "POST", body: JSON.stringify(body) }),
  addMessage: (ticketId: string, body: { authorType: string; body: string; attachments?: { name: string; base64: string }[] }) =>
    request<TicketMessage>(`/tickets/${ticketId}/messages`, { method: "POST", body: JSON.stringify(body) }),

  approveApproval: (approvalId: string) => request(`/approvals/${approvalId}/approve`, { method: "POST", body: "{}" }),
  rejectApproval: (approvalId: string) => request(`/approvals/${approvalId}/reject`, { method: "POST", body: "{}" }),

  requestToolCall: (ticketId: string, body: { initiatedBy: "ai" | "human"; tool: string; params: Record<string, unknown>; reasoning?: string }) =>
    request(`/tickets/${ticketId}/tool-calls`, { method: "POST", body: JSON.stringify(body) }),

  getTakeoverLink: (ticketId: string) => request<{ url: string }>(`/tickets/${ticketId}/takeover-link`),

  // Bounded autonomous diagnostic workflow. It stops at approval boundaries,
  // completion, timeout, or its server-side safety step limit.
  runAiStep: (ticketId: string) =>
    request<{ status: "running" | "finished" | "failed"; stoppedBecause?: string }>(`/tickets/${ticketId}/ai-step`, {
      method: "POST",
      body: "{}",
    }),

  // Computer-use addendum (docs/v0.1-computer-use-addendum.md) — every
  // desktop.* action this proposes still goes through the same
  // approve/reject flow as any other write tool (see the ticket page's
  // pending-approvals card).
  startComputerUseSession: (ticketId: string) =>
    request<ComputerUseSession>(`/tickets/${ticketId}/computer-use/start`, { method: "POST", body: "{}" }),
  stopComputerUseSession: (sessionId: string) =>
    request<ComputerUseSession>(`/computer-use-sessions/${sessionId}/stop`, { method: "POST", body: "{}" }),
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
