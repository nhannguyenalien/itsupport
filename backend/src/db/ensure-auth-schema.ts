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
      db_dumps JSONB NOT NULL DEFAULT '[]',
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
  await pool.query(`ALTER TABLE backup_policies ADD COLUMN IF NOT EXISTS db_dumps JSONB NOT NULL DEFAULT '[]'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_db_backup (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled BOOLEAN NOT NULL DEFAULT false,
      repo TEXT NOT NULL DEFAULT '',
      secrets_enc TEXT NOT NULL DEFAULT '',
      interval_hours INTEGER NOT NULL DEFAULT 24 CHECK (interval_hours BETWEEN 1 AND 168),
      keep_daily INTEGER NOT NULL DEFAULT 7,
      keep_weekly INTEGER NOT NULL DEFAULT 4,
      keep_monthly INTEGER NOT NULL DEFAULT 6,
      last_alert_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_db_backup_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kind TEXT NOT NULL CHECK (kind IN ('backup', 'verify', 'restore')),
      trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
      state TEXT NOT NULL CHECK (state IN ('running', 'success', 'error')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      requested_by TEXT,
      snapshot_id TEXT,
      bytes_added BIGINT,
      dump_bytes BIGINT,
      tables_found INTEGER,
      error TEXT,
      detail JSONB NOT NULL DEFAULT '{}'
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_platform_db_backup_runs_started ON platform_db_backup_runs(started_at DESC)`);
  await pool.query(`ALTER TABLE platform_db_backup ENABLE ROW LEVEL SECURITY`);
  await pool.query(`ALTER TABLE platform_db_backup_runs ENABLE ROW LEVEL SECURITY`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenant_db_backups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
      source_label TEXT NOT NULL,
      source_enc TEXT NOT NULL,
      repo_password_enc TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      interval_hours INTEGER NOT NULL DEFAULT 24 CHECK (interval_hours IN (6, 12, 24, 48, 168)),
      keep_daily INTEGER NOT NULL DEFAULT 7,
      keep_weekly INTEGER NOT NULL DEFAULT 4,
      keep_monthly INTEGER NOT NULL DEFAULT 6,
      created_by UUID,
      last_alert_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tenant_db_backups_tenant ON tenant_db_backups(tenant_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenant_db_backup_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      backup_id UUID NOT NULL REFERENCES tenant_db_backups(id) ON DELETE CASCADE,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('backup', 'verify', 'restore')),
      trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
      state TEXT NOT NULL CHECK (state IN ('running', 'success', 'error')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      snapshot_id TEXT,
      bytes_added BIGINT,
      dump_bytes BIGINT,
      tables_found INTEGER,
      error TEXT,
      detail JSONB NOT NULL DEFAULT '{}'
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tenant_db_backup_runs_backup ON tenant_db_backup_runs(backup_id, started_at DESC)`);
  for (const table of ["tenant_db_backups", "tenant_db_backup_runs"]) {
    await pool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = '${table}' AND policyname = 'tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON ${table} USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
      END IF; END $$`);
  }
  await pool.query(`ALTER TABLE backup_policies ADD COLUMN IF NOT EXISTS storage TEXT NOT NULL DEFAULT 'custom'`);
  await pool.query(`ALTER TABLE backup_policies ADD COLUMN IF NOT EXISTS repo_password_enc TEXT`);
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backup_policies_storage_check') THEN
      ALTER TABLE backup_policies ADD CONSTRAINT backup_policies_storage_check CHECK (storage IN ('custom', 'system'));
    END IF; END $$`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free'`);
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_plan_check') THEN
      ALTER TABLE tenants ADD CONSTRAINT tenants_plan_check CHECK (plan IN ('free', 'pro'));
    END IF; END $$`);
  await pool.query(`ALTER TABLE tenant_db_backups ADD COLUMN IF NOT EXISTS last_size_bytes BIGINT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_backup_policies_tenant ON backup_policies(tenant_id)`);
  await pool.query(`ALTER TABLE backup_policies ENABLE ROW LEVEL SECURITY`);
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'backup_policies' AND policyname = 'tenant_isolation') THEN
      CREATE POLICY tenant_isolation ON backup_policies USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
    END IF; END $$`);
}
