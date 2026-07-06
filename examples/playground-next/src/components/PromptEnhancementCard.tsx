/**
 * Renders one Enhancement card in the activity thread.
 *
 * State machine the card walks through:
 *
 *   streaming   — text streaming in; spinner chip, actions hidden
 *   ready       — text complete; Edit / Discard / Approve actions
 *   approved    — receipt; "Sent to agent" tombstone with check
 *   edited      — receipt; "Edited — see composer" tombstone
 *   discarded   — collapsed tombstone with the original raw input
 *   errored     — failure tombstone with the error message + retry
 *
 * Approve = same `send()` path the normal Send button uses, with the
 * enhanced text as the user message. Edit drops the enhanced text
 * into the composer and switches the toggle OFF (don't loop-enhance).
 * Discard collapses the card to a small tombstone row.
 *
 * Word-count chip: visually quiet at 30–50 words (the skill's
 * sweet spot), warning-toned outside that band. Truth is in the
 * enhancer prompt; this is a signal the user can read at a glance
 * to know whether the model honored the length contract.
 */
import { useEffect, useState } from 'react';
import { CopyButton } from './CopyButton';
import { countWords } from '~/lib/agent/prompt-enhancer/enhance';
import type { Enhancement } from '~/lib/store/enhancer';
import { useSettingsStore } from '~/lib/store/settings';

interface Props {
  enhancement: Enhancement;
  /** Caller submits the enhanced text to the main agent loop. */
  onApprove: (id: string, enhancedText: string) => void;
  /** Caller drops the enhanced text into the composer + toggles
   *  enhance-mode OFF so the user's tweaks aren't re-enhanced. */
  onEdit: (id: string, enhancedText: string) => void;
  /** Caller transitions the card to `discarded`. */
  onDiscard: (id: string) => void;
  /** Caller re-runs the enhancement with the same raw input. */
  onRetry?: (id: string, rawInput: string) => void;
  /** Disables Approve while an agent turn is in flight (so the user
   *  can't fire a second turn over a streaming one). */
  approveBusy?: boolean;
  /** True when this card is the most-recent item in the activity
   *  timeline. Drives the same auto-fold semantics Turn uses — when
   *  `autoFoldOlder` is on, non-latest cards mount collapsed; each
   *  `collapseSignal` tick resets to `isLatest`. Live (streaming /
   *  ready / errored) cards always stay open regardless. */
  isLatest?: boolean;
}

/** Pre-action card states are "live" — the user is still deciding.
 *  These should never auto-collapse; the action surface must stay
 *  reachable without a fold gesture. */
function isLiveState(s: Enhancement['state']): boolean {
  return s === 'streaming' || s === 'ready' || s === 'errored';
}

/** One-line preview used in the collapsed header so the user can
 *  identify which card is which without expanding. Falls back to the
 *  raw input when the enhanced text is empty (e.g. discarded
 *  pre-completion). */
function firstLine(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const nl = trimmed.indexOf('\n');
  return nl === -1 ? trimmed : trimmed.slice(0, nl);
}

function wordCountTone(n: number): { tone: string; label: string } {
  // Skill says 30-50 words. Treat 25-55 as soft band, 30-50 as ideal.
  if (n >= 30 && n <= 50) return { tone: 'text-[#a4d4a8] border-[#a4d4a8]/40', label: 'ideal' };
  if (n >= 25 && n <= 55) return { tone: 'text-[#e6c79c] border-[#e6c79c]/40', label: 'close' };
  return { tone: 'text-slate-gray border-slate-gray/40', label: n < 25 ? 'short' : 'long' };
}

