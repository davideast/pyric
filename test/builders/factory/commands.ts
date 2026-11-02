/** The factory's harness commands: `factory`, `factory-summary`, `factory-check` and `factory-drafts`. */
import { checkDrafts, draftsDir, formatDrafts } from './drafts.ts';
import { parseCheckOptions, parseFactoryOptions, parseSummaryOptions } from './options.ts';
import { RunDirError, runPaths } from './run-dir.ts';
import { loadRunner } from './runner-module.ts';
import { workDirOf } from './app-paths.ts';
import { formatSummary, workSizeLine } from './summary.ts';
import { runSupervisor } from './supervisor.ts';
import { readTimeline } from './timeline.ts';
import { checkSupervisor } from './watchdog.ts';

export const FACTORY_USAGE = 'factory --run-dir <dir> [--hours <n> --agent <name> --brief-dir <dir>] [--resume] [--runner <module>]';
export const FACTORY_SUMMARY_USAGE = 'factory-summary --run-dir <dir>';
export const FACTORY_DRAFTS_USAGE = 'factory-drafts --run-dir <dir>';
export const FACTORY_CHECK_USAGE = 'factory-check --run-dir <dir> --unit <name> [--stale-minutes <n>]';

/** Runs the supervisor to the deadline. A SIGTERM or SIGINT stops it, and its sessions, early. */
export async function factoryCommand(args: readonly string[]): Promise<number> {
  const options = parseFactoryOptions(args);
  const runner = await loadRunner(options.runner);
  const stop = new AbortController();
  const onSignal = (): void => stop.abort();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    await runSupervisor({ ...options, ...runner, stop: stop.signal });
    return 0;
  } catch (error) {
    if (!(error instanceof RunDirError)) throw error;
    console.error(error.message);
    return 2;
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
}

export async function factorySummaryCommand(args: readonly string[]): Promise<number> {
  const { runDir } = parseSummaryOptions(args);
  console.log(formatSummary(readTimeline(runPaths(runDir).timeline)));
  console.log(workSizeLine(workDirOf(runDir)));
  return 0;
}

export async function factoryCheckCommand(args: readonly string[]): Promise<number> {
  const options = parseCheckOptions(args);
  const result = checkSupervisor(runPaths(options.runDir), options.unit, options.staleMinutes * 60_000, Date.now());
  console.log(result.message);
  return result.exitCode;
}

/** Prints the run's issue drafts and what breaks the issue standard in each; exits 1 when any does. */
export async function factoryDraftsCommand(args: readonly string[]): Promise<number> {
  const { runDir } = parseSummaryOptions(args);
  const checks = checkDrafts(runDir);
  console.log(formatDrafts(draftsDir(runDir), checks));
  return checks.some((check) => check.errors.length > 0) ? 1 : 0;
}
