/**
 * The global ⌘K overlay — the command typeahead's SECOND mount (the first is
 * inline on Home). A top-centered panel positioned BELOW the header bar: the
 * bar stays visible and uncovered; only the content region dims. Escape and
 * backdrop-click close; selecting navigates and closes; focus returns to
 * whatever held it before the overlay opened.
 */

import { useEffect, useRef } from 'react';
import { CommandTypeahead } from '../features/home/CommandTypeahead.js';

export function CommandOverlay({ onClose }: { onClose: () => void }) {
  // Focus restoration: capture the opener's focus once on mount, restore on
  // unmount (close by any path — Escape, backdrop, selection).
  const previouslyFocused = useRef<Element | null>(null);
  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    return () => {
      const el = previouslyFocused.current;
      if (el instanceof HTMLElement) el.focus();
    };
  }, []);

  return (
    <div className="studio__cmdk-backdrop" onMouseDown={onClose}>
      <div
        className="studio__cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Command"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <CommandTypeahead autoFocus onEscape={onClose} onNavigated={onClose} />
      </div>
    </div>
  );
}
