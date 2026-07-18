/**
 * Session-scoped event-log folding — the ONE rule for what a Studio event
 * accumulation keeps across a sandbox reset (issue #359 extension: Settings →
 * Reset must also empty Traffic / Session / Action Center, not just the data).
 *
 * `sandbox.reset()` emits a `session_boundary` (phase `'reset'`) and THEN
 * clears its own `history()` — the source of truth reads empty afterwards.
 * Studio's surfaces, however, ACCUMULATE the live stream in their own state
 * (the worker feed's running snapshot, `useStudioEvents`, the Action Center
 * buffer, the dev-seed event log); without folding the boundary they keep
 * showing the wiped session's traffic forever. Every accumulation site folds
 * through here so the rule cannot drift per surface.
 *
 * PINNED DECISION: on a reset boundary the fold keeps EXACTLY the boundary
 * event itself — the live view shows one "session reset" marker (see
 * `features/home/activity.ts`) instead of a mysteriously blank log, while
 * everything from the closed session drops. `sandbox.history()` itself keeps
 * NOTHING (a worker reboot shows an empty feed); the marker is a live-view
 * nicety only. A `'dispose'` boundary does NOT clear: dispose closes the
 * sandbox, it doesn't wipe data.
 */
import type { SandboxEvent } from 'pyric/sandbox';

/** True for the `session_boundary` a `sandbox.reset()` emits — the signal
 *  that every event before it belongs to a wiped session. */
export function isSessionResetBoundary(event: SandboxEvent): boolean {
  return event.kind === 'session_boundary' && event.phase === 'reset';
}

/**
 * Fold one live event into an accumulated log: append, except a reset
 * boundary REPLACES the log with just itself. Pure/immutable — safe as a
 * React `setState` updater.
 */
export function foldSessionEventLog(
  prev: readonly SandboxEvent[],
  event: SandboxEvent,
): readonly SandboxEvent[] {
  return isSessionResetBoundary(event) ? [event] : [...prev, event];
}
