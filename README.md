# AI Windows Support Agent — v0.1

An AI support agent for Windows fleets: diagnoses via read-only tools, proposes a
remediation, waits for human approval on any state-changing action, executes
through a privilege-separated Go agent, and verifies success deterministically
before closing the ticket. Falls back to human takeover (MeshCentral) on failure.

Full scope contract: [`docs/v0.1-spec.md`](docs/v0.1-spec.md) — read that before
adding anything. If it's not in the IN list there, it's not v0.1.

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

Scaffolding in progress. See task list / commit history for what's actually
implemented vs. stubbed. Nothing here is production-hardened yet — this is v0.1
under active construction, not a finished product.

## Git

No remote configured yet — user will provide the repo to push to.
