/**
 * One conversation turn — a user prompt at the top followed by N
 * assistant messages (multi-step ReAct loops emit one assistant
 * message per turn). Rendered inside a single bordered container so
 * each prompt + response cycle reads as a contained unit.
 *
 * Whole-turn fold:
 *   The header strip carries a tiny chevron between `time · YOU`.
 *   The chevron + label cluster is the click target; clicking
 *   toggles the whole article (prompt body + assistant responses)
 *   open/closed. Defaults open. Designed so:
 *     - The fold affordance is *visible* (chevron at rest) — not a
 *       hidden hover-reveal that nobody discovers.
 *     - The click target is the LEFT cluster only. Copy chip lives
 *       on the right with `stopPropagation`, so clicking copy never
 *       collapses the turn.
 *     - Collapsed turns show a one-line preview of the prompt right
 *       next to the YOU label so the user can identify which turn
 *       they want to expand without a guessing game.
 *
 *   `chevron_right` rotates 90° on open via CSS transform — same
 *   pattern the inline `<details>` folds use across the app.
 */
import { useEffect, useState } from 'react';
import type { ChatMessage } from '~/lib/store/chat';
import { useSettingsStore } from '~/lib/store/settings';
import { useTraceStore } from '~/lib/store/trace';
import { AssistantBlock } from './AssistantBlock';
import { CopyButton } from './CopyButton';
import { Markdown } from './Markdown';

/** Char threshold past which the prompt clamps with a fold divider.
 *  Below this, the prompt renders inline as a normal paragraph. */
const PROMPT_FOLD_THRESHOLD = 600;

interface Props {
  prompt: ChatMessage; // role: 'user'
  responses: ChatMessage[]; // role: 'assistant'
  /** Click a tool call → drill into ReadingPane via the parent. */
  onSelectTool?: (messageId: string, callId: string) => void;
  /** Click the trace chip → drill into TraceView via the parent. */
  onSelectTrace?: (turnId: string) => void;
  /** True when this is the most recent turn. Used by the collapse-
   *  signal effect so a "fold all but latest" gesture leaves the
   *  current turn open. */
  isLatest?: boolean;
}

function fmtTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 5);
}

/** First non-empty line of the prompt, trimmed — used as the inline
 *  preview when the turn is collapsed. Newlines wrecked the
 *  single-line layout if we used the raw text. */
