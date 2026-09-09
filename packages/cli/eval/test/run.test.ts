/**
 * The whole pipeline, without a model. The fake provider replays a canned
 * transcript against a stand-in stdio server that speaks the section 3 contract,
 * and the runner seeds, spawns, scores and records exactly as it does for a real
 * CLI. What this pins is that the seams line up: the server's env block reaches
 * the process that writes the log, the log reaches the scorer, the flushed
 * snapshot reaches the task's assertion, and the result file the reporter reads
 * is the one the runner wrote.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runAll, planRuns, parseArgs, RESULTS_FILE, type RunnerOptions } from '../run.js';
import { buildInvocation as buildFake } from '../providers/fake.js';
import { buildReport, readResults } from '../report.js';
import type { EvalResultLine, EvalRow, EvalState, EvalTask } from '../types.js';

const STANDIN = resolve(import.meta.dirname, 'standin-server.ts');

const ROW: EvalRow = {
  id: 'fake-row',
  cli: 'claude',
  model: 'fake-model',
  effort: 'low',
  condition: 'agent-default',
  seeds: [1],
};

const READ_TASK: EvalTask = {
  id: 'read-the-seeded-post',
  prompt: 'Read posts/p1.',
  seed: { firestore: { 'posts/p1': { title: 'seeded' } } },
  acceptedFirstOperations: ['get_firestore_document'],
  assert: (state: EvalState) => {
    if (state.calls.length === 0) return 'no calls were logged';
    return true;
  },
  tags: ['firestore', 'read'],
};

const WRITE_TASK: EvalTask = {
  id: 'write-a-new-post',
  prompt: 'Create posts/p2 with the title "written".',
  seed: { firestore: { 'posts/p1': { title: 'seeded' } } },
  acceptedFirstOperations: ['write_firestore_document'],
  assert: (state: EvalState) => {
    const document = state.firestore.get('posts/p2');
    if (document === null) return 'posts/p2 was not created';
    if (document.title !== 'written') return 'posts/p2 has the wrong title';
    return true;
  },
  tags: ['firestore', 'write'],
};

function optionsFor(resultsDir: string): RunnerOptions {
  return {
    repoRoot: resolve(import.meta.dirname, '..', '..', '..', '..'),
    resultsDir,
    runId: 'pipeline',
    rows: [ROW],
    tasks: [READ_TASK, WRITE_TASK],
    variants: ['verb-prefixed'],
    seeds: [],
    dryRun: false,
    timeoutMs: 60_000,
    pacing: { minGapMs: 0, budgetPerWindow: 10 },
    serverCommand: () => ['bun', STANDIN],
    providerFor: () => buildFake,
    transcripts: {
      'read-the-seeded-post': [{ tool: 'get_firestore_document', args: { path: 'posts/p1' } }],
      'write-a-new-post': [
        { tool: 'write_firestore_document', args: { path: 'posts/p2', data: { title: 'written' } } },
      ],
    },
  };
}

describe('the fake provider drives the whole pipeline', () => {
  test('two tasks run end to end and produce a readable results file', async () => {
    const resultsDir = mkdtempSync(join(tmpdir(), 'pyric-runner-'));
    const options = optionsFor(resultsDir);

    const lines = await runAll(options);
    expect(lines).toHaveLength(2);

    const read = lines.find((line) => line.task === 'read-the-seeded-post') as EvalResultLine;
    expect(read.outcome).toBe('pass');
    expect(read.firstOperation).toBe('get_firestore_document');
    expect(read.firstOperationAccepted).toBe(true);
    expect(read.callCount).toBe(1);
    expect(read.schemaRejections).toBe(0);
    expect(read.errorCalls).toBe(0);
    expect(read.assertReason).toBeNull();

    const write = lines.find((line) => line.task === 'write-a-new-post') as EvalResultLine;
    expect(write.outcome).toBe('pass');
    expect(write.firstOperation).toBe('write_firestore_document');
    expect(write.callCount).toBe(1);

    const resultsPath = join(resultsDir, 'pipeline', RESULTS_FILE);
    const persisted = readResults([resultsPath]);
    expect(persisted).toHaveLength(2);

    const reports = buildReport(persisted);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.variant).toBe('verb-prefixed');
    expect(reports[0]?.row).toBe('fake-row');
    expect(reports[0]?.tasks).toBe(2);
    expect(reports[0]?.completion.value).toBe(1);
    expect(reports[0]?.selectionAccuracy.value).toBe(1);
    expect(reports[0]?.argumentValidity.value).toBe(1);
    expect(reports[0]?.meanCallsPerCompletedTask.value).toBe(1);
  }, 120_000);

  test('a run whose transcript picks the wrong operation fails its assertion', async () => {
    const resultsDir = mkdtempSync(join(tmpdir(), 'pyric-runner-'));
    const options = optionsFor(resultsDir);
    options.tasks = [WRITE_TASK];
    options.transcripts = {
      'write-a-new-post': [{ tool: 'get_firestore_document', args: { path: 'posts/p1' } }],
    };

    const lines = await runAll(options);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.outcome).toBe('fail');
    expect(lines[0]?.firstOperation).toBe('get_firestore_document');
    expect(lines[0]?.firstOperationAccepted).toBe(false);
    expect(lines[0]?.assertReason).toBe('posts/p2 was not created');
  }, 120_000);

  test('the events log carries the run block the provider put in the server env', async () => {
    const resultsDir = mkdtempSync(join(tmpdir(), 'pyric-runner-'));
    const options = optionsFor(resultsDir);
    options.tasks = [READ_TASK];
    await runAll(options);

    const eventsPath = join(
      resultsDir,
      'pipeline',
      'fake-row',
      'verb-prefixed',
      'read-the-seeded-post',
      '1',
      'events.ndjson',
    );
    const event = JSON.parse(readFileSync(eventsPath, 'utf8').trim()) as {
      tool: string;
      operation: string;
      run: Record<string, unknown>;
    };
    expect(event.tool).toBe('get_firestore_document');
    expect(event.operation).toBe('get_firestore_document');
    expect(event.run).toMatchObject({
      runId: 'pipeline',
      taskId: 'read-the-seeded-post',
      variant: 'verb-prefixed',
      cli: 'claude',
      model: 'fake-model',
      effort: 'low',
      condition: 'agent-default',
      seed: 1,
      callIndex: 0,
    });
  }, 120_000);
});

describe('planning and argument parsing', () => {
  test('one run per row, variant, task and seed', () => {
    const options = optionsFor('/results');
    options.rows = [{ ...ROW, seeds: [1, 2] }];
    options.variants = ['verb-prefixed', 'noun-prefixed'];
    expect(planRuns(options)).toHaveLength(8);
  });

  test('an explicit seed selection narrows a row', () => {
    const options = optionsFor('/results');
    options.rows = [{ ...ROW, seeds: [1, 2, 3] }];
    options.seeds = [2];
    const runs = planRuns(options);
    expect(runs.every((run) => run.seed === 2)).toBe(true);
  });

  test('flags parse as values and bare booleans', () => {
    expect(parseArgs(['--rows', 'a,b', '--dry-run', '--variants', 'v'])).toEqual({
      rows: 'a,b',
      'dry-run': true,
      variants: 'v',
    });
  });
});
