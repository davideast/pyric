/**
 * Drill-in panel: where did this turn's tokens go, per tool call.
 * Renders under the RESULT section of `ToolDetailView` — the user is
 * already reading one call; this situates it against its siblings so
 * "the agent burned 9k tokens" becomes "the discover call returned
 * 6k of schema, everything else was cheap."
 *
 * All per-call numbers are payload-size estimates (`≈`); the footer
 * carries the provider's REAL turn totals for contrast. Renders
 * nothing when the turn had no tool calls.
 */
import type { ChatMessage } from '~/lib/store/chat';
import { formatCostUsd } from '~/lib/llm/pricing';
import {
  attributeToolTokens,
  buildMetricsStripParts,
  formatTokenCount,
} from './token-attribution';

interface Props {
  message: ChatMessage;
  /** The call whose drill-in we're inside — its row is highlighted. */
  currentCallId: string;
}

export function TurnAttribution({ message, currentCallId }: Props) {
  const { rows, toolTrafficTok } = attributeToolTokens(message);
  if (rows.length === 0) return null;

  const m = message.metrics;
  const turnParts = buildMetricsStripParts(m);
  const turnCostLabel =
    m && typeof m.costUsd === 'number'
      ? `${m.costEstimated ? '≈' : ''}${formatCostUsd(m.costUsd)}`
      : null;

  return (
    <section className="mt-8 pt-5 border-t border-[#2a2a35]" data-teach="turn-attribution">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <span className="text-[10px] uppercase tracking-wider text-slate-gray font-bold">
          Turn attribution
        </span>
        <span className="text-[10px] font-mono text-slate-gray/70">
          tool traffic ≈{formatTokenCount(toolTrafficTok)} tok · by payload size
        </span>
      </div>

      <ul className="space-y-1">
        {rows.map((r) => {
          const current = r.callId === currentCallId;
          const pct = Math.round(r.share * 100);
          return (
            <li
              key={r.callId}
              className={[
                'flex items-center gap-2 text-[11px] font-mono rounded px-1.5 py-0.5',
                current ? 'bg-[#2a2a35]/40 text-soft-white' : 'text-slate-gray',
              ].join(' ')}
            >
              <span className="w-3 shrink-0 text-slate-gray/70">
                {current ? '▸' : ''}
              </span>
              <span className="truncate flex-1 min-w-0">{r.name}</span>
              <span className="shrink-0 tabular-nums">
                ≈{formatTokenCount(r.totalTok)} tok
              </span>
              <span className="shrink-0 w-10 text-right tabular-nums text-slate-gray/70">
                {pct}%
              </span>
              {r.estCostUsd !== undefined ? (
                <span className="shrink-0 w-16 text-right tabular-nums text-slate-gray/70">
                  ≈{formatCostUsd(r.estCostUsd)}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* Share bar — one glance answers "which call dominated". */}
      <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded bg-[#1a1a22]">
        {rows.map((r) => (
          <div
            key={r.callId}
            className={
              r.callId === currentCallId ? 'bg-[#a4d4a8]/80' : 'bg-[#3a3a48]'
            }
            style={{ width: `${Math.max(1, r.share * 100)}%` }}
            title={`${r.name} · ≈${formatTokenCount(r.totalTok)} tok`}
          />
        ))}
      </div>

      {turnParts.length > 0 || turnCostLabel ? (
        <p className="mt-3 text-[10px] font-mono text-slate-gray/70">
          turn total (provider-reported): {turnParts.join(' · ')}
          {turnCostLabel ? ` · ${turnCostLabel}` : ''}
        </p>
      ) : null}
      <p className="mt-1 text-[10px] text-slate-gray/60 leading-relaxed">
        Per-call numbers are payload-size estimates (~4 chars/token);
        results re-sent on later iterations are counted once.
      </p>
    </section>
  );
}
