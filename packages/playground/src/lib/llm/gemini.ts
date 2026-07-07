/**
 * Gemini `CallbackProvider` — thin wrapper that builds a
 * `NormalizedRequest` from the agent loop's args, calls the shared
 * inference client, and translates the `InferenceEvent` stream back
 * into the callback shape `@inbrowser/agent` expects.
 *
 * The actual HTTP call (raw fetch against the Generative Language
 * REST API) lives in src/lib/llm/inference/adapters/gemini.ts so the
 * same code runs page-side and inside the server function. This file
 * is just BYOK + model selection + event-to-callback translation.
 */
import type {
  ProviderTurnResult,
  CallbackProvider,
} from '@inbrowser/agent';
import { geminiByok } from './byok';
import { useLlmStore } from '~/lib/store/llm';
import { createInference, toModelMessages, toToolSpecs } from './inference';
import type { NormalizedRequest } from './inference';

export interface ModelDef {
  id: string;
  label: string;
  /** Provider context window, when the playground can name it confidently.
   *  Unknown models omit this so the UI shows tokens without a fake percent. */
  contextWindowTokens?: number;
}

/**
 * Curated Gemini model list. Mirrors `examples/admin-compat-browser`'s
 * Gemini picker. Older `gemini-2.5` slugs are intentionally absent —
 * their tool-call thoughtSignature contract differs and we don't
 * translate it.
 */
export const GEMINI_MODELS: readonly ModelDef[] = [
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindowTokens: 1_000_000 },
  { id: 'gemini-3.1-flash-lite', label: '3.1 Flash Lite', contextWindowTokens: 1_000_000 },
  { id: 'gemini-3-flash-preview', label: '3 Flash Preview', contextWindowTokens: 1_000_000 },
  { id: 'gemini-3.1-pro-preview', label: '3.1 Pro Preview', contextWindowTokens: 1_000_000 },
];

export const DEFAULT_GEMINI_MODEL = GEMINI_MODELS[0]!.id;

function activeModel(): string {
  const s = useLlmStore.getState();
  return s.providerId === 'gemini' && s.modelId ? s.modelId : DEFAULT_GEMINI_MODEL;
}

export const geminiProvider: CallbackProvider = {
  label: 'gemini',
  supportsTools: true,

  async chatWithTools(messages, tools, callbacks): Promise<ProviderTurnResult> {
    const apiKey = geminiByok.getKey();
    if (!apiKey) {
      throw new Error('Gemini API key not set. Open the key modal in the top bar.');
    }
    const model = activeModel();
    const inference = createInference();

    const req: NormalizedRequest = {
      provider: 'gemini',
      model,
      messages: toModelMessages(messages),
      tools: toToolSpecs(tools),
      toolUseEnabled: tools.length > 0,
      apiKey,
      ...(callbacks.signal ? { signal: callbacks.signal } : {}),
    };

    let textBuf = '';
    let promptTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;

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
            ...(evt.signature ? { signature: evt.signature } : {}),
          });
          break;
        case 'usage':
          promptTokens = evt.promptTokens;
          outputTokens = evt.outputTokens;
          if (typeof evt.cachedTokens === 'number') cachedTokens = evt.cachedTokens;
          break;
        case 'error':
          // Genuine upstream error (4xx, 5xx, network). Abort is
          // handled by the signal check at loop top + the post-loop
          // check below; adapters suppress error emission on abort.
          throw new Error(evt.message);
      }
    }

    const finishReason: ProviderTurnResult['finishReason'] =
      callbacks.signal?.aborted ? 'abort' : 'stop';

    return {
      text: textBuf,
      finishReason,
      usage: { promptTokens, outputTokens, cachedTokens, isByok: true },
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
