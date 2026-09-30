# MeshCentral remote support

Deployment (2026-09-30): https://mesh.schoolsai.work on `root@rootcloud`.
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

Set `MESHCENTRAL_URL=https://mesh.schoolsai.work`, `MESHCENTRAL_API_USER`,
and `MESHCENTRAL_API_PASSWORD` in macmini's protected `infra/.env`.
The service account needs remote desktop and guest sharing on configured tenant
groups, with files denied (group rights 524288 | 8 | 1024 = 525320) and no site administrator privileges. Its
credential is stored in `/root/itsupport-meshcentral-api.json` (mode 600).
Never expose it to browsers or logs.

The chat shows one On/Off switch. On creates a 60-minute share. Windows/macOS
share desktop and Terminal with local consent prompts and a desktop privacy bar.
Linux shares Terminal only; the explicit On toggle grants access without a GUI prompt. Repeated On reuses the active
share. Off revokes all application-issued shares for that device. Only IT Support
technicians/admins receive the share URL; members can grant/revoke access without
receiving the URL. Independent MeshCentral administrator access is separate.
Tenant-scoped device lookup and MeshCentral group membership are checked before
issuing access. Agent enrollment automatically registers its node ID using the
existing device credential; customers never need to copy node IDs.

Stop AI desktop actions before taking control: this switch does not implement an
atomic AI handoff lock. macOS still requires Screen Recording and Accessibility.
Device revocation in IT Support does not remove independently granted MeshCentral
access; revoke/remove the device in MeshCentral as well.

## Validation and remaining on-device acceptance

Tests cover tenant/role boundaries, repeat On/Off, expiry and link validation.
The scoped production service account has been verified to create, list and revoke
a consent share without opening a remote desktop connection.
Real screen capture, keyboard/mouse and consent UI still need an on-device test.

## Bundled customer installation

The macOS/Windows/Linux CLI installs Mesh Agent after Support Agent enrollment.
It requests `/devices/:deviceId/remote-install` with the device credential.
Set `MESHCENTRAL_TENANT_GROUPS` to a JSON object mapping tenant UUIDs to the
64-character MeshCentral group IDs (without `mesh//`). Create a separate
desktop agent group per customer with consent 127; grant technicians only their groups.
For headless Linux, create a separate group per tenant with consent 109 (127 minus
terminal notify 2 and terminal prompt 16), and configure its ID in
`MESHCENTRAL_LINUX_TENANT_GROUPS` using the same JSON format. Set domain
`userConsentFlags.terminalnotify` and `terminalprompt` to false: MeshCentral ORs
domain/group/share policies, so mandatory global prompts otherwise block headless
hosts. Keep all other domain consent flags and existing desktop group consent 127.
Windows/macOS retain Terminal prompts through their group and share consent 88.
Linux group membership is checked separately before issuing a share. The API account
needs the same limited rights 525320 on the Linux group. Independent MeshCentral
administrator access is still privileged and separate from the application switch.
When migrating a Linux agent, move only that node to the tenant's Linux group;
MeshCentral updates its local group configuration. Keep the previous group mapping
and domain config backup for rollback. Without the Linux mapping, legacy group
selection remains compatible, but a group with terminal prompts cannot support
headless Terminal sessions.
Unconfigured tenants receive 503 rather than joining a shared customer group.
Keep the JSON single-quoted in Compose's `.env` to preserve `$` in IDs.

macOS downloads the official universal ZIP package and invokes `sudo installer`;
customers must grant Screen Recording and Accessibility in System Settings.
Windows downloads the official x64 installer and installs its service as admin.
Existing Mesh installations are not overwritten when their ownership is unknown.
Failures stop setup with an error; Support Agent remains installed, and rerunning
the original command retries without consuming another enrollment token.
After installation, the CLI reads the local Mesh Agent identity and registers it
with the backend. Existing customers can rerun the original installer to register
their installed agent. The customer enables access using the chat switch.

Public tunnel origin on rootcloud: `http://127.0.0.1:4430`; public HTTPS uses 443.
If the tunnel runs inside a container, use a reachable host address instead of its
container loopback. Preserve WebSocket support and do not put an interactive
Cloudflare Access login in front of the Mesh agent endpoints.

## Terminal support

Windows/macOS shares use protocol flags 3 (desktop + Terminal), consent 88 (desktop and
Terminal prompts + desktop privacy bar), and a 60-minute expiry. Existing shares
keep their original permissions: turn support Off and On to create a new link.
In the shared Mesh page, select Terminal in the left menu and Connect. The
customer approves the prompt on their device. No SSH listener or port 22 is needed.
The shell runs with Mesh Agent privileges (the installed macOS daemon runs as
root); this is privileged support access. File transfer remains disabled.

To roll back, revert the app change and restore the API account group rights to
525832 (adds NoTerminal). Revoke active application shares with the support switch;
changing the application alone does not downgrade already-issued links.

Linux shares use protocol 1 and consent 0; On is the customer's explicit grant of
root Terminal access for up to 60 minutes, and Off revokes active connections.
No desktop permission dialog or desktop session is used. Linux x64 was verified
on Debian 13 / Proxmox host `pve`: CLI enrollment and repeated installation,
Mesh Terminal running `id -u`, `uname -s`, `hostname`, and disconnect on share
revocation. No VM configuration or host reboot was performed.
