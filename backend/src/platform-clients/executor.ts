import { pool } from "../db/pool.js";
import { recordToolCallResult } from "../tool-calls/execution.js";
import { loadConnection, type PlatformConnectionRow } from "./types.js";
import * as googleAds from "./googleAds.js";
import * as metaAds from "./metaAds.js";
import * as ga4 from "./ga4.js";
import * as crm from "./crm.js";

type ToolFn = (connection: PlatformConnectionRow, params: Record<string, unknown>) => Promise<unknown>;

/** Real implementations only — everything NOT listed here throws "not
 * implemented yet" (see the catch-all in execute() below), same honesty
 * contract as agent/internal/tools/registry_windows.go's notImplemented()
 * stubs for the Windows side. This is a representative slice across all four
 * platform types (Google Ads, Meta, GA4, a CRM adapter), not full coverage of
 * the 109-tool registry — proving the architecture works end to end, not
 * pretending every tool has a real backend yet. */
const DISPATCH: Record<string, ToolFn> = {
  "ads.accounts.list": async (c) => {
    if (c.platform === "google_ads") return googleAds.listAccounts(c);
    throw new Error(`ads.accounts.list not implemented for platform ${c.platform}`);
  },
  "ads.campaigns.list": async (c) => {
    if (c.platform === "google_ads") return googleAds.listCampaigns(c);
    if (c.platform === "meta_ads") return metaAds.listCampaigns(c);
    throw new Error(`ads.campaigns.list not implemented for platform ${c.platform}`);
  },
  "ads.metrics.read": async (c, p) => {
    if (c.platform === "google_ads") return googleAds.readMetrics(c, p as { scope_id?: string; date_range?: string });
    throw new Error(`ads.metrics.read not implemented for platform ${c.platform}`);
  },
  "ads.campaign.pause": async (c, p) => {
    if (c.platform === "google_ads") return googleAds.pauseCampaign(c, p as { campaign_id: string });
    throw new Error(`ads.campaign.pause not implemented for platform ${c.platform}`);
  },
  "ads.campaign.enable": async (c, p) => {
    if (c.platform === "google_ads") return googleAds.enableCampaign(c, p as { campaign_id: string });
    throw new Error(`ads.campaign.enable not implemented for platform ${c.platform}`);
  },
  "google_ads.search_terms": (c, p) => googleAds.searchTerms(c, p as { campaign_id: string; date_range?: string }),
  "meta_ads.frequency": (c, p) => metaAds.frequency(c, p as { adset_id: string; date_range?: string }),
  "meta_ads.breakdowns": (c, p) => metaAds.breakdowns(c, p as { scope_id: string; dimension: string; date_range?: string }),
  "analytics.sessions": (c, p) => ga4.sessions(c, p as { date_range?: string }),
  "analytics.source_medium": (c, p) => ga4.sourceMedium(c, p as { date_range?: string }),
  "analytics.conversions": (c, p) => ga4.conversions(c, p as { date_range?: string }),
  "crm.leads.list": (c, p) => crm.listLeads(c, p as { date_range?: string }),
  "crm.leads.count": async (c, p) => ({ count: await crm.countLeads(c, p as { date_range?: string }) }),
};

/** Executes a marketing tool call synchronously and records the result via
 * the same recordToolCallResult() the Windows agent's result-reporting
 * endpoint uses — see tool-calls/execution.ts. Called right after a marketing
 * tool_call is created with outcome auto_execute (tool-calls/service.ts);
 * there's no separate device to poll for these, the backend has direct API
 * access via the tenant's stored token.
 *
 * Deliberately swallows execution errors into a recorded 'error' result
 * rather than throwing back to the HTTP caller — the tool_call row IS the
 * result, same as a Windows tool failing on-device. The caller (service.ts)
 * already returned outcome:"auto_execute" to its own caller before this
 * runs; that response describes the ADMISSION decision (was this allowed to
 * run), not the execution outcome, which lands on the tool_calls row.
 */
export async function executeMarketingTool(toolCallId: string, tool: string, params: Record<string, unknown>, platformConnectionId: string, tenantId: string): Promise<void> {
  const fn = DISPATCH[tool];
  if (!fn) {
    await recordToolCallResult(toolCallId, { result: "error", errorMessage: `${tool} has no real platform-client implementation yet` }, tenantId, "system");
    return;
  }
  try {
    const connection = await loadConnection(pool, platformConnectionId);
    const data = await fn(connection, params);
    await recordToolCallResult(toolCallId, { result: "success", resultData: data }, tenantId, "system");
  } catch (err) {
    await recordToolCallResult(toolCallId, { result: "error", errorMessage: err instanceof Error ? err.message : String(err) }, tenantId, "system");
  }
}
