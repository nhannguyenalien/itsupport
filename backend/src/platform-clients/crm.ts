import { Client as HubSpotClient } from "@hubspot/api-client";
import { decryptToken } from "../oauth/crypto.js";
import type { PlatformConnectionRow } from "./types.js";

/** Generic CRM interface (docs/v0.2-marketing-ops-spec.md section 7): a
 * platform_connections row with platform='crm_generic' carries a
 * `crm_vendor` marker (see decideVendor below) so this dispatcher knows which
 * concrete adapter to use. Only HubSpot is implemented — it's the reference
 * adapter proving the pattern, not full coverage. Salesforce/Zoho/Pipedrive
 * are the same shape of work, unbuilt, deliberately not stubbed with fake
 * data (an unimplemented adapter throws, it doesn't return {}). */
export interface Lead {
  id: string;
  email: string | null;
  name: string | null;
  source: string | null;
  created_at: string | null;
}

interface CrmAdapter {
  listLeads(connection: PlatformConnectionRow, params: { date_range?: string }): Promise<Lead[]>;
  countLeads(connection: PlatformConnectionRow, params: { date_range?: string }): Promise<number>;
}

/** external_account_id for a crm_generic connection is "<vendor>:<account
 * id>" (e.g. "hubspot:12345678") — the vendor prefix picks the adapter, the
 * suffix is whatever that vendor's own account/portal id is. */
function parseVendor(connection: PlatformConnectionRow): { vendor: string; accountId: string } {
  const [vendor, ...rest] = connection.external_account_id.split(":");
  if (!vendor || rest.length === 0) {
    throw new Error(`crm_generic external_account_id must be "<vendor>:<account id>", got ${JSON.stringify(connection.external_account_id)}`);
  }
  return { vendor, accountId: rest.join(":") };
}

const hubspot: CrmAdapter = {
  // date_range (params) isn't applied yet — getPage has no date filter of its
  // own; that needs the Search API with a createdate filter instead. Known
  // gap, not silently ignored — every caller of ads.leads.list-style tools
  // that passes date_range will get unfiltered results until this is built.
  async listLeads(connection) {
    const accessToken = decryptToken(connection.access_token_ciphertext);
    const client = new HubSpotClient({ accessToken });
    const properties = ["email", "firstname", "lastname", "hs_lead_status", "createdate", "hs_analytics_source"];
    const page = await client.crm.contacts.basicApi.getPage(100, undefined, properties);
    return page.results.map((r) => ({
      id: r.id,
      email: r.properties.email ?? null,
      name: [r.properties.firstname, r.properties.lastname].filter(Boolean).join(" ") || null,
      source: r.properties.hs_analytics_source ?? null,
      created_at: r.properties.createdate ?? null,
    }));
  },
  async countLeads(connection, params) {
    const leads = await hubspot.listLeads(connection, params);
    return leads.length; // page-size-limited (100) until pagination is added — not a true total
  },
};

const ADAPTERS: Record<string, CrmAdapter> = { hubspot };

function getAdapter(vendor: string): CrmAdapter {
  const adapter = ADAPTERS[vendor];
  if (!adapter) {
    throw new Error(`no CRM adapter implemented for vendor ${JSON.stringify(vendor)} — only "hubspot" exists so far (docs/v0.2-marketing-ops-spec.md section 7)`);
  }
  return adapter;
}

export async function listLeads(connection: PlatformConnectionRow, params: { date_range?: string }) {
  const { vendor } = parseVendor(connection);
  return getAdapter(vendor).listLeads(connection, params);
}

export async function countLeads(connection: PlatformConnectionRow, params: { date_range?: string }) {
  const { vendor } = parseVendor(connection);
  return getAdapter(vendor).countLeads(connection, params);
}
