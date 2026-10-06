#!/bin/sh
# Nightly dump of the database the application really uses, kept 14 days.
#   - EXTERNAL_DATABASE_ADMIN_URL set (e.g. Neon): dump that database
#   - otherwise: dump the bundled `db` service (PGPASSWORD from env)
# pg_dump from the (newer) client image works against older servers.
set -eu
mkdir -p /backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="/backups/support_agent-${stamp}.dump"
trap 'rm -f "$out.partial"' EXIT
if [ -n "${EXTERNAL_DATABASE_ADMIN_URL:-}" ]; then
  pg_dump "$EXTERNAL_DATABASE_ADMIN_URL" -Fc -f "$out.partial"
else
  pg_dump -h db -U support -d support_agent -Fc -f "$out.partial"
fi
# Never keep a dump that cannot even be listed (truncated or empty).
pg_restore -l "$out.partial" >/dev/null
mv "$out.partial" "$out"
find /backups -type f -name 'support_agent-*.dump' -mtime +14 -delete
echo "backup ok: $out ($(wc -c < "$out") bytes)"
