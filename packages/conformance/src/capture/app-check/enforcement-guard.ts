/**
 * The App Check rig records AI Logic behavior with enforcement off. Any run
 * that sends a generateContent request reads the enforcement mode first and
 * refuses to capture when it is on, so an enforced-mode response never
 * overwrites an observation that describes the unenforced one.
 */

/** Standalone browser probes that send a real generateContent request. */
export const AI_REQUEST_BROWSER_PROBES: readonly string[] = ['app-check-client-get-token-before-initialize'];

/** A full run (no selection) always sends AI requests; a selection does when it names an AI probe. */
function sendsAiRequest(only: readonly string[] | undefined): boolean {
  if (!only) return true;
  return only.some((name) => AI_REQUEST_BROWSER_PROBES.includes(name));
}

/** Throws unless AI Logic enforcement reads off. */
function assertEnforcementOff(enforcementMode: string): void {
  const off = enforcementMode === 'UNENFORCED' || enforcementMode === 'OFF';
  if (off) return;
  throw new Error(`firebaseml.googleapis.com enforcementMode is ${enforcementMode}; this run expects enforcement off`);
}

/**
 * Reads enforcement and asserts it is off when the run sends an AI request.
 * Returns the mode it read, or null when the run sends none and nothing was read.
 */
async function guardAiEnforcement(
  only: readonly string[] | undefined,
  readEnforcement: () => Promise<string>,
): Promise<string | null> {
  if (!sendsAiRequest(only)) return null;
  const enforcementMode = await readEnforcement();
  assertEnforcementOff(enforcementMode);
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
