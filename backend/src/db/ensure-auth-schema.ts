import { adminPool as pool } from "./pool.js";

// Keeps existing development volumes usable. Production deployments should
// execute the equivalent statements through their normal migration pipeline.
export async function ensureAuthSchema(): Promise<void> {
  // Device API credentials allow agents to use the normal HTTPS endpoint when
  // an ingress (for example Cloudflare Tunnel) terminates TLS before Caddy.
  // Only the hash is persisted; the raw token is returned once at enrollment.
  await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_token_hash TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS devices_agent_token_hash_unique ON devices (agent_token_hash) WHERE agent_token_hash IS NOT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_firebase_uid_unique ON users (firebase_uid) WHERE firebase_uid IS NOT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email))`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at)`);
  await pool.query(`DELETE FROM auth_sessions WHERE expires_at <= now()`);
}
