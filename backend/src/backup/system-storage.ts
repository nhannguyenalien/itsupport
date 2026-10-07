import { randomBytes } from "node:crypto";
import { compareVersions } from "../devices/agent-updates.js";
import { decryptToken, encryptToken } from "../oauth/crypto.js";
import { getStorage, repoJoin } from "../db-backup/storage.js";
import { FILES_PREFIX, credentialsFor, currentMinter, parseS3Base } from "./r2-credentials.js";

/** Oldest agent that accepts temporary credentials (AWS_SESSION_TOKEN). */
export const SYSTEM_STORAGE_MIN_AGENT_VERSION = "0.4.2";

export function agentSupportsSystemStorage(version: string | null): boolean {
  return !!version && /^\d+\.\d+\.\d+$/.test(version) && compareVersions(version, SYSTEM_STORAGE_MIN_AGENT_VERSION) >= 0;
}

export const newRepoPassword = (): string => encryptToken(randomBytes(32).toString("base64url"));

/** Can this deployment give agents storage? Needs the operator's R2 repository
 * (saved on the platform page) AND the Cloudflare settings used to mint scoped keys. */
export async function systemStorageReady(): Promise<boolean> {
  if (!currentMinter()) return false;
  const storage = await getStorage();
  if (!storage) return false;
  try { parseS3Base(storage.base); return true; } catch { return false; }
}

/** Repository + environment for ONE device on the system storage: a prefix of its
 * own, temporary keys that reach nothing else, and the device's own password. */
export async function systemAccess(tenantId: string, deviceId: string, repoPasswordEnc: string): Promise<{ repo: string; env: Record<string, string> }> {
  const storage = await getStorage();
  if (!storage) throw new Error("The system storage is not configured");
  const loc = parseS3Base(storage.base);
  const prefix = [loc.prefix, FILES_PREFIX(tenantId, deviceId)].filter(Boolean).join("/");
  const creds = await credentialsFor({ bucket: loc.bucket, prefix });
  return {
    repo: repoJoin(storage.base, FILES_PREFIX(tenantId, deviceId)),
    env: {
      AWS_ACCESS_KEY_ID: creds.accessKeyId, AWS_SECRET_ACCESS_KEY: creds.secretAccessKey, AWS_SESSION_TOKEN: creds.sessionToken,
      AWS_DEFAULT_REGION: "auto", RESTIC_PASSWORD: decryptToken(repoPasswordEnc),
    },
  };
}
