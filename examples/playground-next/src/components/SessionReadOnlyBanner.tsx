/**
 * Slim strip under the TopBar shown when this tab LOST the
 * per-session writer election — the same session is open in another
 * tab that holds the writer lock (see `lib/sessions/writer-lock.ts`).
 *
 * While visible: agent turns are blocked, the VFS is read-only, and
 * the ambient autosave is paused, so this tab can't silently revert
 * the writer tab's work. "Take over" asks the holder to yield
 * gracefully (it flushes its final save first), then promotes this
 * tab to writer and re-syncs from the saved state.
 *
 * Same one-line idiom as `DenialBanner` — informational strip, single
 * action, amber tone.
 */
import { useState } from 'react';

interface SessionReadOnlyBannerProps {
  /** Request the writer role from the holding tab. */
  onTakeOver: () => Promise<void> | void;
}

export function SessionReadOnlyBanner({ onTakeOver }: SessionReadOnlyBannerProps) {
  const [busy, setBusy] = useState(false);

  const handleTakeOver = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onTakeOver();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 border-b backdrop-blur-sm bg-[#2a241a]/95 border-[#3a3225]">
      <div className="flex items-center gap-2 px-4 py-2">
        <span className="material-symbols-outlined text-[16px] text-[#e6c79c]">
          visibility
        </span>
        <span className="text-[12px] font-medium text-[#e6c79c]">
          This session is open in another tab — view only
        </span>
        <button
          type="button"
          onClick={() => void handleTakeOver()}
          disabled={busy}
          title="Make this tab the writer; the other tab becomes view-only"
          className="ml-auto flex items-center gap-1 text-[11px] font-mono text-slate-gray hover:text-soft-white transition-colors disabled:opacity-50"
        >
          <span>{busy ? 'taking over…' : 'take over'}</span>
          <span className="material-symbols-outlined text-[14px]">swap_horiz</span>
        </button>
      </div>
    </div>
  );
}