export function PromptEnhancementCard({
  enhancement,
  onApprove,
  onEdit,
  onDiscard,
  onRetry,
  approveBusy,
  isLatest = true,
}: Props) {
  const { id, state, enhancedText, rawInput, errorMessage } = enhancement;
  const [showRaw, setShowRaw] = useState(false);
  const wc = countWords(enhancedText);
  const wcTone = wordCountTone(wc);

  const isTerminal =
    state === 'approved' ||
    state === 'edited' ||
    state === 'discarded' ||
    state === 'errored';

  // Fold behaviour mirrors Turn — same store, same signal, same
  // `isLatest` gating. Live cards (streaming / ready / errored) are
  // ALWAYS open: the action surface must stay reachable. Resolved
  // receipt cards (approved / edited / discarded) collapse with old
  // turns when the user bumps the collapse signal.
  const collapseSignal = useSettingsStore((s) => s.collapseSignal);
  const live = isLiveState(state);
  const initialOpen = live
    ? true
    : useSettingsStore.getState().autoFoldOlder
      ? isLatest
      : true;
  const [open, setOpen] = useState(initialOpen);
  useEffect(() => {
    if (live) {
      setOpen(true);
      return;
    }
    setOpen(isLatest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapseSignal]);
  // Force open if the card transitions back into a live state (e.g.
  // retry from errored). Without this, a previously-collapsed
  // resolved card stays collapsed even after streaming resumes.
  useEffect(() => {
    if (live) setOpen(true);
  }, [live]);

  const preview = firstLine(enhancedText) || firstLine(rawInput);
  const canFold = !live;

  return (
    <article
      className={[
        'rounded-md border bg-[#0f0f17]',
        state === 'discarded' || state === 'edited'
          ? 'border-[#2a2a35]/40 opacity-70'
          : state === 'errored'
            ? 'border-red-500/30'
            : 'border-[#2a2a35]/60',
      ].join(' ')}
    >
      {/* Header strip — ✨ ENHANCED PROMPT + (when foldable) chevron
          + state chip + word-count chip. When collapsed, a one-line
          preview of the enhanced text fills the leftover space so the
          user can identify the card without expanding. */}
      <header
        className={[
          'flex items-center gap-2 px-3 py-2',
          open ? 'border-b border-[#2a2a35]/40' : '',
        ].join(' ')}
      >
        {/* Left cluster — fold toggle on foldable cards, otherwise
            just the icon + label. */}
        {canFold ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            title={open ? 'Collapse this enhancement' : 'Expand this enhancement'}
            className="flex items-center gap-2 min-w-0 flex-1 text-left hover:text-soft-white transition-colors group"
          >
            <span className="material-symbols-outlined text-[14px] text-soft-white shrink-0">
              auto_awesome
            </span>
            <span
              className="material-symbols-outlined text-[14px] text-slate-gray shrink-0 transition-transform group-hover:text-soft-white"
              style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
              aria-hidden
            >
              chevron_right
            </span>
            <span className="text-[10px] uppercase tracking-wider font-bold text-soft-white shrink-0">
              enhanced prompt
            </span>
            {!open && preview ? (
              <span className="text-[12px] text-slate-gray/70 truncate min-w-0 ml-1">
                {preview}
              </span>
            ) : null}
          </button>
        ) : (
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="material-symbols-outlined text-[14px] text-soft-white shrink-0">
              auto_awesome
            </span>
            <span className="text-[10px] uppercase tracking-wider font-bold text-soft-white">
              enhanced prompt
            </span>
          </div>
        )}

        {/* Right cluster — state chip (varies by state). Word-count
            chip only on `ready` and only when open; otherwise the
            tombstone label is the chip. */}
        {state === 'streaming' ? (
          <span className="text-[10px] font-mono text-slate-gray inline-flex items-center gap-1 shrink-0">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-gray animate-pulse" />
            streaming
          </span>
        ) : state === 'approved' ? (
          <span className="text-[10px] font-mono uppercase tracking-wider text-[#a4d4a8] inline-flex items-center gap-1 shrink-0">
            <span className="material-symbols-outlined text-[12px]">check</span>
            sent to agent
          </span>
        ) : state === 'edited' ? (
          <span className="text-[10px] font-mono uppercase tracking-wider text-slate-gray inline-flex items-center gap-1 shrink-0">
            <span className="material-symbols-outlined text-[12px]">edit</span>
            in composer
          </span>
        ) : state === 'discarded' ? (
          <span className="text-[10px] font-mono uppercase tracking-wider text-slate-gray shrink-0">
            discarded
          </span>
        ) : state === 'errored' ? (
          <span className="text-[10px] font-mono uppercase tracking-wider text-red-400 shrink-0">
            failed
          </span>
        ) : (
          <span
            className={[
              'px-1.5 py-0.5 rounded border text-[10px] tracking-wider font-mono shrink-0 lowercase',
              wcTone.tone,
            ].join(' ')}
            title={`${wc} words — the shape rule targets 30–50 words (your prompt is "${wcTone.label}")`}
          >
            {wc} / 30–50 words
          </span>
        )}
      </header>

      {/* Body + footer — only rendered when the card is open. Collapsed
          state is header-only, matching Turn's one-strip look. */}
      {!open ? null : (
        <>
      {/* Body — the enhanced text, or the error message, or the raw
          collapsed view for discarded/edited tombstones. */}
      <div className="px-3 py-2.5 grid gap-2.5">
        {state === 'errored' ? (
          <p className="text-[12px] text-red-300/90 leading-relaxed">
            {errorMessage ?? 'Enhancement failed.'}
          </p>
        ) : enhancedText ? (
          <p className="text-[12px] text-soft-white/90 leading-relaxed whitespace-pre-wrap break-words">
            {enhancedText}
            {state === 'streaming' ? (
              <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-soft-white/70 align-middle animate-pulse" />
            ) : null}
          </p>
        ) : (
          <p className="text-[11px] text-slate-gray/70 italic">
            Awaiting model output…
          </p>
        )}

        {/* Original input — collapsed by default, expandable. Helpful
            for the user to see what they wrote vs. what the model
            produced; also makes Discard reviewable later. */}
        <details
          className="text-[11px]"
          open={showRaw}
          onToggle={(e) => setShowRaw((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="text-slate-gray hover:text-soft-white cursor-pointer select-none list-none inline-flex items-center gap-1">
            <span
              className="material-symbols-outlined text-[12px] transition-transform"
              style={{ transform: showRaw ? 'rotate(90deg)' : 'rotate(0deg)' }}
              aria-hidden
            >
              chevron_right
            </span>
            <span className="text-[10px] uppercase tracking-wider font-mono">
              before
            </span>
            <span className="text-[10px] text-slate-gray/60 normal-case ml-1">
              — the text the enhancer rewrote
            </span>
          </summary>
          <p className="mt-1.5 pl-4 text-soft-white/70 italic whitespace-pre-wrap break-words">
            {rawInput}
          </p>
        </details>
      </div>

      {/* Action bar — only on `ready`. Other states show inline
          tombstone messaging in the header instead. */}
      {state === 'ready' ? (
        <div className="px-3 py-2 border-t border-[#2a2a35]/40 grid grid-cols-[auto_auto_1fr] gap-2 items-center">
          <button
            type="button"
            onClick={() => onEdit(id, enhancedText)}
            className="px-3 py-1.5 rounded-md border border-[#2a2a35] text-[11px] font-mono uppercase tracking-wider text-soft-white hover:bg-[#2a2a35]/60 transition-colors"
            title="Drop the enhanced text into the composer for tweaks"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onDiscard(id)}
            className="px-3 py-1.5 rounded-md text-[11px] font-mono uppercase tracking-wider text-slate-gray hover:text-soft-white hover:bg-[#2a2a35]/60 transition-colors"
            title="Throw away this enhancement"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => onApprove(id, enhancedText)}
            disabled={!!approveBusy || enhancedText.trim().length === 0}
            aria-disabled={!!approveBusy || enhancedText.trim().length === 0}
            className={[
              'justify-self-end inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[11px] font-mono uppercase tracking-wider transition-colors',
              approveBusy || enhancedText.trim().length === 0
                ? 'bg-[#2a2a35] text-slate-gray cursor-not-allowed'
                : 'bg-soft-white text-[#1a1a22] hover:bg-soft-white/90 cursor-pointer',
            ].join(' ')}
            title={
              approveBusy
                ? 'Agent is processing — wait for the current turn to finish'
                : 'Send the enhanced prompt to the agent'
            }
          >
            <span>Approve</span>
            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </button>
        </div>
      ) : null}

      {/* Errored card gets a Retry / Dismiss row. */}
      {state === 'errored' ? (
        <div className="px-3 py-2 border-t border-[#2a2a35]/40 grid grid-cols-[1fr_auto_auto] gap-2 items-center">
          <CopyButton value={rawInput} label="Copy the pre-enhancement text" text="Copy" />
          <button
            type="button"
            onClick={() => onDiscard(id)}
            className="px-3 py-1.5 rounded-md text-[11px] font-mono uppercase tracking-wider text-slate-gray hover:text-soft-white hover:bg-[#2a2a35]/60 transition-colors"
          >
            Dismiss
          </button>
          {onRetry ? (
            <button
              type="button"
              onClick={() => onRetry(id, rawInput)}
              className="px-3 py-1.5 rounded-md text-[11px] font-mono uppercase tracking-wider text-soft-white border border-[#2a2a35] hover:bg-[#2a2a35]/60 transition-colors"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Approved / edited / discarded — no action bar, but keep a
          discreet copy affordance so the user can fish out the text. */}
      {isTerminal && state !== 'errored' ? (
        <div className="px-3 py-1.5 border-t border-[#2a2a35]/40 flex items-center justify-end">
          <CopyButton
            value={enhancedText || rawInput}
            label="Copy enhanced text"
            text="Copy"
          />
        </div>
      ) : null}
        </>
      )}
    </article>
  );
}
