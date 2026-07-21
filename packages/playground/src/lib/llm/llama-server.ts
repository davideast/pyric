/**
 * llama.cpp `llama-server` CallbackProvider. llama-server exposes an
 * OpenAI-compatible `/v1/chat/completions` endpoint, so it shares the
 * exact wire of the Ollama provider; the actual HTTP work lives upstream
 * in `@inbrowser/relay/providers/ollama` (a generic OpenAI-compatible
 * transport that takes the base URL via `req.apiKey`). The inference
 * dispatcher routes the `llamaServer` tag through that transport — see
 * inference/index.ts.
 *
 * Local-first like Ollama: the "credential" is a base URL (default
 * `http://localhost:8080`) rather than a secret. Model discovery uses
 * the OpenAI `/v1/models` endpoint; llama-server typically serves a
 * single loaded GGUF, so the `model` field is best-effort.
 *
 * CORS: llama-server allows cross-origin requests by default. If a setup
 * runs it behind a proxy that strips CORS headers, point the BYOK URL at
 * a CORS-enabled endpoint.
 */
import type { ProviderTurnResult, CallbackProvider } from '@inbrowser/agent';
import { llamaServerByok } from './byok';
import { useLlmStore } from '~/lib/store/llm';
import { createInference, toModelMessages, toToolSpecs } from './inference';
import type { NormalizedRequest } from './inference';
import type { ModelDef } from './gemini';

/**
 * Seed list shown until live `/v1/models` discovery resolves. llama-server
 * serves whatever GGUF is loaded regardless of the id sent, so this is
 * mostly a picker placeholder; discovery is the ground truth.
 */
export const FALLBACK_LLAMA_SERVER_MODELS: readonly ModelDef[] = [
  { id: 'default', label: 'Loaded model (llama.cpp)' },
];

/** Back-compat alias — `registry.ts` reads this name. */
export const LLAMA_SERVER_MODELS = FALLBACK_LLAMA_SERVER_MODELS;

export const DEFAULT_LLAMA_SERVER_MODEL = FALLBACK_LLAMA_SERVER_MODELS[0]!.id;

/** llama-server's default listen address. */
const DEFAULT_LLAMA_SERVER_BASE_URL = 'http://localhost:8080';
let transportBaseUrlOverride: string | null = null;

/**
 * Resolve the base URL: the BYOK-stored override wins, else the default
 * `http://localhost:8080`. (No env-var layer like Ollama's `OLLAMA_HOST`;
 * set the URL via the key modal when it isn't the default.)
 */
export function resolveConfiguredLlamaServerBaseUrl(): string {
  const stored = llamaServerByok.getStoredKey();
  if (stored && stored.length > 0) return stored;
  return DEFAULT_LLAMA_SERVER_BASE_URL;
}

/** The route inference should use. Discovery installs the local dev
 * proxy here when the browser cannot reach llama-server directly. */
export function resolveLlamaServerBaseUrl(): string {
  return transportBaseUrlOverride ?? resolveConfiguredLlamaServerBaseUrl();
}

/** Same-origin Vite proxy available only while serving the Playground
 * locally. Production builds must continue to call the user's URL
 * directly—the hosted server cannot reach a model on their machine. */
export function resolveLocalLlamaServerProxyBaseUrl(): string | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  if (!['localhost', '127.0.0.1'].includes(window.location.hostname)) return null;
  return new URL('/__llama-server', window.location.origin).toString().replace(/\/$/, '');
}

export function useLlamaServerTransportBaseUrl(baseUrl: string | null): void {
  transportBaseUrlOverride = baseUrl;
}

interface OpenAiModelsResponse {
  data?: Array<{ id?: string }>;
}

/**
 * Fetch the live model list from `GET ${baseUrl}/v1/models` (OpenAI shape:
 * `{ data: [{ id }, ...] }`). Throws on network/CORS errors or non-200;
 * callers surface the failure.
 */
export async function fetchLlamaServerModels(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<readonly ModelDef[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/models`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`llama-server /v1/models returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as OpenAiModelsResponse;
  const models: ModelDef[] = [];
  for (const m of body.data ?? []) {
    if (!m.id) continue;
    models.push({ id: m.id, label: m.id });
  }
  return models;
}

function activeModel(): string {
  const s = useLlmStore.getState();
  return s.providerId === 'llamaServer' && s.modelId ? s.modelId : DEFAULT_LLAMA_SERVER_MODEL;
}

export function getLlamaServerModel(state = useLlmStore.getState()): string {
  return state.providerId === 'llamaServer' && state.modelId
    ? state.modelId
    : DEFAULT_LLAMA_SERVER_MODEL;
}

export const llamaServerProvider: CallbackProvider = {
  label: 'llama-server',
  supportsTools: true,

  async chatWithTools(messages, tools, callbacks): Promise<ProviderTurnResult> {
    const baseUrl = resolveLlamaServerBaseUrl();
    if (!baseUrl) {
      throw new Error('llama-server base URL not set. Open the key modal in the top bar.');
    }
    const model = activeModel();
    const inference = createInference();

    const req: NormalizedRequest = {
      provider: 'llamaServer',
      model,
      messages: toModelMessages(messages),
      tools: toToolSpecs(tools),
      toolUseEnabled: tools.length > 0,
      // The relay transport treats apiKey as the base URL (opaque).
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
          callbacks.onToolCall({ callId: evt.callId, name: evt.name, args: evt.args });
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
        // Local resources, BYOK in the same sense as Ollama — no Pyric billing.
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
