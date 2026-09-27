/**
 * Summary statistics and the baseline comparison for the rules benchmark.
 * Pure functions, so the gate's arithmetic has its own test.
 */

/** One stage's timing summary, in microseconds. */
export interface StageSummary {
  median: number;
  p95: number;
  p99: number;
  samples: number;
}

/** A stage row in a report: timing, or a count (the simulator node axis). */
export interface StageRow extends Partial<StageSummary> {
  /** `fixture / request` the row belongs to. */
  subject: string;
  /** Stage name, such as `parse.warm` or `evaluate`. */
  stage: string;
  /** How the value was produced: timed directly, or derived from timed stages. */
  kind: 'timed' | 'derived' | 'count';
  /** For `count` rows: the counted value. */
  count?: number;
  /** A short note that belongs next to the number. */
  note?: string;
}

export interface BenchReport {
  version: 1;
  recordedAt: string;
  machine: { platform: string; arch: string; cpu: string; memoryGiB: number; bun: string };
  settings: { warmup: number; iterations: number; coldSamples: number; rounds: number };
  rows: StageRow[];
}

/** Nearest-rank percentile of sorted values. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

/** Summarize nanosecond samples as microseconds, rounded to 0.01. */
export function summarize(nanoseconds: readonly number[]): StageSummary {
  const sorted = nanoseconds.map((ns) => ns / 1000).sort((a, b) => a - b);
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    median: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    samples: sorted.length,
  };
}

export const rowKey = (row: Pick<StageRow, 'subject' | 'stage'>) => `${row.subject} :: ${row.stage}`;

export interface GateResult {
  regressions: string[];
  improvements: string[];
  missing: string[];
  added: string[];
}

/**
 * Compare a run to the baseline. A timed stage regresses when its median
 * exceeds the baseline median by more than `margin` (0.25 = 25 percent) and
 * by more than `floorMicros`, so a sub-microsecond stage cannot fail on timer
 * jitter alone. A count row regresses on any increase. Derived rows are the
 * difference of two timed medians, so they carry the noise of both; they are
 * reported and never gated. Stages in only one of the two reports are listed,
 * never failed.
 */
export function compareToBaseline(
  baseline: BenchReport,
  current: BenchReport,
  margin = 0.25,
  floorMicros = 1,
): GateResult {
  const base = new Map(baseline.rows.map((row) => [rowKey(row), row]));
  const now = new Map(current.rows.map((row) => [rowKey(row), row]));
  const result: GateResult = { regressions: [], improvements: [], missing: [], added: [] };

  for (const [key, row] of now) {
    const before = base.get(key);
    if (!before) {
      result.added.push(key);
      continue;
    }
    if (row.kind === 'count') {
      if ((row.count ?? 0) > (before.count ?? 0)) {
        result.regressions.push(`${key}: ${before.count} -> ${row.count}`);
      } else if ((row.count ?? 0) < (before.count ?? 0)) {
        result.improvements.push(`${key}: ${before.count} -> ${row.count}`);
      }
      continue;
    }
    if (row.kind === 'derived') continue;
    const was = before.median;
    const is = row.median;
    if (was === undefined || is === undefined || !Number.isFinite(was) || !Number.isFinite(is)) continue;
    const change = was === 0 ? 0 : (is - was) / was;
    const line = `${key}: ${was} us -> ${is} us (${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%)`;
    if (is > was * (1 + margin) && is - was > floorMicros) result.regressions.push(line);
    else if (is < was * (1 - margin) && was - is > floorMicros) result.improvements.push(line);
  }
  for (const key of base.keys()) if (!now.has(key)) result.missing.push(key);
  return result;
}
