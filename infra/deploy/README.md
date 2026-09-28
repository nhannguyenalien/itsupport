# macmini automatic deployment

Production lives at `mac@macmini:/home/mac/apps/itsupport`, behind the Cloudflare Tunnel on localhost:18080. The user systemd timer checks GitHub main every two minutes and deploys only after the commit's CI workflow succeeds. User lingering is enabled so it runs without an SSH session.

The installed runner is `/home/mac/.local/bin/itsupport-auto-deploy`; unit files live under `~/.config/systemd/user/`. Changes to these deployment scripts require reinstalling them on the host. Runtime secrets remain in ignored `infra/.env` and `infra/secrets/`.

Builds finish before replacing frontend/backend containers. Health checks include the database-backed API health route and login page. On failure the runner restores the previous Git revision and frontend/backend images. This does not undo database migrations; review migration compatibility before pushing main. Compose configuration changes involving other services require a separate deployment.

Inspect: `systemctl --user status itsupport-deploy.timer` and `journalctl --user -u itsupport-deploy.service -n 100`.
Pause: `systemctl --user stop itsupport-deploy.timer`.
Run now: `systemctl --user start itsupport-deploy.service`.

The initial pre-Git source/config backup is stored with mode 600 under `/home/mac/deploy-backups/`. It includes secrets and must remain private. Docker volumes are not included in that source backup.
