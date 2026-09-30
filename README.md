# AI Windows Support Agent — v0.1

An AI support agent for Windows fleets: diagnoses via read-only tools, proposes a
remediation, waits for human approval on any state-changing action, executes
through a privilege-separated Go agent, and verifies success deterministically
before closing the ticket. Technicians can open MeshCentral from tickets or
devices after an admin links a separately installed Mesh Agent. See
[remote support setup](infra/meshcentral-ca.md); handoff is manual.

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
- **Transport**: HTTPS through Cloudflare Tunnel with a per-device bearer token;
  enrollment also issues X.509 material for direct/private mTLS deployments.
- **Remote takeover**: MeshCentral (external authenticated console with per-device links).

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
in the dev environment). AI orchestration is wired and **verified against the
real OpenAI API** with a real key (`gpt-4.1-mini`) — including a real bug this
found and fixed: OpenAI function names must match `^[a-zA-Z0-9_-]+$`, which our
dotted tool names (`service.status`) violated outright; see
`backend/src/ai-orchestration/schema.ts`'s `toOpenAiToolName`/`fromOpenAiToolName`.

Computer-use (AI remote desktop assist, `docs/v0.1-computer-use-addendum.md`):
9 more agent tools (screenshot/click/type/etc.) wired end to end through the
same policy-engine/approval/audit pipeline. Per-action human approval by
default; a tenant can opt into **autonomous mode**
(`tenants.computer_use_autonomous_enabled`, toggle on the dashboard Home
page) where most actions run without pausing and a technician only steps in
when the AI itself signals it's stuck (`RESOLVED:`/`ESCALATE:` message
prefix, verified against a mock server) — a Luhn-valid card number typed via
`desktop.type` always still requires approval regardless. Also handles the
model batching multiple actions into one response (current OpenAI behavior)
by walking the batch one human-approved action at a time. Runs on the
**current** OpenAI computer-use API — the `computer` tool + `gpt-5.6-sol` —
after `computer-use-preview` was confirmed retired (real `404` from the live
API mid-session). Needs `OPENAI_COMPUTER_USE_MODEL` (defaults to
`gpt-5.6-sol`) in addition to `OPENAI_API_KEY`. The customer whose machine
it is gets their own auto-opened status/chat view (`desktop.open_customer_view`,
`FRONTEND_URL` env var) — visibility, not a consent gate (see the addendum's
known gaps).
Multi-OS: **Windows** (compile + cross-compile verified, no Windows box to
runtime-test on), **macOS** (real — built, unit-tested, and screenshot-tested
on this project's own dev machine), **Linux/X11** (screenshot capture verified
against a real X server on a real Linux machine over SSH; click/type/etc.
injection compile-checked only, never run for real). Mobile/TV OSes aren't
attempted — platform-level walls, not a gap (see the addendum doc).

Production operator docs: [`docs/HUONG_DAN_SU_DUNG.md`](docs/HUONG_DAN_SU_DUNG.md)
and [`docs/API.md`](docs/API.md).

Known gaps, flagged not hidden: Cloudflare Tunnel terminates TLS and does not
forward the client certificate, so the public agent route authenticates with a
per-device token; a persistent agent↔backend channel (polling for
now); an autonomous multi-step AI loop (one step per `POST /tickets/:id/ai-step`
today); the v0.2 marketing-ops platform clients (blocked on real Google/Meta/GA4
API credentials — `docs/v0.2-marketing-ops-spec.md` known gaps); no pixel-level
screenshot redaction for computer-use (`docs/v0.1-computer-use-addendum.md`
known gaps).

## Git

Remote: `github.com/nhannguyenalien/itsupport` (`main`).
