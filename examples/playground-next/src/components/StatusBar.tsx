/**
 * Footer strip pinned to the bottom of the right panel. Always
 * visible. Left side: active model + session-state pill (or error
 * banner). Right side: turn count + token total.
 */
import { formatCostUsd } from '~/lib/llm/pricing';

export interface StatusBarProps {
  modelLabel?: string | null;
  sessionState: 'idle' | 'streaming' | 'failed';
  error?: string | null;
  turns?: number;
  requests?: number | null;
  tokensTotal?: number;
  /** Cumulative session cost in USD (sum of per-turn costs). Null/absent
   *  when no turn reported one. Exact when every turn's cost came from
   *  the provider (OpenRouter `usage.cost`); `≈`-prefixed when any turn
   *  was locally estimated. */
  costUsd?: number | null;
  costEstimated?: boolean;
}

export function StatusBar({
  modelLabel,
  sessionState,
  error,
  turns = 0,
  requests = 0,
  tokensTotal = 0,
  costUsd = null,
  costEstimated = false,
}: StatusBarProps) {
  return (
    <footer className="h-[28px] bg-sidebar-bg border-t border-[#2a2a32] shrink-0 flex items-center justify-between px-3 relative">
      {error ? (
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-[14px] text-red-500 shrink-0">
            error
          </span>
          <span className="text-[11px] text-red-400 truncate">{error}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 min-w-0">
          {modelLabel ? (
            <span className="text-[11px] font-mono text-slate-gray truncate">
              {modelLabel}
            </span>
          ) : null}
          {/* Streaming has its own per-message indicator on the
              timeline row — surfacing it here too duplicates the
              signal. Only show a state pill on failed; idle is
              implied by the absence of any pill. */}
          {sessionState === 'failed' ? (
            <>
              <span className="hidden sm:inline text-[11px] text-slate-gray shrink-0">·</span>
              <span className="text-[11px] text-red-400 shrink-0">failed</span>
            </>
          ) : null}
        </div>
      )}

      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        {/* Session cost leads the stat cluster — the primary metric of a
            run. Brighter than the rest so it reads first. Exact from the
            provider when unprefixed; `≈` = locally estimated. */}
        {typeof costUsd === 'number' ? (
          <>
            <span
              className="text-[11px] font-mono font-semibold text-[#e6c79c]"
              title="Cumulative session cost across all completed turns. Exact when reported by the provider (OpenRouter usage accounting); ≈ when locally estimated from pricing tables."
            >
              {costEstimated ? '\u2248' : ''}{formatCostUsd(costUsd)}
            </span>
            <span className="text-[11px] text-slate-gray">·</span>
          </>
        ) : null}
        <span className="text-[11px] font-mono text-slate-gray">
          {turns}t
          <span className="hidden sm:inline">{turns === 1 ? ' turn' : ' turns'}</span>
        </span>
        <span className="text-[11px] text-slate-gray">·</span>
        {typeof requests === 'number' && requests > 0 ? (
          <>
            <span
              className="text-[11px] font-mono text-slate-gray"
              title="Model requests made across the session. One user turn can contain many requests."
            >
              {requests} req
            </span>
            <span className="text-[11px] text-slate-gray">·</span>
          </>
        ) : requests === null ? (
          <>
            <span
              className="hidden sm:inline text-[11px] font-mono text-slate-gray"
              title="Request counts require saved provider traces. This restored session has token metrics but no trace detail for one or more turns."
            >
              req unknown
            </span>
            <span className="hidden sm:inline text-[11px] text-slate-gray">·</span>
          </>
        ) : null}
        <span
          className="text-[11px] font-mono text-slate-gray"
          title="Cumulative provider-reported tokens spent across all completed model requests. This is not the current context-window size."
        >
          <span className="hidden sm:inline">spent </span>
          {tokensTotal.toLocaleString()} tok
        </span>
      </div>
    </footer>
  );
}
