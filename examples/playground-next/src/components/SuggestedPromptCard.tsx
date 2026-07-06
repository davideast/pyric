/**
 * Renders the `pyric-suggestion` block the Analyze model emits — a
 * list of follow-up entries, each one a single compact row by
 * default. Click any row to drill in and see the rationale + the
 * prompt body + a larger Send button.
 *
 * Two kinds of suggestion entry:
 *
 *   `action`     — Send button submits `prompt` to the agent.
 *                  Compact row shows label + confidence chip + a
 *                  small icon-only send affordance. Drill-in
 *                  reveals the rationale + the prompt body + a
 *                  larger primary Send.
 *   `no-action`  — Disabled "No Action" chip in place of Send. The
 *                  rule is doing its job / the denial is the
 *                  intent; sending a no-op prompt to the agent
 *                  would burn tokens. Still drillable to read the
 *                  rationale.
 *
 * State machine per row:
 *   - idle (collapsed)        small icon-Send / "No action" chip
 *   - drilled (expanded)      rationale + prompt + big Send
 *   - sent (action only)      checkmark + "Sent" label
 *   - sendBusy (global)       all Send buttons disabled with reduced
 *                             opacity — semaphore from the agent loop
 *
 * After a Send click `onAfterSend` fires so the parent can switch
 * back to the Activity tab to watch the response stream.
 */
import { useState } from 'react';
import { CopyButton } from './CopyButton';

/**
 * Extended suggestion shape — same as the parser output plus the
 * persisted `sent` and `dismissed` flags the parent reads from
 * the cached analysis on the store. Keeping the local prop type
 * here decoupled from the parser type means parent can pass either
 * shape (freshly-parsed or cached-with-state) without coercion.
 */
export interface RenderedSuggestion {
  kind: 'action' | 'no-action';
  label: string;
  confidence: number;
  rationale: string;
  prompt?: string;
  sent?: boolean;
  dismissed?: boolean;
}

interface Props {
  suggestions: RenderedSuggestion[];
  /** Submit a suggested prompt to the agent loop. When omitted, the
   *  cards still render with Copy chips — no Send buttons. */
  onSend?: (prompt: string) => void;
  /** True while a turn is in flight. Locks every Send button in the
   *  list so the user can't spam parallel sends. */
  sendBusy?: boolean;
  /** Called after a Send click. Parent uses this to switch tabs / etc. */
  onAfterSend?: () => void;
  /** Persist the "sent" flag on the suggestion at `index` so the
   *  state survives unmounts (tab switches, scroll-virtualization). */
  onMarkSent?: (index: number) => void;
  /** Persist the "dismissed" flag on the suggestion at `index` so
   *  the row stays hidden across mounts. */
  onDismiss?: (index: number) => void;
}

function confidenceTone(c: number): { tone: string; label: string } {
  if (c >= 0.75) return { tone: 'text-[#a4d4a8] border-[#a4d4a8]/40', label: 'high' };
  if (c >= 0.4) return { tone: 'text-[#e6c79c] border-[#e6c79c]/40', label: 'medium' };
  return { tone: 'text-slate-gray border-slate-gray/40', label: 'low' };
}

export function SuggestedPromptCard({
  suggestions,
  onSend,
  sendBusy,
  onAfterSend,
  onMarkSent,
  onDismiss,
}: Props) {
  if (!suggestions || suggestions.length === 0) return null;

  // Filter out dismissed rows entirely. The dismissed flag is
  // persisted on the suggestion via `onDismiss`, so the row stays
  // hidden across tab switches.
  const visible = suggestions
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !s.dismissed);
  if (visible.length === 0) return null;

  const handleSend = (idx: number, prompt: string) => {
    if (sendBusy || suggestions[idx]?.sent || !onSend) return;
    onMarkSent?.(idx);
    onSend(prompt);
    onAfterSend?.();
  };

  return (
    <section className="mt-4 pt-4 border-t border-[#2a2a35]/60 space-y-2">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-[14px] text-slate-gray">
          tips_and_updates
        </span>
        <span className="text-[10px] uppercase tracking-wider text-slate-gray font-bold">
          suggested
        </span>
        {visible.length > 1 ? (
          <span className="text-[10px] font-mono text-slate-gray/70">
            · {visible.length}
          </span>
        ) : null}
      </div>
      <ul className="space-y-1.5">
        {visible.map(({ s, i }) => (
          <SuggestionRow
            key={i}
            suggestion={s}
            sendBusy={sendBusy}
            onSend={
              onSend && s.kind === 'action' && s.prompt && !s.sent
                ? () => handleSend(i, s.prompt!)
                : undefined
            }
            onDismiss={onDismiss ? () => onDismiss(i) : undefined}
          />
        ))}
      </ul>
    </section>
  );
}