function firstLine(text: string | undefined): string {
  if (!text) return '';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

export function Turn({ prompt, responses, onSelectTool, onSelectTrace, isLatest = true }: Props) {
  // Trace chip — only shown when this turn has a captured trace.
  // Reads count directly from the store so streaming requests bump
  // the chip in real time.
  const turnId = prompt.turnId;
  const traceReqCount = useTraceStore((s) =>
    turnId ? s.summaries[turnId]?.requestCount ?? 0 : 0,
  );
  const promptFoldable = (prompt.text?.length ?? 0) > PROMPT_FOLD_THRESHOLD;
  const [promptExpanded, setPromptExpanded] = useState(false);
  const collapseSignal = useSettingsStore((s) => s.collapseSignal);
  // Initial open state respects the "auto-fold older" setting at
  // mount time — when on, only the latest turn renders open.
  const initialOpen = useSettingsStore.getState().autoFoldOlder ? isLatest : true;
  const [turnOpen, setTurnOpen] = useState(initialOpen);
  // Each tick of `collapseSignal` (hotkey, new-turn auto-fold, or the
  // settings modal's "Collapse older now") resets to the
  // collapse-all-but-latest state. Manual toggles after the signal
  // still win until the next signal.
  useEffect(() => {
    setTurnOpen(isLatest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapseSignal]);
  // Hidden-line estimate for the chip label — purely informative.
  // Uses the post-clamp height in `em` (~12 visual lines) so the
  // number matches what the user is hiding from view.
  const totalLines = prompt.text?.split('\n').length ?? 0;
  const approxHiddenLines = Math.max(1, Math.ceil(prompt.text.length / 80) - 12);
  const preview = firstLine(prompt.text);

  return (
    <article className="rounded-lg border border-[#2a2a35] bg-content-bg overflow-hidden">
      <header
        className={[
          'flex flex-col gap-1 px-4 pt-3 pb-3 bg-[#1a1a22]/60',
          // Drop the bottom border + bg-gap when collapsed so the
          // turn reads as one tidy strip rather than "header with
          // empty body underneath."
          turnOpen ? 'border-b border-[#2a2a35]' : '',
        ].join(' ')}
      >
        <div className="flex items-center justify-between gap-2">
          {/* Left cluster — the fold toggle. Time + chevron + YOU
              label + (when collapsed) a one-line preview of the
              prompt. Restricting the click target to this cluster
              prevents accidental folds when the user clicks copy
              or any future right-side affordance. */}
          <button
            type="button"
            onClick={() => setTurnOpen((o) => !o)}
            aria-expanded={turnOpen}
            className="flex items-center gap-2 min-w-0 flex-1 text-left hover:text-soft-white transition-colors group"
            title={turnOpen ? 'Collapse this turn' : 'Expand this turn'}
          >
            <span className="text-[11px] font-mono text-slate-gray shrink-0">
              {fmtTime(prompt.createdAt)}
            </span>
            <span
              className="material-symbols-outlined text-[14px] text-slate-gray shrink-0 transition-transform group-hover:text-soft-white"
              style={{ transform: turnOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
              aria-hidden
            >
              chevron_right
            </span>
            <span className="text-[9px] font-bold uppercase tracking-wider text-slate-gray shrink-0">
              you
            </span>
            {!turnOpen && preview ? (
              // One-line preview when collapsed so the user can
              // identify the turn without expanding. Muted slate,
              // truncated with overflow-ellipsis to keep the strip
              // single-line.
              <span className="text-[12px] text-slate-gray/70 truncate min-w-0 ml-1">
                {preview}
              </span>
            ) : null}
          </button>
          <div className="flex items-center gap-1 shrink-0">
            {turnId && traceReqCount > 0 && onSelectTrace ? (
              <button
                type="button"
                onClick={() => onSelectTrace(turnId)}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[#2a2a35] text-[10px] font-mono uppercase tracking-wider text-slate-gray hover:text-soft-white hover:border-[#3a3a45] transition-colors"
                title="View the full LLM context for this turn"
              >
                <span className="material-symbols-outlined text-[12px]">search_insights</span>
                <span>trace · {traceReqCount}req</span>
              </button>
            ) : null}
            <CopyButton value={prompt.text} label="Copy prompt" />
          </div>
        </div>

        {turnOpen ? (
          <>
            <div
              className={[
                'text-[13px] text-soft-white leading-snug break-words',
                // CSS clamp via max-height when foldable and
                // collapsed. `12em` = ~12 lines at this leading;
                // height collapses any further content. No ellipsis —
                // the divider below tells the user there's more,
                // which reads cleaner than a hanging `…`.
                promptFoldable && !promptExpanded ? 'max-h-[12em] overflow-hidden' : '',
              ].join(' ')}
            >
              {/* Markdown render so fenced code in the prompt body
                  (auto-generated Fix-error prompts) renders as
                  `<CodeBlock>`. Plain text passes through. */}
              {prompt.text ? (
                <Markdown source={prompt.text} />
              ) : (
                <span className="text-slate-gray italic">(empty prompt)</span>
              )}
            </div>
            {promptFoldable ? (
              <button
                type="button"
                onClick={() => setPromptExpanded((v) => !v)}
                className="mt-2 flex items-center gap-3 w-full text-slate-gray hover:text-soft-white transition-colors"
                aria-expanded={promptExpanded}
              >
                <span className="h-px flex-1 bg-[#2a2a35]" aria-hidden />
                <span className="text-[10px] uppercase tracking-wider font-mono shrink-0">
                  {promptExpanded
                    ? 'collapse'
                    : `show full prompt · ${totalLines > 12 ? `${totalLines - 12} more lines` : `${approxHiddenLines} more lines`}`}
                </span>
                <span className="h-px flex-1 bg-[#2a2a35]" aria-hidden />
              </button>
            ) : null}
          </>
        ) : null}
      </header>
      {turnOpen ? (
        <div className="flex flex-col gap-4 px-4 py-4">
          {responses.length === 0 ? (
            <p className="text-[12px] text-slate-gray italic">waiting for the agent…</p>
          ) : (
            responses.map((m) => (
              <AssistantBlock
                key={m.id}
                message={m}
                time={fmtTime(m.createdAt)}
                onSelectTool={onSelectTool}
              />
            ))
          )}
        </div>
      ) : null}
    </article>
  );
}
