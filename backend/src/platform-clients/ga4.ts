import { BetaAnalyticsDataClient } from "@google-analytics/data";
import { decryptToken } from "../oauth/crypto.js";
import type { PlatformConnectionRow } from "./types.js";

/** Official Google Cloud client (@google-analytics/data). Auth via the
 * "authorized_user" credential JSON shape (client_id/client_secret/
 * refresh_token) — the same format `gcloud auth application-default login`
 * produces, passed as plain data rather than a pre-built auth client class
 * instance. Deliberate: this package pulls in its OWN nested copy of
 * google-auth-library (via google-gax) at a different version than this
 * project's top-level one, so a UserRefreshClient/OAuth2Client built from the
 * top-level import is a structurally different (incompatible) type — passing
 * plain JSON sidesteps that entirely instead of importing from the nested
 * copy's path. */
function getClient(connection: PlatformConnectionRow): BetaAnalyticsDataClient {
  const client_id = process.env.GA4_OAUTH_CLIENT_ID;
  const client_secret = process.env.GA4_OAUTH_CLIENT_SECRET;
  if (!client_id || !client_secret) {
    throw new Error("GA4_OAUTH_CLIENT_ID/GA4_OAUTH_CLIENT_SECRET not configured");
  }
  if (!connection.refresh_token_ciphertext) {
    throw new Error("no refresh token stored for this connection — reconnect required");
  }
  const refresh_token = decryptToken(connection.refresh_token_ciphertext);

  return new BetaAnalyticsDataClient({
    credentials: { type: "authorized_user", client_id, client_secret, refresh_token },
  });
}

function propertyPath(connection: PlatformConnectionRow): string {
  const id = connection.external_account_id.replace(/^properties\//, "");
  return `properties/${id}`;
}

export async function sessions(connection: PlatformConnectionRow, params: { date_range?: string }) {
  const client = getClient(connection);
  const [response] = await client.runReport({
    property: propertyPath(connection),
    dateRanges: [dateRange(params.date_range)],
    metrics: [{ name: "sessions" }, { name: "activeUsers" }],
    dimensions: [{ name: "date" }],
  });
  return rowsToObjects(response);
}

export async function sourceMedium(connection: PlatformConnectionRow, params: { date_range?: string }) {
  const client = getClient(connection);
  const [response] = await client.runReport({
    property: propertyPath(connection),
    dateRanges: [dateRange(params.date_range)],
    metrics: [{ name: "sessions" }, { name: "conversions" }],
    dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }],
  });
  return rowsToObjects(response);
}

export async function conversions(connection: PlatformConnectionRow, params: { date_range?: string }) {
  const client = getClient(connection);
  const [response] = await client.runReport({
    property: propertyPath(connection),
    dateRanges: [dateRange(params.date_range)],
    metrics: [{ name: "conversions" }, { name: "totalRevenue" }],
    dimensions: [{ name: "date" }],
  });
  return rowsToObjects(response);
}

/** GA4's date range object wants explicit start/end dates or the small set of
 * relative keywords it documents (today, yesterday, NdaysAgo) — same
 * reasoning as metaAds.ts's dateRangeToPreset: an explicit mapping, not the
 * caller's string passed through unchecked. */
function dateRange(range: string | undefined): { startDate: string; endDate: string } {
  switch (range) {
    case "LAST_7_DAYS":
    case undefined:
      return { startDate: "7daysAgo", endDate: "today" };
    case "LAST_14_DAYS":
      return { startDate: "14daysAgo", endDate: "today" };
    case "LAST_30_DAYS":
      return { startDate: "30daysAgo", endDate: "today" };
    case "LAST_90_DAYS":
      return { startDate: "90daysAgo", endDate: "today" };
    case "TODAY":
      return { startDate: "today", endDate: "today" };
    case "YESTERDAY":
      return { startDate: "yesterday", endDate: "yesterday" };
    default:
      throw new Error(`unsupported date_range ${JSON.stringify(range)} — expected one of LAST_7_DAYS/LAST_14_DAYS/LAST_30_DAYS/LAST_90_DAYS/TODAY/YESTERDAY`);
  }
}

function rowsToObjects(response: { dimensionHeaders?: Array<{ name?: string | null }> | null; metricHeaders?: Array<{ name?: string | null }> | null; rows?: Array<{ dimensionValues?: Array<{ value?: string | null }> | null; metricValues?: Array<{ value?: string | null }> | null }> | null }) {
  const dimNames = (response.dimensionHeaders ?? []).map((h) => h.name ?? "");
  const metricNames = (response.metricHeaders ?? []).map((h) => h.name ?? "");
  return (response.rows ?? []).map((row) => {
    const out: Record<string, string> = {};
    (row.dimensionValues ?? []).forEach((v, i) => { out[dimNames[i]] = v.value ?? ""; });
    (row.metricValues ?? []).forEach((v, i) => { out[metricNames[i]] = v.value ?? ""; });
    return out;
  });
}
