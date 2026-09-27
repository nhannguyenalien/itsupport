\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS computer_use_autonomous_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'windows';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_platform_check') THEN
    ALTER TABLE devices ADD CONSTRAINT devices_platform_check
      CHECK (platform IN ('windows', 'mac', 'linux'));
  END IF;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_firebase_uid_unique
  ON users(firebase_uid) WHERE firebase_uid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(lower(email));

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS computer_use_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  openai_response_id TEXT,
  pending_tool_call_id UUID REFERENCES tool_calls(id),
  pending_approval_id UUID REFERENCES approvals(id),
  pending_batch_call_id TEXT,
  pending_batch_remaining JSONB,
  pending_batch_safety_checks JSONB,
  display_width INTEGER NOT NULL DEFAULT 1280,
  display_height INTEGER NOT NULL DEFAULT 800,
  environment TEXT NOT NULL DEFAULT 'windows'
    CHECK (environment IN ('windows', 'mac', 'linux', 'ubuntu', 'browser')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS computer_use_screenshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES computer_use_sessions(id) ON DELETE CASCADE,
  image_data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_computer_use_sessions_ticket ON computer_use_sessions(ticket_id);
CREATE INDEX IF NOT EXISTS idx_computer_use_screenshots_session ON computer_use_screenshots(session_id);

ALTER VIEW metrics_tickets SET (security_invoker = true);
ALTER VIEW metrics_tool_calls SET (security_invoker = true);
ALTER VIEW metrics_approvals SET (security_invoker = true);

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE computer_use_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE computer_use_screenshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenants;
DROP POLICY IF EXISTS tenant_isolation ON users;
DROP POLICY IF EXISTS tenant_isolation ON auth_sessions;
DROP POLICY IF EXISTS tenant_isolation ON enrollment_tokens;
DROP POLICY IF EXISTS tenant_isolation ON devices;
DROP POLICY IF EXISTS tenant_isolation ON platform_connections;
DROP POLICY IF EXISTS tenant_isolation ON tickets;
DROP POLICY IF EXISTS tenant_isolation ON ticket_messages;
DROP POLICY IF EXISTS tenant_isolation ON tool_calls;
DROP POLICY IF EXISTS tenant_isolation ON approvals;
DROP POLICY IF EXISTS tenant_isolation ON audit_log;
DROP POLICY IF EXISTS tenant_isolation ON computer_use_sessions;
DROP POLICY IF EXISTS tenant_isolation ON computer_use_screenshots;

CREATE POLICY tenant_isolation ON tenants USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());
CREATE POLICY tenant_isolation ON users USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON auth_sessions USING (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id));
CREATE POLICY tenant_isolation ON enrollment_tokens USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON devices USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON platform_connections USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON tickets USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON ticket_messages USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_id));
CREATE POLICY tenant_isolation ON tool_calls USING (
  EXISTS (SELECT 1 FROM devices d WHERE d.id = device_id)
  OR EXISTS (SELECT 1 FROM platform_connections p WHERE p.id = platform_connection_id)
);
CREATE POLICY tenant_isolation ON approvals USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_id));
CREATE POLICY tenant_isolation ON audit_log USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON computer_use_sessions USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON computer_use_screenshots USING (
  EXISTS (SELECT 1 FROM computer_use_sessions s WHERE s.id = session_id)
);

GRANT USAGE ON SCHEMA public TO support_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO support_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO support_app;
GRANT EXECUTE ON FUNCTION app_tenant_id() TO support_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO support_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO support_app;
