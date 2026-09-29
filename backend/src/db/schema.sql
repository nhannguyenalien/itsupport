-- AI Windows Support Agent — v0.1 schema
-- Multi-tenant data is protected twice: route-level authorization and native
-- PostgreSQL row-level security keyed by the transaction-local app.tenant_id.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ============================================================
-- TENANTS
-- ============================================================
CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Day-one kill switch (spec: "Disable Tenant AI" button)
    ai_enabled      BOOLEAN NOT NULL DEFAULT true,

    -- Data privacy policy, spec section "Data privacy v0.1"
    ai_data_policy  TEXT NOT NULL DEFAULT 'standard'
                    CHECK (ai_data_policy IN ('standard', 'redacted', 'no_screenshots', 'no_raw_logs')),

    -- Per-tenant autonomy opt-in, spec: "Allow low-risk autonomous remediation"
    -- Stays false until pilot data justifies enabling it (see tool_stats).
    autonomous_low_risk_enabled BOOLEAN NOT NULL DEFAULT false,

    -- Separate opt-in for computer-use write actions (domain:'windows_desktop',
    -- risk:'high') — deliberately its own flag, not reusing
    -- autonomous_low_risk_enabled above: that one only ever unlocks risk:'low'
    -- tools per policy-engine/index.ts's existing rule, and computer-use
    -- actions are risk:'high' by design (every click/type is real reach into
    -- the machine). A tenant can turn general IT-tool autonomy and
    -- computer-use autonomy on independently. See
    -- docs/v0.1-computer-use-addendum.md's autonomous-mode section — even
    -- with this on, a desktop.type carrying a Luhn-valid card number always
    -- still requires approval (policy-engine/index.ts), and no UI toggle
    -- exists yet (same as autonomous_low_risk_enabled) — set via SQL.
    computer_use_autonomous_enabled BOOLEAN NOT NULL DEFAULT false,

    -- v0.2 marketing-ops budget policy (docs/v0.2-marketing-ops-spec.md #12).
    -- ads.budget.update's risk is computed from these at evaluation time, not
    -- looked up statically from the tool registry — see policy-engine/index.ts.
    -- A budget *increase* above budget_approval_pct_limit is never offered to
    -- the AI at all (not requires_approval, rejected outright) — money-losing
    -- actions get a harder ceiling than ordinary "high risk" IT actions do.
    budget_auto_pct_limit      NUMERIC NOT NULL DEFAULT 10,  -- increase <= this %: auto (if autonomy on)
    budget_approval_pct_limit  NUMERIC NOT NULL DEFAULT 25,  -- increase <= this %: approval; above: rejected
    daily_spend_limit_cents    BIGINT,                        -- NULL = no cap enforced
    absolute_budget_limit_cents BIGINT                        -- NULL = no cap enforced
);

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email           TEXT NOT NULL,
    firebase_uid    TEXT UNIQUE,
    password_hash   TEXT,
    role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'technician', 'member')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);

-- Legacy password/session columns are retained for a non-destructive upgrade,
-- but production authentication is performed by Firebase ID tokens.
-- Session tokens are never
-- stored raw: only a SHA-256 digest is persisted, so a database read cannot be
-- turned directly into a logged-in browser session.
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
CREATE TABLE auth_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX idx_auth_sessions_expiry ON auth_sessions(expires_at);

-- ============================================================
-- DEVICE ENROLLMENT
-- Flow: admin creates token -> agent generates keypair locally -> agent sends
-- pubkey+token -> server verifies -> issues device cert -> mTLS from then on.
-- ============================================================
CREATE TABLE enrollment_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE, -- store hash, never the raw token
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL, -- created_at + 10 minutes, enforced in app code
    used_at         TIMESTAMPTZ,          -- one-time: NULL until consumed
    used_by_device  UUID -- FK to devices(id) added below (devices doesn't exist yet here)
);

