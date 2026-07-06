/**
 * Session host — drives `@inbrowser/agent`' `AgentSession` from the
 * browser. Resolves the active provider from the LLM store (Gemini
 * or OpenRouter today; more land via `registry.ts`), wraps it in
 * `callbackProviderAsLlmClient`, and translates `SessionEvent` →
 * `chatStore` patches.
 *
 * The MVP shell uses the resulting `useAgentLoop` hook to drive
 * `ComposeBar.onSubmit`.
 */
import {
  createAgentSession,
  createDispatch,
  createMetricsCollector,
  createReactLoopStrategy,
  callbackProviderAsLlmClient,
  type ChatMessage as CoreChatMessage,
  type SandboxHandle,
  type SessionEvent,
  type ToolContext,
} from '@inbrowser/agent';
import { PROVIDERS } from '~/lib/llm/registry';
import { estimateGeminiCostUsd } from '~/lib/llm/pricing';
/** Custom `strategy_event` names emitted by the draft-then-validate
 *  strategy and the C2 router (routing decision + bounded escalation).
 *  Captured onto the assistant message as `phaseEvents`. */
const DRAFT_VALIDATE_EVENTS = new Set([
  'draft_started',
  'validation_result',
  'repair_started',
  'validation_exhausted',
  'strategy_routed',
  'strategy_escalated',
]);

function activeProviderModelLabels(): { providerLabel: string; modelLabel: string } {
  const s = useLlmStore.getState();
  const def = PROVIDERS[s.providerId];
  const model = def.models.find((m) => m.id === s.modelId);
  return { providerLabel: def.label, modelLabel: model?.label ?? s.modelId };
}

/**
 * Resolve cost for the just-completed turn from the WHOLE-TURN
 * aggregate (all ReAct iterations summed). OpenRouter reports a real
 * per-iteration `costUsd` via `usage.cost` — those sum to a real
 * total. When any iteration's cost was estimated (or missing) we fall
 * back to estimating from the summed token counts — `≈` prefix in the
 * UI signals "computed locally" vs. exact provider number.
 */
function resolveTurnCost(agg: AggregatedTurnMetrics): {
  costUsd: number | null;
  costEstimated: boolean;
} {
  if (!agg.costEstimated && agg.costUsd > 0) {
    return { costUsd: agg.costUsd, costEstimated: false };
  }
  const s = useLlmStore.getState();
  if (s.providerId === 'gemini') {
    const est = estimateGeminiCostUsd(s.modelId, {
      promptTokens: agg.tokensIn,
      outputTokens: agg.tokensOut,
      cachedTokens: agg.tokensCached,
    });
    return { costUsd: est, costEstimated: est !== null };
  }
  if (!agg.costEstimated) {
    // Provider-reported zero (free local model, or genuinely $0).
    return { costUsd: agg.costUsd, costEstimated: false };
  }
  return { costUsd: null, costEstimated: false };
}
import {
  useChatStore,
  type ChatMessage,
  type DelegatedActivity,
  type ReflexionCritique,
  type ToolCall,
} from '~/lib/store/chat';
import { finalizeClaudeTranscript } from '~/lib/llm/claude-transcript';
import { useLlmStore } from '~/lib/store/llm';
import { useSettingsStore, resolveMaxTurns } from '~/lib/store/settings';
import { useTraceStore, type HostCtx } from '~/lib/store/trace';
import { getRunner } from '~/lib/sandbox/runner';
import { buildToolRegistry, filterToolsForProfile } from '~/lib/tools';
import { createDraftThenValidateStrategy } from '~/lib/agent/strategies/draft-then-validate';
import {
  createClaudeDelegateStrategy,
  isDelegatedProvider,
} from '~/lib/agent/strategies/claude-delegate';
import {
  createRoutedStrategy,
  provenanceFromRouted,
  provenanceFromEscalated,
} from '~/lib/agent/strategy-router';
import { selectToolProfileForPrompt } from '~/lib/agent/tool-profile';
import { buildClaudeLanePrompt } from '~/lib/agent/claude-lane-prompt';
import { buildSystemPrompt } from '~/lib/agent/system-prompt';
import { makeDiagnosticsContext } from '~/lib/agent/diagnostics';
import { resolveModelHistory } from './model-history';
import { pruneToolHistoryWithStats, withPrunedHistory } from '~/lib/agent/prune-history';
import { logPage } from '~/lib/llm/inference/diagnostics';
import { setServerJobProgressListener } from '~/lib/llm/inference';
import {
  createTurnMetricsAccumulator,
  snapshotHistoryForTurn,
  type AggregatedTurnMetrics,
} from './turn-accounting';
import type { Tracer, TraceEvent } from '@inbrowser/agent';