function SuggestionRow({
  suggestion,
  sendBusy,
  onSend,
  onDismiss,
}: {
  suggestion: RenderedSuggestion;
  sendBusy?: boolean;
  onSend?: () => void;
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { tone, label } = confidenceTone(suggestion.confidence);
  const pct = Math.round(suggestion.confidence * 100);
  const isNoAction = suggestion.kind === 'no-action';
  const sent = !!suggestion.sent;
  const locked = sent || !!sendBusy;
  const rowOpacity = sent ? 'opacity-60' : sendBusy && !isNoAction ? 'opacity-50' : '';

  return (
    <li
      className={[
        'rounded-md border border-[#2a2a35]/60 bg-[#0f0f17] transition-opacity',
        rowOpacity,
      ].join(' ')}
    >
      {/* Compact header — entire strip is the toggle target. Send /
       *  copy / chip elements stop propagation so a click on them
       *  doesn't also collapse/expand. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[#2a2a35]/30 transition-colors"
        title={open ? 'Hide details' : 'Show rationale'}
      >
        <span
          className="material-symbols-outlined text-[14px] text-slate-gray shrink-0 transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
          aria-hidden
        >
          chevron_right
        </span>
        <span className="text-[11px] font-mono uppercase tracking-wider text-soft-white truncate flex-1 min-w-0">
          {suggestion.label}
        </span>
        <span
          className={[
            'shrink-0 px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider font-mono',
            tone,
          ].join(' ')}
          title={`Model-rated confidence: ${pct}% (${label})`}
        >
          {pct}% · {label}
        </span>
        {/* Dismiss — small `×` to remove the row from view. Always
         *  available regardless of sent state; persisted on the
         *  suggestion via `onDismiss(index)`. stopPropagation so
         *  it doesn't also toggle the drill-in. */}
        {onDismiss ? (
          <span
            role="button"
            aria-label="Dismiss suggestion"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-slate-gray hover:text-soft-white hover:bg-[#2a2a35]/60 transition-colors cursor-pointer"
            title="Dismiss"
          >
            <span className="material-symbols-outlined text-[13px]">close</span>
          </span>
        ) : null}

        {/* Inline action: small icon-Send / "No action" chip /
         *  checkmark. All wrapped in `<span>` with click handling so
         *  the parent's toggle doesn't double-fire. */}
        {isNoAction ? (
          <span
            className="shrink-0 text-[9px] font-mono uppercase tracking-wider text-slate-gray/70 px-1.5 py-0.5 rounded border border-[#2a2a35]"
            title="No action — accept the current behavior"
          >
            no action
          </span>
        ) : sent ? (
          <span
            className="shrink-0 inline-flex items-center gap-1 text-[#a4d4a8] text-[10px] font-mono uppercase tracking-wider"
            title="Sent to the agent"
          >
            <span className="material-symbols-outlined text-[12px]">check</span>
            sent
          </span>
        ) : onSend ? (
          <span
            role="button"
            aria-disabled={locked}
            onClick={(e) => {
              e.stopPropagation();
              if (!locked) onSend();
            }}
            className={[
              'shrink-0 inline-flex items-center justify-center w-6 h-6 rounded',
              locked
                ? 'text-slate-gray cursor-not-allowed'
                : 'text-soft-white hover:bg-[#2a2a35]/60 cursor-pointer transition-colors',
            ].join(' ')}
            title={
              sendBusy
                ? 'Agent is currently processing — wait for the turn to finish'
                : 'Send to agent'
            }
          >
            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </span>
        ) : null}
      </button>

      {/* Drill-in — rationale + (for action) the prompt body and a
       *  larger primary Send. The compact row above stays visible
       *  even when expanded; the user sees the chevron rotated. */}
      {open ? (
        <div className="px-3 py-2.5 border-t border-[#2a2a35]/40 space-y-2.5">
          <div>
            <p className="text-[9px] uppercase tracking-wider text-slate-gray font-bold mb-1">
              rationale
            </p>
            <p className="text-[12px] text-soft-white/90 leading-relaxed whitespace-pre-wrap break-words">
              {suggestion.rationale}
            </p>
          </div>

          {suggestion.kind === 'action' && suggestion.prompt ? (
            <>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[9px] uppercase tracking-wider text-slate-gray font-bold">
                    prompt
                  </p>
                  <CopyButton
                    value={suggestion.prompt}
                    label="Copy suggested prompt"
                    size={12}
                  />
                </div>
                <pre className="text-[12px] font-mono text-soft-white/90 whitespace-pre-wrap break-words leading-relaxed bg-content-bg border border-[#2a2a35]/60 rounded px-3 py-2.5">
                  {suggestion.prompt}
                </pre>
              </div>
              {onSend ? (
                sent ? (
                  <span
                    className={[
                      'flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-md',
                      'bg-[#2a2a35] text-[#a4d4a8]',
                      'text-[11px] font-mono uppercase tracking-wider',
                    ].join(' ')}
                  >
                    <span className="material-symbols-outlined text-[14px]">check</span>
                    <span>Sent</span>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={onSend}
                    disabled={locked}
                    aria-disabled={locked}
                    title={
                      sendBusy
                        ? 'Agent is currently processing'
                        : 'Submit this prompt to the agent'
                    }
                    className={[
                      'flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-md',
                      'text-[11px] font-mono uppercase tracking-wider',
                      locked
                        ? 'bg-[#2a2a35] text-slate-gray cursor-not-allowed'
                        : 'bg-soft-white text-[#1a1a22] hover:bg-soft-white/90 transition-colors cursor-pointer',
                    ].join(' ')}
                  >
                    <span>Send to agent</span>
                    <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                  </button>
                )
              ) : null}
            </>
          ) : (
            <p
              className={[
                'flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-md',
                'bg-[#2a2a35]/60 text-slate-gray/80',
                'text-[10px] font-mono uppercase tracking-wider',
              ].join(' ')}
            >
              <span className="material-symbols-outlined text-[13px]">do_not_disturb_on</span>
              <span>No action — accept current behavior</span>
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}
