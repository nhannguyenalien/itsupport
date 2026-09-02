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

export function toolToOpenAiFunction(tool: ToolDefinition): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.tool,
      description: `Risk level: ${tool.risk}. ${
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
