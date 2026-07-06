export interface OpenRouterModelMeta {
  id: string;
  label: string;
  contextWindowTokens?: number;
  promptPricePerMillion?: number;
  cacheReadPricePerMillion?: number;
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModelRecord[];
}

interface OpenRouterModelRecord {
  id?: string;
  name?: string;
  context_length?: number | null;
  top_provider?: {
    context_length?: number | null;
  } | null;
  pricing?: {
    prompt?: string | number | null;
    input_cache_read?: string | number | null;
  } | null;
}

const OPENROUTER_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models';

export async function fetchOpenRouterModelMetadata(
  signal?: AbortSignal,
): Promise<Record<string, OpenRouterModelMeta>> {
  const res = await fetch(OPENROUTER_MODELS_ENDPOINT, { signal });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter models returned ${res.status}: ${body || res.statusText}`);
  }
  const json = (await res.json()) as OpenRouterModelsResponse;
  const out: Record<string, OpenRouterModelMeta> = {};
  for (const raw of json.data ?? []) {
    if (!raw.id) continue;
    const promptPricePerMillion = dollarsPerMillion(raw.pricing?.prompt);
    const cacheReadPricePerMillion = dollarsPerMillion(raw.pricing?.input_cache_read);
    const context =
      positiveInteger(raw.top_provider?.context_length) ??
      positiveInteger(raw.context_length);
    out[raw.id] = {
      id: raw.id,
      label: raw.name ?? raw.id,
      ...(context !== undefined ? { contextWindowTokens: context } : {}),
      ...(promptPricePerMillion !== undefined ? { promptPricePerMillion } : {}),
      ...(cacheReadPricePerMillion !== undefined ? { cacheReadPricePerMillion } : {}),
    };
  }
  return out;
}

function dollarsPerMillion(value: string | number | null | undefined): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n * 1_000_000;
}

function positiveInteger(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
