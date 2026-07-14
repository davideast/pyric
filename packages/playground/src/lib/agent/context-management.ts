/**
 * VENDORED from @inbrowser/agent's context-management module —
 * DELETE this file and import from '@inbrowser/agent/usage' once that
 * public entrypoint re-exports the runtime functions.
 *
 * @inbrowser/agent@0.4.2 ships the compiled module under
 * `dist/usage/context-management.js`, but does not expose that subpath
 * through package.json `exports`, and `@inbrowser/agent/usage` does not
 * re-export the runtime functions. Keep this local copy until the
 * public usage entrypoint exports these symbols.
 */
/**
 * Context management — append-only history with two independent levers,
 * replacing the per-dispatch history rewrite (`compactHistoryForModel`).
 *
 * WHY (measured in the pyric playground, 291-request session): rewriting
 * the model-bound history every dispatch gave agents a permanent 2-turn
 * memory horizon (constant re-reading, ~32 requests/turn) and rewrote the
 * prompt PREFIX every turn (cross-turn provider-cache misses). The modern
 * split — mirrored from the Anthropic API's context-editing vs compaction
 * features — is:
 *
 *   Lever 1 `editToolResults` — continuous + cheap: clear stale tool
 *   RESULTS (never conversation text) older than N user turns.
 *   Idempotent, so the prompt prefix stays byte-stable up to the sliding
 *   boundary and cross-turn caching works.
 *
 *   Lever 2 compaction — a rare EVENT: when history crosses a threshold,
 *   the HOST runs a summarization request (model-written memory) and
 *   persists a `CompactionMarker`; the model-bound history becomes
 *   marker-summary + everything after its boundary. `mechanicalSummary`
 *   is the fallback when the summarization call fails — a turn is never
 *   blocked on compaction.
 *
 * This module is pure functions over `ModelContextMessageLike` — the
 * host owns the summarization request, marker persistence, and UI.
 */
import { estimateHistoryChars } from '@inbrowser/agent/usage';
import type {
  ModelContextMessageLike,
  ModelContextToolCallLike,
} from '@inbrowser/agent/usage';

// ── Lever 1: context editing (tool-result clearing) ──────────────────

export interface ContextEditOptions {
  /** User turns whose tool results stay verbatim. Default 4. */
  keepResultsRecentTurns?: number;
  /** One-line summary for a cleared call. Default: name + arg preview. */
  summarizeToolCall?: (call: ModelContextToolCallLike) => string;
}

export interface ContextEditStats {
  clearedResults: number;
  clearedChars: number;
}

export interface ContextEditResult<TMessage extends ModelContextMessageLike> {
  messages: TMessage[];
  stats: ContextEditStats;
}

const CLEARED_KEY = '__contextEdited';

/** A cleared result payload — detectable so clearing is idempotent. */
function clearedResult(summary: string): string {
  return JSON.stringify({ [CLEARED_KEY]: true, summary });
}

export function isClearedResult(resultJson: string | undefined): boolean {
  if (!resultJson || resultJson.indexOf(CLEARED_KEY) === -1) return false;
  try {
    const parsed = JSON.parse(resultJson) as Record<string, unknown>;
    return parsed[CLEARED_KEY] === true;
  } catch {
    return false;
  }
}

function defaultSummarizeToolCall(call: ModelContextToolCallLike): string {
  if (call.summary) return `${call.name}: ${call.summary}`;
  const args = call.argsJson.length > 120 ? `${call.argsJson.slice(0, 120)}…` : call.argsJson;
  return `${call.name}(${args})`;
}

/**
 * Clear tool results on every message OLDER than the last
 * `keepResultsRecentTurns` user turns. Conversation text, thinking, and
 * the tool call's name/args are untouched — only `resultJson` is
 * replaced with a one-line summary payload.
 *
 * Idempotent by construction: already-cleared results are skipped, and
 * messages inside the keep window are returned by reference. Two
 * consecutive applications produce byte-identical output for the
 * prefix, which is what keeps provider prompt caches warm across turns.
 */
