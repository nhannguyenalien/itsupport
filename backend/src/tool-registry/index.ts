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