CREATE TABLE devices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    hostname            TEXT NOT NULL,
    os_version          TEXT,
    agent_version       TEXT,
    -- Multi-OS computer-use addendum (docs/v0.1-computer-use-addendum.md) —
    -- which agent build enrolled (cmd/enroll derives this from runtime.GOOS).
    -- Defaults 'windows' for back-compat with pre-multi-OS agent builds that
    -- don't send this field at all. Drives the `environment` value passed to
    -- OpenAI's computer_use_preview tool (backend/src/computer-use/index.ts)
    -- — everything else about a device (registry.json, policy-engine) is
    -- already platform-agnostic.
    platform            TEXT NOT NULL DEFAULT 'windows' CHECK (platform IN ('windows', 'mac', 'linux')),

    public_key          TEXT NOT NULL,       -- device keypair public half, from enrollment
    cert_serial         TEXT UNIQUE,          -- issued device cert serial (mTLS identity)
    cert_issued_at      TIMESTAMPTZ,
    cert_revoked_at     TIMESTAMPTZ,          -- non-null => cert is dead, spec: "Revoke Device"
    agent_token_hash    TEXT UNIQUE,           -- SHA-256 of the per-device API bearer token

    -- spec: "Pause Device Actions" — read tools still allowed, write tools blocked
    -- at the backend regardless of what the agent would otherwise accept.
    actions_paused      BOOLEAN NOT NULL DEFAULT false,

    last_seen_at        TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'unknown')),

    -- Set when the Windows install bundles MeshCentral's mesh agent alongside
    -- ours (not yet wired into the installer — see agent/README.md). Once set,
    -- GET /tickets/:id/takeover-link can build a real desktop-takeover URL;
    -- until then that endpoint 404s honestly instead of returning a dead link.
    meshcentral_device_id TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE enrollment_tokens
    ADD CONSTRAINT fk_enrollment_tokens_device
    FOREIGN KEY (used_by_device) REFERENCES devices(id);

-- ============================================================
-- PLATFORM CONNECTIONS (v0.2 marketing-ops)
-- OAuth token custody for ads/analytics/CRM platforms. The AI and tools never
-- see raw tokens — they call an internal platform-client layer that decrypts
-- and injects the tenant's stored token (docs/v0.2-marketing-ops-spec.md).
-- ============================================================
CREATE TABLE platform_connections (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    platform                TEXT NOT NULL CHECK (platform IN
                             ('google_ads', 'meta_ads', 'ga4', 'gtm', 'crm_generic')),
    external_account_id     TEXT NOT NULL, -- platform's own account/property ID

    -- AES-256-GCM ciphertext, never plaintext — see oauth/crypto.ts. iv+authTag
    -- are prefixed into the stored value, not split into separate columns, so
    -- there's one blob to rotate/delete per token rather than three fields that
    -- could drift out of sync.
    access_token_ciphertext  TEXT NOT NULL,
    refresh_token_ciphertext TEXT,
    token_expires_at         TIMESTAMPTZ,
    scopes                   TEXT[] NOT NULL DEFAULT '{}',

    status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'expired', 'revoked', 'error')),
    -- Same concept as devices.actions_paused, generalized to a platform account
    -- — spec's "human only" band and this kill switch are independent controls.
    actions_paused           BOOLEAN NOT NULL DEFAULT false,
    connected_by             UUID REFERENCES users(id),
    connected_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at             TIMESTAMPTZ,
    last_error               TEXT,

    UNIQUE (tenant_id, platform, external_account_id)
);

-- ============================================================
-- TOOL REGISTRY
-- Canonical definitions live in backend/src/tool-registry/registry.json (loaded
-- at boot, versioned in git). This table records what the registry looked like
-- at the moment a tool_call executed, for audit — never a live source of truth.
-- ============================================================
CREATE TABLE tool_registry_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tool            TEXT NOT NULL,
    risk            TEXT NOT NULL CHECK (risk IN ('read', 'low', 'medium', 'high')),
    verification    JSONB NOT NULL DEFAULT '[]', -- array of tool names checked after execution
    registry_hash   TEXT NOT NULL, -- hash of the full registry.json this snapshot came from
    captured_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- TICKETS
