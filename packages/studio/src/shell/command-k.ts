/**
 * Global ⌘K (Ctrl+K on non-mac) plumbing.
 *
 * Two behaviors, one binding (specs: command surface, M4):
 *   - On Home, ⌘K focuses the EXISTING inline command input — no overlay.
 *   - On every other tab, the shell opens the overlay panel below the bar.
 *
 * The inline input registers a focus handle here (a module-level slot: there
 * is exactly one inline command input, mounted only while Home is the active
 * surface), and the shell's key handler consults it before overlaying.
 */

let inlineFocus: (() => void) | null = null;

/** Registration seam for the inline mount — matches the
 *  `CommandTypeahead#exposeFocus` prop shape (focus fn on mount, null on
 *  unmount). Stable identity so effects keyed on it never re-run. */
export function setInlineCommandFocus(focus: (() => void) | null): void {
  inlineFocus = focus;
}

/** Focus the inline command input if one is mounted. True when handled. */
export function focusInlineCommand(): boolean {
  if (!inlineFocus) return false;
  inlineFocus();
  return true;
}

/** Is this keydown the global command binding (⌘K / Ctrl+K)? Plain chord
 *  only — Alt/Shift variants stay the browser's. */
export function isCommandK(e: KeyboardEvent): boolean {
  return (
    (e.metaKey || e.ctrlKey) &&
    !e.altKey &&
    !e.shiftKey &&
    (e.key === 'k' || e.key === 'K')
  );
}
