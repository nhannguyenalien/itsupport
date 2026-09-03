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

## Run as Windows services (install/install.ps1)

All 3 binaries now integrate with the Windows Service Control Manager via
`internal/winsvc` — `svc.IsWindowsService()` detects whether the process was
actually launched by the SCM; if so it does the full StartPending/Running/
Stop/Shutdown handshake, otherwise it just runs the same loop directly
(interactive/dev mode, unchanged from before).

```powershell
# From a Windows machine (or copy the built binaries there):
GOOS=windows GOARCH=amd64 go build -o install/ ./cmd/daemon ./cmd/telemetry ./cmd/executor ./cmd/enroll

# Then, as Administrator:
cd install
.\install.ps1 -BackendUrl "https://your-backend" -EnrollmentToken "<token>"
# Re-running later (already enrolled) needs neither param — it reuses the
# existing config.json and IPC secret, just re-registers the services.

.\uninstall.ps1            # stops + removes the 3 services, keeps enrollment
.\uninstall.ps1 -Full       # also wipes config.json and the IPC secret
```

Process separation carries into the service accounts: `SupportAgentExecutor`
runs as `LocalSystem` (the only one that touches privileged Win32 APIs),
`SupportAgentDaemon`/`SupportAgentTelemetry` run as `NT AUTHORITY\NetworkService`
(network access, no local elevation). See `install/install.ps1`'s own doc
comment for the one flagged simplification (IPC secret is a machine-wide env
var, not scoped per-service via the registry).

**Verified**: cross-compiles clean for windows/amd64, `go vet`/`go test` clean
on both platforms, and the refactored run-loops smoke-tested for real in
interactive mode (this repo's dev environment isn't Windows, so the actual SCM
handshake — StartPending/Running/Stop — could not be exercised end-to-end;
flagged, not assumed working from compilation alone).

## Run manually (no service, for local dev/testing)

```sh
# 1. Enroll once — get a one-time token from an admin first
#    (POST /enrollment-tokens on the backend, 10 minute TTL).
./enroll -backend https://your-backend -token <token>
# writes device config (device_id + local keypair) to config.DefaultPath(),
# override with -config or $AGENT_CONFIG_PATH

# 2. Start the three processes. daemon/telemetry read the config file written
# above; only the executor needs its own env var (never persisted to disk —
# it's a shared secret, not device identity).
export AGENT_IPC_SECRET="<shared secret, same value for daemon and executor>"
./executor &
./daemon &
./telemetry &
```

## Known gaps (flagged, not silently assumed done)

- **mTLS**: agent talks plain HTTPS with no client cert yet. `cmd/enroll`
  generates a real Ed25519 keypair and sends the public half, but the backend
  only returns a placeholder `cert_serial` (see
  `backend/src/enrollment/routes.ts`) — nothing yet issues a real certificate
  off that public key, and the private key it saves isn't used for anything
  past enrollment (no client-cert presentation on later requests).
- **IPC transport**: loopback HTTP + HMAC, not a Windows named pipe with an
  ACL. Loopback-only binding is the real boundary today; a named pipe would be
  tighter.
- **Windows service install**: `install/install.ps1` registers all 3 as real
  services (see above) — but has only been exercised via cross-compile +
  interactive-mode smoke test, never against a real Windows SCM (no Windows
  machine available in this environment). The IPC secret being machine-wide
  rather than per-service is a known, flagged simplification, not an oversight.
