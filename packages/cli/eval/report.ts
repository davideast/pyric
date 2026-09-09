/**
 * Reporting: statistics and rendering. Reads one or more `runs.ndjson` files,
 * or one or more results directories, and prints, per variant and row, the
 * numbers the eval exists to compare, each with a bootstrap 95% interval.
 *
 * The resampling unit is the task, not the run. Seeds of one task are repeats
 * of the same question, so treating them as independent would understate the
 * interval. Resampling tasks with replacement and pooling every run of each
 * drawn task keeps the interval honest about how few distinct questions the
 * corpus asks.
 *
 * A results directory is not trusted verbatim: `loadRunLines` hands it to
 * `rederive.ts`, which re-scores every run whose event log is intact against
 * the current corpus, so a corrected assertion or a fixed classifier applies
 * to runs already paid for. This folds what used to be `rescore.ts` into the
 * one reporting tool.
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { loadRows, loadTasks } from './load.js';
import { readNdjsonLines, rederiveResultsDirectory, type LoadRunLinesOptions } from './rederive.js';
import type { EvalResultLine } from './types.js';

/** Resamples per interval. Fixed so two reports over the same data agree. */
export const BOOTSTRAP_RESAMPLES = 1000;
/** Default RNG seed. Reporting is deterministic unless a caller changes this. */
export const BOOTSTRAP_SEED = 0x5eed;

export interface Interval {
  value: number;
  low: number;
  high: number;
}

/** Outcomes that are infrastructure or bypass signals, not a verdict on the task. */
const INFRA_OUTCOMES: ReadonlySet<string> = new Set(['throttled', 'interrupted', 'bypassed']);

export interface InfrastructureCounts {
  throttled: number;
  interrupted: number;
  bypassed: number;
}

export interface CellReport {
  variant: string;
  row: string;
  runs: number;
  tasks: number;
  selectionAccuracy: Interval;
  /** Whether any logged call, not just the first, reached an accepted operation. */
  acceptedOpReached: Interval;
  argumentValidity: Interval;
  completion: Interval;
  /** Completion restricted to runs that logged at least one MCP call. */
  completionEngaged: Interval;
  meanCallsPerCompletedTask: Interval;
  /** Share of runs in which the server rejected at least one call on schema. */
  runsWithARejection: Interval;
  /** Mean wall-clock seconds one run took. */
  meanDurationSeconds: Interval;
  infrastructure: InfrastructureCounts;
}

/**
 * Deterministic 32-bit RNG. A named generator rather than `Math.random` so a
 * report is reproducible and a test can pin its output.
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A statistic over a pooled set of runs. Returns NaN when the set says nothing. */
type Statistic = (runs: EvalResultLine[]) => number;

const selectionAccuracy: Statistic = (runs) => {
  if (runs.length === 0) return Number.NaN;
  const accepted = runs.filter((run) => run.firstOperationAccepted).length;
  return accepted / runs.length;
};

/** Whether any logged call, not just the first, reached an accepted operation. */
const acceptedOpReached: Statistic = (runs) => {
  if (runs.length === 0) return Number.NaN;
  const reached = runs.filter((run) => run.acceptedOpReached).length;
  return reached / runs.length;
};

/** Share of logged calls the server accepted rather than rejecting on schema. */
const argumentValidity: Statistic = (runs) => {
  let calls = 0;
  let rejected = 0;
  for (const run of runs) {
    calls += run.callCount;
    rejected += run.schemaRejections;
  }
  if (calls === 0) return Number.NaN;
  return (calls - rejected) / calls;
};

/**
 * Runs whose outcome carries a verdict on the task rather than an
 * infrastructure or bypass signal. A throttled, interrupted or bypassed run
 * never reached the task, so it would understate completion to count it as a
 * failure; it is reported on its own instead, under `infrastructure`.
 */
function eligibleForCompletion(runs: EvalResultLine[]): EvalResultLine[] {
  return runs.filter((run) => !INFRA_OUTCOMES.has(run.outcome));
}

const completion: Statistic = (runs) => {
  const eligible = eligibleForCompletion(runs);
  if (eligible.length === 0) return Number.NaN;
  return eligible.filter((run) => run.outcome === 'pass').length / eligible.length;
};

/** Runs that logged at least one MCP call, engaging the surface under test. */
function engagedRuns(runs: EvalResultLine[]): EvalResultLine[] {
  return runs.filter((run) => run.callCount > 0);
}

