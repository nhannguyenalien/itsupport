#!/bin/sh
set -eu

app_password="$(cat /run/secrets/db_app_password)"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$app_password" <<'SQL'
DO $block$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'support_app') THEN
    CREATE ROLE support_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$block$;
SELECT format('ALTER ROLE support_app PASSWORD %L', :'app_password') \gexec
GRANT CONNECT ON DATABASE support_agent TO support_app;
GRANT USAGE ON SCHEMA public TO support_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO support_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO support_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO support_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO support_app;
SQL
