# Agent

Three separate binaries, deliberately not one process — see
`docs/v0.1-spec.md` "Quyền Windows nên tách":

- `cmd/executor` — the ONLY privileged process. Listens on `127.0.0.1:47800`
  (loopback only), verifies an HMAC signature on every request before parsing
  anything, and refuses any tool name outside the compile-time allowlist
  (`internal/tools/registry_windows.go`). Runs as an elevated Windows service;
  macOS/Linux implementations run in the logged-in user's session.
- `cmd/daemon` — low privilege. Polls the backend for pending tool calls,
  forwards each to the executor over the signed local channel, reports the
  result back.
- `cmd/telemetry` — low privilege. Periodic heartbeat only in v0.1 (backend's
  online/offline status is built on this).

## Implemented (compiles + cross-compiles for Windows)

All 16 v0.1 tools have real implementations, each a native Win32 / Go stdlib
call — no shelling out to PowerShell or `ipconfig`/`ping`/`nslookup`:

| Group   | Tools | API used |
|---------|-------|----------|
| service | `service.status`, `service.restart` | SCM via `x/sys/windows/svc/mgr` |
| process | `process.list`, `process.kill` | `CreateToolhelp32Snapshot`, `OpenProcess`/`TerminateProcess` |
| disk    | `disk.usage` | `GetDiskFreeSpaceEx` |
| system  | `system.info` | `GlobalMemoryStatusEx` |
| network | `network.ping`, `network.dns_lookup`, `network.flush_dns` | `IcmpSendEcho`, Go resolver, `DnsFlushResolverCache` |
| temp    | `temp.scan`, `temp.clean` | filesystem walk of fixed temp dirs |
| printer | `printer.status`, `printer.queue`, `printer.test`, `printer.clear_queue` | `winspool.drv` (`EnumPrinters`, `GetPrinter` L6, `EnumJobs`, `StartDocPrinter`, `SetPrinter` PURGE) |
| eventlog| `eventlog.read` | `wevtapi` `EvtQuery`/`EvtNext`/`EvtRender` (XML) |
| browser | `browser.open_url` (v0.2 OAuth-assist) | `cmd /c start` |

`registry_windows_test.go` fails the build if the name allowlist
(`registry.go`) and the implementation table (`registry_windows.go`) drift.

Verified by `GOOS=windows go build ./...` + `GOOS=windows go vet ./...` from
the (non-Windows) dev environment. The Win32 struct layouts and syscall
argument order have **not** been exercised against a real Windows host yet — no
Windows machine available here; flagged, not assumed correct from compilation
alone. `notImplemented()` stays in `registry_windows.go` as the wiring for any
future tool added to the name list before its Win32 code lands.

## Build

```sh
# Windows target:
GOOS=windows GOARCH=amd64 go build -o bin/ ./...

# Native build (Linux/macOS):
go build ./...
go test ./...
```

## Run as Windows services (install/install.ps1)

All 3 binaries integrate with the Windows Service Control Manager via
`internal/winsvc`. The installer registers each binary with the explicit
`service` argument, which selects the StartPending/Running/Stop/Shutdown SCM
path; launching a binary without that argument remains interactive/dev mode.

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

Configs created before agent 0.2.0 have no `agentToken`. The installer detects
that case, saves `config.json.pre-token.bak`, and requires a new one-time token.
Use `-ForceReEnroll` to deliberately rotate the device identity.

## Run on macOS

Build the four commands into `install/`, then use the LaunchAgent installer:

```sh
go build -o install/enroll ./cmd/enroll
go build -o install/daemon ./cmd/daemon
go build -o install/telemetry ./cmd/telemetry
go build -o install/executor ./cmd/executor
chmod +x install/install-macos.sh
install/install-macos.sh --backend https://itsupport.schoolsai.work/api --token '<token>'
```

The macOS installer preserves an existing device registration by default. If the
machine is online but absent from your workspace, open **Thiết bị → Thêm máy**,
select macOS and **Đăng ký lại vào workspace này**, then generate a fresh one-time
command. This passes `--force-re-enroll` and backs up the previous configuration
before registering again. The installer verifies a heartbeat before reporting
success. Agent logs are in `~/Library/Application Support/support-agent`.

Process separation carries into the service accounts: `SupportAgentExecutor`
runs as `LocalSystem` (the only one that touches privileged Win32 APIs),
`SupportAgentDaemon`/`SupportAgentTelemetry` run as `NT AUTHORITY\NetworkService`
(network access, no local elevation). See `install/install.ps1`'s own doc
comment for the one flagged simplification (IPC secret is a machine-wide env
var, not scoped per-service via the registry).

**Verified**: cross-compiles clean for windows/amd64 and `go test ./...` passes.
The release installer was also exercised end-to-end on a Windows VM: all three
services installed under `C:\SupportAgent`, completed the real SCM handshake,
remained Running, and sent heartbeats to the production endpoint.

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

- **Public transport**: enrollment issues a real certificate and a per-device
  token. Direct deployments can use mTLS; the Cloudflare Tunnel production
  route uses the token because the tunnel does not forward client certificates.
- **IPC transport**: loopback HTTP + HMAC, not a Windows named pipe with an
  ACL. Loopback-only binding is the real boundary today; a named pipe would be
  tighter.
- **Windows service install**: `install/install.ps1` registers all 3 as real
  services (see above) — but has only been exercised via cross-compile +
  interactive-mode smoke test, never against a real Windows SCM (no Windows
  machine available in this environment). The IPC secret being machine-wide
  rather than per-service is a known, flagged simplification, not an oversight.

### Linux installation

In **Devices → Add device → Linux**, generate the one-time command and run it
on the Linux machine. Supports x86-64 and ARM64 distributions with systemd,
`bash`, `curl`, Python 3, CA certificates and root/sudo access. Containers without
systemd, 32-bit systems and non-systemd distributions are not supported.

The installer enrolls the machine, starts the executor/daemon/telemetry systemd
services, installs the official Mesh Agent for the matching architecture, and
registers its node with the authenticated workspace. Re-running preserves device
identity; select re-enrollment only when deliberately changing the registration.
An existing Mesh Agent belonging to another group/server is rejected.

Support Agent binaries: `/opt/itsupport-agent`; credentials and IPC environment:
`/etc/itsupport-agent` (root only). Services: `itsupport-executor`,
`itsupport-daemon`, `itsupport-telemetry`. Agent application logs are also written
under `/etc/itsupport-agent`. Mesh Agent uses `meshagent.service`.

Remote access uses the existing chat support ON/OFF and session consent controls.
An unattended/headless machine may not be able to display the local consent
prompt; this installer does not bypass consent. Desktop control depends on the
Linux desktop/session. The existing AI X11 tools require a user graphical session
and are not enabled by this root system service; Wayland automation and Linux IT
repair tools are not implemented by this onboarding change.

Build both Linux architectures with `agent/build-release.sh`. Publish the ignored
`frontend/public/downloads/agent/linux-{amd64,arm64}` directories to the deployment
checkout before rebuilding the frontend image; bootstrap and service scripts are
tracked in Git. Verify public downloads before directing customers to install.
