import { adminPool } from "../db/pool.js";
import { decryptToken } from "../oauth/crypto.js";

// The operator's shared storage: a restic repository root plus the credentials
// for it, saved once on the platform database-backup page. Everything that backs
// up to "the system storage" (system DB, customer DBs, device files) hangs below it.

/** `base/a/b`, tolerant of a trailing slash on the base (also works for b2:bucket:path). */
export function repoJoin(base: string, ...parts: string[]): string {
  return [base.replace(/\/+$/, ""), ...parts].join("/");
}

export async function getStorage(): Promise<{ base: string; env: Record<string, string> } | null> {
  await adminPool.query(`INSERT INTO platform_db_backup (id) VALUES (1) ON CONFLICT DO NOTHING`);
  const r = (await adminPool.query(`SELECT repo, secrets_enc FROM platform_db_backup WHERE id = 1`)).rows[0];
  if (!r?.repo || !r?.secrets_enc) return null;
  try { return { base: r.repo, env: JSON.parse(decryptToken(r.secrets_enc)) }; } catch { return null; }
}
