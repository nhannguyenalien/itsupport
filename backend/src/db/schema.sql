-- AI Windows Support Agent — v0.1 schema
-- Multi-tenant via tenant_id on every tenant-scoped table. No shared-nothing DB
-- separation for v0.1 (pilot scale) — row-level scoping enforced in application
-- code (every query filters by tenant_id from the authenticated session/agent
-- cert). Revisit if a pilot tenant requires hard data isolation.

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
    autonomous_low_risk_enabled BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email           TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'technician', 'member')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);

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

    public_key          TEXT NOT NULL,       -- device keypair public half, from enrollment
    cert_serial         TEXT UNIQUE,          -- issued device cert serial (mTLS identity)
    cert_issued_at      TIMESTAMPTZ,
    cert_revoked_at     TIMESTAMPTZ,          -- non-null => cert is dead, spec: "Revoke Device"

    -- spec: "Pause Device Actions" — read tools still allowed, write tools blocked
    -- at the backend regardless of what the agent would otherwise accept.
    actions_paused      BOOLEAN NOT NULL DEFAULT false,

    last_seen_at        TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'unknown')),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE enrollment_tokens
    ADD CONSTRAINT fk_enrollment_tokens_device
    FOREIGN KEY (used_by_device) REFERENCES devices(id);

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
    device_id       UUID NOT NULL REFERENCES devices(id),
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
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- TOOL CALLS — every read AND write invocation, plus verification results.
-- This table is the backbone of both the audit log and remediation_success_rate.
-- ============================================================
CREATE TABLE tool_calls (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID REFERENCES tickets(id) ON DELETE CASCADE,
    device_id           UUID NOT NULL REFERENCES devices(id),
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
