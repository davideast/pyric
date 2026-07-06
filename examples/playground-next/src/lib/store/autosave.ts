/**
 * Ambient-autosave status — the observable seam for the session
 * autosave loop in `useSessionRouting`.
 *
 * The playground autosaves the session payload (rules + App.tsx +
 * conversation) ~800 ms after every chat/workspace change. That loop
 * is invisible without this store: `useSessionRouting` reports each
 * save's real lifecycle here (saving → saved/error), and the TopBar's
 * `AutosaveStatus` indicator renders it. Nothing in here invents
 * status from timers — `report()` is only called around the actual
 * `saveSession` promise.
 */
import { create } from 'zustand';

/**
 * The one user-facing sentence describing what actually persists.
 * Single source of truth — rendered as the indicator tooltip AND in
 * the status popover. Derived from the state-persistence audit
 * (true on main as of 2026-06-11):
 *   - session payload = rules + App.tsx + chat, autosaved locally
 *     (IndexedDB `pyric:playground:sessions`)
 *   - every other workspace file writes through to OPFS instantly,
 *     and that tree is shared across sessions
 *   - sandbox Firestore data + sandbox auth users are in-memory only
 * If sandbox persistence lands (a parallel track), update THIS
 * constant — it is the only place the claim lives.
 */
export const AUTOSAVE_TRUTH_COPY =
  'This session autosaves its rules, app code, and chat to this ' +
  'browser. Other workspace files persist instantly and are shared ' +
  'across sessions; sandbox data is not yet saved.';

export type AutosaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; at: number }
  | { status: 'error'; message: string };

interface AutosaveStoreState {
  state: AutosaveState;
  report(state: AutosaveState): void;
}

export const useAutosaveStore = create<AutosaveStoreState>()((set) => ({
  state: { status: 'idle' },
  report: (state) => set({ state }),
}));

/** Imperative reporter for non-React callers (`useSessionRouting`'s
 *  persist closure). */
export function reportAutosave(state: AutosaveState): void {
  useAutosaveStore.getState().report(state);
}

export interface AutosaveDescription {
  /** Short label for the TopBar indicator, e.g. "Saved · just now". */
  label: string;
  /** Render hint: muted (idle), busy (saving), ok (saved), error. */
  tone: 'muted' | 'busy' | 'ok' | 'error';
}

/**
 * Pure derivation: autosave state → indicator label + tone. `now` is
 * injected so the relative-time buckets are testable without clocks.
 */
export function describeAutosave(
  state: AutosaveState,
  now: number = Date.now(),
): AutosaveDescription {
  switch (state.status) {
    case 'idle':
      // Session loaded, nothing changed yet this visit — autosave is
      // armed but hasn't fired. "Saved" would overclaim (we didn't
      // save anything); "Autosave on" states the actual contract.
      return { label: 'Autosave on', tone: 'muted' };
    case 'saving':
      return { label: 'Saving…', tone: 'busy' };
    case 'saved':
      return { label: `Saved · ${relativeTime(state.at, now)}`, tone: 'ok' };
    case 'error':
      return { label: 'Save failed', tone: 'error' };
  }
}

/** Coarse relative-time buckets for the saved label. Mirrors the
 *  home page's session-card formatter, plus a "just now" bucket so
 *  the steady state right after a save reads naturally. */
function relativeTime(at: number, now: number): string {
  const diff = Math.max(0, now - at);
  if (diff < 10_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}
