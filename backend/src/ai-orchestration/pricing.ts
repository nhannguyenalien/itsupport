/** Rough public list prices (USD per 1M tokens), for cost ESTIMATION only.
 * The metrics endpoint's ai_cost_per_ticket is an ROI/sales indicator, not a
 * billing figure — treat it as "order of magnitude", not an invoice.
 *
 * An unknown model (self-hosted, or newer than this table) falls back to a
 * mid-range guess so the estimate is still non-zero rather than silently
 * hiding real spend. Update as list prices change. */
export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

const PRICES: Record<string, ModelPrice> = {
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
  "gpt-4.1": { inputPer1M: 2, outputPer1M: 8 },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
};

const FALLBACK: ModelPrice = { inputPer1M: 0.5, outputPer1M: 1.5 };

export function priceFor(model: string | null | undefined): ModelPrice {
  return (model && PRICES[model]) || FALLBACK;
}

export function estimateCostUsd(
  model: string | null | undefined,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = priceFor(model);
  return (promptTokens / 1_000_000) * p.inputPer1M + (completionTokens / 1_000_000) * p.outputPer1M;
}
