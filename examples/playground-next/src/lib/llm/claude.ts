/**
 * Claude (local CLI) `CallbackProvider` — thin wrapper that builds a
 * `NormalizedRequest` and translates `InferenceEvent`s back to
 * `ProviderCallbacks`. Mirrors `./openrouter.ts`; the transport is
 * the dev-only OpenAI-compatible route at
 * `/api/claude-lane/v1/chat/completions`, which runs `claude -p` on
 * the dev server via `@inbrowser/relay`'s claude-cli provider.
 *
 * Auth: the CLI's own subscription login. `apiKey` is always `''` —
 * there is intentionally no BYOK key UI for this lane (the byok slot
 * is `kind: 'none'`).
 *
 * TOOLS via the MCP BRIDGE: `claude -p` cannot register caller-defined
 * tool schemas, but the dev server hosts the playground's core tools as
 * an MCP server (`/api/claude-mcp`) and the lane points the subprocess
 * at it with `--mcp-config`. Turns on this lane are DELEGATED
 * (`~/lib/agent/strategies/claude-delegate.ts`): Claude executes the
 * tool loop ITSELF against a server-side workspace — no `tool_call`
 * deltas come back over the wire — and this wrapper syncs the browser
 * workspace around the turn (push before, pull after; see
 * `./claude-workspace-sync.ts`). The playground strategies (ReAct /
 * Draft → Validate) never drive this lane.
 */
import type { ProviderTurnResult, CallbackProvider } from '@inbrowser/agent';
import { useLlmStore } from '~/lib/store/llm';
import { pullWorkspaceFromBridge, pushWorkspaceToBridge } from './claude-workspace-sync';
import { createInference, toModelMessages, toToolSpecs } from './inference';
import type { NormalizedRequest } from './inference';
import type { ModelDef } from './gemini';
import { IS_LOCAL_HOST_BUILD } from '~/lib/env/local-host';

/**
 * Full model ids, verified against `claude --help` (v2.1.172) and the
 * Claude model catalog. The CLI accepts aliases ('fable', 'opus',
 * 'sonnet'); full ids are pinned for determinism. Haiku 4.5 is the one
 * id whose full form carries a date suffix.
 */
export const CLAUDE_MODELS: readonly ModelDef[] = [
  { id: 'claude-fable-5', label: 'Fable 5', contextWindowTokens: 200_000 },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', contextWindowTokens: 200_000 },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindowTokens: 200_000 },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', contextWindowTokens: 200_000 },
];

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

function activeModel(): string {
  const s = useLlmStore.getState();
  return s.providerId === 'claude' && s.modelId ? s.modelId : DEFAULT_CLAUDE_MODEL;
}

export const claudeProvider: CallbackProvider = {
  label: 'claude',
  // Tools ride the server's MCP bridge; the lane (and the bridge)
  // exist exactly on owner-machine builds — `astro dev` AND the
  // local-auth prod preview. Gating on bare DEV silently disabled the
  // delegated tool loop (and the workspace push/pull around it) on the
  // tailnet preview.
  supportsTools: IS_LOCAL_HOST_BUILD,

  async chatWithTools(messages, tools, callbacks): Promise<ProviderTurnResult> {
    const model = activeModel();
    // Same effort knob the OpenRouter lane uses; the relay provider
    // maps low/medium/high onto `claude --effort` ('off' is omitted).
    const effort = useLlmStore.getState().openrouterEffort;
    const inference = createInference();

    // MCP bridge turn: Claude works on the SERVER workspace, so seed it
    // from the browser first. Failing the push aborts the turn (loud)
    // before any spend.
    const mcpTurn = tools.length > 0;
    if (mcpTurn) await pushWorkspaceToBridge();

    const req: NormalizedRequest = {
      provider: 'claude',
      model,
      messages: toModelMessages(messages),
      tools: toToolSpecs(tools),
      toolUseEnabled: tools.length > 0,
      apiKey: '', // subscription auth — handled by the CLI server-side
      reasoningEffort: effort,
      ...(callbacks.signal ? { signal: callbacks.signal } : {}),
    };

    let textBuf = '';
    let promptTokens = 0;
    let outputTokens = 0;
    let cachedTokens: number | undefined;
    let costUsd: number | undefined;

    let streamError: Error | null = null;
    try {
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
            // Unreachable — MCP-mode tool calls run INSIDE `claude -p`
            // on the server, and text mode carries no tools. Kept for
            // contract completeness should the lane ever grow tool
            // emulation.
            callbacks.onToolCall({ callId: evt.callId, name: evt.name, args: evt.args });
            break;
          case 'usage':
            promptTokens = evt.promptTokens;
            outputTokens = evt.outputTokens;
            // Cache reads are real prompt tokens the lane already folded
            // into promptTokens; carrying the detail through lets the UI
            // show the cached fraction instead of dropping it.
            if (typeof evt.cachedTokens === 'number') cachedTokens = evt.cachedTokens;
            if (typeof evt.costUsd === 'number') costUsd = evt.costUsd;
            break;
          case 'error':
            throw new Error(evt.message);
        }
      }
    } catch (e) {
      streamError = e instanceof Error ? e : new Error(String(e));
    }

    // MCP bridge turn: bring Claude's server-side file changes back to
    // the browser. Happy path failures are LOUD (a silently stale files
    // panel lies to the user); on a failed/aborted stream the pull is
    // best-effort so the original error stays the headline.
    if (mcpTurn) {
      if (streamError || callbacks.signal?.aborted) {
        await pullWorkspaceFromBridge().catch(() => {});
      } else {
        await pullWorkspaceFromBridge();
      }
    }
    if (streamError) throw streamError;

    const finishReason: ProviderTurnResult['finishReason'] = callbacks.signal?.aborted
      ? 'abort'
      : 'stop';

    return {
      text: textBuf,
      finishReason,
      usage: {
        promptTokens,
        outputTokens,
        ...(typeof cachedTokens === 'number' ? { cachedTokens } : {}),
        // The user's own subscription pays — same "your resources, not
        // Pyric billing" sense as the other BYOK lanes.
        isByok: true,
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
