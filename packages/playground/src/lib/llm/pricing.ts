/**
 * Per-million-token USD pricing for Gemini models. Mirrors
 * `examples/admin-compat-browser/src/gemini.ts` PRICING table —
 * keep these in sync when Google revises pricing. There's no API
 * for it.
 *
 * `cacheRead` is the discounted rate Google bills for input tokens
 * served from the explicit prompt cache (~25% of `input`). When
 * `usageMetadata.cachedContentTokenCount` is non-zero we bill the
 * cached portion at the discount and the remainder at `input`.
 *
 * OpenRouter also returns `usage.cost` directly on completed
 * responses when we ask for it via `usage.include`; that exact
 * provider cost still beats estimates. For pre-send context estimates,
 * the playground can pass pricing loaded from OpenRouter's models API.
 */
export interface Pricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M input tokens served from the prompt cache. */
  cacheRead: number;
}

const PRICING: Record<string, Pricing> = {
  'gemini-3.5-flash': { input: 1.5, output: 9.0, cacheRead: 0.15 },
  'gemini-3.1-pro-preview': { input: 2.5, output: 20.0, cacheRead: 0.625 },
  'gemini-3-flash-preview': { input: 0.5, output: 4.0, cacheRead: 0.125 },
  'gemini-3.1-flash-lite': { input: 0.15, output: 0.6, cacheRead: 0.0375 },
};

export interface CostInputs {
  promptTokens: number;
  outputTokens: number;
  /** Subset of `promptTokens` that were served from cache. Defaults
   *  to 0 when the provider doesn't report it. */
  cachedTokens?: number;
}

export interface PromptInputCostEstimate {
  costUsd: number;
  estimated: boolean;
  source: 'gemini-pricing-table' | 'openrouter-models-api';
  inputPricePerMillion: number;
  cacheReadPricePerMillion: number;
}

export interface PromptInputPricing {
  source: PromptInputCostEstimate['source'];
  inputPricePerMillion: number;
  cacheReadPricePerMillion?: number;
}

export function estimatePromptInputCostUsd(
  providerId: string,
  model: string,
  promptTokens: number,
  cachedTokens = 0,
  pricing?: PromptInputPricing | null,
): PromptInputCostEstimate | null {
  const p = pricing
    ? {
        input: pricing.inputPricePerMillion,
        cacheRead: pricing.cacheReadPricePerMillion ?? pricing.inputPricePerMillion,
        source: pricing.source,
      }
    : providerId === 'gemini' && PRICING[model]
      ? {
          input: PRICING[model]!.input,
          cacheRead: PRICING[model]!.cacheRead,
          source: 'gemini-pricing-table' as const,
        }
      : null;
  if (!p) return null;
  const cached = Math.max(0, Math.min(promptTokens, cachedTokens));
  const billedInput = Math.max(0, promptTokens - cached);
  return {
    costUsd: (billedInput * p.input + cached * p.cacheRead) / 1_000_000,
    estimated: true,
    source: p.source,
    inputPricePerMillion: p.input,
    cacheReadPricePerMillion: p.cacheRead,
  };
}

/**
 * Compute estimated cost in USD for a Gemini call. Returns `null`
 * for unknown model slugs; the caller decides whether to render no
 * cost or fall back to a generic "—". Caller is responsible for
 * marking results estimated (`≈`) in the UI.
 */
export function estimateGeminiCostUsd(
  model: string,
  { promptTokens, outputTokens, cachedTokens = 0 }: CostInputs,
): number | null {
  const p = PRICING[model];
  if (!p) return null;
  const billedInput = Math.max(0, promptTokens - cachedTokens);
  const cached = cachedTokens;
  const out = outputTokens;
  return (billedInput * p.input + cached * p.cacheRead + out * p.output) / 1_000_000;
}

export function formatCostUsd(cost: number): string {
  if (cost === 0) return '$0';
  if (cost < 0.0001) return '<$0.0001';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}
