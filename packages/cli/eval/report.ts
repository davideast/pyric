/**
 * Reporting. Reads one or more `runs.ndjson` files and prints, per variant and
 * row, the four numbers the eval exists to compare, each with a bootstrap 95%
 * interval.
 *
 * The resampling unit is the task, not the run. Seeds of one task are repeats
 * of the same question, so treating them as independent would understate the
 * interval. Resampling tasks with replacement and pooling every run of each
 * drawn task keeps the interval honest about how few distinct questions the
 * corpus asks.
 */
import { existsSync, readFileSync } from 'node:fs';
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

export interface CellReport {
  variant: string;
  row: string;
  runs: number;
  tasks: number;
  selectionAccuracy: Interval;
  argumentValidity: Interval;
  completion: Interval;
  meanCallsPerCompletedTask: Interval;
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

const completion: Statistic = (runs) => {
  if (runs.length === 0) return Number.NaN;
  return runs.filter((run) => run.outcome === 'pass').length / runs.length;
};

const meanCallsPerCompletedTask: Statistic = (runs) => {
  const passed = runs.filter((run) => run.outcome === 'pass');
  if (passed.length === 0) return Number.NaN;
  let calls = 0;
  for (const run of passed) calls += run.callCount;
  return calls / passed.length;
};

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
      argumentValidity: bootstrap(tasks, argumentValidity, seed),
      completion: bootstrap(tasks, completion, seed),
      meanCallsPerCompletedTask: bootstrap(tasks, meanCallsPerCompletedTask, seed),
    });
  }
  return reports;
}

/** Read every result line out of the named NDJSON files. */
export function readResults(paths: string[]): EvalResultLine[] {
  const runs: EvalResultLine[] = [];
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`no results file at ${path}`);
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      runs.push(JSON.parse(trimmed) as EvalResultLine);
    }
  }
  return runs;
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
    lines.push(`  argument validity    ${formatRate(report.argumentValidity)}`);
    lines.push(`  completion           ${formatRate(report.completion)}`);
    lines.push(`  calls per completion ${formatCount(report.meanCallsPerCompletedTask)}`);
    lines.push('');
  }
  return lines.join('\n');
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    process.stderr.write('usage: report.ts <runs.ndjson> [more.ndjson ...]\n');
    process.exit(2);
  }
  process.stdout.write(renderReport(buildReport(readResults(paths))));
}