export function editToolResults<TMessage extends ModelContextMessageLike>(
  messages: readonly TMessage[],
  opts: ContextEditOptions = {},
): ContextEditResult<TMessage> {
  const keepRecent = Math.max(1, opts.keepResultsRecentTurns ?? 4);
  const summarize = opts.summarizeToolCall ?? defaultSummarizeToolCall;

  const userIndexes = messages
    .map((m, i) => (m.role === 'user' ? i : -1))
    .filter((i) => i >= 0);
  const boundary =
    userIndexes.length > keepRecent ? userIndexes[userIndexes.length - keepRecent]! : 0;

  let clearedResults = 0;
  let clearedChars = 0;
  const out = messages.map((message, index) => {
    if (index >= boundary) return message;
    const calls = message.toolCalls;
    if (!calls || calls.length === 0) return message;
    let changed = false;
    const nextCalls = calls.map((call) => {
      if (!call.resultJson || isClearedResult(call.resultJson)) return call;
      clearedResults += 1;
      const replacement = clearedResult(summarize(call));
      clearedChars += Math.max(0, call.resultJson.length - replacement.length);
      changed = true;
      return { ...call, resultJson: replacement };
    });
    if (!changed) return message;
    return { ...message, toolCalls: nextCalls };
  });

  return { messages: out, stats: { clearedResults, clearedChars } };
}

// ── Lever 2: compaction (the event) ─────────────────────────────────

export interface CompactionPolicy {
  /** The active model's context window, in tokens. */
  windowTokens?: number;
  /** Fraction of the window that triggers compaction. Default 0.7. */
  ratio?: number;
  /**
   * Quality ceiling, in tokens — long-context recall degrades well
   * before big windows fill, so history is capped even on 1M-context
   * models. Default 150k (matches Claude Code's compaction trigger).
   */
  hardCapTokens?: number;
  /** chars→tokens estimator. Default chars/4. */
  estimateTokens?: (chars: number) => number;
}

export interface CompactionDecision {
  compact: boolean;
  historyTokens: number;
  thresholdTokens: number;
}

export const COMPACTION_DEFAULT_RATIO = 0.7;
export const COMPACTION_DEFAULT_HARD_CAP_TOKENS = 150_000;

export function shouldCompact(
  messages: readonly ModelContextMessageLike[],
  policy: CompactionPolicy = {},
): CompactionDecision {
  const estimate = policy.estimateTokens ?? ((chars: number) => Math.round(chars / 4));
  const historyTokens = estimate(estimateHistoryChars(messages));
  const ratio = policy.ratio ?? COMPACTION_DEFAULT_RATIO;
  const hardCap = policy.hardCapTokens ?? COMPACTION_DEFAULT_HARD_CAP_TOKENS;
  const windowTerm = policy.windowTokens ? Math.floor(policy.windowTokens * ratio) : Infinity;
  const thresholdTokens = Math.min(windowTerm, hardCap);
  return { compact: historyTokens > thresholdTokens, historyTokens, thresholdTokens };
}

export interface CompactionSplit<TMessage extends ModelContextMessageLike> {
  /** Messages the summary will replace. */
  older: TMessage[];
  /** Messages kept verbatim after the boundary. */
  recent: TMessage[];
  /** Id of the LAST older message — the marker's boundary. */
  atMessageId: string;
}

/**
 * Split history for a compaction event, keeping the most recent
 * `keepRecentUserTurns` user turns (default 4) verbatim. Returns null
 * when there is nothing meaningful to compact (too few turns, or an
 * empty older segment).
 */
export function splitForCompaction<TMessage extends ModelContextMessageLike>(
  messages: readonly TMessage[],
  opts: { keepRecentUserTurns?: number } = {},
): CompactionSplit<TMessage> | null {
  const keepRecent = Math.max(1, opts.keepRecentUserTurns ?? 4);
  const userIndexes = messages
    .map((m, i) => (m.role === 'user' ? i : -1))
    .filter((i) => i >= 0);
  if (userIndexes.length <= keepRecent) return null;
  const keepStart = userIndexes[userIndexes.length - keepRecent]!;
  if (keepStart === 0) return null;
  const older = messages.slice(0, keepStart);
  const last = older[older.length - 1]!;
  return { older, recent: messages.slice(keepStart), atMessageId: last.id };
}

