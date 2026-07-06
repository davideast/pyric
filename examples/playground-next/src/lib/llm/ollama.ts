/**
 * Ollama `CallbackProvider` — thin wrapper that builds a
 * `NormalizedRequest` and translates `InferenceEvent`s back to
 * `ProviderCallbacks`. Mirrors `./openrouter.ts` since Ollama also
 * exposes an OpenAI-compatible `/v1/chat/completions` endpoint; the
 * actual HTTP work lives upstream in
 * `@inbrowser/relay/providers/ollama`.
 *
 * BYOK is different from the cloud providers — Ollama is local-first,
 * so the "credential" is a base URL (default `http://localhost:11434`)
 * rather than a secret token. The relay provider still accepts the
 * URL via `req.apiKey` (the relay treats it as opaque), keeping the
 * wire contract identical to OpenRouter / Gemini.
 *
 * CORS. Ollama blocks browser origins by default. The user has to
 * `export OLLAMA_ORIGINS=*` (or a specific origin) before starting
 * the daemon. The BYOK form surfaces this when Ollama is active.
 */
import type {
  ProviderTurnResult,
  CallbackProvider,
} from '@inbrowser/agent';
import { ollamaByok } from './byok';
import { useLlmStore } from '~/lib/store/llm';
import { createInference, toModelMessages, toToolSpecs } from './inference';
import type { NormalizedRequest } from './inference';
import type { ModelDef } from './gemini';

/**
 * Boilerplate seed list — used only until the live `/api/tags` fetch
 * resolves (see {@link fetchOllamaModels}). Without a real Ollama
 * daemon every entry here will fail at request time anyway; the seed
 * exists so the ModelPicker dropdown has something to render during
 * the first paint and so non-Ollama flows that import this module
 * don't pay a network cost. Real model discovery is the ground
 * truth; this is the fallback when discovery fails.
 */
export const FALLBACK_OLLAMA_MODELS: readonly ModelDef[] = [
  { id: 'llama3.1:8b', label: 'Llama 3.1 8B' },
  { id: 'llama3.1:70b', label: 'Llama 3.1 70B' },
  { id: 'qwen2.5-coder', label: 'Qwen 2.5 Coder' },
  { id: 'mistral', label: 'Mistral' },
  { id: 'phi3', label: 'Phi-3' },
];

/** Back-compat alias — `registry.ts` reads this name. */
export const OLLAMA_MODELS = FALLBACK_OLLAMA_MODELS;

/** Default model when nothing has been picked yet. Used only before
 *  the live tags fetch hydrates the picker. */
export const DEFAULT_OLLAMA_MODEL = FALLBACK_OLLAMA_MODELS[0]!.id;

/** Last-resort URL when both the env var and BYOK slot are empty. */
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

/** Build-time-inlined value of `OLLAMA_HOST`; see astro.config.mjs.
 *  `null` when the env var was unset at build/dev-server start. */
const OLLAMA_HOST_ENV: string | null =
  (import.meta.env as Record<string, unknown>).PUBLIC_OLLAMA_HOST as
    | string
    | null
    | undefined ?? null;

/**
 * Resolve the Ollama base URL with documented precedence:
 *   1. BYOK-stored URL (set explicitly via the API-key modal — wins
 *      so the user can change hosts at runtime without a restart).
 *   2. `OLLAMA_HOST` env var (build-time default — survives until
 *      the user picks something else).
 *   3. `http://localhost:11434` (Ollama's default daemon address).
 *
 * Used by both tag discovery and the inference path so the user's
 * choice covers both flows without separate config. The BYOK slot's
 * fallback default (also `http://localhost:11434`) is intentionally
 * not consulted here — we only honor `setStoredKey()`-style writes
 * so the env-var default can win when BYOK is untouched.
 */
