// Credentials restic may receive (device policies and the platform database
// backup). Kept free of database imports so pure modules and tests can use it.
// Must mirror backupEnvAllowlist in agent/internal/tools/backup.go.
export const BACKUP_ENV_KEYS = [
  "RESTIC_PASSWORD", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_DEFAULT_REGION",
  "B2_ACCOUNT_ID", "B2_ACCOUNT_KEY", "RESTIC_REST_USERNAME", "RESTIC_REST_PASSWORD",
] as const;
