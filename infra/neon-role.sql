\set ON_ERROR_STOP on

SELECT format(
  'CREATE ROLE %I LOGIN NOINHERIT NOBYPASSRLS',
  'support_app'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'support_app')
\gexec

ALTER ROLE support_app LOGIN NOINHERIT NOBYPASSRLS PASSWORD :'app_password';
