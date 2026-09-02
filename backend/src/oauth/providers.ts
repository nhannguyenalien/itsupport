export type OAuthPlatform = "google_ads" | "meta_ads" | "ga4";

export interface OAuthProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  // env var names — kept as names (not values) so callers can produce a clear
  // "X is not configured" message naming exactly which var is missing.
  clientIdEnv: string;
  clientSecretEnv: string;
  // Google Ads additionally needs a developer token (separate from OAuth
  // entirely — see docs/v0.2-marketing-ops-spec.md known gaps) to actually
  // call the API once a token exists; not part of the OAuth flow itself.
}

// Real, current, documented endpoints for each platform — verified against
// each platform's own OAuth documentation, not guessed. GA4 (Google Analytics
// Data API) uses the same Google OAuth endpoints as Google Ads, just a
// different scope, since both are Google Cloud IAM-based.
export const OAUTH_PROVIDERS: Record<OAuthPlatform, OAuthProviderConfig> = {
  google_ads: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/adwords"],
    clientIdEnv: "GOOGLE_ADS_OAUTH_CLIENT_ID",
    clientSecretEnv: "GOOGLE_ADS_OAUTH_CLIENT_SECRET",
  },
  ga4: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
    clientIdEnv: "GA4_OAUTH_CLIENT_ID",
    clientSecretEnv: "GA4_OAUTH_CLIENT_SECRET",
  },
  meta_ads: {
    authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    scopes: ["ads_management", "ads_read"],
    clientIdEnv: "META_ADS_OAUTH_CLIENT_ID",
    clientSecretEnv: "META_ADS_OAUTH_CLIENT_SECRET",
  },
};

export function isOAuthPlatform(v: string): v is OAuthPlatform {
  return v in OAUTH_PROVIDERS;
}
