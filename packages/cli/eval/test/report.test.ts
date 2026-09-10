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
    acceptedOpReached: true,
    callCount: 2,
    schemaRejections: 0,
    errorCalls: 0,
    verdictCalls: 0,
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

describe('accepted op reached', () => {
  test('is its own statistic, independent of the first operation', () => {
    const runs = [
      line({ task: 't1', firstOperationAccepted: true, acceptedOpReached: true }),
      line({ task: 't2', firstOperationAccepted: false, acceptedOpReached: true }),
      line({ task: 't3', firstOperationAccepted: false, acceptedOpReached: false }),
    ];
    const report = buildReport(runs, 42)[0];
    expect(report?.selectionAccuracy.value).toBeCloseTo(1 / 3, 10);
    expect(report?.acceptedOpReached.value).toBeCloseTo(2 / 3, 10);
  });
});

describe('infrastructure and bypass outcomes', () => {
  test('throttled, interrupted and bypassed runs are excluded from the completion denominator', () => {
    const runs = [
      line({ task: 't1', outcome: 'pass' }),
      line({ task: 't2', outcome: 'fail' }),
      line({ task: 't3', outcome: 'throttled' }),
      line({ task: 't4', outcome: 'interrupted' }),
      line({ task: 't5', outcome: 'bypassed' }),
    ];
    const report = buildReport(runs, 42)[0];
    // Only t1 and t2 are eligible: completion is 1 of 2, not 1 of 5.
    expect(report?.completion.value).toBeCloseTo(1 / 2, 10);
    expect(report?.infrastructure).toEqual({ throttled: 1, interrupted: 1, bypassed: 1 });
  });

  test('a cell with none of the three counts reports zero for each', () => {
    const runs = [line({ task: 't1', outcome: 'pass' }), line({ task: 't2', outcome: 'fail' })];
    const report = buildReport(runs, 42)[0];
    expect(report?.infrastructure).toEqual({ throttled: 0, interrupted: 0, bypassed: 0 });
  });

  test('the rendered report names the infrastructure and bypass heading when any are present', () => {
    const runs = [line({ task: 't1', outcome: 'pass' }), line({ task: 't2', outcome: 'throttled' })];
    const rendered = renderReport(buildReport(runs, 42));
    expect(rendered).toContain('infrastructure and bypass');
    expect(rendered).toContain('throttled');
  });

  test('the heading is omitted when a cell has no infrastructure or bypass outcomes', () => {
    const runs = [line({ task: 't1', outcome: 'pass' })];
    const rendered = renderReport(buildReport(runs, 42));
    expect(rendered).not.toContain('infrastructure and bypass');
  });
});

describe('the two threshold metrics the eval gate reads', () => {
  test('the rejection rate counts runs, not calls, over the runs that reached the task', () => {
    const runs = [
      line({ task: 't1', schemaRejections: 0 }),
      line({ task: 't2', schemaRejections: 3 }),
      line({ task: 't3', schemaRejections: 1 }),
      line({ task: 't4', outcome: 'throttled', schemaRejections: 0 }),
    ];
    const report = buildReport(runs, 42)[0];
    // Two of the three runs that reached the task carried a rejection; the
    // throttled run never reached it and is not in the denominator.
    expect(report?.runsWithARejection.value).toBeCloseTo(2 / 3, 10);
  });

  test('mean duration is reported in seconds over the runs that reached the task', () => {
    const runs = [
      line({ task: 't1', durationMs: 10_000 }),
      line({ task: 't2', durationMs: 20_000 }),
      line({ task: 't3', outcome: 'bypassed', durationMs: 900_000 }),
    ];
    const report = buildReport(runs, 42)[0];
    expect(report?.meanDurationSeconds.value).toBeCloseTo(15, 10);
  });

  test('both appear in the printed report', () => {
    const rendered = renderReport(buildReport(mixedRuns(), 42));
    expect(rendered).toContain('runs with a rejection');
    expect(rendered).toContain('mean duration');
  });
});

