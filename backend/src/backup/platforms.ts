// Which device platforms can run the backup tools. Kept in its own module so
// health.ts and index.ts can both use it without importing each other.
export const BACKUP_PLATFORMS = ["windows", "linux", "mac"] as const;
export function platformSupportsBackup(platform: string): boolean {
  return (BACKUP_PLATFORMS as readonly string[]).includes(platform);
}