/**
 * Real `SandboxHandle` backed by the shared `SandboxRunner` singleton.
 * The `runOnce` tool drives this directly via the runner, but exposing
 * it on `ToolContext` keeps other agents framework-style tools wired
 * to the same instance if they reach for `ctx.sandbox` later.
 *
 * Reseed is currently a no-op — Phase 5+ wires presets and surfaces
 * a fresh instance via `disposeRunner()` + `getRunner()`.
 */
function realSandbox(): SandboxHandle {
  const r = getRunner();
  return {
    async run(code) {
      return r.run(code);
    },
    async deployRules(source) {
      return r.deployRules(source);
    },
    async readState(opts) {
      return r.readState(opts);
    },
    reseed() {},
    dispose() {
      /* keep the runner around — disposal is owned by the page lifecycle */
    },
  };
}

function uiToCoreHistory(uiMessages: readonly ChatMessage[]): CoreChatMessage[] {
  return uiMessages.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    timestamp: m.createdAt,
    ...(m.toolCalls && m.toolCalls.length > 0
      ? {
          toolCalls: m.toolCalls.map((c) => ({
            id: c.id,
            name: c.name,
            argsJson: c.argsJson,
            ...(c.resultJson !== undefined ? { resultJson: c.resultJson } : {}),
            ...(c.ok !== undefined ? { ok: c.ok } : {}),
            ...(c.summary ? { summary: c.summary } : {}),
            ...(c.signature ? { signature: c.signature } : {}),
          })),
        }
      : {}),
    ...(m.thinking ? { thinking: m.thinking } : {}),
  }));
}

let lastContextCompactSignal = 0;

function traceProviderVisibleRequest<T extends { messages: unknown[] }>(req: T): T {
  const { messages } = pruneToolHistoryWithStats(req.messages as never, { keepLastResults: 3 });
  return { ...req, messages } as T;
}

