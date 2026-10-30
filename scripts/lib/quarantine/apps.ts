// The quarantine verdict for a run of the app scenarios (test/apps/run.ts).
// Each app is one result, named by its directory, `test/apps/<app>`. Only a
// failure inside the app's scenario carries that name: a failure while it
// installs or loads is named `test/apps/<app> > <step>`, which no entry names,
// so it always blocks. The run's own summary is the count, so the same
// conditions as a bun suite apply. Quarantine is off unless the runner was
// given `--quarantine` (source.ts), so a publish's app run keeps its exit code.

import { todayUtc, type LoadedEntry, type TestResult } from './entries.ts';
import { publish } from './report.ts';
import { runEntries } from './source.ts';
import { honouredEntries } from './validate.ts';
import { decide, type Verdict } from './verdict.ts';

export interface AppOutcome {
  name: string;
  ok: boolean;
  /** True when the failure happened while the scenario itself ran. */
  inScenario?: boolean;
  step?: string;
}

export interface AppVerdictInput {
  apps: readonly AppOutcome[];
  exitCode: number;
}

function appResult(app: AppOutcome): TestResult {
  const id = `test/apps/${app.name}`;
  if (app.ok) return { id, file: id, outcome: 'passed' };
  const failedInScenario = app.inScenario === true;
  if (failedInScenario) return { id, file: id, outcome: 'failed' };
  return { id: `${id} > ${app.step ?? 'before its scenario'}`, file: id, outcome: 'failed' };
}

export function appVerdict(input: AppVerdictInput, entries: LoadedEntry[], today: string): Verdict {
  const results = input.apps.map(appResult);
  const fail = results.filter((result) => result.outcome === 'failed').length;
  return decide({ exitCode: input.exitCode, results, totals: { fail, errors: 0 } }, entries, today);
}

/** Decides, reports, and returns the exit code the app run ends with. */
export function finishAppRun(suite: string, input: AppVerdictInput, quarantine: boolean, env: NodeJS.ProcessEnv = process.env): number {
  if (!quarantine) return input.exitCode;
  const verdict = appVerdict(input, honouredEntries(runEntries(env)), todayUtc());
  publish(suite, verdict, env);
  return verdict.exitCode;
}
