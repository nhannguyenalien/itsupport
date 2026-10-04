import { adminPool as pool } from "./pool.js";

// Keeps existing development volumes usable. Production deployments should
// execute the equivalent statements through their normal migration pipeline.
export async function ensureAuthSchema(): Promise<void> {
  await pool.query(`ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query(`ALTER TABLE computer_use_sessions ADD COLUMN IF NOT EXISTS action_count INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE computer_use_sessions ADD COLUMN IF NOT EXISTS stop_requested BOOLEAN NOT NULL DEFAULT false`);
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backup_policies (
      device_id UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT false,
      repo TEXT NOT NULL,
      secrets_enc TEXT NOT NULL,
      paths JSONB NOT NULL DEFAULT '[]',
      excludes JSONB NOT NULL DEFAULT '[]',
      interval_hours INTEGER NOT NULL DEFAULT 24 CHECK (interval_hours BETWEEN 1 AND 168),
      keep_daily INTEGER NOT NULL DEFAULT 7,
      keep_weekly INTEGER NOT NULL DEFAULT 4,
      keep_monthly INTEGER NOT NULL DEFAULT 6,
      use_vss BOOLEAN NOT NULL DEFAULT true,
      limit_upload_kbps INTEGER NOT NULL DEFAULT 0,
      last_run_requested_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backup_alert_settings (
      tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT true,
      emails TEXT[] NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`ALTER TABLE backup_alert_settings ENABLE ROW LEVEL SECURITY`);
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'backup_alert_settings' AND policyname = 'tenant_isolation') THEN
      CREATE POLICY tenant_isolation ON backup_alert_settings USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
    END IF; END $$`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_backup_policies_tenant ON backup_policies(tenant_id)`);
  await pool.query(`ALTER TABLE backup_policies ENABLE ROW LEVEL SECURITY`);
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'backup_policies' AND policyname = 'tenant_isolation') THEN
      CREATE POLICY tenant_isolation ON backup_policies USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
    END IF; END $$`);
}