const completionEngaged: Statistic = (runs) => completion(engagedRuns(runs));

const meanCallsPerCompletedTask: Statistic = (runs) => {
  const passed = runs.filter((run) => run.outcome === 'pass');
  if (passed.length === 0) return Number.NaN;
  let calls = 0;
  for (const run of passed) calls += run.callCount;
  return calls / passed.length;
};

/**
 * Share of runs the server rejected at least one call in. Counted over runs
 * that reached the task, like completion, because a throttled or bypassed run
 * made no calls to reject and would only dilute the rate.
 */
const runsWithARejection: Statistic = (runs) => {
  const eligible = eligibleForCompletion(runs);
  if (eligible.length === 0) return Number.NaN;
  return eligible.filter((run) => run.schemaRejections > 0).length / eligible.length;
};

/** Mean wall-clock seconds one run took, over the runs that reached the task. */
const meanDurationSeconds: Statistic = (runs) => {
  const eligible = eligibleForCompletion(runs);
  if (eligible.length === 0) return Number.NaN;
  let totalMs = 0;
  for (const run of eligible) totalMs += run.durationMs;
  return totalMs / eligible.length / 1000;
};

/** Counts of the three infrastructure and bypass outcomes in a pooled run set. */
function infrastructureCounts(runs: EvalResultLine[]): InfrastructureCounts {
  return {
    throttled: runs.filter((run) => run.outcome === 'throttled').length,
    interrupted: runs.filter((run) => run.outcome === 'interrupted').length,
    bypassed: runs.filter((run) => run.outcome === 'bypassed').length,
  };
}

/** Group runs by task id, preserving a stable task order for the resampler. */
function byTask(runs: EvalResultLine[]): EvalResultLine[][] {
  const groups = new Map<string, EvalResultLine[]>();
  for (const run of runs) {
    const existing = groups.get(run.task);
    if (existing === undefined) {
      groups.set(run.task, [run]);
      continue;
    }
    existing.push(run);
  }
  return [...groups.keys()].sort().map((task) => groups.get(task) as EvalResultLine[]);
}

/**
 * Point estimate plus a percentile bootstrap 95% interval, resampling tasks
 * with replacement. Resamples that produce no defined value are dropped rather
 * than counted as zero, so a statistic like mean calls per completed task is
 * not dragged down by draws in which nothing completed.
 */
export function bootstrap(
  tasks: EvalResultLine[][],
  statistic: Statistic,
  seed: number = BOOTSTRAP_SEED,
): Interval {
  const pooled = tasks.flat();
  const value = statistic(pooled);
  if (tasks.length === 0) return { value: Number.NaN, low: Number.NaN, high: Number.NaN };

  const rng = createRng(seed);
  const samples: number[] = [];
  for (let resample = 0; resample < BOOTSTRAP_RESAMPLES; resample += 1) {
    const drawn: EvalResultLine[] = [];
    for (let pick = 0; pick < tasks.length; pick += 1) {
      const index = Math.floor(rng() * tasks.length);
      const group = tasks[index];
      if (group !== undefined) drawn.push(...group);
    }
    const estimate = statistic(drawn);
    if (Number.isNaN(estimate)) continue;
    samples.push(estimate);
  }
  if (samples.length === 0) return { value, low: Number.NaN, high: Number.NaN };

  samples.sort((a, b) => a - b);
  return { value, low: percentile(samples, 0.025), high: percentile(samples, 0.975) };
}

/** Nearest-rank percentile of an ascending sample. */
function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] as number;
}

/** One report per variant and row present in the data, in stable id order. */
export function buildReport(runs: EvalResultLine[], seed: number = BOOTSTRAP_SEED): CellReport[] {
  const cells = new Map<string, EvalResultLine[]>();
  for (const run of runs) {
    const key = `${run.variant} ${run.row}`;
    const existing = cells.get(key);
    if (existing === undefined) {
      cells.set(key, [run]);
      continue;
    }
    existing.push(run);
  }

  const reports: CellReport[] = [];
  for (const key of [...cells.keys()].sort()) {
    const cellRuns = cells.get(key) as EvalResultLine[];
    const first = cellRuns[0] as EvalResultLine;
    const tasks = byTask(cellRuns);
    reports.push({
      variant: first.variant,
      row: first.row,
      runs: cellRuns.length,
      tasks: tasks.length,
      selectionAccuracy: bootstrap(tasks, selectionAccuracy, seed),
      acceptedOpReached: bootstrap(tasks, acceptedOpReached, seed),
      argumentValidity: bootstrap(tasks, argumentValidity, seed),
      completion: bootstrap(tasks, completion, seed),
      completionEngaged: bootstrap(tasks, completionEngaged, seed),
      meanCallsPerCompletedTask: bootstrap(tasks, meanCallsPerCompletedTask, seed),
      runsWithARejection: bootstrap(tasks, runsWithARejection, seed),
      meanDurationSeconds: bootstrap(tasks, meanDurationSeconds, seed),
      infrastructure: infrastructureCounts(cellRuns),
    });
  }
  return reports;
}

