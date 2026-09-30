import type { ToolDefinition } from "../tool-registry/index.js";
import type OpenAI from "openai";

/** registry.json's `params` is just a list of names, no types (see
 * docs/v0.1-spec.md's open TODO on the registry format) — this generates a
 * permissive schema (every param optional, type "string" unless the name
 * suggests otherwise) rather than pretending to know types it doesn't have.
 * Tightening this is a registry.json format change, not something to fake here. */
function paramsToJsonSchema(paramNames: string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const name of paramNames) {
    // A handful of param names are known to be numeric from the tool
    // implementations (agent/internal/tools) — everything else defaults to
    // string, which is safe for the LLM to emit even for something like
    // service_name.
    const isNumeric = name === "pid" || name === "max_events";
    properties[name] = { type: isNumeric ? "number" : "string" };
  }
  return {
    type: "object",
    properties,
    additionalProperties: false,
  };
}

/** OpenAI function names must match ^[a-zA-Z0-9_-]+$ — our tool names use "."
 * as a namespace separator (e.g. "service.status", "google_ads.pmax.assets"),
 * which the real API rejects outright ("does not match pattern") the moment
 * more than one tool is offered. Discovered by testing against the real
 * OpenAI API for the first time (prior testing only ever used a mock or
 * typechecked, never actually round-tripped a tool list through the real
 * endpoint). "-" is never used inside a tool name (confirmed against the full
 * registry) so it's a safe, reversible substitute for "." — toOpenAiToolName/
 * fromOpenAiToolName are exact inverses of each other. */
export function toOpenAiToolName(tool: string): string {
  return tool.replace(/\./g, "-");
}

export function fromOpenAiToolName(openAiName: string): string {
  return openAiName.replace(/-/g, ".");
}

export function toolToOpenAiFunction(tool: ToolDefinition): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: toOpenAiToolName(tool.tool),
      description: `${tool.tool === "package.install" ? "Install one named package and dependencies from configured apt repositories on Debian/Ubuntu/Proxmox. ALWAYS requires explicit human approval, including with autonomy enabled. " : tool.tool === "system.temperature" ? "Read actual Linux hardware sensor temperatures in Celsius, identifying CPU sensors. No package installation required. " : tool.tool === "package.status" ? "Check whether a named Debian/Ubuntu/Proxmox package is installed and its version. " : ""}Risk level: ${tool.risk}. ${
        tool.risk === "read"
          ? "Read-only, executes immediately."
          : "State-changing — will be held for human approval before running unless the tenant has opted into autonomous low-risk remediation."
      }`,
      parameters: paramsToJsonSchema(tool.params),
    },
  };
}

export function allToolsAsOpenAiFunctions(tools: ToolDefinition[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map(toolToOpenAiFunction);
}