describe('error calls per completion', () => {
  test('counts the unsuccessful calls a completed task made', () => {
    const runs = [
      line({ task: 't1', outcome: 'pass', errorCalls: 1 }),
      line({ task: 't2', outcome: 'pass', errorCalls: 3 }),
      // A failed run's error calls are not in the numerator or the denominator.
      line({ task: 't3', outcome: 'fail', errorCalls: 9 }),
    ];
    const report = buildReport(runs, 42)[0];
    expect(report?.meanErrorCallsPerCompletedTask.value).toBeCloseTo(4 / 2, 10);
  });

  test('a production refusal shows up in the printed report', () => {
    // The task the surface refuses completes, because the refusal is the
    // answer, and the refused call is the only trace it leaves.
    const rendered = renderReport(buildReport([line({ task: 't1', errorCalls: 1 })], 42));
    expect(rendered).toContain('error calls/completion');
    expect(rendered).toContain('1.00');
  });

  test('a cell with nothing completed reports no interval rather than a zero', () => {
    const report = buildReport([line({ task: 't1', outcome: 'fail', errorCalls: 2 })], 42)[0];
    expect(Number.isNaN(report?.meanErrorCallsPerCompletedTask.value as number)).toBe(true);
  });
});

describe('engaged-run completion', () => {
  test('a run with zero calls is excluded from the engaged completion rate', () => {
    const runs = [
      line({ task: 't1', outcome: 'pass', callCount: 2 }),
      line({ task: 't2', outcome: 'fail', callCount: 0 }),
    ];
    const report = buildReport(runs, 42)[0];
    // Overall completion counts both tasks; engaged completion counts only t1.
    expect(report?.completion.value).toBeCloseTo(1 / 2, 10);
    expect(report?.completionEngaged.value).toBe(1);
  });
});

describe('the single-step and multi-step split', () => {
  /** A corpus in which one of the three tasks is a sequence of operations. */
  const MULTI_STEP = new Set(['t2']);

  test('completion, calls and error calls are reported per class', () => {
    const runs = [
      line({ task: 't1', outcome: 'pass', callCount: 2, errorCalls: 0 }),
      line({ task: 't2', outcome: 'pass', callCount: 8, errorCalls: 2 }),
      line({ task: 't3', outcome: 'fail', callCount: 4, errorCalls: 1 }),
    ];
    const report = buildReport(runs, 42, MULTI_STEP)[0];
    const single = report?.classes.find((cell) => cell.taskClass === 'single-step');
    const multi = report?.classes.find((cell) => cell.taskClass === 'multi-step');

    expect(single?.tasks).toBe(2);
    expect(single?.completion.value).toBeCloseTo(1 / 2, 10);
    expect(single?.meanCallsPerCompletedTask.value).toBeCloseTo(2, 10);
    expect(single?.meanErrorCallsPerCompletedTask.value).toBeCloseTo(0, 10);

    expect(multi?.tasks).toBe(1);
    expect(multi?.completion.value).toBe(1);
    expect(multi?.meanCallsPerCompletedTask.value).toBeCloseTo(8, 10);
    expect(multi?.meanErrorCallsPerCompletedTask.value).toBeCloseTo(2, 10);
  });

  test('a task id the corpus no longer holds counts as single-step', () => {
    const runs = [line({ task: 'retired-task', outcome: 'pass', callCount: 3 })];
    const report = buildReport(runs, 42, MULTI_STEP)[0];
    const single = report?.classes.find((cell) => cell.taskClass === 'single-step');
    expect(single?.tasks).toBe(1);
    expect(report?.classes.find((cell) => cell.taskClass === 'multi-step')?.tasks).toBe(0);
  });

  test('both classes appear in the printed report', () => {
    const runs = [
      line({ task: 't1', outcome: 'pass', callCount: 2 }),
      line({ task: 't2', outcome: 'pass', callCount: 8 }),
    ];
    const rendered = renderReport(buildReport(runs, 42, MULTI_STEP));
    expect(rendered).toContain('single-step');
    expect(rendered).toContain('multi-step');
  });
});

describe('verdict calls per completion', () => {
  test('a rules denial on a completed task is a verdict call, not an error call', () => {
    const runs = [
      line({ task: 't1', outcome: 'pass', errorCalls: 0, verdictCalls: 2 }),
      line({ task: 't2', outcome: 'pass', errorCalls: 1, verdictCalls: 0 }),
    ];
    const report = buildReport(runs, 42)[0];
    expect(report?.meanVerdictCallsPerCompletedTask.value).toBeCloseTo(1, 10);
    expect(report?.meanErrorCallsPerCompletedTask.value).toBeCloseTo(0.5, 10);
  });

  test('the count appears in the printed report', () => {
    const rendered = renderReport(buildReport([line({ task: 't1', verdictCalls: 3 })], 42));
    expect(rendered).toContain('verdict calls/completion');
  });
});
