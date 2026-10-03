import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type ToolRisk = "read" | "low" | "medium" | "high";

export interface ToolDefinition {
  tool: string;
  risk: ToolRisk;
  params: string[];
  verification: string[];
  // v0.2 marketing-ops fields — absent (undefined) on v0.1 Windows tools.
  // "windows_desktop" (computer-use addendum, docs/v0.1-computer-use-addendum.md)
  // is deliberately its own domain, not "windows" — these tools are exposed to
  // OpenAI's Responses API `computer_use_preview` tool, not as Chat Completions
  // functions, so ai-orchestration/index.ts must exclude them from the normal
  // function-calling tool list (see the device-ticket filter there).
  domain?: "linux" | "windows" | "windows_desktop" | "marketing" | "agent";
  // Which platform_connections.platform this tool needs, "any" for
  // cross-platform tools (ads.*, marketing.* KPIs), absent for tools that
  // don't touch a stored platform connection at all (web.*, report.*, alert.*).
  platform?: "google_ads" | "meta_ads" | "ga4" | "gtm" | "crm_generic" | "any";
}

interface RegistryFile {
  version: number;
  tools: ToolDefinition[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, "registry.json");

const raw = readFileSync(REGISTRY_PATH, "utf-8");
const parsed: RegistryFile = JSON.parse(raw);

export const registryHash = createHash("sha256").update(raw).digest("hex");
export const registryVersion = parsed.version;

const byName = new Map<string, ToolDefinition>(parsed.tools.map((t) => [t.tool, t]));

/** The single source of truth for "does this tool exist and what does it need."
 * Both the policy engine and the tool-call endpoint must go through this —
 * never trust a tool name coming from the AI or the request body directly. */
export function getTool(name: string): ToolDefinition | undefined {
  return byName.get(name);
}

export function allTools(): ToolDefinition[] {
  return parsed.tools;
}

export function isKnownTool(name: string): boolean {
  return byName.has(name);
}
