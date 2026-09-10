# Local development

Three pieces: **backend** (Fastify API + Postgres), **frontend** (Next.js),
**agent** (Go, Windows-only). The spec is `docs/v0.1-spec.md` — read it before
adding scope.

## Option A — Docker (backend + frontend + Postgres)

```sh
cd infra
cp .env.example .env        # optional: add OPENAI_API_KEY etc.
docker compose up --build
```

| Service  | URL                       | Notes                              |
|----------|---------------------------|------------------------------------|
| backend  | http://localhost:3000     | health check: `/health`            |
| frontend | http://localhost:3001     |                                    |
| postgres | localhost:5432            | `support` / `support` / `support_agent` |

`backend/src/db/schema.sql` is auto-loaded on the **first** boot only (when the
db volume is empty). To reload it: `docker compose down -v && docker compose up`.

The Windows **agent** is never in Docker — it only runs on Windows. Point it at
`http://<your-host-ip>:3000` from a real Windows box/VM (see `agent/README.md`).

## Option B — run each piece directly

Prereqs: Node 20+, Go 1.23+, a Postgres 14+ you can reach.

### Postgres

```sh
createdb support_agent
psql support_agent -f backend/src/db/schema.sql
```

### Backend

```sh
cd backend
cp .env.example .env         # set DATABASE_URL at minimum
npm install
npm run dev                  # tsx watch, listens on :3000
```

`OPENAI_API_KEY` is optional — without it every endpoint works except
`POST /tickets/:id/ai-step`, which fails with a clear message (by design, see
`docs/v0.1-spec.md` status).

### Frontend

```sh
cd frontend
npm install
NEXT_PUBLIC_API_URL=http://localhost:3000 npm run dev   # listens on :3000 by default; use -p 3001 alongside the backend
```

### Agent (on Windows)

```powershell
cd agent
$env:GOOS="windows"; go build -o bin/ ./...
# enroll once with a token from POST /enrollment-tokens, then run the 3 procs
# — full instructions in agent/README.md
```

From Linux/macOS you can still compile-check it:

```sh
cd agent
GOOS=windows go build ./...     # the real target
go build ./... && go test ./... # native: exercises IPC + allowlist logic
```

## Smoke test (no AI key needed)

```sh
API=http://localhost:3000

# 1. create a tenant
TENANT=$(curl -s -XPOST $API/tenants -H 'content-type: application/json' \
  -d '{"name":"Acme"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# 2. mint an enrollment token (enroll a real agent with it, or inspect the flow)
curl -s -XPOST $API/enrollment-tokens -H 'content-type: application/json' \
  -d "{\"tenantId\":\"$TENANT\"}"

# 3. metrics for the tenant (all zeros until there's activity)
curl -s "$API/metrics?tenantId=$TENANT"
```

Then open the frontend, paste the tenant id on the Home page, and use
Devices / Tickets / Metrics.

## Checks that CI runs (`.github/workflows/ci.yml`)

```sh
( cd backend  && npm ci && npm run typecheck )
( cd frontend && npm ci && npm run build )
( cd agent    && go vet ./... && go test ./... && GOOS=windows go build ./... && GOOS=windows go vet ./... )
```