function stringifyArgs(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface SubmitOptions {
  signal: AbortSignal;
  /** Called by the session host to update the chat store. */
  appendMessage: (m: ChatMessage) => void;
  patchMessage: (id: string, patch: Partial<ChatMessage>) => void;
  patchToolCall: (messageId: string, callId: string, patch: Partial<ToolCall>) => void;
}

/**
 * One round-trip through an `AgentSession`. The hook driving this
 * call has already appended the user message + the streaming
 * assistant placeholder. This function:
 *
 *   - snapshots the chat-store history
 *   - builds a fresh session with the gemini provider as LlmClient
 *   - reads events off `session.submit()` and patches the chat store
 *
 * No persistence, no logging, no event log writes — MVP keeps the
 * boundary minimal.
 */
export async function runOneTurn(
  prompt: string,
  firstAsstId: string,
  userId: string,
  opts: SubmitOptions,
): Promise<void> {
  const settings = useSettingsStore.getState();
  const delegated = isDelegatedProvider(useLlmStore.getState().providerId);

  // Drop the streaming assistant placeholder AND the in-flight user
  // message — `@inbrowser/agent` appends the prompt to history itself
  // (and its strategy appends it to the wire again). Leaving it in the
  // snapshot put the user prompt on the wire THREE times per request
  // (sonnet-food trace, 2026-06-10). See turn-accounting.ts.
  const rawHistory = snapshotHistoryForTurn(useChatStore.getState().messages, userId);
  const forceCompact = settings.contextCompactSignal !== lastContextCompactSignal;
  lastContextCompactSignal = settings.contextCompactSignal;
  // ── Append-only history + compaction EVENTS ──────────────────────
  // (plans/context-compaction-redesign.md; replaces the per-dispatch
  // compactHistoryForModel rewrite that capped agent memory at 2 turns
  // and rewrote the prompt prefix every turn.) Model-bound history =
  // latest persisted marker's summary + messages after its boundary.
  // Stale tool RESULTS are handled separately at the client seam by
  // withPrunedHistory below (the playground's lever-1 equivalent of
  // @inbrowser/agent editToolResults).
  const history = await resolveModelHistory(rawHistory, { forceCompact });

  // Phase 2: a real tool registry. Today contains `writeRules`. The
  // list grows as we add capabilities — agent sees them at function-
  // declaration time and can call any of them.
  const registry = buildToolRegistry();
  const dispatch = createDispatch(registry);
  const toolProfile = selectToolProfileForPrompt({ prompt, settings, delegated });
  const visibleTools = filterToolsForProfile(registry.list(), toolProfile);
  const metrics = createMetricsCollector();

  let currentId = firstAsstId;
  let currentBuf = '';
  let thinkingBuf = '';
  let firstTurn = true;
  let turnStart = performance.now();
  // SF-S0a: the session-emitted turnId for this user turn — captured on
  // `turn_started` so the router/escalation milestones can stamp strategy
  // provenance onto the turn's trace. The router yields `strategy_routed`
  // BEFORE the inner strategy's `turn_started`, so provenance is buffered
  // here and flushed once the turnId is known (and re-flushed whenever a
  // later milestone — escalation — overrides the routing decision).
  let turnId = '';
  let pendingProv: import('~/lib/store/trace').StrategyProvenance | null = null;
  const flushProvenance = () => {
    if (turnId && pendingProv) {
      useTraceStore.getState().setProvenance(turnId, pendingProv);
    }
  };
  // Whole-turn usage. The strategy emits one `turn_completed` per ReAct
  // iteration — summing here is what makes the reported tokens/cost
  // cover the WHOLE turn, not just the last iteration (defect: a
  // 60,583-token turn reported as 183 tokens / $0.04).
  const turnMetrics = createTurnMetricsAccumulator();

  // Tracer impl — synchronous, non-throwing, captures host-side
  // provider/model/settings AT EMIT TIME so a mid-session picker
  // swap shows up in the trace honestly. Pushed straight into the
  // trace store; the UI subscribes there.
  const tracer: Tracer = {
    emit(event: TraceEvent) {
      try {
        if (event.kind === 'llm_request') {
          const llm = useLlmStore.getState();
          const settings = useSettingsStore.getState();
          const def = PROVIDERS[llm.providerId];
          const modelLabel =
            def.models.find((m) => m.id === llm.modelId)?.label ?? llm.modelId;
          const hostCtx: HostCtx = {
            providerId: llm.providerId,
            providerLabel: def.label,
            modelLabel,
            diagnosticsEnabled: settings.pyricDiagnosticsEnabled,
            resumableServerMode: settings.resumableServerMode,
          };
          useTraceStore.getState().appendRequest(traceProviderVisibleRequest(event.data), hostCtx);
        } else if (event.kind === 'llm_response') {
          useTraceStore.getState().appendResponse(event.data);
        }
      } catch (e) {
        // Tracer MUST NOT fail the LLM dispatch. Swallow + log so a
        // broken trace doesn't take down the agent loop.
        console.warn('[trace] emit failed', e);
      }
    },
  };

  // Resolve strategy knobs from the settings store at session-creation
  // time so updated values (via the SettingsModal) take effect on the
  // next submit without a reload. The store clamps values to sane
  // ranges so a stale localStorage entry can't push the agent into a
  // runaway loop.
  //
  // `strategyMode` (default 'auto', C2) is threaded through the routed
  // wrapper in every mode so the `strategy_routed` milestone always
  // fires (source: 'override' when the user pinned a strategy,
  // 'heuristic' under auto):
  //   - auto: build/modify prompts with a data/security surface run
  //     draft-validate (tool-free draft → host validation → bounded
  //     repair → write-back), escalating ONCE to ReAct with the draft +
  //     failures when repairs exhaust. Everything else runs ReAct.
  //   - react: the ReAct loop, with two 0.2.0 opt-ins, both default-off:
  //       · parallelDispatch — parallel-safe tool calls run concurrently.
  //       · reflexion — critique-and-retry after a candidate answer.
  //   - draft-validate: forced draft-then-validate (no escalation —
  //     an explicit override means "use this strategy", not "fall back").
  //
  // DELEGATED LANES (Claude local CLI): the provider is itself an agent
  // — `claude -p` runs its own tool loop against the dev server's MCP
  // bridge and returns finished text. Nesting it inside the react/DV
  // strategies double-drives two agents (the user-found
  // text-as-tool-call failure, trace t-mq9msa9m-xcgt), so the session
  // hard-routes to the delegate strategy (one LLM call per user turn,
  // no playground-side dispatch) and to the lane-composed system prompt
  // that describes the MCP tool surface by its real names. The
  // strategyMode setting is intentionally ignored for these lanes — the
  // Settings UI says so.
  const makeReact = () =>
    createReactLoopStrategy({
      // Lane-aware default (LIVE economics): hosted reasoning lanes
      // (openrouter/claude) default to 16 react iterations; local/stub
      // lanes keep 32. An explicit user setting always wins.
      maxTurns: resolveMaxTurns(settings.maxTurns, useLlmStore.getState().providerId),
      parallelDispatch: settings.parallelDispatch,
      ...(settings.reflexionEnabled
        ? { reflexion: { enabled: true, maxRetries: settings.reflexionMaxRetries } }
        : {}),
    });
  const strategy = delegated
    ? createClaudeDelegateStrategy()
    : createRoutedStrategy({
        makeReact,
        makeDraftValidate: () =>
          createDraftThenValidateStrategy({ maxRepairs: settings.draftMaxRepairs }),
        override: settings.strategyMode,
      });
  const session = createAgentSession({
    tracer,
    strategy,
    // Resolve the active provider from the LLM store at submit time so
    // the picker can swap providers mid-session without re-instantiating
    // anything. Provider implementations read their model id from the
    // same store inside `chatWithTools`.
    llm: (() => {
      const def = PROVIDERS[useLlmStore.getState().providerId];
      // Stale-tool-result pruning (#515, ported from the eval harness —
      // scripts/run-app-build.ts wraps its client the same way): all but
      // the K=3 most-recent tool results in the re-sent history collapse
      // to a one-line stub ({_pruned, tool, ok, summary, bytes, hint})
      // before each model call. Same policy + threshold as the harness's
      // `--prune` (keepLastResults 3). Pure transform at the client seam:
      // strategy internals and @inbrowser/agent's history stay untouched,
      // tool callIds keep their pairing (only `resultJson` is compacted).
      // Draft-validate's repair hatch now threads OpenAI-strict role:'tool'
      // messages WITH callIds (the SF fix), so they prune like any other —
      // the id pairing survives, only bulky results are compacted.
      return withPrunedHistory(callbackProviderAsLlmClient(def.provider, def.id), {
        keepLastResults: 3,
        onPrune: (s) =>
          logPage('prune_history', undefined, { pruned: s.pruned, bytesSaved: s.bytesSaved }),
      });
    })(),
    tools: dispatch,
    toolList: visibleTools,
    toolContext: (): ToolContext => {
      const diagnosticsEnabled = useSettingsStore.getState().pyricDiagnosticsEnabled;
      return {
        workspace: {
          presetId: '',
          rules: '',
          code: '',
          appSource: '',
          stitch: { projectId: null, latestScreenUrl: null, brief: null },
        },
        runtime: {
          terminal: [],
          runSummary: null,
          deploy: null,
          parseError: null,
          uiErrors: [],
          sandboxVersion: 0,
        },
        sandbox: realSandbox(),
        // `lint` always has the same shape (handler callers don't
        // need to know the toggle state); when diagnostics are off
        // it's a noop that returns `{ warnings: [] }`.
        ...makeDiagnosticsContext(diagnosticsEnabled),
        signal: opts.signal,
      };
    },
    // Delegated lanes get the lane-composed prompt: same pinned
    // guidance, but the tool-surface sections describe the MCP bridge's
    // real `mcp__playground__*` names instead of the browser registry.
    systemPromptBuilder: () =>
      delegated
        ? buildClaudeLanePrompt({
            diagnosticsEnabled: useSettingsStore.getState().pyricDiagnosticsEnabled,
          })
        : buildSystemPrompt({
            diagnosticsEnabled: useSettingsStore.getState().pyricDiagnosticsEnabled,
          }),
    metrics,
    history: uiToCoreHistory(history),
    id: `cf-${Date.now().toString(36)}`,
  });

  // Reattach support: while a server-mode LLM request streams, stamp its
  // durable-job id on the streaming assistant message ONCE per request
  // (seq 0 — recovery replays the whole response and appends only the
  // missing suffix, so no per-event re-stamp is needed and the streaming
  // hot path stays untouched). Cleared when each request finishes; if the
  // page dies mid-request, the session-saved stamp lets
  // `recoverInterruptedJobs` finish the response on next load.
  let stampedJobId: string | null = null;
  setServerJobProgressListener((progress) => {
    try {
      if (!progress) {
        if (stampedJobId) {
          stampedJobId = null;
          opts.patchMessage(currentId, { activeJob: undefined });
        }
        return;
      }
      if (progress.jobId === stampedJobId) return;
      stampedJobId = progress.jobId;
      opts.patchMessage(currentId, {
        activeJob: { jobId: progress.jobId, seq: 0, provider: progress.provider },
      });
    } catch {
      // Stamping must never break the turn.
    }
  });

  // ── Stream-chunk coalescing (perf) ──────────────────────────────────
  // A patchMessage per streamed chunk = a full React render (+ markdown
  // re-parse) per token — and after a resumable reconnect the server
  // REPLAYS the backlog as a tight burst of thousands of chunks, which
  // froze the UI for minutes. `currentBuf`/`thinkingBuf` stay the source
  // of truth per chunk; the store patch is throttled to one flush per
  // ~80ms. Every non-stream event flushes first, so tool ordering,
  // chunk snapshots, and turn boundaries observe fully-current text.
  const STREAM_FLUSH_MS = 80;
  let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let streamDirty: { text: boolean; thinking: boolean } = { text: false, thinking: false };
  const flushStreamBufs = () => {
    if (streamFlushTimer) {
      clearTimeout(streamFlushTimer);
      streamFlushTimer = null;
    }
    if (!streamDirty.text && !streamDirty.thinking) return;
    const patch: { text?: string; thinking?: string } = {};
    if (streamDirty.text) patch.text = currentBuf;
    if (streamDirty.thinking) patch.thinking = thinkingBuf;
    streamDirty = { text: false, thinking: false };
    opts.patchMessage(currentId, patch);
  };
  const scheduleStreamFlush = () => {
    if (streamFlushTimer) return;
    streamFlushTimer = setTimeout(flushStreamBufs, STREAM_FLUSH_MS);
  };

  try {
  for await (const ev of session.submit(prompt, opts.signal) as AsyncIterable<SessionEvent>) {
    if (opts.signal.aborted) return;
    // Keep the rendered message current before anything that isn't a
    // stream chunk (tool events, turn boundaries, errors) acts on it.
    if (ev.kind !== 'text' && ev.kind !== 'thinking') flushStreamBufs();
    switch (ev.kind) {
      case 'turn_started':
        if (firstTurn) {
          firstTurn = false;
          turnStart = performance.now();
          // The first turnId is the one the Trace drill-in keys on
          // (`getTurnTrace(turnId)`) — capture it so the SF-S0a
          // provenance milestones stamp the same trace entry.
          turnId = ev.turnId;
          // Now the turnId is known, apply any provenance the router
          // already reported (the common case — routing fires first).
          flushProvenance();
          // Stamp the user prompt and first assistant message with
          // the session-emitted turnId so the Trace drill-in can
          // look up `getTurnTrace(turnId)` from the chat
          // message we're rendering.
          opts.patchMessage(userId, { turnId: ev.turnId });
          opts.patchMessage(currentId, { turnId: ev.turnId });
        } else {
          opts.patchMessage(currentId, { streaming: false });
          const id = `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          const { providerLabel, modelLabel } = activeProviderModelLabels();
          opts.appendMessage({
            id,
            role: 'assistant',
            text: '',
            createdAt: Date.now(),
            streaming: true,
            providerLabel,
            modelLabel,
          });
          currentId = id;
          currentBuf = '';
          thinkingBuf = '';
          turnStart = performance.now();
          turnMetrics.reset(); // fresh assistant message → fresh totals
        }
        break;
      case 'text':
        currentBuf += ev.chunk;
        streamDirty.text = true;
        scheduleStreamFlush();
        break;
      case 'thinking':
        thinkingBuf += ev.chunk;
        streamDirty.thinking = true;
        scheduleStreamFlush();
        break;
      case 'tool_started': {
        const existingMsg =
          useChatStore.getState().messages.find((m) => m.id === currentId);
        const existing = existingMsg?.toolCalls ?? [];
        const existingChunks = existingMsg?.textChunks ?? [];
        const existingThinkingChunks = existingMsg?.thinkingChunks ?? [];
        // Capture WHEN the model emitted this call + WHAT thinking
        // had accumulated up to that moment. The drill-in uses these
        // for the "time into turn" stat and the "reasoning that led
        // here" fold. Subsequent thinking chunks belong to the next
        // call (or to the final answer); they don't get attributed
        // here.
        const next: ToolCall = {
          id: ev.callId,
          name: ev.name,
          argsJson: stringifyArgs(ev.args),
          summary: `${ev.name} · running…`,
          emittedAt: Date.now(),
          ...(thinkingBuf.length > 0 ? { thinkingUpToHere: thinkingBuf } : {}),
          ...(ev.signature ? { signature: ev.signature } : {}),
        };
        // Snapshot the text the model emitted since the LAST chunk
        // boundary (= prior tool_started or turn start) so the
        // renderer can interleave text and tool calls chronologically.
        // Skip the snapshot when there's no new text since the last
        // boundary — keeps the chunks array tight when the model
        // chains calls back-to-back.
        const priorChunkTextLen = existingChunks.reduce((a, c) => a + c.text.length, 0);
        const newText = currentBuf.slice(priorChunkTextLen);
        const nextChunks = newText.length > 0
          ? [...existingChunks, { text: newText, ts: Date.now() }]
          : existingChunks;
        const priorThinkingLen = existingThinkingChunks.reduce((a, c) => a + c.text.length, 0);
        const newThinking = thinkingBuf.slice(priorThinkingLen);
        const nextThinkingChunks = newThinking.length > 0
          ? [...existingThinkingChunks, { text: newThinking, ts: Date.now() }]
          : existingThinkingChunks;
        opts.patchMessage(currentId, {
          toolCalls: [...existing, next],
          textChunks: nextChunks,
          thinkingChunks: nextThinkingChunks,
        });
        break;
      }
      case 'tool_finished':
        opts.patchToolCall(currentId, ev.callId, {
          ok: ev.result.ok,
          summary: ev.result.summary,
          resultJson: stringifyArgs(ev.result.data),
        });
        break;
      case 'turn_completed': {
        const durationMs = Math.round(performance.now() - turnStart);
        // Fold this iteration's usage into the whole-turn totals; the
        // message metrics below always reflect the running SUM, so the
        // final patch (last iteration) carries the full turn.
        const agg = turnMetrics.add(ev.metrics);
        const cost = resolveTurnCost(agg);
        if (delegated) {
          currentBuf = finalizeClaudeTranscript(currentBuf);
        }
        // Final snapshot — capture any text emitted after the last
        // tool call (the closing reply) as the trailing chunk. The
        // renderer interleaves textChunks with toolCalls by ts; this
        // chunk lands strictly after every prior tool call's
        // emittedAt, so it ends the timeline.
        const finalMsg =
          useChatStore.getState().messages.find((m) => m.id === currentId);
        const priorChunks = finalMsg?.textChunks ?? [];
        const priorLen = priorChunks.reduce((a, c) => a + c.text.length, 0);
        const tailText = currentBuf.slice(priorLen);
        const finalChunks = tailText.length > 0
          ? [...priorChunks, { text: tailText, ts: Date.now() }]
          : priorChunks;
        const priorThinkingChunks = finalMsg?.thinkingChunks ?? [];
        const priorThinkingLen = priorThinkingChunks.reduce((a, c) => a + c.text.length, 0);
        const tailThinking = thinkingBuf.slice(priorThinkingLen);
        const finalThinkingChunks = tailThinking.length > 0
          ? [...priorThinkingChunks, { text: tailThinking, ts: Date.now() }]
          : priorThinkingChunks;
        opts.patchMessage(currentId, {
          text: currentBuf,
          textChunks: finalChunks,
          thinkingChunks: finalThinkingChunks,
          metrics: {
            durationMs,
            tokensIn: agg.tokensIn,
            tokensOut: agg.tokensOut,
            tokensTotal: agg.tokensIn + agg.tokensOut,
            ...(cost.costUsd !== null
              ? { costUsd: cost.costUsd, costEstimated: cost.costEstimated }
              : {}),
            cachedTokens: agg.tokensCached,
            reasoningTokens: agg.tokensReasoning,
            ...(agg.isByok !== undefined ? { isByok: agg.isByok } : {}),
          },
        });
        break;
      }
      case 'error':
        opts.patchMessage(currentId, {
          text: currentBuf || `_(error: ${ev.message})_`,
          streaming: false,
        });
        throw new Error(ev.message);
      case 'strategy_event': {
        // SF-S0a provenance: the router's routing decision and bounded
        // escalation milestones become trace `hostCtx` provenance. Buffered
        // and flushed (routing arrives BEFORE the inner strategy's first
        // turn_started; escalation arrives later and overrides the routing
        // decision, since the escalated strategy is what finished the turn).
        if (ev.name === 'strategy_routed') {
          const prov = provenanceFromRouted((ev.data ?? {}) as Record<string, unknown>);
          if (prov) {
            pendingProv = prov;
            flushProvenance();
          }
        } else if (ev.name === 'strategy_escalated') {
          pendingProv = provenanceFromEscalated((ev.data ?? {}) as Record<string, unknown>);
          flushProvenance();
        }
        // Reflexion (0.2.0) surfaces each critique decision here. Attach
        // it to the current assistant message so AssistantBlock can show
        // a critique strip; `retry`/`exhausted` carry the feedback the
        // model was asked to address. Other strategy events are ignored.
        if (ev.name === 'reflexion_critique') {
          const d = (ev.data ?? {}) as {
            verdict?: string;
            text?: string;
            feedback?: string;
          };
          const verdict: ReflexionCritique['verdict'] =
            d.verdict === 'retry' ? 'retry' : d.verdict === 'exhausted' ? 'exhausted' : 'ok';
          const critique: ReflexionCritique = {
            verdict,
            ...(typeof d.text === 'string' ? { text: d.text } : {}),
            ...(typeof d.feedback === 'string' ? { feedback: d.feedback } : {}),
          };
          const msg = useChatStore.getState().messages.find((m) => m.id === currentId);
          opts.patchMessage(currentId, {
            reflexionCritiques: [...(msg?.reflexionCritiques ?? []), critique],
          });
        } else if (DRAFT_VALIDATE_EVENTS.has(ev.name)) {
          // draft-then-validate phase milestones — attach raw so
          // AssistantBlock can render a phase strip. Stored generically;
          // the component formats by name.
          const msg = useChatStore.getState().messages.find((m) => m.id === currentId);
          opts.patchMessage(currentId, {
            phaseEvents: [
              ...(msg?.phaseEvents ?? []),
              { name: ev.name, ...(ev.data ? { data: ev.data as Record<string, unknown> } : {}) },
            ],
          });
        } else if (ev.name === 'delegated_activity') {
          const activity = ev.data as DelegatedActivity;
          const msg = useChatStore.getState().messages.find((m) => m.id === currentId);
          opts.patchMessage(currentId, {
            delegatedActivity: [...(msg?.delegatedActivity ?? []), activity],
          });
        } else if (ev.name === 'delegated_activity_update') {
          const { id, resultSummary } = ev.data as { id: string; resultSummary: string };
          const msg = useChatStore.getState().messages.find((m) => m.id === currentId);
          opts.patchMessage(currentId, {
            delegatedActivity: (msg?.delegatedActivity ?? []).map((a) =>
              a.id === id ? { ...a, resultSummary } : a,
            ),
          });
        } else if (ev.name === 'delegated_transcript') {
          const raw = (ev.data as { raw?: string } | undefined)?.raw;
          if (typeof raw === 'string') {
            opts.patchMessage(currentId, { rawTranscript: raw });
          }
        }
        break;
      }
      case 'completed':
      case 'workspace_changed':
      case 'runtime_changed':
        break;
    }
  }
  } finally {
    // Land the tail of the throttled stream buffer (≤80ms of text) —
    // covers completion, thrown errors, and user aborts alike.
    flushStreamBufs();
    // Turn over (completed, errored, or aborted) — stop observing job
    // progress. The inference layer already sent a final `null` per
    // request, so any surviving `activeJob` stamp means the page died
    // mid-request (the reattach case), not a code path we missed.
    setServerJobProgressListener(null);
  }
}
