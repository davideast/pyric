// The quarantine verdict for a run of the app scenarios (test/apps/run.ts).
// Each app is one result, named by its directory, `test/apps/<app>`. The run's
// own summary is the count, so the same conditions as a bun suite apply.

import { readEntries, todayUtc, type LoadedEntry, type TestResult } from './entries.ts';
import { publish } from './report.ts';
import { honouredEntries } from './validate.ts';
import { decide, type Verdict } from './verdict.ts';

export interface AppVerdictInput {
  apps: ReadonlyArray<{ name: string; ok: boolean }>;
  exitCode: number;
}

function appResult(app: { name: string; ok: boolean }): TestResult {
  const id = `test/apps/${app.name}`;
  const outcome = app.ok ? 'passed' : 'failed';
  return { id, file: id, outcome };
}

export function appVerdict(input: AppVerdictInput, entries: LoadedEntry[], today: string): Verdict {
  const results = input.apps.map(appResult);
  const fail = results.filter((result) => result.outcome === 'failed').length;
  return decide({ exitCode: input.exitCode, results, totals: { fail, errors: 0 } }, entries, today);
}

/** Decides, reports, and returns the exit code the app run ends with. */
export function finishAppRun(suite: string, input: AppVerdictInput): number {
  const verdict = appVerdict(input, honouredEntries(readEntries()), todayUtc());
  publish(suite, verdict);
  return verdict.exitCode;
}
