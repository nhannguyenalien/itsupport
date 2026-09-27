import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, setTenantContext } from "../db/pool.js";
import { recordAudit } from "../audit/index.js";
import { OAUTH_PROVIDERS, isOAuthPlatform } from "./providers.js";
import { createState, verifyState } from "./state.js";
import { encryptToken } from "./crypto.js";

const platformParams = z.object({ platform: z.string() });
const connectQuery = z.object({
  tenantId: z.string().uuid(),
  // Which ad/analytics account to attach this token to. Real integrations
  // usually let the user pick from a live "list my accounts" call after
  // authorizing — that needs a working platform API client, which doesn't
  // exist yet (see docs/v0.2-marketing-ops-spec.md known gaps), so v0.2 asks
  // for it up front instead of pretending account discovery works.
  externalAccountId: z.string().min(1),
});
const callbackQuery = z.object({
  code: z.string().optional(),
  state: z.string(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

function redirectUri(platform: string): string {
  const base = process.env.OAUTH_REDIRECT_BASE_URL;
  if (!base) {
    throw new Error("OAUTH_REDIRECT_BASE_URL is not set — cannot build an OAuth redirect_uri without it");
  }
  return `${base.replace(/\/$/, "")}/oauth/${platform}/callback`;
}

export async function oauthRoutes(app: FastifyInstance) {
  // Step 1: tenant admin clicks "Connect Google Ads" (etc.) in the dashboard,
  // which links here. This redirects their OWN browser to the platform's real
  // login/consent page — we never see their platform password, only the
  // authorization code the platform hands back afterward.
  app.get("/oauth/:platform/connect", async (req, reply) => {
    const { platform } = platformParams.parse(req.params);
    if (!isOAuthPlatform(platform)) {
      return reply.code(404).send({ error: `unknown OAuth platform "${platform}"` });
    }
    const { tenantId, externalAccountId } = connectQuery.parse(req.query);
    const provider = OAUTH_PROVIDERS[platform];

    const clientId = process.env[provider.clientIdEnv];
    if (!clientId) {
      return reply.code(500).send({
        error: `${provider.clientIdEnv} is not set — this backend has no registered OAuth app for ${platform} yet`,
      });
    }

    let state: string;
    let uri: string;
    try {
      state = createState(tenantId, platform, externalAccountId);
      uri = redirectUri(platform);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: uri,
      response_type: "code",
      scope: provider.scopes.join(" "),
      state,
    });
    // Google-specific: without these, Google only returns a refresh_token on
    // the FIRST-ever consent for that user+app, which breaks reconnect flows.
    if (platform === "google_ads" || platform === "ga4") {
      params.set("access_type", "offline");
      params.set("prompt", "consent");
    }

    reply.redirect(`${provider.authorizeUrl}?${params.toString()}`);
  });

  // Step 2: the platform redirects the admin's browser back here with a code
  // (or an error). Exchanges the code for tokens server-side and stores them
  // encrypted — the AI/tools never see raw tokens, only this layer does.
  app.get("/oauth/:platform/callback", async (req, reply) => {
    const { platform } = platformParams.parse(req.params);
    if (!isOAuthPlatform(platform)) {
      return reply.code(404).send({ error: `unknown OAuth platform "${platform}"` });
    }
    const q = callbackQuery.parse(req.query);
    if (q.error) {
      return reply.code(400).send({ error: `${platform} denied the connection: ${q.error_description ?? q.error}` });
    }
    if (!q.code) {
      return reply.code(400).send({ error: "missing authorization code" });
    }

    const statePayload = verifyState(q.state, platform);
    if (!statePayload) {
      return reply.code(400).send({ error: "invalid, expired, or mismatched OAuth state — possible CSRF, connection rejected" });
    }
    setTenantContext(statePayload.tenantId);

    const provider = OAUTH_PROVIDERS[platform];
    const clientId = process.env[provider.clientIdEnv];
    const clientSecret = process.env[provider.clientSecretEnv];
    if (!clientId || !clientSecret) {
      return reply.code(500).send({
        error: `${provider.clientIdEnv}/${provider.clientSecretEnv} not fully configured — cannot exchange the code`,
      });
    }

    let tokenRes: Response;
    try {
      tokenRes = await fetch(provider.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code: q.code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri(platform),
        }),
      });
    } catch (err) {
      return reply.code(502).send({ error: `token exchange request failed: ${err instanceof Error ? err.message : String(err)}` });
    }

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      return reply.code(502).send({ error: `${platform} rejected the token exchange (HTTP ${tokenRes.status}): ${body}` });
    }
    const tokens = (await tokenRes.json()) as TokenResponse;
    if (!tokens.access_token) {
      return reply.code(502).send({ error: `${platform} token response had no access_token — got: ${JSON.stringify(tokens)}` });
    }

    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
    const accessCiphertext = encryptToken(tokens.access_token);
    const refreshCiphertext = tokens.refresh_token ? encryptToken(tokens.refresh_token) : null;

    const row = await pool.query(
      `INSERT INTO platform_connections
         (tenant_id, platform, external_account_id, access_token_ciphertext, refresh_token_ciphertext, token_expires_at, scopes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
       ON CONFLICT (tenant_id, platform, external_account_id) DO UPDATE SET
         access_token_ciphertext = EXCLUDED.access_token_ciphertext,
         refresh_token_ciphertext = COALESCE(EXCLUDED.refresh_token_ciphertext, platform_connections.refresh_token_ciphertext),
         token_expires_at = EXCLUDED.token_expires_at,
         scopes = EXCLUDED.scopes,
         status = 'active',
         last_error = NULL
       RETURNING id`,
      [
        statePayload.tenantId,
        platform,
        statePayload.externalAccountId,
        accessCiphertext,
        refreshCiphertext,
        expiresAt,
        provider.scopes,
      ],
    );

    await recordAudit({
      tenantId: statePayload.tenantId,
      actorType: "user",
      eventType: "platform_connection.connected",
      eventData: { platform, externalAccountId: statePayload.externalAccountId },
    });

    reply.send({ ok: true, platformConnectionId: row.rows[0].id, platform, externalAccountId: statePayload.externalAccountId });
  });
}
