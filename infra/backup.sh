#!/bin/sh
set -eu
export PGPASSWORD="$(cat /run/secrets/db_password)"
mkdir -p /backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
pg_dump -h db -U support -d support_agent -Fc -f "/backups/support_agent-${stamp}.dump"
find /backups -type f -name 'support_agent-*.dump' -mtime +14 -delete
