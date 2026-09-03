import { GoogleAdsApi, enums, type Customer } from "google-ads-api";
import { decryptToken } from "../oauth/crypto.js";
import type { PlatformConnectionRow } from "./types.js";

/** No official Google Node SDK exists for the Ads API (Google ships official
 * clients for Java/C#/PHP/Python/Ruby only) — this uses `google-ads-api`, the
 * de facto standard community client (Opteo, actively maintained, wraps
 * Google's real gRPC/REST service definitions rather than hand-rolling
 * requests). Flagged, not passed off as Google-official. */
function getApi(): GoogleAdsApi {
  const client_id = process.env.GOOGLE_ADS_OAUTH_CLIENT_ID;
  const client_secret = process.env.GOOGLE_ADS_OAUTH_CLIENT_SECRET;
  const developer_token = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!client_id || !client_secret) {
    throw new Error("GOOGLE_ADS_OAUTH_CLIENT_ID/GOOGLE_ADS_OAUTH_CLIENT_SECRET not configured");
  }
  if (!developer_token) {
    throw new Error(
      "GOOGLE_ADS_DEVELOPER_TOKEN not configured — separate from the OAuth app, requires applying to Google " +
        "and can take days to be approved (see docs/v0.2-marketing-ops-spec.md known gaps)",
    );
  }
  return new GoogleAdsApi({ client_id, client_secret, developer_token });
}

function getCustomer(connection: PlatformConnectionRow): Customer {
  const refreshTokenCiphertext = connection.refresh_token_ciphertext;
  if (!refreshTokenCiphertext) {
    throw new Error("no refresh token stored for this connection — the OAuth consent needs to be redone (reconnect)");
  }
  const refresh_token = decryptToken(refreshTokenCiphertext);
  // Google Ads customer IDs are conventionally displayed as 123-456-7890 but
  // the API wants them digits-only.
  const customer_id = connection.external_account_id.replace(/[^0-9]/g, "");
  return getApi().Customer({ customer_id, refresh_token });
}

/** Only digits allowed before string-interpolating into a GAQL WHERE clause —
 * GAQL has no parameterized-query support in this client, so this is the
 * injection guard. Every function below that takes an id-like param runs it
 * through this rather than trusting the caller (which may ultimately be the
 * AI) to have already sanitized it. */
function assertNumericId(value: string, label: string): string {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${label} must be numeric, got ${JSON.stringify(value)}`);
  return value;
}

export async function listAccounts(connection: PlatformConnectionRow) {
  if (!connection.refresh_token_ciphertext) throw new Error("no refresh token stored for this connection");
  const refresh_token = decryptToken(connection.refresh_token_ciphertext);
  const res = await getApi().listAccessibleCustomers(refresh_token);
  return { resource_names: res.resource_names };
}

export async function listCampaigns(connection: PlatformConnectionRow) {
  const customer = getCustomer(connection);
  const rows = await customer.query(`
    SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.status != 'REMOVED'
    ORDER BY campaign.id
  `);
  return rows.map((r) => ({
    id: r.campaign?.id,
    name: r.campaign?.name,
    status: r.campaign?.status,
    budget_micros: r.campaign_budget?.amount_micros,
  }));
}

export async function readMetrics(connection: PlatformConnectionRow, params: { scope_id?: string; date_range?: string }) {
  const customer = getCustomer(connection);
  const dateRange = params.date_range ?? "LAST_7_DAYS";
  const scopeClause = params.scope_id ? `AND campaign.id = ${assertNumericId(params.scope_id, "scope_id")}` : "";
  const rows = await customer.query(`
    SELECT campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM campaign
    WHERE segments.date DURING ${dateRange}
    ${scopeClause}
  `);
  return rows.map((r) => ({
    campaign_id: r.campaign?.id,
    campaign_name: r.campaign?.name,
    impressions: r.metrics?.impressions,
    clicks: r.metrics?.clicks,
    cost_micros: r.metrics?.cost_micros,
    conversions: r.metrics?.conversions,
  }));
}

export async function searchTerms(connection: PlatformConnectionRow, params: { campaign_id: string; date_range?: string }) {
  const customer = getCustomer(connection);
  const campaignId = assertNumericId(params.campaign_id, "campaign_id");
  const dateRange = params.date_range ?? "LAST_7_DAYS";
  const rows = await customer.query(`
    SELECT search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM search_term_view
    WHERE campaign.id = ${campaignId} AND segments.date DURING ${dateRange}
    ORDER BY metrics.impressions DESC
    LIMIT 100
  `);
  return rows.map((r) => ({
    search_term: r.search_term_view?.search_term,
    impressions: r.metrics?.impressions,
    clicks: r.metrics?.clicks,
    cost_micros: r.metrics?.cost_micros,
    conversions: r.metrics?.conversions,
  }));
}

async function setCampaignStatus(connection: PlatformConnectionRow, campaignIdRaw: string, status: (typeof enums.CampaignStatus)["ENABLED"] | (typeof enums.CampaignStatus)["PAUSED"]) {
  const customer = getCustomer(connection);
  const campaignId = assertNumericId(campaignIdRaw, "campaign_id");
  const customerId = connection.external_account_id.replace(/[^0-9]/g, "");
  await customer.campaigns.update([{ resource_name: `customers/${customerId}/campaigns/${campaignId}`, status }]);
  return { campaign_id: campaignId, status: enums.CampaignStatus[status] };
}

export const pauseCampaign = (connection: PlatformConnectionRow, params: { campaign_id: string }) =>
  setCampaignStatus(connection, params.campaign_id, enums.CampaignStatus.PAUSED);

export const enableCampaign = (connection: PlatformConnectionRow, params: { campaign_id: string }) =>
  setCampaignStatus(connection, params.campaign_id, enums.CampaignStatus.ENABLED);
