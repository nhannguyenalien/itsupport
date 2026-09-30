# MeshCentral remote support

Deployment (2026-09-30): https://mesh.bluetechsw.com on `root@rootcloud`.
MeshCentral 1.2.5 runs as the dedicated `meshcentral` user under systemd.
The loopback HTTP listener on 127.0.0.1:4430 is reached through a dedicated
Cloudflare tunnel; there is no new public inbound port. Existing nginx services
and the IT Support deployment on macmini are independent.

## Operations

- Code and pinned npm lockfile: `/opt/itsupport-meshcentral`.
- Persistent config/database/keys: `meshcentral-data` under that directory.
- Files/backups: `meshcentral-files`, `meshcentral-backups`.
- Units: `itsupport-meshcentral.service`, `itsupport-meshcentral-tunnel.service`.
- Tunnel configuration/credential: `/etc/itsupport-meshcentral/` (root only).
- Bootstrap admin credential: `/root/itsupport-meshcentral-admin.json` (mode 600).
  Retrieve privately over SSH; never commit or paste into chat/logs. Set up MFA
  in My Account and create named technician accounts with scoped device access.
- Status: `systemctl status itsupport-meshcentral itsupport-meshcentral-tunnel`.
- Logs: `journalctl -u itsupport-meshcentral -n 50 --no-pager`.
- Limits: MeshCentral 768 MiB / 75% CPU; tunnel 192 MiB. Initial host free disk
  40 GiB, available RAM ~3 GiB, swap already full. Monitor before expanding.
- Before upgrades: stop MeshCentral, take a protected off-host copy of data,
  files, package-lock.json and config, then restart. Backups contain secrets.
  Upgrade pinned versions in a maintenance window and verify real agent sessions.
- Roll back an upgrade with the previous package-lock.json (`npm ci --omit=dev`)
  and a compatible data backup. Do not erase live data to roll back the app.
- Disable service: `systemctl disable --now itsupport-meshcentral itsupport-meshcentral-tunnel`.

## Application configuration and enrollment

Set `MESHCENTRAL_URL=https://mesh.bluetechsw.com` in macmini's `infra/.env`.
Docker Compose passes it to the backend. No MeshCentral admin token goes to the
browser; MeshCentral authenticates users and independently enforces ACLs.

1. Sign in to MeshCentral. Create a device group for each customer; grant only
   assigned named technicians access. Do not share the server administrator.
2. Use **Add Agent** in that group. Install its signed agent on the intended
   client with the customer's permission. This is separate from Support Agent.
   On macOS, enable Screen Recording and Accessibility in System Settings.
3. Open the device in its own MeshCentral tab; copy its `?node=...` link.
4. In IT Support → Devices → Technician remote support, an IT Support admin
   pastes that link (or its 64-character node ID / 96-character hex ID) and saves.
   A blank value removes only the link, not the installed agent.
5. Technicians can open remote support from Devices or the ticket. Stop the AI
   desktop session and wait for pending actions before taking remote control.
   This release provides navigation, not an automatic/atomic AI handoff lock.
6. Connect from MeshCentral. Server defaults require customer consent for
   desktop, terminal and files; timeout never auto-accepts. A privacy bar is on.

A saved link does not prove agent installation, online status or an active
remote session. MeshCentral provides those states. Support Agent revocation
hides the link but does not revoke MeshCentral access: revoke/remove the device
in MeshCentral too. Tenant admins configure mappings; they must choose the
correct device. MeshCentral ACLs remain the access boundary even with a wrong ID.

## Validation and remaining on-device acceptance

HTTPS and authenticated WebSocket access can be tested independently of a client.
Backend tests verify role/tenant rejection and deep-link ID handling. Before
claiming end-to-end remote control, enroll a consenting Windows/macOS client and
verify desktop, mouse/keyboard, reject/timeout consent, disconnect, and scoped
technician permissions. No customer device is enrolled automatically.
