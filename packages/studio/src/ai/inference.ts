/**
 * Inference for Studio AI assists: build an `@inbrowser/agent` `ModelClient`
 * from the active provider selection + BYOK key.
 *
 * Through `@inbrowser/relay@0.3.x` the heavy lifting (per-provider HTTP + SSE +
 * tool-call buffering) lived in the relay's browser-safe cloud providers
 * (`anthropicProvider`, `openrouterProvider`, `geminiProvider`,
 * `ollamaProvider`). Published `@inbrowser/relay@0.4.0` removed those: the
 * cloud providers moved into `@inbrowser/model` as `ModelClient` factories
 * (a different, nested event shape), and `@inbrowser/model` is not a Studio
 * dependency. So — exactly as the playground did — Studio keeps a small
 * page-direct provider contract in-repo (the flat `InferenceEvent` /
 * `InferenceProvider` shape this adapter and its tests already assume), and
 * this module is the thin adapter that maps an in-repo `InferenceProvider` to
 * the agent's `ModelClient`.
 *
 * The mapping work:
 *   - agent `ModelMessage` -> the provider's `InferenceMessage`
 *   - agent `ToolSpec` (nested `{ type, function }`) -> the provider's flat
 *     `InferenceToolDecl` (`{ name, description, parameters }`)
 *   - the provider's flat `InferenceEvent` -> the agent's nested `ModelEvent`
 *     (`text`/`thinking` carry `text`; usage is a nested `usage` object; the
 *     iterable's return — not a terminal event — signals turn completion).
 *
 * The page-direct provider implementations themselves (the per-provider
 * fetch + SSE) are a follow-up: they were the relay's, and 0.4.0 took them
 * away. Until they land in-repo, `makeLlmClient` resolves a not-yet-wired
 * stub. The injectable `relayProviderAsLlmClient` adapter (and its unit
 * tests, which pass a mock provider) is fully migrated and exercises the
 * mapping end to end.
 */

import { useMemo, useSyncExternalStore } from 'react';
import type {
  ModelClient,
  ModelRequest,
  ModelEvent,
  ModelMessage,
  ToolSpec,
  ReasoningEffort,
} from '@inbrowser/agent';
import { PROVIDERS, type ProviderId } from './providers.js';
import { useLlmSelection } from './llm-store.js';
import { subscribeKeys, keysVersionSnapshot } from './byok.js';

/**
 * The wire request a page-direct provider accepts. Mirrors the relay's old
 * `NormalizedRequest` (provider routing key + model + BYOK key + the flat
 * message/tool shapes), kept in-repo now that the relay no longer owns it.
 */
export interface InferenceMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text?: string;
  toolCalls?: { callId: string; name: string; args: unknown; signature?: string }[];
  callId?: string;
  name?: string;
  resultJson?: string;
}

export interface InferenceToolDecl {
  name: string;
  description: string;
  parameters: unknown;
}

export interface NormalizedRequest {
  provider: string;
  model: string;
  messages: InferenceMessage[];
  tools: InferenceToolDecl[];
  apiKey: string;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
}

/**
 * The flat event a page-direct provider streams. This is the shape Studio's
 * adapter + tests speak; the agent's nested `ModelEvent` is derived from it
 * in `mapEvent`.
 */
export type InferenceEvent =
  | { kind: 'text'; chunk: string }
  | { kind: 'thinking'; chunk: string }
  | { kind: 'tool_call'; callId: string; name: string; args: unknown; signature?: string }
  | {
      kind: 'usage';
      promptTokens: number;
      outputTokens: number;
      cachedTokens?: number;
      costUsd?: number;
    }
  | { kind: 'error'; message: string };

/** A page-direct provider: a request in, a stream of flat events out. */
export type InferenceProvider = (req: NormalizedRequest) => AsyncIterable<InferenceEvent>;

/**
 * Not-yet-wired page-direct provider. Published `@inbrowser/relay@0.4.0`
 * removed the relay's cloud providers (they moved to `@inbrowser/model` as
 * `ModelClient` factories, which Studio doesn't depend on). The in-repo
 * page-direct fetch + SSE implementations are a follow-up; until they land,
 * the live path surfaces a clear error rather than silently failing.
 */
const notWiredProvider: InferenceProvider = async function* (req) {
  yield {
    kind: 'error',
    message: `Provider "${req.provider}" is not wired yet (relay 0.4.0 removed the built-in cloud providers; the in-repo page-direct provider is a follow-up).`,
  };
};

/** Our `ProviderId` to the page-direct provider fn + its routing key. */
const RELAY_PROVIDER: Record<ProviderId, { fn: InferenceProvider; key: string }> = {
  anthropic: { fn: notWiredProvider, key: 'anthropic' },
  openrouter: { fn: notWiredProvider, key: 'openrouter' },
  gemini: { fn: notWiredProvider, key: 'gemini' },
  ollama: { fn: notWiredProvider, key: 'ollama' },
};

function toProviderMessage(m: ModelMessage): InferenceMessage {
  return {
    role: m.role,
    ...(m.text !== undefined ? { text: m.text } : {}),
    ...(m.toolCalls
      ? {
          toolCalls: m.toolCalls.map((c) => ({
            callId: c.id,
            name: c.name,
            args: c.args,
            ...(c.signature ? { signature: c.signature } : {}),
          })),
        }
      : {}),
    ...(m.toolCallId ? { callId: m.toolCallId } : {}),
    ...(m.name ? { name: m.name } : {}),
    ...(m.resultJson ? { resultJson: m.resultJson } : {}),
  };
}

