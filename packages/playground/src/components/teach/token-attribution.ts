/**
 * Token/cost teaching helpers — pure functions behind the
 * AssistantBlock metrics strip and the drill-in's turn-attribution
 * panel.
 *
 * Honesty contract: per-tool numbers are ESTIMATES derived from
 * payload sizes (`estimateTokens` — ~4 chars/token), not provider
 * accounting. Real token counts exist only per-turn (the provider's
 * usage block, already on `message.metrics`). Everything estimated
 * renders with the `≈` prefix, matching the session-host's
 * `costEstimated` vocabulary.
 */
import type { ChatMessage, ToolCall } from '~/lib/store/chat';
import { estimateTokens } from '~/lib/tools/behavior';

/** Compact token-count formatter for dense strips: 950 → "950",
 *  8,842 → "8.8k", 123,456 → "123k". */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 100_000) {
    const k = n / 1000;
    const s = k.toFixed(1);
    return `${s.endsWith('.0') ? s.slice(0, -2) : s}k`;
  }
  return `${Math.round(n / 1000)}k`;
}

/**
 * Build the per-message metrics strip parts. Order: duration, token
 * split (in/out/cached), cost. Falls back to the legacy total when
 * the split isn't on the message (older restored sessions).
 */
export function buildMetricsStripParts(m: ChatMessage['metrics']): string[] {
  if (!m) return [];
  const parts: string[] = [];
  const hasSplit = m.tokensIn != null || m.tokensOut != null;
  if (hasSplit) {
    if (m.tokensIn != null) parts.push(`in ${formatTokenCount(m.tokensIn)}`);
    if (m.tokensOut != null) parts.push(`out ${formatTokenCount(m.tokensOut)}`);
    if (m.cachedTokens != null && m.cachedTokens > 0) {
      parts.push(`cached ${formatTokenCount(m.cachedTokens)}`);
    }
  } else if (m.tokensTotal != null) {
    parts.push(`${m.tokensTotal.toLocaleString()} tok`);
  }
  return parts;
}

export interface ToolTokenRow {
  callId: string;
  name: string;
  /** ≈tokens the model SPENT emitting this call's args. */
  argsTok: number;
  /** ≈tokens the tool result ADDED to the conversation. */
  resultTok: number;
  totalTok: number;
  /** This call's share of the turn's total tool traffic (0..1). */
  share: number;
  /** ≈cost attributed to this call — turn cost × token share of the
   *  turn's REAL total. Present only when the turn has both a cost
   *  and a token total. Always an estimate. */
  estCostUsd?: number;
}

export interface TurnAttribution {
  rows: ToolTokenRow[];
  /** Sum of all calls' ≈tokens (args + results). */
  toolTrafficTok: number;
}

/**
 * Estimate each tool call's token footprint for the drill-in
 * breakdown. Note the systematic UNDER-count: in a multi-iteration
 * ReAct turn the provider re-sends earlier results on every later
 * request — this attribution counts each payload once. That's the
 * right teaching number ("what did this call put on the wire"), not
 * a billing reconstruction.
 */
export function attributeToolTokens(message: ChatMessage): TurnAttribution {
  const calls = message.toolCalls ?? [];
  const rows: ToolTokenRow[] = calls.map((c: ToolCall) => {
    const argsTok = estimateTokens(c.argsJson) ?? 0;
    const resultTok = estimateTokens(c.resultJson) ?? 0;
    return {
      callId: c.id,
      name: c.name,
      argsTok,
      resultTok,
      totalTok: argsTok + resultTok,
      share: 0,
    };
  });
  const toolTrafficTok = rows.reduce((a, r) => a + r.totalTok, 0);
  const m = message.metrics;
  const turnTok = m?.tokensTotal;
  const turnCost = m?.costUsd;
  for (const r of rows) {
    r.share = toolTrafficTok > 0 ? r.totalTok / toolTrafficTok : 0;
    if (typeof turnCost === 'number' && turnTok && turnTok > 0) {
      r.estCostUsd = turnCost * (r.totalTok / turnTok);
    }
  }
  return { rows, toolTrafficTok };
}
