import { queryTenantScoped } from "../db/pool.js";

export type ActorType = "user" | "ai" | "system" | "agent" | "technician";

export interface AuditEvent {
  tenantId: string;
  actorType: ActorType;
  actorId?: string | null;
  eventType: string;
  eventData?: Record<string, unknown>;
  ticketId?: string | null;
  deviceId?: string | null;
}

/** Append-only. Called from every route that changes state — enrollment,
 * revoke/pause, AI kill switch, approvals, tool-call execution. Never update or
 * delete rows here; if something needs correcting, write a new audit_log row
 * that says so, don't rewrite history. */
export async function recordAudit(event: AuditEvent): Promise<void> {
  await queryTenantScoped(
    event.tenantId,
    `INSERT INTO audit_log (tenant_id, actor_type, actor_id, event_type, event_data, ticket_id, device_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      event.tenantId,
      event.actorType,
      event.actorId ?? null,
      event.eventType,
      JSON.stringify(event.eventData ?? {}),
      event.ticketId ?? null,
      event.deviceId ?? null,
    ],
  );
}
