/**
 * OpenRouter `CallbackProvider` — thin wrapper that builds a
 * `NormalizedRequest` and translates `InferenceEvent`s back to
 * `ProviderCallbacks`. The actual fetch + SSE parsing lives in
 * src/lib/llm/inference/adapters/openrouter.ts and runs unchanged
 * page-side and inside the server function.
 *
 * One key, many upstream models — the active model id comes from
 * the LLM store at request time so the picker can switch between
 * GPT and open-source models without re-instantiating.
 */
import type {
  ProviderTurnResult,
  CallbackProvider,
} from '@inbrowser/agent';
import { openrouterByok } from './byok';
import { useLlmStore } from '~/lib/store/llm';
import { useSettingsStore } from '~/lib/store/settings';
import { createInference, toModelMessages, toToolSpecs } from './inference';
import type { PageNormalizedRequest } from './inference/openrouter-page';
import { logPage } from './inference/diagnostics';
import { setActiveOpenRouterTurn } from './inference/openrouter-inspect';
import type { ModelDef } from './gemini';

function newTurnId(): string {
  return `or_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Curated picker entries. `id` is the slug OpenRouter accepts on
 * the wire. Grouped by upstream provider in a sensible reading
 * order: OpenAI, Moonshot, Z-AI, MiniMax, Google,
 * DeepSeek. Gemini lives under the native provider — listing it
 * here too would be a redundant routing alternative with different
 * pricing/usage.
 */
export const OPENROUTER_MODELS: readonly ModelDef[] = [
  // OpenAI
  { id: 'openai/gpt-5.5', label: 'GPT-5.5', contextWindowTokens: 258_000 },
  // Moonshot
  { id: 'moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code' },
  // Z-AI
  { id: 'z-ai/glm-5.1', label: 'GLM 5.1' },
  { id: 'z-ai/glm-5.2', label: 'GLM 5.2' },
  // MiniMax
  { id: 'minimax/minimax-m3', label: 'MiniMax M3' },
  // Google
  { id: 'google/gemma-4-31b-it', label: 'Gemma 4 31B IT' },
  // DeepSeek
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek v4 Pro' },
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek v4 Flash' },
];

export const DEFAULT_OPENROUTER_MODEL = OPENROUTER_MODELS[0]!.id;

function activeModel(): string {
  const s = useLlmStore.getState();
  return s.providerId === 'openrouter' && s.modelId
    ? s.modelId
    : DEFAULT_OPENROUTER_MODEL;
}

function providerError(evt: {
  message: string;
  code?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}): Error {
  const error = new Error(evt.message) as Error & {
    code?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
  if (evt.code) error.code = evt.code;
  if (typeof evt.retryable === 'boolean') error.retryable = evt.retryable;
  if (evt.details) error.details = evt.details;
  return error;
}

export const openrouterProvider: CallbackProvider = {
  label: 'openrouter',
  supportsTools: true,

  async chatWithTools(messages, tools, callbacks): Promise<ProviderTurnResult> {
    const apiKey = openrouterByok.getKey();
    if (!apiKey) {
      throw new Error('OpenRouter API key not set. Open the key modal in the top bar.');
    }
    const model = activeModel();
    const effort = useLlmStore.getState().openrouterEffort;
    const inference = createInference();

    // Provider-routing controls (settings modal → wire `provider`
    // field): sort mode + optional price ceilings in USD per million
    // tokens. buildBody (openrouter-page.ts) turns this into the wire
    // shape and omits the field entirely when nothing is configured.
    const settings = useSettingsStore.getState();
    const req: PageNormalizedRequest = {
      provider: 'openrouter',
      model,
      messages: toModelMessages(messages),
      tools: toToolSpecs(tools),
      toolUseEnabled: tools.length > 0,
      apiKey,
      reasoningEffort: effort,
      providerRouting: {
        sort: settings.openrouterSort,
        ...(settings.openrouterMaxPromptPrice !== undefined
          ? { maxPromptPrice: settings.openrouterMaxPromptPrice }
          : {}),
        ...(settings.openrouterMaxCompletionPrice !== undefined
          ? { maxCompletionPrice: settings.openrouterMaxCompletionPrice }
          : {}),
      },
      ...(callbacks.signal ? { signal: callbacks.signal } : {}),
    };

    // ── Turn instrumentation. Tag this turn so the wire inspector
    //    (openrouter-inspect.ts) correlates its capture with the effort
    //    we *requested* here. Provider-side timing also covers `server`
    //    mode, where the page never sees the OpenRouter fetch. ─────────
    const turnId = newTurnId();
    setActiveOpenRouterTurn(turnId);
    const t0 = performance.now();
    const transport = useSettingsStore.getState().resumableServerMode ? 'server' : 'fallback';
    let firstEventMs: number | null = null;
    let firstTextMs: number | null = null;
    let firstThinkingMs: number | null = null;
    let thinkingChars = 0;
    logPage('openrouter_turn', turnId, {
      phase: 'start',
      model,
      requestedEffort: effort,
      transport,
      toolCount: tools.length,
      messageCount: messages.length,
    });

    let textBuf = '';
    let promptTokens = 0;
    let outputTokens = 0;
    let cachedTokens: number | undefined;
    let reasoningTokens: number | undefined;
    let costUsd: number | undefined;

    try {
      for await (const evt of inference.stream(req)) {
        if (callbacks.signal?.aborted) break;
        if (firstEventMs === null) firstEventMs = performance.now() - t0;
        switch (evt.kind) {
          case 'text':
            if (firstTextMs === null) firstTextMs = performance.now() - t0;
            textBuf += evt.chunk;
            callbacks.onText(evt.chunk);
            break;
          case 'thinking':
            if (firstThinkingMs === null) firstThinkingMs = performance.now() - t0;
            thinkingChars += evt.chunk.length;
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
            if (typeof evt.cachedTokens === 'number') cachedTokens = evt.cachedTokens;
            if (typeof evt.reasoningTokens === 'number') reasoningTokens = evt.reasoningTokens;
            if (typeof evt.costUsd === 'number') costUsd = evt.costUsd;
            break;
          case 'error':
            throw providerError(evt);
        }
      }
    } finally {
      // Always emitted — even on the `error` throw or an abort — so the
      // turn timeline is complete. Pairs with the wire capture under the
      // same turnId; `firstThinkingMs` here is the model's thinking as
      // seen by the agent loop, independent of transport.
      logPage('openrouter_turn', turnId, {
        phase: 'end',
        requestedEffort: effort,
        transport,
        firstEventMs: firstEventMs === null ? null : Math.round(firstEventMs),
        firstThinkingMs: firstThinkingMs === null ? null : Math.round(firstThinkingMs),
        firstTextMs: firstTextMs === null ? null : Math.round(firstTextMs),
        thinkingChars,
        textChars: textBuf.length,
        promptTokens,
        outputTokens,
        totalMs: Math.round(performance.now() - t0),
        aborted: callbacks.signal?.aborted ?? false,
      });
      setActiveOpenRouterTurn(null);
    }

    const finishReason: ProviderTurnResult['finishReason'] =
      callbacks.signal?.aborted ? 'abort' : 'stop';

    return {
      text: textBuf,
      finishReason,
      usage: {
        promptTokens,
        outputTokens,
        isByok: true,
        ...(typeof cachedTokens === 'number' ? { cachedTokens } : {}),
        ...(typeof reasoningTokens === 'number' ? { reasoningTokens } : {}),
        ...(typeof costUsd === 'number' ? { costUsd } : {}),
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
