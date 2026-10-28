/**
 * Ends an app's processes and removes its temp tree, for run.ts. A failure in
 * either step is returned, never thrown: by then the app's verdict is known,
 * and a cleanup error must neither hide it nor stop the apps still running.
 */
import { tmpdir } from 'node:os';
import { runCommand, type CommandResult } from './install.ts';

/** Runs `rm` with these arguments. */
export type RunRemove = (args: string[]) => Promise<CommandResult>;

const runRm: RunRemove = (args) => runCommand('rm', args, { cwd: tmpdir() });

/** How many times `removeTree` runs `rm -rf` before it reports the tree as left behind. */
const REMOVE_ATTEMPTS = 3;
/** The wait between attempts, for a process that is still exiting to stop writing into the tree. */
const RETRY_DELAY_MS = 250;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Remove `path` and everything under it with `rm -rf` in a child process. A
 * child keeps the walk off the runner's event loop (#1283), and keeps it out
 * of Bun's own recursive rm: Bun 1.3.11 reports an error it has no errno for,
 * such as a directory removed while it reads it, as EFAULT, and that crashed
 * the alpha.30 gate (#1354). A failed attempt is retried, since a process
 * still exiting can add an entry after rm has read its directory.
 *
 * Resolves to undefined once the tree is gone, or to why it is still there.
 */
export async function removeTree(path: string, runRemove: RunRemove = runRm, retryDelayMs = RETRY_DELAY_MS): Promise<string | undefined> {
  let reason = '';
  for (let attempt = 1; attempt <= REMOVE_ATTEMPTS; attempt++) {
    try {
      const result = await runRemove(['-rf', '--', path]);
      if (result.code === 0) return undefined;
      reason = `rm exited with code ${result.code}: ${result.output.trim() || '(no output)'}`;
    } catch (error) {
      reason = `rm did not start: ${describe(error)}`;
    }
    const isLastAttempt = attempt === REMOVE_ATTEMPTS;
    if (!isLastAttempt) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  return `could not remove ${path} after ${REMOVE_ATTEMPTS} attempts: ${reason}`;
}

/**
 * Close an app's run, then remove its tree, even when closing throws. Returns
 * what went wrong, one line per failed step, or an empty list.
 */
export async function cleanUpApp(steps: { close: () => Promise<void>; remove: () => Promise<string | undefined> }): Promise<string[]> {
  const failures: string[] = [];
  try {
    await steps.close();
  } catch (error) {
    failures.push(`closing the app's browser and processes failed: ${describe(error)}`);
  }
  try {
    const removeFailure = await steps.remove();
    if (removeFailure !== undefined) failures.push(removeFailure);
  } catch (error) {
    failures.push(`removing the app's directory failed: ${describe(error)}`);
  }
  return failures;
}

/** What `summarize` needs of each app's result. */
export interface Verdict {
  name: string;
  ok: boolean;
  step?: string;
  cleanupFailures: string[];
}

/**
 * The run's closing lines and exit code. Cleanup failures are a warning on
 * their own lines, after every app's verdict, and never change the exit code:
 * each app's temp folder has a unique name, so one left behind cannot affect a
 * later run, and failing a release over it would stop the gate on something
 * that is not a verdict.
 */
export function summarize(results: readonly Verdict[], totalSeconds: string, skipped: string): { lines: string[]; exitCode: number } {
  const failed = results.filter((result) => !result.ok);
  const uncleaned = results.filter((result) => result.cleanupFailures.length > 0);
  const lines = [failed.length
    ? `✗ ${failed.length} of ${results.length} apps failed (${totalSeconds}s): ${failed.map((result) => `${result.name} at "${result.step}"`).join(', ')}${skipped}`
    : `✓ ${results.length} apps passed (${totalSeconds}s)${skipped}`];
  if (uncleaned.length) {
    lines.push(`warning: cleanup failed for ${uncleaned.length} of ${results.length} apps: ${uncleaned.map((result) => result.name).join(', ')}`);
    for (const result of uncleaned) lines.push(...result.cleanupFailures.map((failure) => `  ${result.name}: ${failure}`));
  }
  return { lines, exitCode: failed.length > 0 ? 1 : 0 };
}
