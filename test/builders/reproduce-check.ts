/**
 * Everything `reproduce` checks before it starts a sandbox: the run's kept
 * record and app, the problem it names, the script, the checkout (as the
 * canary checks it), and that the tarballs are the ones the run installed.
 * A reproduction on other tarballs would test other code, so it refuses
 * rather than warns.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tarballsIn, type Tarballs } from '../apps/install.ts';
import { PreflightFailed, preflightProblems } from './canary/canary.ts';
import { tarballMismatches } from './provenance.ts';
import { findTarget, readKeptRun, reproTargets, targetLine, type KeptRun, type ReproTarget } from './repro-target.ts';
import type { ReproduceOptions } from './reproduce-options.ts';
import { runDataDir } from './round-paths.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export interface CheckedRepro {
  kept: KeptRun;
  target: ReproTarget;
  appArchive: string;
  tarballs: Tarballs;
  packagesDir: string;
}

export const keptRecordFile = (round: string, run: string) => join(runDataDir(round, run), 'report.json');

/** The run's kept record, or `PreflightFailed` naming why it can't be read. */
export function keptRunOrFail(round: string, run: string): KeptRun {
  const read = readKeptRun(keptRecordFile(round, run));
  if (!read.ok) throw new PreflightFailed(`run ${run} of round ${round} can't be reproduced:\n- ${read.errors.join('\n- ')}`);
  return read.value;
}

/** The lines `reproduce <round> <run> --list` prints. */
export function listLines(round: string, run: string): string[] {
  return reproTargets(keptRunOrFail(round, run)).map(targetLine);
}

function tarballProblems(kept: KeptRun, packagesDir: string): { tarballs?: Tarballs; problems: string[] } {
  if (!existsSync(packagesDir)) return { problems: [] };
  let tarballs: Tarballs;
  try {
    tarballs = tarballsIn(REPO_ROOT, packagesDir);
  } catch (error) {
    return { problems: [error instanceof Error ? error.message : String(error)] };
  }
  const mismatches = tarballMismatches(kept.harness.provenance.tarballs, tarballs);
  if (mismatches.length === 0) return { tarballs, problems: [] };
  const why = `the tarballs in ${packagesDir} are not the ones run ${kept.harness.run} installed (commit ${kept.harness.provenance.commit})`;
  return { problems: [`${why}: ${mismatches.join('; ')}`] };
}

/** Checks everything; throws `PreflightFailed` with every problem. */
export function checkReproduce(options: ReproduceOptions): CheckedRepro {
  const kept = keptRunOrFail(options.round, options.run);
  const packagesDir = options.packages ?? join(REPO_ROOT, 'dist', 'packages');
  const appArchive = join(runDataDir(options.round, options.run), 'app.tgz');
  const { target, error } = findTarget(kept, options.problem);
  const { tarballs, problems: tarballErrors } = tarballProblems(kept, packagesDir);
  const problems = [
    ...(error === undefined ? [] : [error]),
    ...(existsSync(appArchive) ? [] : [`run ${options.run} kept no app.tgz (it is withheld when the app held the harness's token)`]),
    ...(existsSync(options.script) ? [] : [`the repro script ${options.script} does not exist`]),
    ...preflightProblems(REPO_ROOT, { build: false, packages: packagesDir }),
    ...tarballErrors,
  ];
  const isReady = problems.length === 0 && target !== undefined && tarballs !== undefined;
  if (!isReady) throw new PreflightFailed(`can't reproduce ${options.problem} of run ${options.run}:\n- ${problems.join('\n- ')}`);
  return { kept, target, appArchive, tarballs, packagesDir };
}