/** Read every result line out of the named NDJSON files. */
export function readResults(paths: string[]): EvalResultLine[] {
  const runs: EvalResultLine[] = [];
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`no results file at ${path}`);
    for (const line of readNdjsonLines(path)) runs.push(line);
  }
  return runs;
}

/**
 * Read every result line out of the named paths, each either a `runs.ndjson`
 * file (trusted verbatim) or a results directory (re-derived by `rederive.ts`
 * from every run's event log against the current corpus). This is what makes
 * a corrected assertion or a fixed classifier apply to runs already paid for.
 */
export async function loadRunLines(
  paths: string[],
  options: LoadRunLinesOptions = {},
): Promise<EvalResultLine[]> {
  const tasks = options.tasks ?? (await loadTasks());
  const rows = options.rows ?? (await loadRows());
  const lines: EvalResultLine[] = [];
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`no results at ${path}`);
    if (statSync(path).isDirectory()) {
      lines.push(...(await rederiveResultsDirectory(path, tasks, rows)));
    } else {
      lines.push(...readNdjsonLines(path));
    }
  }
  return lines;
}

function formatRate(interval: Interval): string {
  if (Number.isNaN(interval.value)) return 'n/a';
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
  return `${pct(interval.value).padStart(6)} [${pct(interval.low)}, ${pct(interval.high)}]`;
}

function formatCount(interval: Interval): string {
  if (Number.isNaN(interval.value)) return 'n/a';
  const num = (value: number): string => value.toFixed(2);
  return `${num(interval.value).padStart(6)} [${num(interval.low)}, ${num(interval.high)}]`;
}

/** The printed report. Returned rather than written so a test can read it. */
export function renderReport(reports: CellReport[]): string {
  const lines: string[] = [];
  for (const report of reports) {
    lines.push(`${report.variant} / ${report.row}  (${report.runs} runs, ${report.tasks} tasks)`);
    lines.push(`  selection accuracy   ${formatRate(report.selectionAccuracy)}`);
    lines.push(`  accepted op reached  ${formatRate(report.acceptedOpReached)}`);
    lines.push(`  argument validity    ${formatRate(report.argumentValidity)}`);
    lines.push(`  completion           ${formatRate(report.completion)}`);
    lines.push(`  completion (engaged) ${formatRate(report.completionEngaged)}`);
    lines.push(`  calls per completion ${formatCount(report.meanCallsPerCompletedTask)}`);
    lines.push(`  runs with a rejection${formatRate(report.runsWithARejection)}`);
    lines.push(`  mean duration        ${formatCount(report.meanDurationSeconds)} s`);
    const { throttled, interrupted, bypassed } = report.infrastructure;
    if (throttled + interrupted + bypassed > 0) {
      lines.push('  infrastructure and bypass');
      lines.push(`    throttled          ${throttled}`);
      lines.push(`    interrupted        ${interrupted}`);
      lines.push(`    bypassed           ${bypassed}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Parse a trailing `--json <path>` pair out of the argument list, if present. */
function parseJsonFlag(argv: string[]): { paths: string[]; jsonOut: string | null } {
  const paths: string[] = [];
  let jsonOut: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--json') {
      jsonOut = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    paths.push(token);
  }
  return { paths, jsonOut };
}

async function main(argv: string[]): Promise<number> {
  const { paths, jsonOut } = parseJsonFlag(argv);
  if (paths.length === 0) {
    process.stderr.write(
      'usage: report.ts <runs.ndjson | results-dir> [more ...] [--json <out.ndjson>]\n',
    );
    return 2;
  }
  const lines = await loadRunLines(paths);
  process.stdout.write(renderReport(buildReport(lines)));
  if (jsonOut !== null) {
    writeFileSync(jsonOut, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
