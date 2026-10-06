#!/bin/sh
# Turns Coolify environment variables into the files and URLs the backend
# expects, then starts it. Secret files live on the container's tmpfs only.
set -eu
umask 077

: "${FIREBASE_ADMIN_JSON_B64:?}" "${AGENT_CA_CERT_B64:?}" "${AGENT_CA_KEY_B64:?}"

mkdir -p /tmp/secrets
printf '%s' "$FIREBASE_ADMIN_JSON_B64" | base64 -d > /tmp/secrets/firebase-admin.json
printf '%s' "$AGENT_CA_CERT_B64" | base64 -d > /tmp/secrets/agent-ca.crt
printf '%s' "$AGENT_CA_KEY_B64" | base64 -d > /tmp/secrets/agent-ca.key

export GOOGLE_APPLICATION_CREDENTIALS=/tmp/secrets/firebase-admin.json
export AGENT_CA_CERT_PATH=/tmp/secrets/agent-ca.crt
export AGENT_CA_KEY_PATH=/tmp/secrets/agent-ca.key
# An external database (e.g. Neon) wins over the bundled `db` service. Both
# URLs are required together: the app role is subject to RLS, the admin one runs
# migrations.
if [ -n "${EXTERNAL_DATABASE_URL:-}" ] || [ -n "${EXTERNAL_DATABASE_ADMIN_URL:-}" ]; then
  : "${EXTERNAL_DATABASE_URL:?set both EXTERNAL_DATABASE_URL and EXTERNAL_DATABASE_ADMIN_URL}"
  : "${EXTERNAL_DATABASE_ADMIN_URL:?set both EXTERNAL_DATABASE_URL and EXTERNAL_DATABASE_ADMIN_URL}"
  export DATABASE_URL="$EXTERNAL_DATABASE_URL"
  export DATABASE_ADMIN_URL="$EXTERNAL_DATABASE_ADMIN_URL"
else
  : "${DB_ADMIN_PASSWORD:?}" "${DB_APP_PASSWORD:?}"
  export DATABASE_URL="postgresql://support_app:${DB_APP_PASSWORD}@db:5432/support_agent"
  export DATABASE_ADMIN_URL="postgresql://support:${DB_ADMIN_PASSWORD}@db:5432/support_agent"
fi

exec node dist/index.js
