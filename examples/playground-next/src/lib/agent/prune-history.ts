/**
 * Bounded tool-result history (Epic #505, issue #515).
 *
 * The ReAct loop appends every tool result (simulate traces, write_file
 * echoes, lint dumps) to the conversation and re-sends the whole thing on
 * each iteration. Old results are rarely needed verbatim, yet they grow the
 * input unboundedly — the accumulation half of the context blowup (the static
 * prefix is the other half: #512/#513).
 *
 * `pruneToolHistory` is a pure transform over the message list: keep the last
 * K tool results in full, and SUMMARIZE older ones — preserve each result's
 * `ok` + one-line `summary` (so the model still knows what the call did) while
 * dropping the bulky `data` (the per-expression simulate trace, the diff
 * stats, the sampled docs). `withPrunedHistory` wraps any `ModelClient` to apply
 * it to `req.messages` just before the model call, so it works under any
 * strategy without touching the loop internals.
 *
 * Conservative by construction: only `role:'tool'` messages are ever touched,
 * the K most-recent results are always intact (the model always sees its
 * latest output), and an already-pruned or unparseable result is left as-is.
 */
import type { ModelClient } from '@inbrowser/agent';

/** Structural view of a normalized message — matches `@inbrowser/agent`'s
 *  `ModelMessage` for the fields we read, without importing the type. */
export interface NormMsgLike {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text?: string;
  toolCalls?: unknown;
  callId?: string;
  name?: string;
  resultJson?: string;
}

export interface PruneOpts {
  /** Keep this many of the most-recent tool results verbatim; older ones are
   *  summarized. Default 3. Must be >= 1 so the latest result is never lost. */
  keepLastResults?: number;
}

export interface PruneStats {
  /** Tool-result messages summarized (not counting the kept-last-K). */
  pruned: number;
  /** Bytes of `resultJson` elided (original length − summary length). */
  bytesSaved: number;
}

/** Pure transform: returns a new message array with old tool results
 *  summarized. Also returns how much was elided (for measurement). */
export function pruneToolHistoryWithStats<M extends NormMsgLike>(
  messages: readonly M[],
  opts: PruneOpts = {},
): { messages: M[]; stats: PruneStats } {
  const keep = Math.max(1, opts.keepLastResults ?? 3);
  const toolIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'tool') toolIdx.push(i);
  });
  if (toolIdx.length <= keep) {
    return { messages: messages.slice() as M[], stats: { pruned: 0, bytesSaved: 0 } };
  }
  // Everything except the last `keep` tool results gets summarized.
  const toSummarize = new Set(toolIdx.slice(0, toolIdx.length - keep));
  let pruned = 0;
  let bytesSaved = 0;
  const out = messages.map((m, i) => {
    if (!toSummarize.has(i)) return m;
    const original = m.resultJson ?? '';
    const summary = summarizeResult(original, m.name);
    if (summary.length < original.length) {
      pruned += 1;
      bytesSaved += original.length - summary.length;
      return { ...m, resultJson: summary };
    }
    return m;
  });
  return { messages: out, stats: { pruned, bytesSaved } };
}

/** Convenience: transform only (drops the stats). */
export function pruneToolHistory<M extends NormMsgLike>(messages: readonly M[], opts: PruneOpts = {}): M[] {
  return pruneToolHistoryWithStats(messages, opts).messages;
}

/** Replace a tool result with a compact stand-in: keep `ok` + `summary`,
 *  drop everything bulky. Leaves non-JSON / already-pruned results alone. */
function summarizeResult(resultJson: string, name: string | undefined): string {
  if (!resultJson) return resultJson;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    // Non-JSON payload — only truncate if it's actually large.
    if (resultJson.length <= 240) return resultJson;
    return JSON.stringify({ _pruned: true, tool: name ?? 'tool', bytes: resultJson.length, hint: PRUNE_HINT });
  }
  if (parsed && typeof parsed === 'object' && (parsed as { _pruned?: unknown })._pruned) {
    return resultJson; // already summarized on a prior turn
  }
  const obj = (parsed ?? {}) as { ok?: unknown; summary?: unknown };
  const compact = {
    _pruned: true,
    tool: name ?? undefined,
    ok: typeof obj.ok === 'boolean' ? obj.ok : undefined,
    summary: typeof obj.summary === 'string' ? obj.summary : undefined,
    bytes: resultJson.length,
    hint: PRUNE_HINT,
  };
  return JSON.stringify(compact);
}

const PRUNE_HINT = 'older tool result trimmed to bound context; re-call the tool if you need its full output again';

/** Wrap a `ModelClient` so every chat request has its tool history pruned
 *  before the model sees it. `onPrune` receives per-call stats (measurement). */
export function withPrunedHistory(
  inner: ModelClient,
  opts: PruneOpts & { onPrune?: (stats: PruneStats) => void } = {},
): ModelClient {
  const { onPrune, ...pruneOpts } = opts;
  return {
    ...inner,
    async *chat(req: { messages: NormMsgLike[] }, signal: AbortSignal) {
      const { messages, stats } = pruneToolHistoryWithStats(req.messages, pruneOpts);
      if (onPrune && stats.pruned > 0) onPrune(stats);
      yield* (inner.chat as (r: unknown, s: AbortSignal) => AsyncIterable<unknown>)({ ...req, messages }, signal);
    },
  } as unknown as ModelClient;
}
