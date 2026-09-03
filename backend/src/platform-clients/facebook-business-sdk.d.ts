// facebook-nodejs-business-sdk ships no TypeScript definitions (plain JS,
// Flow-annotated source only) — this is a minimal ambient shim covering only
// what metaAds.ts actually calls, not a full API surface. Real methods,
// verified against node_modules/facebook-nodejs-business-sdk/src/objects/*.js
// (getCampaigns/getInsights signatures), not guessed.
declare module "facebook-nodejs-business-sdk" {
  export class FacebookAdsApi {
    static init(accessToken: string): FacebookAdsApi;
  }
  export class AdAccount {
    constructor(id: string);
    getCampaigns(fields: string[], params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  }
  export class AdSet {
    constructor(id: string);
    getInsights(fields: string[], params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  }
}
