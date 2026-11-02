/** The factory's harness commands: `factory`, `factory-summary` and `factory-check`. */
import { parseCheckOptions, parseFactoryOptions, parseSummaryOptions } from './options.ts';
import { RunDirError, runPaths } from './run-dir.ts';
import { loadRunner } from './runner-module.ts';
import { formatSummary } from './summary.ts';
import { runSupervisor } from './supervisor.ts';
import { readTimeline } from './timeline.ts';
import { checkSupervisor } from './watchdog.ts';

export const FACTORY_USAGE = 'factory --run-dir <dir> [--hours <n>] [--resume] [--runner <module>]';
export const FACTORY_SUMMARY_USAGE = 'factory-summary --run-dir <dir>';
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
  return 0;
}

export async function factoryCheckCommand(args: readonly string[]): Promise<number> {
  const options = parseCheckOptions(args);
  const result = checkSupervisor(runPaths(options.runDir), options.unit, options.staleMinutes * 60_000, Date.now());
  console.log(result.message);
  return result.exitCode;
}
