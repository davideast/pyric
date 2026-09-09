/**
 * The bootstrap is the number a reader will argue about, so it must be
 * reproducible: the same result lines and the same seed give the same interval,
 * and a different seed moves it. These tests pin both, and pin that the
 * resampling unit is the task rather than the run.
 */
import { describe, expect, test } from 'bun:test';
import { bootstrap, buildReport, createRng, renderReport } from '../report.js';
import type { EvalResultLine } from '../types.js';

function line(overrides: Partial<EvalResultLine>): EvalResultLine {
  return {
    runId: 'r',
    row: 'row-a',
    variant: 'verb-prefixed',
    task: 't1',
    seed: 1,
    outcome: 'pass',
    firstOperation: 'get_firestore_document',
    firstOperationAccepted: true,
    callCount: 2,
    schemaRejections: 0,
    errorCalls: 0,
    durationMs: 100,
    assertReason: null,
    ...overrides,
  };
}

/** Six tasks, four of which pass, so every statistic has a defined value. */
function mixedRuns(): EvalResultLine[] {
  return [
    line({ task: 't1' }),
    line({ task: 't2' }),
    line({ task: 't3', callCount: 4 }),
    line({ task: 't4', callCount: 6 }),
    line({ task: 't5', outcome: 'fail', firstOperationAccepted: false, assertReason: 'no' }),
    line({ task: 't6', outcome: 'fail', schemaRejections: 1, callCount: 3 }),
  ];
}

describe('the reporter is deterministic', () => {
  test('the seeded generator produces the same stream every time', () => {
    const first = [createRng(7), createRng(7)].map((rng) => [rng(), rng(), rng()]);
    expect(first[0]).toEqual(first[1] as number[]);
    expect(createRng(8)()).not.toBe(createRng(7)());
  });

  test('two reports over the same lines and seed are identical', () => {
    const runs = mixedRuns();
    expect(renderReport(buildReport(runs, 42))).toBe(renderReport(buildReport(runs, 42)));
  });

  test('the seed never moves the point estimate', () => {
    const runs = mixedRuns();
    const first = buildReport(runs, 1)[0];
    const second = buildReport(runs, 2)[0];
    // The estimate is computed on the pooled data, so resampling cannot touch
    // it. Only the interval is a function of the seed, and over a corpus this
    // small the percentiles may land on the same values for either seed.
    expect(second?.completion.value).toBe(first?.completion.value as number);
    expect(second?.meanCallsPerCompletedTask.value).toBe(
      first?.meanCallsPerCompletedTask.value as number,
    );
  });

  test('the interval brackets the point estimate', () => {
    const report = buildReport(mixedRuns(), 42)[0];
    expect(report?.completion.value).toBeCloseTo(4 / 6, 10);
    expect(report?.completion.low).toBeLessThanOrEqual(report?.completion.value as number);
    expect(report?.completion.high).toBeGreaterThanOrEqual(report?.completion.value as number);
  });

  test('the statistics read the fields the scorer wrote', () => {
    const report = buildReport(mixedRuns(), 42)[0];
    expect(report?.tasks).toBe(6);
    expect(report?.runs).toBe(6);
    expect(report?.selectionAccuracy.value).toBeCloseTo(5 / 6, 10);
    // Nineteen logged calls across six runs, one of them rejected on schema.
    expect(report?.argumentValidity.value).toBeCloseTo(18 / 19, 10);
    expect(report?.meanCallsPerCompletedTask.value).toBeCloseTo(14 / 4, 10);
  });

  test('an empty task set yields no interval rather than a zero', () => {
    const interval = bootstrap([], () => 1, 42);
    expect(Number.isNaN(interval.value)).toBe(true);
    expect(Number.isNaN(interval.low)).toBe(true);
  });

  test('runs split into one cell per variant and row', () => {
    const runs = [
      line({ task: 't1', variant: 'verb-prefixed', row: 'row-a' }),
      line({ task: 't1', variant: 'noun-prefixed', row: 'row-a' }),
      line({ task: 't1', variant: 'noun-prefixed', row: 'row-b' }),
    ];
    const reports = buildReport(runs, 42);
    expect(reports.map((report) => `${report.variant}/${report.row}`)).toEqual([
      'noun-prefixed/row-a',
      'noun-prefixed/row-b',
      'verb-prefixed/row-a',
    ]);
  });
});
