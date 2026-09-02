# Agent

Three separate binaries, deliberately not one process — see
`docs/v0.1-spec.md` "Quyền Windows nên tách":

- `cmd/executor` — the ONLY privileged process. Listens on `127.0.0.1:47800`
  (loopback only), verifies an HMAC signature on every request before parsing
  anything, and refuses any tool name outside the compile-time allowlist
  (`internal/tools/registry_windows.go`). Meant to run as a Windows service
  under an elevated account — that service install/manifest isn't written yet.
- `cmd/daemon` — low privilege. Polls the backend for pending tool calls,
  forwards each to the executor over the signed local channel, reports the
  result back.
- `cmd/telemetry` — low privilege. Periodic heartbeat only in v0.1 (backend's
  online/offline status is built on this).

## Implemented for real (compiles + cross-compiles for Windows)

`service.status`, `service.restart`, `process.list`, `process.kill`,
`disk.usage`, `system.info` — enough to run demo scenarios A and D end-to-end
once wired to a real backend and a real Windows box. Everything else in the
registry is wired to a typed `not implemented` error (see
`registry_windows.go`) so the dispatch architecture is complete even before
every Win32 call is written.

## Build

```sh
# Windows target (the only one that actually runs tools):
GOOS=windows GOARCH=amd64 go build -o bin/ ./...

# Native build (Linux/macOS) — compiles and lets you exercise the IPC layer,
# allowlist rejection, and daemon/backend polling logic; tool execution itself
# always returns "windows only" on non-Windows, by design (executor_other.go).
go build ./...
go test ./...
```

## Run (manual, no service installer yet)

```sh
export AGENT_IPC_SECRET="<shared secret, same value for daemon and executor>"
./executor &

export AGENT_BACKEND_URL="https://your-backend"
export AGENT_DEVICE_ID="<uuid from enrollment>"
./daemon &
./telemetry &
```

## Known gaps (flagged, not silently assumed done)

- **mTLS**: agent talks plain HTTPS with no client cert yet. Backend issues a
  placeholder `cert_serial` at enrollment (see `backend/src/enrollment/routes.ts`)
  — real PKI issuance/verification on both ends is unbuilt.
  Not registered anywhere: enrollment keypair generation
  (`docs/v0.1-spec.md`'s enrollment flow says the agent generates a keypair
  locally before contacting the server) isn't implemented in `cmd/` yet either
  — enrollment today would need a separate one-off tool or manual step.
- **IPC transport**: loopback HTTP + HMAC, not a Windows named pipe with an
  ACL. Loopback-only binding is the real boundary today; a named pipe would be
  tighter.
- **Windows service installation**: none of the three binaries install
  themselves as services yet (elevated executor, low-priv daemon/telemetry).
