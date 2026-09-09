/**
 * The bootstrap is the number a reader will argue about, so it must be
 * reproducible: the same result lines and the same seed give the same interval,
 * and a different seed moves it. These tests pin both, and pin that the
 * resampling unit is the task rather than the run.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap, buildReport, createRng, loadRunLines, renderReport } from '../report.js';
import { runAll } from '../run.js';
import { buildInvocation as buildFake } from '../providers/fake.js';
import type { EvalResultLine, EvalRow, EvalState, EvalTask } from '../types.js';

const STANDIN = join(import.meta.dirname, 'standin-server.ts');

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

describe('loadRunLines re-derives from a results directory', () => {
  const ROW: EvalRow = {
    id: 'fake-row',
    cli: 'claude',
    model: 'fake-model',
    effort: 'low',
    condition: 'agent-default',
    seeds: [1],
  };

  const TASK: EvalTask = {
    id: 'read-the-seeded-post',
    prompt: 'Read posts/p1.',
    seed: { firestore: { 'posts/p1': { title: 'seeded' } } },
    acceptedFirstOperations: ['get_firestore_document'],
    assert: (state: EvalState) => (state.calls.length === 0 ? 'no calls were logged' : true),
    tags: ['firestore', 'read'],
  };

  async function producedResultsDir(): Promise<string> {
    const resultsDir = mkdtempSync(join(tmpdir(), 'pyric-report-'));
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'pyric-pacing-'));
    await runAll({
      repoRoot: join(import.meta.dirname, '..', '..', '..', '..'),
      resultsDir,
      runId: 'run-1',
      rows: [ROW],
      tasks: [TASK],
      variants: ['verb-prefixed'],
      seeds: [],
      dryRun: false,
      timeoutMs: 60_000,
      pacing: { minGapMs: 0, budgetPerWindow: 10, ledgerRoot },
      serverCommand: () => ['bun', STANDIN],
      providerFor: () => buildFake,
      transcripts: {
        'read-the-seeded-post': [{ tool: 'get_firestore_document', args: { path: 'posts/p1' } }],
      },
    });
    return join(resultsDir, 'run-1');
  }

  test('a directory with a passing run re-derives the same result via the event log', async () => {
    const runDir = await producedResultsDir();
    const lines = await loadRunLines([runDir], {
      tasks: new Map([[TASK.id, TASK]]),
      rows: new Map([[ROW.id, ROW]]),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.outcome).toBe('pass');
    expect(lines[0]?.callCount).toBe(1);
  }, 30_000);

  test('a crash line whose run directory still has a non-empty event log is scored from the log', async () => {
    const runDir = await producedResultsDir();
    const runsPath = join(runDir, 'runs.ndjson');
    const original = JSON.parse(readFileSync(runsPath, 'utf8').trim()) as EvalResultLine;
    const asCrash: EvalResultLine = { ...original, outcome: 'crash', assertReason: 'harness died' };
    writeFileSync(runsPath, `${JSON.stringify(asCrash)}\n`, 'utf8');

    const lines = await loadRunLines([runDir], {
      tasks: new Map([[TASK.id, TASK]]),
      rows: new Map([[ROW.id, ROW]]),
    });
    expect(lines).toHaveLength(1);
    // The event log is intact, so the harness crash is recovered as a pass.
    expect(lines[0]?.outcome).toBe('pass');
  }, 30_000);

  test('a genuine crash whose event log is empty is left as recorded', async () => {
    const resultsDir = mkdtempSync(join(tmpdir(), 'pyric-report-'));
    const runDir = join(resultsDir, 'run-1', 'fake-row', 'verb-prefixed', 'read-the-seeded-post', '1');
    mkdirSync(runDir, { recursive: true });
    // The runner writes an empty events file while it prepares a run and copies
    // it out afterwards, so a harness crash before the spawn leaves exactly
    // this: a crash line and a log with nothing in it.
    writeFileSync(join(runDir, 'events.ndjson'), '', 'utf8');
    const crashLine: EvalResultLine = {
      runId: 'run-1',
      row: 'fake-row',
      variant: 'verb-prefixed',
      task: 'read-the-seeded-post',
      seed: 1,
      outcome: 'crash',
      firstOperation: null,
      firstOperationAccepted: false,
      acceptedOpReached: false,
      callCount: 0,
      schemaRejections: 0,
      errorCalls: 0,
      durationMs: 0,
      assertReason: 'seeding failed',
    };
    writeFileSync(
      join(resultsDir, 'run-1', 'runs.ndjson'),
      `${JSON.stringify(crashLine)}\n`,
      'utf8',
    );

    const lines = await loadRunLines([join(resultsDir, 'run-1')], {
      tasks: new Map([[TASK.id, TASK]]),
      rows: new Map([[ROW.id, ROW]]),
    });
    expect(lines).toHaveLength(1);
    // Re-scoring this against the task's assertion would report a harness
    // failure as a design failure.
    expect(lines[0]?.outcome).toBe('crash');
    expect(lines[0]?.assertReason).toBe('seeding failed');
  });

  test('a genuine crash with no event log is left as recorded', async () => {
    const resultsDir = mkdtempSync(join(tmpdir(), 'pyric-report-'));
    const runDir = join(resultsDir, 'run-1', 'fake-row', 'verb-prefixed', 'read-the-seeded-post', '1');
    mkdirSync(runDir, { recursive: true });
    const crashLine: EvalResultLine = {
      runId: 'run-1',
      row: 'fake-row',
      variant: 'verb-prefixed',
      task: 'read-the-seeded-post',
      seed: 1,
      outcome: 'crash',
      firstOperation: null,
      firstOperationAccepted: false,
      acceptedOpReached: false,
      callCount: 0,
      schemaRejections: 0,
      errorCalls: 0,
      durationMs: 0,
      assertReason: 'spawn failed',
    };
    writeFileSync(
      join(resultsDir, 'run-1', 'runs.ndjson'),
      `${JSON.stringify(crashLine)}\n`,
      'utf8',
    );

    const lines = await loadRunLines([join(resultsDir, 'run-1')], {
      tasks: new Map([[TASK.id, TASK]]),
      rows: new Map([[ROW.id, ROW]]),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.outcome).toBe('crash');
    expect(existsSync(join(runDir, 'events.ndjson'))).toBe(false);
  });
});
