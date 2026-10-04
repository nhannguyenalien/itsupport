import nodemailer, { type TransportOptions } from "nodemailer";
import { adminPool } from "../db/pool.js";
import type { BackupHealth } from "./health.js";

// Email delivery for backup alerts. Transport is plain SMTP configured by
// environment (SMTP_URL, e.g. smtps://user:pass@smtp.example.com:465, and
// MAIL_FROM); recipients are per workspace in backup_alert_settings. Alerts are
// one digest per workspace, and each device is emailed at most once per 24h
// while it stays unhealthy (tracked by `device.backup_alert_emailed` audit rows).

export function mailConfigured(): boolean {
  return !!process.env.SMTP_URL && !!process.env.MAIL_FROM;
}

export async function sendMail(to: string[], subject: string, text: string): Promise<void> {
  if (!mailConfigured()) throw new Error("Email chưa được cấu hình trên server (SMTP_URL, MAIL_FROM).");
  const transport = nodemailer.createTransport({ url: process.env.SMTP_URL, connectionTimeout: 15_000, socketTimeout: 30_000 } as TransportOptions);
  try {
    await transport.sendMail({ from: process.env.MAIL_FROM, to, subject, text });
  } finally {
    transport.close();
  }
}

export interface AlertDevice { hostname: string; health: BackupHealth; last_success_at: string | Date | null; device_status: string }

const REASON: Record<string, string> = {
  overdue: "quá hạn backup",
  never: "chưa có backup thành công",
  failed: "lần backup gần nhất bị lỗi",
};

// Everything below is plain text on purpose: hostnames are user data, and a text
// body can't carry markup injected through one.
export function formatAlertEmail(tenantName: string, devices: AlertDevice[]): { subject: string; text: string } {
  const lines = devices.map((d) => {
    const last = d.last_success_at ? new Date(d.last_success_at).toISOString() : "chưa có";
    return `- ${d.hostname}: ${REASON[d.health] ?? d.health} (lần thành công cuối: ${last}${d.device_status !== "online" ? "; máy đang ngoại tuyến" : ""})`;
  });
  return {
    subject: `[${tenantName}] ${devices.length} máy cần chú ý về backup`,
    text: `Các máy sau có backup cần chú ý:\n\n${lines.join("\n")}\n\nMở trang Thiết bị để xem chi tiết hoặc chạy backup ngay.\nEmail này tự gửi tối đa một lần mỗi 24 giờ cho mỗi máy còn vấn đề.\n`,
  };
}

interface ProblemRow extends AlertDevice { tenant_id: string; device_id: string }

/** Sends one digest per workspace for devices not yet emailed in the last 24h.
 * Marker rows are written only after the mail was accepted, so an SMTP outage
 * is retried on the next sweep instead of silently swallowing the alert. */
export async function emailBackupAlerts(problems: ProblemRow[]): Promise<void> {
  if (!mailConfigured() || problems.length === 0) return;
  const byTenant = new Map<string, ProblemRow[]>();
  for (const p of problems) byTenant.set(p.tenant_id, [...(byTenant.get(p.tenant_id) ?? []), p]);

  for (const [tenantId, devices] of byTenant) {
    const settings = await adminPool.query(
      `SELECT s.emails, t.name FROM backup_alert_settings s JOIN tenants t ON t.id = s.tenant_id
       WHERE s.tenant_id = $1 AND s.enabled AND cardinality(s.emails) > 0`, [tenantId]);
    if (!settings.rowCount) continue;
    const recent = await adminPool.query(
      `SELECT DISTINCT device_id FROM audit_log WHERE tenant_id = $1 AND event_type = 'device.backup_alert_emailed'
         AND created_at > now() - interval '24 hours'`, [tenantId]);
    const done = new Set(recent.rows.map((r) => r.device_id));
    const fresh = devices.filter((d) => !done.has(d.device_id));
    if (!fresh.length) continue;
    const { subject, text } = formatAlertEmail(settings.rows[0].name, fresh);
    try {
      await sendMail(settings.rows[0].emails, subject, text);
    } catch (err) {
      console.error("backup alert email failed", tenantId, err instanceof Error ? err.message : err);
      continue;
    }
    for (const d of fresh) {
      await adminPool.query(
        `INSERT INTO audit_log (tenant_id, actor_type, event_type, event_data, device_id) VALUES ($1, 'system', 'device.backup_alert_emailed', $2, $3)`,
        [tenantId, JSON.stringify({ health: d.health, recipients: settings.rows[0].emails.length }), d.device_id]);
    }
  }
}
