# AI Windows Support Agent — v0.1

An AI support agent for Windows fleets: diagnoses via read-only tools, proposes a
remediation, waits for human approval on any state-changing action, executes
through a privilege-separated Go agent, and verifies success deterministically
before closing the ticket. Falls back to human takeover (MeshCentral) on failure.

Full scope contract: [`docs/v0.1-spec.md`](docs/v0.1-spec.md) — read that before
adding anything. If it's not in the IN list there, it's not v0.1.

**Run it locally:** [`DEVELOPMENT.md`](DEVELOPMENT.md) (`cd infra && docker compose up --build`).

## Stack (chosen now, flag if you want different)

- **Backend**: Node.js + TypeScript, Fastify, PostgreSQL (via `pg` + hand-written
  SQL/migrations — no ORM magic hiding the multi-tenant row-level scoping). Chosen
  for first-class LLM tool-calling SDK support (needed for AI orchestration) and
  fast iteration on the ticket/policy/audit business logic.
- **Agent**: Go, Windows-only for v0.1, three separate binaries per the process
  separation requirement (`connection daemon`, `telemetry`, `privileged executor`).
- **Frontend**: Next.js + TypeScript — ticket/chat UI, device dashboard, kill
  switches.
- **Transport**: mTLS between agent and backend, issued during enrollment.
- **Remote takeover**: MeshCentral (external, integrated via its API — not
  reimplemented).

## Repo layout

```
backend/     Multi-tenant API: enrollment, tickets, tool registry, policy engine,
             AI orchestration, audit log, metrics
agent/       Go Windows agent (3 privilege-separated processes)
frontend/    Next.js ticket/chat UI + admin dashboard
docs/        Spec + design notes (source of truth: v0.1-spec.md)
infra/       Local dev (docker-compose: postgres, backend, frontend)
```

## Status

v0.1 under active construction — not production-hardened. See commit history for
what's implemented vs. stubbed.

Working end to end: the API (tickets / policy engine / approvals / audit /
metrics), the Next.js dashboard, and all 16 Windows agent tools (compile +
cross-compile verified; on-device runtime testing still pending — no Windows box
in the dev environment). AI orchestration is wired and runs given an
`OPENAI_API_KEY`.

Known gaps, flagged not hidden: real mTLS cert issuance at enrollment (returns a
placeholder serial today — see `backend/src/enrollment/routes.ts` and
`infra/meshcentral-ca.md`); a persistent agent↔backend channel (polling for
now); an autonomous multi-step AI loop (one step per `POST /tickets/:id/ai-step`
today); the v0.2 marketing-ops platform clients (blocked on real Google/Meta/GA4
API credentials — `docs/v0.2-marketing-ops-spec.md` known gaps).

## Git

Remote: `github.com/nhannguyenalien/itsupport` (`main`).