/**
 * The summarization request body — the contract for the MODEL-WRITTEN
 * memory. Serializes the older history compactly (texts previewed,
 * tool calls as one-liners) and instructs the model to produce a
 * memory document, not a paraphrase.
 */
export function buildCompactionPrompt(
  older: readonly ModelContextMessageLike[],
  opts: { summarizeToolCall?: (call: ModelContextToolCallLike) => string } = {},
): string {
  const summarize = opts.summarizeToolCall ?? defaultSummarizeToolCall;
  const lines: string[] = [];
  for (const m of older) {
    if (m.text) lines.push(`${m.role}: ${preview(m.text, 600)}`);
    for (const call of m.toolCalls ?? []) {
      lines.push(`tool: ${summarize(call)}`);
    }
  }
  return [
    'You are compacting an agent session so work can continue with a smaller context.',
    'Write a MEMORY DOCUMENT for your future self — not a narrative summary. Capture, as terse bullet lists:',
    '- DECISIONS made and constraints stated by the user (verbatim where load-bearing)',
    '- CURRENT TASK STATE: what is done, what is in progress, what is next',
    '- FILES: paths touched, and the last-known relevant content/shape of each (schemas, key functions, rules)',
    '- OPEN THREADS: unresolved errors, promises made, things to verify',
    'Omit pleasantries, narration, and anything derivable from the workspace itself.',
    '',
    '--- SESSION HISTORY (oldest first, tool calls summarized) ---',
    ...lines,
  ].join('\n');
}

export interface CompactionMarker {
  /** Boundary: model-bound history = summary + messages AFTER this id. */
  atMessageId: string;
  summaryText: string;
  beforeTokens: number;
  afterTokens: number;
  ts: number;
  source: 'model' | 'mechanical';
}

/**
 * Mechanical fallback summary — used when the host's summarization
 * request fails. Deterministic turn-grouped previews; strictly worse
 * than a model-written memory but never blocks a turn.
 */
export function mechanicalSummary(older: readonly ModelContextMessageLike[]): string {
  const lines: string[] = [
    'Prior conversation memory (mechanically compacted; full transcript preserved in the UI):',
  ];
  let toolLines = 0;
  for (const m of older) {
    if (m.role === 'user' && m.text) lines.push(`\nUser: ${preview(m.text, 360)}`);
    if (m.role === 'assistant' && m.text) lines.push(`Assistant: ${preview(m.text, 420)}`);
    for (const call of m.toolCalls ?? []) {
      if (toolLines >= 120) continue;
      lines.push(`Tool: ${defaultSummarizeToolCall(call)}`);
      toolLines += 1;
    }
  }
  if (toolLines >= 120) lines.push('Tool: additional older tool calls omitted');
  return lines.join('\n');
}

/**
 * Apply a persisted marker: model-bound history = one synthetic
 * assistant message carrying the summary + everything after the
 * boundary. When the boundary id is missing (history was replaced),
 * the marker is IGNORED and the full history returned — fail-open to
 * completeness, never to silent loss.
 */
export function applyCompactionMarker<TMessage extends ModelContextMessageLike>(
  marker: CompactionMarker,
  messages: readonly TMessage[],
  createSummaryMessage: (input: {
    id: string;
    role: 'assistant';
    text: string;
    createdAt: number;
  }) => TMessage,
): { messages: TMessage[]; applied: boolean } {
  const idx = messages.findIndex((m) => m.id === marker.atMessageId);
  if (idx === -1) return { messages: messages.slice(), applied: false };
  const summary = createSummaryMessage({
    id: `compaction-${marker.ts}`,
    role: 'assistant',
    text: `[Session memory — compacted ${marker.source === 'model' ? 'by the model' : 'mechanically'}]\n${marker.summaryText}`,
    createdAt: marker.ts,
  });
  return { messages: [summary, ...messages.slice(idx + 1)], applied: true };
}

function preview(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
