import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Signed, expiring OAuth `state` parameter — mandatory CSRF protection for the
// authorization-code flow (without it, an attacker could trick a tenant admin
// into approving a token that gets attached to the ATTACKER's tenant/account).
// Deliberately a separate secret from OAUTH_TOKEN_ENC_KEY (crypto.ts) — one
// key per purpose, so rotating one doesn't force rotating the other.
const TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  tenantId: string;
  platform: string;
  externalAccountId: string;
  nonce: string;
  exp: number;
}

function getSecret(): string {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) {
    throw new Error(
      "OAUTH_STATE_SECRET is not set — cannot start an OAuth connect flow without it. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  return secret;
}

function sign(data: string): string {
  return createHmac("sha256", getSecret()).update(data).digest("base64url");
}

export function createState(tenantId: string, platform: string, externalAccountId: string): string {
  const payload: StatePayload = { tenantId, platform, externalAccountId, nonce: randomBytes(8).toString("hex"), exp: Date.now() + TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Returns the payload if the state is validly signed, unexpired, AND matches
 * the platform the callback route is being hit on — null otherwise. Callers
 * must treat null as "reject the callback," never as "proceed with unknown
 * tenant." */
export function verifyState(state: string, expectedPlatform: string): StatePayload | null {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;

  const expectedSig = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.exp < Date.now()) return null;
  if (payload.platform !== expectedPlatform) return null;
  return payload;
}
