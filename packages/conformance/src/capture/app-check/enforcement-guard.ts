/**
 * Each project's AI Logic enforcement date is configurable, so the rig records
 * behavior with enforcement off or on. Any run that sends a generateContent
 * request reads the enforcement mode first and refuses a mode it cannot name.
 * A full run records the mode on what it writes: `app-check-ai-gate-wire` in its
 * behavior, and each browser probe's file through its observation context. A
 * selected run of an AI probe records it the same way and refuses ENFORCED, so a
 * partial run cannot replace one file of an unenforced capture set on its own.
 */

const CAPTURABLE_MODES: readonly string[] = ['UNENFORCED', 'OFF', 'ENFORCED'];

/** Standalone browser probes that send a real generateContent request. */
export const AI_REQUEST_BROWSER_PROBES: readonly string[] = ['app-check-client-get-token-before-initialize'];

/** A full run (no selection) always sends AI requests; a selection does when it names an AI probe. */
function sendsAiRequest(only: readonly string[] | undefined): boolean {
  if (!only) return true;
  return only.some((name) => AI_REQUEST_BROWSER_PROBES.includes(name));
}

/** Throws unless AI Logic enforcement reads a mode the capture can record. */
function assertCapturableMode(enforcementMode: string): void {
  if (CAPTURABLE_MODES.includes(enforcementMode)) return;
  throw new Error(`firebaseml.googleapis.com enforcementMode is ${enforcementMode}; this run expects ${CAPTURABLE_MODES.join(', ')}`);
}

/** Throws when a selected AI probe would capture with enforcement on. */
function assertSelectionAllowed(only: readonly string[] | undefined, enforcementMode: string | null): void {
  if (!only || enforcementMode !== 'ENFORCED') return;
  throw new Error(`firebaseml.googleapis.com enforcementMode is ENFORCED; a selected AI probe (--only) runs only with enforcement off. Run the full rig to capture ENFORCED.`);
}

/**
 * Reads enforcement and asserts it is a known mode when the run sends an AI request.
 * Returns the mode it read, or null when the run sends none and nothing was read.
 */
async function guardAiEnforcement(
  only: readonly string[] | undefined,
  readEnforcement: () => Promise<string>,
): Promise<string | null> {
  if (!sendsAiRequest(only)) return null;
  const enforcementMode = await readEnforcement();
  assertCapturableMode(enforcementMode);
  return enforcementMode;
}

interface ProbeRun {
  only: readonly string[] | undefined;
  readEnforcement: () => Promise<string>;
  /** Runs the named standalone browser probes; receives the mode the guard read, or null when it read none. */
  runSelected: (only: readonly string[], enforcementMode: string | null) => Promise<void>;
  /** Runs every probe; receives the enforcement mode the guard read. */
  runAll: (enforcementMode: string) => Promise<void>;
}

/** The rig's dispatch: the enforcement guard runs before any probe that sends an AI request. */
export async function runProbes(run: ProbeRun): Promise<void> {
  const enforcementMode = await guardAiEnforcement(run.only, run.readEnforcement);
  assertSelectionAllowed(run.only, enforcementMode);
  if (run.only) {
    await run.runSelected(run.only, enforcementMode);
    return;
  }
  await run.runAll(enforcementMode ?? 'UNSET');
}