-- ============================================================
CREATE TABLE tickets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- Exactly one target, same reasoning as tool_calls above.
    device_id               UUID REFERENCES devices(id),
    platform_connection_id  UUID REFERENCES platform_connections(id),
    CHECK (
        (device_id IS NOT NULL AND platform_connection_id IS NULL) OR
        (device_id IS NULL AND platform_connection_id IS NOT NULL)
    ),

    created_by      UUID REFERENCES users(id),

    title           TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'diagnosing', 'awaiting_approval',
                                       'remediating', 'resolved', 'remediation_failed',
                                       'escalated', 'closed')),
    scenario        TEXT CHECK (scenario IN ('A_printer', 'B_dns', 'C_hung_app', 'D_disk_full', NULL)),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ,
    closed_at       TIMESTAMPTZ
);

CREATE TABLE ticket_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id       UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author_type     TEXT NOT NULL CHECK (author_type IN ('user', 'ai', 'system', 'technician')),
    author_id       UUID, -- users.id when author_type = 'user' or 'technician'
    body            TEXT NOT NULL,
    attachments     JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- TOOL CALLS — every read AND write invocation, plus verification results.
-- This table is the backbone of both the audit log and remediation_success_rate.
-- ============================================================
CREATE TABLE tool_calls (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID REFERENCES tickets(id) ON DELETE CASCADE,

    -- Exactly one target: a Windows device (v0.1 tools) or a platform
    -- connection (v0.2 marketing tools) — never both, never neither.
    device_id               UUID REFERENCES devices(id),
    platform_connection_id  UUID REFERENCES platform_connections(id),
    CHECK (
        (device_id IS NOT NULL AND platform_connection_id IS NULL) OR
        (device_id IS NULL AND platform_connection_id IS NOT NULL)
    ),

    tool                TEXT NOT NULL,
    risk                TEXT NOT NULL CHECK (risk IN ('read', 'low', 'medium', 'high')),
    params              JSONB NOT NULL DEFAULT '{}',

    -- NULL for top-level calls (diagnosis reads, or the write action itself).
    -- Set when this row exists to verify a PARENT write call, per that tool's
    -- registry.json `verification` list — see tool-calls/routes.ts.
    parent_tool_call_id UUID REFERENCES tool_calls(id),

    -- Approval linkage — NULL for read tools (auto-executed, no approval step).
    -- FK to approvals(id) added below (approvals doesn't exist yet here).
    approval_id         UUID,

    requested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    executed_at         TIMESTAMPTZ,
    result              TEXT CHECK (result IN ('success', 'error', 'timeout', NULL)),
    result_data         JSONB,
    error_message       TEXT,

    -- Deterministic verification per registry.json's `verification` chain.
    -- verification_status is the terminal call state the ticket state machine reads.
    verification_status TEXT DEFAULT 'not_required'
                        CHECK (verification_status IN ('not_required', 'pending', 'passed', 'failed')),
    verification_detail JSONB -- per-step pass/fail, e.g. [{"tool":"service.status","passed":true}]
);

-- ============================================================
-- APPROVALS — spec: write actions require human approval by default in v0.1.
-- ============================================================
CREATE TABLE approvals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id       UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    tool            TEXT NOT NULL,
    params          JSONB NOT NULL DEFAULT '{}',
    proposed_by_ai  BOOLEAN NOT NULL DEFAULT true,
    reasoning       TEXT, -- AI's stated justification, shown to the approver

    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    decided_by      UUID REFERENCES users(id),
    decided_at      TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tool_calls
    ADD CONSTRAINT fk_tool_calls_approval
    FOREIGN KEY (approval_id) REFERENCES approvals(id);

-- ============================================================
-- AUDIT LOG — append-only. Every state-relevant event across the system, not
-- just tool_calls (also: enrollment, revoke/pause, AI-disable, MeshCentral
-- takeover, approval decisions). tool_calls/approvals are the detailed record;
-- audit_log is the flat append-only trail spec explicitly requires end-to-end.
-- ============================================================
CREATE TABLE audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    actor_type      TEXT NOT NULL CHECK (actor_type IN ('user', 'ai', 'system', 'agent', 'technician')),
    actor_id        UUID,
    event_type      TEXT NOT NULL, -- e.g. 'device.enrolled', 'device.revoked', 'tenant.ai_disabled',
                                    -- 'approval.granted', 'tool_call.executed', 'takeover.started'
    event_data      JSONB NOT NULL DEFAULT '{}',
    ticket_id       UUID REFERENCES tickets(id),
    device_id       UUID REFERENCES devices(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- COMPUTER USE — docs/v0.1-computer-use-addendum.md. OpenAI Computer-Using-
-- Agent (Responses API, computer_use_preview tool) sessions for AI-driven
-- remote desktop support. Every actual action (click/type/etc.) is still an
-- ordinary tool_calls/approvals row — domain:'windows_desktop' in
-- registry.json, risk:'high' -> policy-engine/index.ts always requires_
-- approval, never auto-execute. This table only tracks the OpenAI
-- conversation state needed to resume that loop; it grants no authorization
-- by itself.
-- ============================================================
CREATE TABLE computer_use_sessions (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    ticket_id             UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    device_id             UUID NOT NULL REFERENCES devices(id),

    status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
    stop_requested       BOOLEAN NOT NULL DEFAULT false,
    action_count         INTEGER NOT NULL DEFAULT 0,
    openai_response_id    TEXT, -- OpenAI Responses API response id, for previous_response_id chaining

    -- Exactly one of these is set while a step is in flight: the tool_calls row
    -- for an auto-executed read action (desktop.screenshot/move/wait) still
    -- waiting on the agent to report a result, or the approvals row for a
    -- risk:'high' write action still waiting on a human. advanceSession()
    -- (computer-use/index.ts) polls whichever is set and only calls OpenAI
    -- again once it's resolved — same "frontend polls every few seconds"
    -- posture as the rest of this app, no new push/wait mechanism.
    pending_tool_call_id  UUID REFERENCES tool_calls(id),
    pending_approval_id   UUID REFERENCES approvals(id),

    -- The current OpenAI computer-use API ("computer" tool, gpt-5.6-sol —
    -- computer-use-preview is retired, confirmed via a real 404) returns a
    -- BATCH of actions per computer_call (actions[], one shared call_id, one
    -- pending_safety_checks for the whole batch), but this product's hard
    -- requirement is per-action human approval. These 3 columns hold the
    -- rest of an in-progress batch while pending_tool_call_id/
    -- pending_approval_id above track whichever single action within it is
    -- currently being approved/executed — see computer-use/index.ts. All
    -- three are NULL when not mid-batch (including right after the last
    -- action of a batch resolves, before the end-of-batch response is sent).
    pending_batch_call_id       TEXT,
    pending_batch_remaining     JSONB, -- array of not-yet-started ComputerAction objects
    pending_batch_safety_checks JSONB, -- the batch's pending_safety_checks, echoed back once at the end

    display_width         INTEGER NOT NULL DEFAULT 1280,
    display_height        INTEGER NOT NULL DEFAULT 800,
    environment            TEXT NOT NULL DEFAULT 'windows' CHECK (environment IN ('windows', 'mac', 'linux', 'ubuntu', 'browser')),

    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Screenshot bytes live here, never inline in tool_calls.result_data or
-- audit_log.event_data (both JSONB, no size cap enforced today) — keeps
-- binary payloads out of rows/columns that get scanned constantly.
-- tool_calls.result_data for a desktop.screenshot call instead carries just
-- {"screenshot_id": "<this table's id>"}, see tool-calls/execution.ts.
CREATE TABLE computer_use_screenshots (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID NOT NULL REFERENCES computer_use_sessions(id) ON DELETE CASCADE,
    image_data  BYTEA NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_computer_use_sessions_ticket ON computer_use_sessions(ticket_id);
CREATE INDEX idx_computer_use_screenshots_session ON computer_use_screenshots(session_id);

-- ============================================================
-- METRICS — spec explicitly wants these queryable from day one, not bolted on.
-- Kept as views over the tables above rather than a separately-maintained
-- aggregate table, so numbers can never drift from the source records.
-- ============================================================
CREATE VIEW metrics_tickets AS
SELECT
    tenant_id,
    count(*)                                                   AS tickets_total,
    count(*) FILTER (WHERE status = 'resolved')                AS tickets_ai_resolved,
    count(*) FILTER (WHERE status = 'escalated')                AS tickets_escalated,
    avg(extract(epoch FROM (resolved_at - created_at)))
        FILTER (WHERE resolved_at IS NOT NULL)                  AS avg_resolution_seconds
FROM tickets
GROUP BY tenant_id;

CREATE VIEW metrics_tool_calls AS
SELECT
    tc.device_id,
    d.tenant_id,
    tc.tool,
    count(*)                                                    AS calls_total,
    count(*) FILTER (WHERE tc.result = 'success')               AS calls_succeeded,
    count(*) FILTER (WHERE tc.verification_status = 'passed')   AS verified_passed,
    count(*) FILTER (WHERE tc.verification_status = 'failed')   AS verified_failed,
    round(
        count(*) FILTER (WHERE tc.verification_status = 'passed')::numeric
        / NULLIF(count(*) FILTER (WHERE tc.verification_status IN ('passed','failed')), 0),
        4
    ) AS remediation_success_rate
FROM tool_calls tc
JOIN devices d ON d.id = tc.device_id
GROUP BY tc.device_id, d.tenant_id, tc.tool;

CREATE VIEW metrics_approvals AS
SELECT
    t.tenant_id,
    count(*)                                        AS approvals_total,
    count(*) FILTER (WHERE a.status = 'approved')   AS approvals_granted,
    round(
        count(*) FILTER (WHERE a.status = 'approved')::numeric
        / NULLIF(count(*), 0), 4
    ) AS approval_rate
FROM approvals a
JOIN tickets t ON t.id = a.ticket_id
GROUP BY t.tenant_id;

-- Views must run as the caller so the underlying tenant RLS policies remain
-- effective (PostgreSQL 15+ defaults to the view owner's privileges).
ALTER VIEW metrics_tickets SET (security_invoker = true);
ALTER VIEW metrics_tool_calls SET (security_invoker = true);
ALTER VIEW metrics_approvals SET (security_invoker = true);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_devices_tenant ON devices(tenant_id);
CREATE INDEX idx_tickets_tenant ON tickets(tenant_id);
CREATE INDEX idx_tickets_device ON tickets(device_id);
CREATE INDEX idx_ticket_messages_ticket ON ticket_messages(ticket_id);
CREATE INDEX idx_tool_calls_ticket ON tool_calls(ticket_id);
CREATE INDEX idx_tool_calls_device ON tool_calls(device_id);
CREATE INDEX idx_approvals_ticket ON approvals(ticket_id);
CREATE INDEX idx_approvals_status ON approvals(status) WHERE status = 'pending';
CREATE INDEX idx_audit_log_tenant ON audit_log(tenant_id);
CREATE INDEX idx_audit_log_device ON audit_log(device_id);
CREATE INDEX idx_enrollment_tokens_hash ON enrollment_tokens(token_hash);

-- ============================================================
-- ROW LEVEL SECURITY
-- The application role must not own these tables and must not have BYPASSRLS.
-- Missing app.tenant_id therefore means no tenant rows, never all rows.
-- ============================================================
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

CREATE POLICY tenant_isolation ON tenants USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());
CREATE POLICY tenant_isolation ON users USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON enrollment_tokens USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON devices USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON platform_connections USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON tickets USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON audit_log USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON computer_use_sessions USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON auth_sessions USING (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id));
CREATE POLICY tenant_isolation ON ticket_messages USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_id));
CREATE POLICY tenant_isolation ON tool_calls USING (
  EXISTS (SELECT 1 FROM devices d WHERE d.id = device_id)
  OR EXISTS (SELECT 1 FROM platform_connections p WHERE p.id = platform_connection_id)
);
CREATE POLICY tenant_isolation ON approvals USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_id));
CREATE POLICY tenant_isolation ON computer_use_screenshots USING (
  EXISTS (SELECT 1 FROM computer_use_sessions s WHERE s.id = session_id)
);
