/**
 * AI Logic enforces App Check for every project from November 2, 2026, so the
 * rig records behavior with enforcement off or on. Any run that sends a
 * generateContent request reads the enforcement mode first, and refuses to
 * capture on a mode it cannot name, so an observation always says which mode
 * it describes.
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
  /** Runs the named standalone browser probes. */
  runSelected: (only: readonly string[]) => Promise<void>;
  /** Runs every probe; receives the enforcement mode the guard read. */
  runAll: (enforcementMode: string) => Promise<void>;
}

/** The rig's dispatch: the enforcement guard runs before any probe that sends an AI request. */
export async function runProbes(run: ProbeRun): Promise<void> {
  const enforcementMode = await guardAiEnforcement(run.only, run.readEnforcement);
  if (run.only) {
    await run.runSelected(run.only);
    return;
  }
  await run.runAll(enforcementMode ?? 'UNSET');
}