function toProviderTool(t: ToolSpec): InferenceToolDecl {
  return {
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  };
}

/** Map one flat `InferenceEvent` to the agent's nested `ModelEvent`. */
function mapEvent(ev: InferenceEvent): ModelEvent {
  switch (ev.kind) {
    case 'text':
      return { kind: 'text', text: ev.chunk };
    case 'thinking':
      return { kind: 'thinking', text: ev.chunk };
    case 'tool_call':
      return {
        kind: 'tool_call',
        id: ev.callId,
        name: ev.name,
        args: ev.args,
        ...(ev.signature ? { signature: ev.signature } : {}),
      };
    case 'usage':
      return {
        kind: 'usage',
        usage: {
          promptTokens: ev.promptTokens,
          outputTokens: ev.outputTokens,
          ...(ev.cachedTokens != null ? { cachedTokens: ev.cachedTokens } : {}),
          ...(ev.costUsd != null ? { costUsd: ev.costUsd } : {}),
        },
      };
    case 'error':
      return { kind: 'error', message: ev.message };
  }
}

export interface RelayClientConfig {
  /** The provider routing key (e.g. 'anthropic'). */
  providerKey: string;
  model: string;
  apiKey: string;
  effort?: ReasoningEffort;
}

/**
 * Wrap a page-direct `InferenceProvider` as an agent `ModelClient`. Injectable
 * (takes the provider fn) so the adapter is unit-testable with a mock
 * provider. The provider buffers partial tool-call JSON and flushes complete
 * `tool_call` events, so this adapter passes them through unchanged.
 *
 * Per the `@inbrowser/model` contract, the turn ends when the iterable
 * returns; on a normal end a `usage` event MUST precede the return, and
 * `error` is itself terminal (no `usage` after it). This adapter synthesizes a
 * zero `usage` event if a provider stream ends without one.
 */
export function relayProviderAsLlmClient(
  relayFn: InferenceProvider,
  cfg: RelayClientConfig,
): ModelClient {
  return {
    id: `${cfg.providerKey}:${cfg.model}`,
    supportsTools: true,
    async *chat(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      const normalized: NormalizedRequest = {
        provider: cfg.providerKey,
        model: cfg.model,
        messages: req.messages.map(toProviderMessage),
        tools: req.toolUseEnabled ? req.tools.map(toProviderTool) : [],
        apiKey: cfg.apiKey,
        ...(cfg.effort ? { reasoningEffort: cfg.effort } : {}),
        signal,
      };
      let sawUsage = false;
      for await (const ev of relayFn(normalized)) {
        if (signal.aborted) return;
        const mapped = mapEvent(ev);
        if (mapped.kind === 'usage') sawUsage = true;
        // `error` is terminal in the contract: yield it and return with no
        // trailing `usage` event.
        if (mapped.kind === 'error') {
          yield mapped;
          return;
        }
        yield mapped;
      }
      // The contract requires a `usage` event before a normal return. If the
      // provider stream ended without one, synthesize a zero usage.
      if (!sawUsage) {
        yield { kind: 'usage', usage: { promptTokens: 0, outputTokens: 0 } };
      }
    },
  };
}

export interface LlmClientConfig {
  providerId: ProviderId;
  model: string;
  apiKey: string;
  effort?: ReasoningEffort;
}

/** Build the live `ModelClient` for a provider selection. */
export function makeLlmClient(cfg: LlmClientConfig): ModelClient {
  const relay = RELAY_PROVIDER[cfg.providerId];
  return relayProviderAsLlmClient(relay.fn, {
    providerKey: relay.key,
    model: cfg.model,
    apiKey: cfg.apiKey,
    ...(cfg.effort ? { effort: cfg.effort } : {}),
  });
}

export interface UseLlmClientResult {
  /** The live client for the active selection, or null when no key is set. */
  client: ModelClient | null;
  providerId: ProviderId;
  modelId: string;
  /** True when the active provider has no key (assists show a "set a key" state). */
  missingKey: boolean;
}

/**
 * The active `ModelClient`, derived from the persisted selection + the active
 * provider's BYOK key. `null` (with `missingKey: true`) when no key is set, so an
 * assist can render a "needs an API key" empty state that links to settings.
 */
export function useLlmClient(): UseLlmClientResult {
  const { providerId, modelId, effort } = useLlmSelection();
  // Re-derive when a key is saved/cleared (byok is reactive), not just on a
  // selection change.
  const keysVersion = useSyncExternalStore(subscribeKeys, keysVersionSnapshot, keysVersionSnapshot);
  return useMemo<UseLlmClientResult>(() => {
    const apiKey = PROVIDERS[providerId].byok.getKey();
    if (!apiKey) {
      return { client: null, providerId, modelId, missingKey: true };
    }
    return {
      client: makeLlmClient({ providerId, model: modelId, apiKey, effort }),
      providerId,
      modelId,
      missingKey: false,
    };
  }, [providerId, modelId, effort, keysVersion]);
}
