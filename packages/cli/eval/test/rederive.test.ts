/**
 * A results directory is re-derived rather than trusted verbatim: every run
 * whose event log is intact is re-scored against the current corpus, so a
 * corrected assertion or a fixed classifier applies to runs already paid for.
 * These tests exercise `loadRunLines` against directories `runAll` actually
 * produces, and against directories hand-built to pin the recovery rules a
 * harness crash is subject to.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRunLines } from '../report.js';
import { runAll } from '../run.js';
import { buildInvocation as buildFake } from '../providers/fake.js';
import type { EvalResultLine, EvalRow, EvalState, EvalTask } from '../types.js';

const STANDIN = join(import.meta.dirname, 'standin-server.ts');

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
      verdictCalls: 0,
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
      verdictCalls: 0,
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
