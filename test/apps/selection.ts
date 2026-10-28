/**
 * Which apps a run of `test/apps/run.ts` drives: its command-line options,
 * and the choice between every app, the named apps, and the slow ones.
 *
 * A scenario that waits on real timeouts declares `export const slow = true`
 * in its `scenario.ts`. Pull requests skip those apps (`--skip-slow`); a
 * separate workflow runs them alone (`--only-slow`). An app named on the
 * command line runs whatever its marker says.
 */

/** Whether a run includes the slow apps, skips them, or runs only them. */
export type SlowFilter = 'include' | 'skip' | 'only';

export interface Options {
  names: string[];
  packages?: string;
  build: boolean;
  /** Apps run at once; undefined leaves it to `defaultJobs` in schedule.ts. */
  jobs?: number;
  keep: boolean;
  slow: SlowFilter;
}

function positiveInteger(value: string | undefined): number {
  const parsed = Number(value);
  const isPositiveInteger = Number.isInteger(parsed) && parsed >= 1;
  if (!isPositiveInteger) throw new Error(`--jobs takes a whole number of at least 1, received ${String(value)}`);
  return parsed;
}

export function parseArguments(argv: string[], env: Record<string, string | undefined> = {}): Options {
  const options: Options = { names: [], build: false, keep: false, packages: env.PYRIC_PACKAGE_ARTIFACT_DIR, slow: 'include' };
  const slowFlags: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '--build') options.build = true;
    else if (argument === '--keep') options.keep = true;
    else if (argument === '--packages') options.packages = argv[++index];
    else if (argument === '--jobs') options.jobs = positiveInteger(argv[++index]);
    else if (argument === '--skip-slow' || argument === '--only-slow') slowFlags.push(argument);
    else if (argument.startsWith('--')) throw new Error(`unknown option ${argument}`);
    else options.names.push(argument);
  }
  const distinctSlowFlags = new Set(slowFlags);
  if (distinctSlowFlags.size > 1) throw new Error('--skip-slow and --only-slow cannot be used together');
  if (distinctSlowFlags.has('--skip-slow')) options.slow = 'skip';
  if (distinctSlowFlags.has('--only-slow')) options.slow = 'only';
  return options;
}

export interface Selection {
  /** The apps this run drives, in order. */
  run: string[];
  /** The slow apps the run leaves out. */
  skippedSlow: string[];
}

/**
 * Named apps run as named. Otherwise every available app runs, less the slow
 * ones under `skip`, or only the slow ones under `only`.
 */
export function selectApps(input: {
  available: readonly string[];
  names: readonly string[];
  slow: ReadonlySet<string>;
  filter: SlowFilter;
}): Selection {
  if (input.names.length > 0) return { run: [...input.names], skippedSlow: [] };
  const isSlow = (name: string): boolean => input.slow.has(name);
  if (input.filter === 'skip') {
    return { run: input.available.filter((name) => !isSlow(name)), skippedSlow: input.available.filter(isSlow) };
  }
  if (input.filter === 'only') return { run: input.available.filter(isSlow), skippedSlow: [] };
  return { run: [...input.available], skippedSlow: [] };
}

/** The clause the run summary appends for the slow apps it skipped, or the empty string. */
export function skippedSlowClause(skippedSlow: readonly string[]): string {
  if (skippedSlow.length === 0) return '';
  const noun = skippedSlow.length === 1 ? 'slow app' : 'slow apps';
  return `; skipped ${skippedSlow.length} ${noun} (${skippedSlow.join(', ')})`;
}
