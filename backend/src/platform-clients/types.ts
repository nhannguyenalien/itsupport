/** One row from platform_connections (schema.sql) — the shape every platform
 * client function takes so none of them need to know how to fetch/decrypt a
 * connection themselves. Ciphertext fields are decrypted lazily inside each
 * client (oauth/crypto.ts), never eagerly, so a code path that only needs
 * external_account_id never touches key material at all. */
export interface PlatformConnectionRow {
  id: string;
  tenant_id: string;
  platform: string;
  external_account_id: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string | null;
  token_expires_at: string | null;
}

export async function loadConnection(pool: import("pg").Pool, connectionId: string): Promise<PlatformConnectionRow> {
  const row = await pool.query(
    `SELECT id, tenant_id, platform, external_account_id, access_token_ciphertext, refresh_token_ciphertext, token_expires_at
     FROM platform_connections WHERE id = $1`,
    [connectionId],
  );
  if (row.rowCount === 0) throw new Error(`platform_connections row ${connectionId} not found`);
  return row.rows[0] as PlatformConnectionRow;
}
