/**
 * "Resume turn" banner — the interactive follow-up to an interrupted
 * turn.
 *
 * A reply carries the `interrupted` marker when its turn could not
 * finish: cut short by a page reload / mobile tab discard (stamped by
 * inference/reattach.ts recovery) or by a live connection drop that
 * killed the turn (stamped by useAgentLoop's network-drop handling).
 * This banner sits with the composer and offers a one-tap resume: it
 * sends a continuation prompt as a normal, visible user turn — the
 * partial reply is already in history, so the model picks up where it
 * left off (re-running any tool calls that never executed). Shown only
 * for the LATEST assistant message and only while idle; resuming (or
 * any new prompt) retires it.
 */
import { useCallback } from 'react';
import { useChatStore } from '~/lib/store/chat';

/** The continuation prompt sent on tap — visible in the chat like any
 *  user message, so the resume is transparent, not magic. */
export const RESUME_TURN_PROMPT =
  'Resume the interrupted turn: your last reply was cut short (connection ' +
  'drop or page reload), so any remaining tool calls never executed. ' +
  'Review what you already said, re-check the workspace state, and finish ' +
  'the remaining work.';

interface Props {
  sending: boolean;
  onSend: (prompt: string) => void | Promise<void>;
  /** Composer has no API key etc. — mirror its disabled state. */
  disabled?: boolean;
}

export function ResumeTurnBanner({ sending, onSend, disabled = false }: Props) {
  // The affordance applies to the newest assistant reply only — once a
  // newer turn exists, resuming an older interruption would be confusing.
  const interruptedId = useChatStore((s) => {
    const lastAssistant = [...s.messages].reverse().find((m) => m.role === 'assistant');
    return lastAssistant?.interrupted ? lastAssistant.id : null;
  });
  const toolCallsPending = useChatStore((s) => {
    const m = interruptedId ? s.messages.find((x) => x.id === interruptedId) : undefined;
    return m?.interrupted?.toolCallsPending ?? false;
  });

  const resume = useCallback(() => {
    if (!interruptedId) return;
    // Retire the marker first so the banner drops instantly (and stays
    // gone if the send itself fails — the error bar takes over then).
    useChatStore.getState().patchMessage(interruptedId, { interrupted: undefined });
    void onSend(RESUME_TURN_PROMPT);
  }, [interruptedId, onSend]);

  if (!interruptedId || sending) return null;

  return (
    <div className="flex items-center gap-3 px-3 py-2 border-t border-[#4a3f2f] bg-[#181410] text-[12px]">
      <span className="material-symbols-outlined text-[16px] text-[#e6c79c] shrink-0" aria-hidden>
        replay
      </span>
      <p className="text-[#e6c79c] flex-1 min-w-0">
        {toolCallsPending
          ? 'This turn was interrupted — its remaining tool calls never ran.'
          : 'This turn was interrupted before it finished.'}
      </p>
      <button
        type="button"
        onClick={resume}
        disabled={disabled}
        className={[
          'shrink-0 px-3 py-1 rounded-full text-[11px] font-mono uppercase tracking-wider',
          'bg-[#e6c79c] text-content-bg hover:bg-[#f0d4ae] transition-colors',
          'disabled:opacity-50 disabled:cursor-not-allowed',
        ].join(' ')}
      >
        Resume turn
      </button>
    </div>
  );
}
