import {
  buildContextWindowSnapshot as buildContextWindowSnapshotBase,
  formatContextPercent,
  formatContextRatio,
  formatContextTokens as formatContextTokensBase,
  type BuildContextWindowSnapshotOptions as BaseBuildContextWindowSnapshotOptions,
  type ContextWindowBasis,
  type ContextWindowBreakdownRow,
  type ContextWindowCompactionPreview,
  type ContextWindowInputComposition,
  type ContextWindowPricing,
  type ContextWindowPromptCostEstimate,
  type ContextWindowPromptCostEstimator,
  type ContextWindowSessionCacheInsight,
  type ContextWindowSessionCategoryDetail,
  type ContextWindowSessionDetailRow,
  type ContextWindowSessionRequest,
  type ContextWindowSessionSpendCategoryId,
  type ContextWindowSessionToolRef,
  type ContextWindowSessionTurn,
  type ContextWindowSessionUsage,
  type ContextWindowSnapshot,
  type ContextWindowStatus,
  type SessionRequestUsage,
  type SessionTokenUsage,
  type SessionTurnUsage,
  type SessionUsageCategoryDetail,
  type SessionUsageDetailRow,
} from '@inbrowser/agent/usage';
import type { ToolHandler } from '@inbrowser/agent';
import { estimatePromptInputCostUsd, type PromptInputPricing } from '~/lib/llm/pricing';
import { estimateTokens } from '~/lib/tools/behavior';
import type { ChatMessage } from '~/lib/store/chat';
import type { TurnTrace } from '~/lib/store/trace';
import {
  applyCompactionMarker,
  editToolResults,
  type CompactionMarker,
} from './context-management';

export {
  formatContextPercent,
  formatContextRatio,
};
export type {
  ContextWindowBasis,
  ContextWindowBreakdownRow,
  ContextWindowCompactionPreview,
  ContextWindowInputComposition,
  ContextWindowPricing,
  ContextWindowPromptCostEstimate,
  ContextWindowPromptCostEstimator,
  ContextWindowSessionCacheInsight,
  ContextWindowSessionCategoryDetail,
  ContextWindowSessionDetailRow,
  ContextWindowSessionRequest,
  ContextWindowSessionSpendCategoryId,
  ContextWindowSessionToolRef,
  ContextWindowSessionTurn,
  ContextWindowSessionUsage,
  ContextWindowSnapshot,
  ContextWindowStatus,
  SessionRequestUsage,
  SessionTokenUsage,
  SessionTurnUsage,
  SessionUsageCategoryDetail,
  SessionUsageDetailRow,
};

export interface BuildContextWindowSnapshotOptions
  extends Omit<
    BaseBuildContextWindowSnapshotOptions<ChatMessage>,
    'compactHistory' | 'compactionOptions' | 'estimatePromptInputCost' | 'estimateTokens' | 'tools' | 'tracesByTurn'
  > {
  tools: readonly ToolHandler[];
  promptPricing?: PromptInputPricing | null;
  tracesByTurn?: Record<string, TurnTrace>;
  /** Persisted compaction markers (chat store) — the latest one defines
   *  the model-bound boundary for the next-send estimate. */
  compactionMarkers?: readonly CompactionMarker[];
}

export function buildContextWindowSnapshot(
  opts: BuildContextWindowSnapshotOptions,
): ContextWindowSnapshot {
  const { compactionMarkers, ...rest } = opts;
  return buildContextWindowSnapshotBase({
    ...rest,
    tools: opts.tools,
    tracesByTurn: opts.tracesByTurn,
    estimateTokens: tokenEstimate,
    compactHistory: (messages) => estimateModelBoundHistory(messages, compactionMarkers ?? []),
    estimatePromptInputCost: ({ providerId, modelId, promptTokens, cachedTokens }) =>
      estimatePromptInputCostUsd(
        providerId,
        modelId,
        promptTokens,
        cachedTokens,
        opts.promptPricing,
      ),
  });
}

function tokenEstimate(value: string | undefined | null): number {
  return estimateTokens(value) ?? 0;
}

/**
 * Mirror of what the dispatch pipeline actually sends: the latest
 * compaction marker's summary + messages after its boundary, with stale
 * tool results cleared (lever 1). Replaces the removed per-dispatch
 * `compactHistoryForModel` so the next-send estimate matches reality
 * under the append-only + compaction-events model
 * (plans/context-compaction-redesign.md).
 */
function estimateModelBoundHistory(
  messages: readonly ChatMessage[],
  markers: readonly CompactionMarker[],
): { messages: ChatMessage[]; stats: ReturnType<typeof compactionStats> } {
  const marker = markers.length > 0 ? markers[markers.length - 1]! : null;
  let applied: ChatMessage[] = messages.slice();
  let markerApplied = false;
  let messagesCompacted = 0;
  if (marker) {
    const res = applyCompactionMarker(marker, messages, (input) => ({ ...input }) as ChatMessage);
    if (res.applied) {
      markerApplied = true;
      messagesCompacted = messages.length - (res.messages.length - 1);
      applied = res.messages;
    }
  }
  const { messages: edited, stats } = editToolResults(applied, { keepResultsRecentTurns: 4 });
  return {
    messages: edited,
    stats: compactionStats({
      compacted: markerApplied || stats.clearedResults > 0,
      originalChars: messageChars(messages),
      compactedChars: messageChars(edited),
      messagesCompacted,
    }),
  };
}

function compactionStats(input: {
  compacted: boolean;
  originalChars: number;
  compactedChars: number;
  messagesCompacted: number;
}) {
  return {
    compacted: input.compacted,
    originalChars: input.originalChars,
    compactedChars: input.compactedChars,
    bytesSaved: Math.max(0, input.originalChars - input.compactedChars),
    turnsCompacted: 0,
    messagesCompacted: input.messagesCompacted,
  };
}

function messageChars(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += m.text.length + (m.thinking?.length ?? 0);
    for (const call of m.toolCalls ?? []) {
      total += call.argsJson.length + (call.resultJson?.length ?? 0);
    }
  }
  return total;
}


/**
 * Token formatting with a millions tier — overrides the base
 * formatter, which renders 14,586,103 as "14586k". One rule
 * everywhere: <1k exact · <100k one-decimal k · <1M whole k ·
 * >=1M two-decimal M. Pair with `formatExactTokens` in titles so
 * every abbreviation carries the precise count.
 */
export function formatContextTokens(n: number): string {
  const base = formatContextTokensBase(n);
  if (n < 1_000_000) return base;
  const m = (n / 1_000_000).toFixed(2);
  return `${m.endsWith('.00') ? m.slice(0, -3) : m}M`;
}

/** Exact count with thousands separators — for tooltips/titles. */
export function formatExactTokens(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString('en-US');
}
