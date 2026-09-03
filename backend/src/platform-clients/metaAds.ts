import { FacebookAdsApi, AdAccount, AdSet } from "facebook-nodejs-business-sdk";
import { decryptToken } from "../oauth/crypto.js";
import type { PlatformConnectionRow } from "./types.js";

/** facebook-nodejs-business-sdk IS Meta's official Node SDK (unlike Google
 * Ads, which has none) — but it ships no TypeScript types, hence the ambient
 * shim in facebook-business-sdk.d.ts covering only the methods used here. */
function initApi(connection: PlatformConnectionRow): void {
  const accessToken = decryptToken(connection.access_token_ciphertext);
  FacebookAdsApi.init(accessToken);
}

function accountId(connection: PlatformConnectionRow): string {
  return connection.external_account_id.startsWith("act_") ? connection.external_account_id : `act_${connection.external_account_id}`;
}

export async function listCampaigns(connection: PlatformConnectionRow) {
  initApi(connection);
  const account = new AdAccount(accountId(connection));
  const campaigns = await account.getCampaigns(["id", "name", "status", "daily_budget", "objective"]);
  return campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    daily_budget: c.daily_budget,
    objective: c.objective,
  }));
}

export async function frequency(connection: PlatformConnectionRow, params: { adset_id: string; date_range?: string }) {
  initApi(connection);
  const adset = new AdSet(params.adset_id);
  const datePreset = dateRangeToPreset(params.date_range);
  const insights = await adset.getInsights(["reach", "impressions", "frequency", "ctr", "cpm", "cpc"], { date_preset: datePreset });
  return insights.map((i) => ({
    reach: i.reach,
    impressions: i.impressions,
    frequency: i.frequency,
    ctr: i.ctr,
    cpm: i.cpm,
    cpc: i.cpc,
  }));
}

export async function breakdowns(connection: PlatformConnectionRow, params: { scope_id: string; dimension: string; date_range?: string }) {
  initApi(connection);
  const adset = new AdSet(params.scope_id);
  const datePreset = dateRangeToPreset(params.date_range);
  const insights = await adset.getInsights(
    ["impressions", "clicks", "spend", "reach"],
    { date_preset: datePreset, breakdowns: [params.dimension] },
  );
  return insights;
}

/** Meta's Insights API takes named presets (last_7d, last_30d, ...), not
 * free-text ranges like the Google Ads client's GAQL DURING clause — this is
 * a deliberately small, explicit mapping rather than passing the caller's
 * string straight through to an API param it was never validated against. */
function dateRangeToPreset(range: string | undefined): string {
  switch (range) {
    case "LAST_7_DAYS":
    case undefined:
      return "last_7d";
    case "LAST_14_DAYS":
      return "last_14d";
    case "LAST_30_DAYS":
      return "last_30d";
    case "LAST_90_DAYS":
      return "last_90d";
    case "TODAY":
      return "today";
    case "YESTERDAY":
      return "yesterday";
    default:
      throw new Error(`unsupported date_range ${JSON.stringify(range)} — expected one of LAST_7_DAYS/LAST_14_DAYS/LAST_30_DAYS/LAST_90_DAYS/TODAY/YESTERDAY`);
  }
}
