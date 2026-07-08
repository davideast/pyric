/**
 * Model-bound history under the append-only + compaction-events design
 * (plans/context-compaction-redesign.md).
 *
 * Per dispatch:
 *   1. Apply the latest persisted CompactionMarker: history = marker
 *      summary + messages after its boundary. (No marker → full
 *      history — verbatim recall, cache-stable prefix.)
 *   2. If the result crosses the threshold — min(70% of the active
 *      model's window, 150k hard cap) — or the user hit "Compact now",
 *      run a MODEL-WRITTEN summarization request on the active lane,
 *      persist a new marker, and re-apply. Mechanical fallback on any
 *      summarization failure: a turn is never blocked on compaction.
 *
 * Stale tool RESULTS are a separate, continuous lever handled at the
 * client seam (`withPrunedHistory`, keepLastResults 3).
 */
import {
  applyCompactionMarker,
  buildCompactionPrompt,
  mechanicalSummary,
  shouldCompact,
  splitForCompaction,
  type CompactionMarker,
} from '~/lib/agent/context-management';
import { callbackProviderAsModelClient } from '~/lib/llm/callback-adapter';
import { PROVIDERS } from '~/lib/llm/registry';
import { useChatStore, type ChatMessage } from '~/lib/store/chat';
import { useLlmStore } from '~/lib/store/llm';
import { logPage } from '~/lib/llm/inference/diagnostics';

const KEEP_RECENT_USER_TURNS = 4;
/** Summarization request output cap-ish guard: bail to mechanical when
 *  the model returns something uselessly short. */
const MIN_MODEL_SUMMARY_CHARS = 200;

function summaryMessage(input: {
  id: string;
  role: 'assistant';
  text: string;
  createdAt: number;
}): ChatMessage {
  return { ...input };
}

function activeWindowTokens(): number | undefined {
  const s = useLlmStore.getState();
  const def = PROVIDERS[s.providerId];
  const model = def?.models.find((m) => m.id === s.modelId) ?? def?.models[0];
  return model?.contextWindowTokens;
}

function latestMarker(): CompactionMarker | null {
  const markers = useChatStore.getState().compactionMarkers;
  return markers.length > 0 ? markers[markers.length - 1]! : null;
}

function applyLatestMarker(messages: readonly ChatMessage[]): ChatMessage[] {
  const marker = latestMarker();
  if (!marker) return messages.slice();
  const { messages: applied, applied: ok } = applyCompactionMarker(
    marker,
    messages,
    summaryMessage,
  );
  if (!ok) {
    logPage('compaction_marker_unapplied', undefined, { atMessageId: marker.atMessageId });
  }
  return applied;
}

/** One-shot summarization request on the ACTIVE lane. Returns null on
 *  any failure — the caller falls back to the mechanical summary. */
async function modelWrittenSummary(older: readonly ChatMessage[]): Promise<string | null> {
  try {
    const def = PROVIDERS[useLlmStore.getState().providerId];
    if (!def) return null;
    const llm = callbackProviderAsModelClient(def.provider, def.id);
    const prompt = buildCompactionPrompt(older);
    let text = '';
    for await (const ev of llm.chat(
      {
        messages: [{ role: 'user', text: prompt }],
        tools: [],
        toolUseEnabled: false,
      },
      new AbortController().signal,
    )) {
      if (ev.kind === 'text') text += ev.text;
      else if (ev.kind === 'error') return null;
    }
    return text.trim().length >= MIN_MODEL_SUMMARY_CHARS ? text.trim() : null;
  } catch {
    return null;
  }
}

export interface ResolveOptions {
  forceCompact?: boolean;
}

/**
 * Resolve the model-bound history for this dispatch, running (and
 * persisting) a compaction event first when warranted.
 */
export async function resolveModelHistory(
  rawHistory: readonly ChatMessage[],
  opts: ResolveOptions = {},
): Promise<ChatMessage[]> {
  let history = applyLatestMarker(rawHistory);

  const decision = shouldCompact(history, { windowTokens: activeWindowTokens() });
  if (!decision.compact && !opts.forceCompact) return history;

  const split = splitForCompaction(history, { keepRecentUserTurns: KEEP_RECENT_USER_TURNS });
  if (!split) return history; // too little history — nothing to do

  const modelSummary = await modelWrittenSummary(split.older);
  const summaryText = modelSummary ?? mechanicalSummary(split.older);
  const source: CompactionMarker['source'] = modelSummary ? 'model' : 'mechanical';

  // Boundary ids must reference the DURABLE transcript, not the
  // marker-applied view: when a previous marker was applied, history[0]
  // is a synthetic summary message that never exists in the chat store.
  // splitForCompaction boundaries always land on real messages except
  // when the split consumes the synthetic head — in that case the last
  // older REAL message id is used.
  const lastRealOlder = [...split.older].reverse().find((m) => !m.id.startsWith('compaction-'));
  const atMessageId = lastRealOlder?.id ?? split.atMessageId;

  const marker: CompactionMarker = {
    atMessageId,
    summaryText,
    beforeTokens: decision.historyTokens,
    afterTokens: Math.round(
      (summaryText.length +
        split.recent.reduce((n, m) => n + m.text.length + (m.thinking?.length ?? 0), 0)) /
        4,
    ),
    ts: Date.now(),
    source,
  };
  useChatStore.getState().appendCompactionMarker(marker);
  logPage('compaction_event', undefined, {
    source,
    forced: Boolean(opts.forceCompact),
    beforeTokens: marker.beforeTokens,
    afterTokens: marker.afterTokens,
    olderMessages: split.older.length,
  });

  const reapplied = applyCompactionMarker(marker, rawHistory, summaryMessage);
  return reapplied.applied ? reapplied.messages : history;
}
