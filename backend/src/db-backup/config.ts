// Pure helpers for the platform database backup: no database or process access,
// so every rule here is unit-testable.

export const DUMP_NAME = "support-agent-db.dump";
export const RESTIC_HOST = "support-platform-db"; // container hostnames change on every deploy
export const RESTIC_TAG = "platform-db";

export const REPO_PATTERN = /^(rest:https?:\/\/|s3:https:\/\/|b2:)/;

/** The database holds every tenant's data, so this is limited to the platform
 * operator: a tenant admin whose email is listed in PLATFORM_ADMIN_EMAILS. With
 * the variable empty the feature is off for everyone. */
export function isPlatformAdmin(email: string | undefined, role: string | undefined, list: string | undefined = process.env.PLATFORM_ADMIN_EMAILS): boolean {
  if (!email || role !== "admin" || !list) return false;
  const allowed = list.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

export function platformAdminEmails(list: string | undefined = process.env.PLATFORM_ADMIN_EMAILS): string[] {
  return (list ?? "").split(",").map((e) => e.trim()).filter(Boolean);
}

export interface PgConnection {
  host: string; port: string; database: string; user: string;
  /** libpq environment variables: credentials never appear on a command line. */
  env: Record<string, string>;
}

const SSLMODES = new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]);
const CHANNEL_BINDING = new Set(["disable", "prefer", "require"]);

export function parsePgUrl(raw: string): PgConnection {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Not a valid PostgreSQL URL"); }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("URL must start with postgresql://");
  if (!url.hostname) throw new Error("PostgreSQL URL has no host");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) throw new Error("PostgreSQL URL has no database name");
  const user = decodeURIComponent(url.username);
  const env: Record<string, string> = {
    PGHOST: url.hostname, PGPORT: url.port || "5432", PGDATABASE: database, PGUSER: user,
  };
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode && SSLMODES.has(sslmode)) env.PGSSLMODE = sslmode;
  // verify-ca / verify-full need a CA bundle and libpq looks for ~/.postgresql/root.crt,
  // which does not exist in the container. Use the operating system's trusted roots.
  // (Only the literal "system": a URL must never name a file path on our server.)
  if (sslmode === "verify-ca" || sslmode === "verify-full") env.PGSSLROOTCERT = "system";
  const binding = url.searchParams.get("channel_binding");
  if (binding && CHANNEL_BINDING.has(binding)) env.PGCHANNELBINDING = binding;
  const options = url.searchParams.get("options");
  if (options && /^[A-Za-z0-9_=,.\- %]+$/.test(options)) env.PGOPTIONS = options;
  const timeout = Number(url.searchParams.get("connect_timeout"));
  if (Number.isInteger(timeout) && timeout > 0 && timeout <= 120) env.PGCONNECT_TIMEOUT = String(timeout);
  return { host: url.hostname, port: env.PGPORT, database, user, env };
}

/** Neon serves the same database on a PgBouncer endpoint (`ep-xxx-pooler.…`) and a
 * direct one (`ep-xxx.…`). pg_dump needs session features pooled connections do
 * not guarantee, and Neon recommends the direct endpoint for it, so backups go
 * straight to the database while the application keeps using the pooler. */
export function directConnection(c: PgConnection): PgConnection {
  const m = c.host.match(/^([^.]+)-pooler(\.[^]*neon\.tech)$/i);
  if (!m) return c;
  const host = m[1] + m[2];
  return { ...c, host, env: { ...c.env, PGHOST: host } };
}

function normalizedHost(host: string): string {
  const [first, ...rest] = host.toLowerCase().split(".");
  return [first.replace(/-pooler$/, ""), ...rest].join(".");
}

/** True when two URLs point at the same database (a Neon pooled host and its
 * direct host count as the same). Used to refuse restoring over production. */
export function sameDatabase(a: PgConnection, b: PgConnection): boolean {
  return normalizedHost(a.host) === normalizedHost(b.host) && a.port === b.port && a.database === b.database;
}

export interface Retention { keepDaily: number; keepWeekly: number; keepMonthly: number }

export function retentionArgs(r: Retention): string[] {
  const args: string[] = [];
  if (r.keepDaily > 0) args.push("--keep-daily", String(r.keepDaily));
  if (r.keepWeekly > 0) args.push("--keep-weekly", String(r.keepWeekly));
  if (r.keepMonthly > 0) args.push("--keep-monthly", String(r.keepMonthly));
  if (!args.length) throw new Error("Retention must keep at least one snapshot");
  return args;
}

export function scrub(text: string, secrets: string[], limit = 1500): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("***");
  out = out.replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/g, "$1***@");
  return (out.length > limit ? out.slice(-limit) : out).trim();
}

export type DbBackupHealth = "disabled" | "ok" | "failed" | "overdue" | "never";

/** Overdue after two intervals (minimum 24h) without a success, like device backups. */
export function dbBackupHealth(s: { enabled: boolean; intervalHours: number; lastSuccessAt: Date | null; lastBackupState: string | null; updatedAt: Date }, now: Date = new Date()): DbBackupHealth {
  if (!s.enabled) return "disabled";
  const since = s.lastSuccessAt ?? s.updatedAt;
  const ageHours = (now.getTime() - since.getTime()) / 3_600_000;
  if (ageHours > Math.max(s.intervalHours * 2, 24)) return s.lastSuccessAt ? "overdue" : "never";
  return s.lastBackupState === "error" ? "failed" : "ok";
}

/** A backup is due when none succeeded within the interval. After a FAILED run it
 * waits two hours before trying again, so a persistent problem leaves a few
 * error rows instead of dozens a day. */
export function isDue(s: { enabled: boolean; repo: string; intervalHours: number; lastSuccessAt: Date | null; lastStartedAt: Date | null; lastState?: string | null }, now: Date = new Date()): boolean {
  if (!s.enabled || !s.repo) return false;
  const pause = s.lastState === "error" ? 2 * 3_600_000 : 30 * 60_000;
  if (s.lastStartedAt && now.getTime() - s.lastStartedAt.getTime() < pause) return false;
  if (!s.lastSuccessAt) return true;
  return now.getTime() - s.lastSuccessAt.getTime() >= s.intervalHours * 3_600_000;
}