export function resolveOllamaBaseUrl(): string {
  const stored = ollamaByok.getStoredKey();
  if (stored && stored.length > 0) return stored;
  if (OLLAMA_HOST_ENV && OLLAMA_HOST_ENV.length > 0) return OLLAMA_HOST_ENV;
  return DEFAULT_OLLAMA_BASE_URL;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

/**
 * Fetch the live model list from `GET ${baseUrl}/api/tags`. Returns
 * `ModelDef[]` shaped for the picker. Throws on network/CORS errors
 * or non-200 responses — callers should surface the failure (the
 * store catches and exposes via its `error` field).
 *
 * The Ollama tag shape is `{ models: [{ name, model, modified_at,
 * size, digest, details }, ...] }`. We use `name` as both the id and
 * label; `id` is what gets shipped to the relay and `label` is what
 * the user sees in the dropdown.
 */
export async function fetchOllamaModels(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<readonly ModelDef[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/tags`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Ollama /api/tags returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as OllamaTagsResponse;
  const raw = body.models ?? [];
  const models: ModelDef[] = [];
  for (const m of raw) {
    const id = m.name ?? m.model;
    if (!id) continue;
    models.push({ id, label: id });
  }
  return models;
}

function activeModel(): string {
  const s = useLlmStore.getState();
  return s.providerId === 'ollama' && s.modelId ? s.modelId : DEFAULT_OLLAMA_MODEL;
}

export function getOllamaModel(state = useLlmStore.getState()): string {
  return state.providerId === 'ollama' && state.modelId
    ? state.modelId
    : DEFAULT_OLLAMA_MODEL;
}

export const ollamaProvider: CallbackProvider = {
  label: 'ollama',
  supportsTools: true,

  async chatWithTools(messages, tools, callbacks): Promise<ProviderTurnResult> {
    // Same precedence as `/api/tags` discovery: OLLAMA_HOST env >
    // BYOK > localhost default. The resolver never returns null, but
    // we guard defensively in case the contract drifts.
    const baseUrl = resolveOllamaBaseUrl();
    if (!baseUrl) {
      throw new Error('Ollama base URL not set. Open the key modal in the top bar.');
    }
    const model = activeModel();
    const inference = createInference();

    const req: NormalizedRequest = {
      provider: 'ollama',
      model,
      messages: toModelMessages(messages),
      tools: toToolSpecs(tools),
      toolUseEnabled: tools.length > 0,
      // The relay's `apiKey` field is opaque — for Ollama the upstream
      // provider treats it as the base URL.
      apiKey: baseUrl,
      ...(callbacks.signal ? { signal: callbacks.signal } : {}),
    };

    let textBuf = '';
    let promptTokens = 0;
    let outputTokens = 0;

    for await (const evt of inference.stream(req)) {
      if (callbacks.signal?.aborted) break;
      switch (evt.kind) {
        case 'text':
          textBuf += evt.chunk;
          callbacks.onText(evt.chunk);
          break;
        case 'thinking':
          callbacks.onThinking?.(evt.chunk);
          break;
        case 'tool_call':
          callbacks.onToolCall({
            callId: evt.callId,
            name: evt.name,
            args: evt.args,
          });
          break;
        case 'usage':
          promptTokens = evt.promptTokens;
          outputTokens = evt.outputTokens;
          break;
        case 'error':
          throw new Error(evt.message);
      }
    }

    const finishReason: ProviderTurnResult['finishReason'] =
      callbacks.signal?.aborted ? 'abort' : 'stop';

    return {
      text: textBuf,
      finishReason,
      usage: {
        promptTokens,
        outputTokens,
        // Ollama is BYOK in the same sense as OpenRouter/Gemini —
        // the user's local resources, no Pyric billing involved.
        isByok: true,
      },
      details: { requestedModel: model, servedModel: model },
    };
  },

  async ask(prompt, onChunk, options): Promise<ProviderTurnResult> {
    let buffer = '';
    const result = await this.chatWithTools!(
      [{ role: 'user', text: prompt }],
      [],
      {
        onText: (chunk) => {
          buffer += chunk;
          onChunk(chunk);
        },
        onToolCall: () => {},
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    return { ...result, text: buffer };
  },
};
