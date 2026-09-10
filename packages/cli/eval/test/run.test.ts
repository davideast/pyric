/**
 * The whole pipeline, without a model. The fake provider replays a canned
 * transcript against a stand-in stdio server that speaks the section 3 contract,
 * and the runner seeds, spawns, scores and records exactly as it does for a real
 * CLI. What this pins is that the seams line up: the server's env block reaches
 * the process that writes the log, the log reaches the scorer, the flushed
 * snapshot reaches the task's assertion, and the result file the reporter reads
 * is the one the runner wrote.
 *
 * It also pins the directory split the measurement depends on: the workspace the
 * CLI is started in holds nothing but the provider's own files, the state the
 * run reads and writes lives under the temp root while the process is alive and
 * is gone afterwards, and the run directory ends up holding the copies.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertNoLeakedPaths,
  runAll,
  planRuns,
  parseArgs,
  readTranscripts,
  resolveResultsDir,
  REPLAY_LEDGER_KEY,
  RESULTS_FILE,
  RESULTS_ROOT,
  STATE_ROOT,
  WORKSPACE_DIR,
  type RunnerOptions,
} from '../run.js';
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

/**
 * State directories are keyed by run id under one shared temp root, so each test
 * takes its own id and no two tests can meet in the same directory.
 */
let runCounter = 0;

function optionsFor(resultsDir: string): RunnerOptions {
  runCounter += 1;
  // A ledger root of its own, so this run's budget never shares state with the
  // real per-CLI ledger under the OS temp root, or with another test's ledger.
  const ledgerRoot = mkdtempSync(join(tmpdir(), 'pyric-pacing-'));
  return {
    repoRoot: resolve(import.meta.dirname, '..', '..', '..', '..'),
    resultsDir,
    runId: `pipeline-${runCounter}`,
    rows: [ROW],
    tasks: [READ_TASK, WRITE_TASK],
    variants: ['verb-prefixed'],
    seeds: [],
    dryRun: false,
    timeoutMs: 60_000,
    pacing: { minGapMs: 0, budgetPerWindow: 10, ledgerRoot },
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

    const resultsPath = join(resultsDir, options.runId, RESULTS_FILE);
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
      options.runId,
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
      runId: options.runId,
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

describe('a dry run prepares everything and spawns nothing', () => {
  test('the config files exist and no results are recorded', async () => {
    const resultsDir = mkdtempSync(join(tmpdir(), 'pyric-runner-'));
    const options = optionsFor(resultsDir);
    options.tasks = [READ_TASK];
    options.dryRun = true;

    const lines = await runAll(options);
    expect(lines).toHaveLength(0);
    expect(existsSync(join(resultsDir, options.runId, RESULTS_FILE))).toBe(false);

    const [run] = planRuns(options);
    expect(existsSync(join(run!.dir, 'fake-plan.json'))).toBe(true);
    expect(existsSync(join(run!.stateDir, '.pyric', 'state', 'headless.json'))).toBe(true);
    expect(existsSync(join(run!.dir, 'stdout.log'))).toBe(false);
  }, 60_000);
});

describe('the run, the workspace and the state are three directories', () => {
  test('the plan puts the workspace under the run directory and the state under the temp root', () => {
    const options = optionsFor('/results');
    const [run] = planRuns(options);
    expect(run!.dir).toBe(
      join('/results', options.runId, 'fake-row', 'verb-prefixed', 'read-the-seeded-post', '1'),
    );
    expect(run!.workspaceDir).toBe(join(run!.dir, WORKSPACE_DIR));
    expect(run!.stateDir).toBe(
      join(STATE_ROOT, options.runId, 'fake-row', 'verb-prefixed', 'read-the-seeded-post', '1'),
    );
    expect(run!.eventsPath).toBe(join(run!.stateDir, 'events.ndjson'));
    // Nothing in the results tree is on the path the CLI is given.
    expect(run!.stateDir.startsWith('/results')).toBe(false);
  });

  test('the workspace the fake provider is started in holds nothing at all', async () => {
    const resultsDir = mkdtempSync(join(tmpdir(), 'pyric-runner-'));
    const options = optionsFor(resultsDir);
    options.tasks = [READ_TASK];
    const [planned] = planRuns(options);

    await runAll(options);

    // The fake provider passes its plan by path, so its workspace is empty. A
    // seed file or a snapshot appearing here is the leak this split closes.
    expect(readdirSync(planned!.workspaceDir)).toEqual([]);
  }, 120_000);

  test('the state lives under the temp root during the run and is gone after it', async () => {
    const resultsDir = mkdtempSync(join(tmpdir(), 'pyric-runner-'));
    const options = optionsFor(resultsDir);
    options.tasks = [READ_TASK];
    const [planned] = planRuns(options);

    // The provider is asked for its invocation while the run is being prepared,
    // which is the one moment the state directory is guaranteed to be seeded.
    let seenDuringRun: string[] = [];
    options.providerFor = () => (run) => {
      seenDuringRun = readdirSync(run.stateDir);
      return buildFake(run);
    };

    await runAll(options);

    expect(planned!.stateDir.startsWith(STATE_ROOT)).toBe(true);
    expect(seenDuringRun).toContain('.pyric');
    expect(existsSync(planned!.stateDir)).toBe(false);
  }, 120_000);

  test('the run directory holds the copied events and snapshot when the run is over', async () => {
    const resultsDir = mkdtempSync(join(tmpdir(), 'pyric-runner-'));
    const options = optionsFor(resultsDir);
    options.tasks = [WRITE_TASK];
    const [planned] = planRuns(options);

    const lines = await runAll(options);
    expect(lines[0]?.outcome).toBe('pass');

    const events = readFileSync(join(planned!.dir, 'events.ndjson'), 'utf8');
    expect(events).toContain('write_firestore_document');
    const snapshot = readFileSync(
      join(planned!.dir, '.pyric', 'state', 'headless.json'),
      'utf8',
    );
    expect(snapshot).toContain('written');
  }, 120_000);
});

describe('the runner refuses to hand the agent a path to the state', () => {
  test('a provider that writes the state directory into the workspace stops the run', async () => {
    const resultsDir = mkdtempSync(join(tmpdir(), 'pyric-runner-'));
    const options = optionsFor(resultsDir);
    options.tasks = [READ_TASK];
    options.providerFor = () => (run) => {
      const invocation = buildFake(run);
      invocation.workspaceFiles = {
        '.agents/mcp_config.json': JSON.stringify({ env: { PYRIC_PROJECT_DIR: run.stateDir } }),
      };
      return invocation;
    };

    await expect(runAll(options)).rejects.toThrow('the state directory in the workspace file');
  }, 60_000);

  test('the events path is caught the same way', async () => {
    const resultsDir = mkdtempSync(join(tmpdir(), 'pyric-runner-'));
    const options = optionsFor(resultsDir);
    options.tasks = [READ_TASK];
    options.providerFor = () => (run) => {
      const invocation = buildFake(run);
      invocation.workspaceFiles = { 'notes.md': `the log is at ${run.eventsPath}\n` };
      return invocation;
    };

    await expect(runAll(options)).rejects.toThrow('the events path in the workspace file notes.md');
  }, 60_000);

  test('the workspace files the real providers produce pass the check', () => {
    const options = optionsFor('/results');
    const [run] = planRuns(options);
    expect(() => assertNoLeakedPaths(run!, buildFake(run!).workspaceFiles)).not.toThrow();
  });
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

describe('a replay run is driven from a transcript file', () => {
  test('the transcripts flag reads one canned call list per task id', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pyric-transcripts-')), 'transcripts.json');
    writeFileSync(
      path,
      JSON.stringify({
        'read-the-seeded-post': [
          { tool: 'firestore', args: { method: 'getDoc', args: { path: 'posts/p1' } } },
        ],
      }),
      'utf8',
    );

    const transcripts = readTranscripts(path);
    expect(transcripts['read-the-seeded-post']).toHaveLength(1);
    expect(transcripts['read-the-seeded-post']?.[0]?.tool).toBe('firestore');
  });

  test('a transcript that is not a list of calls is refused by name', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pyric-transcripts-')), 'transcripts.json');
    writeFileSync(path, JSON.stringify({ 'read-the-seeded-post': 'getDoc' }), 'utf8');
    expect(() => readTranscripts(path)).toThrow('read-the-seeded-post');
  });

  test('a replayed run meters under its own ledger, never a metered account', async () => {
    const resultsDir = mkdtempSync(join(tmpdir(), 'pyric-runner-'));
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'pyric-pacing-'));
    const options = optionsFor(resultsDir);
    options.tasks = [READ_TASK];
    options.pacing = { minGapMs: 0, budgetPerWindow: 10, ledgerRoot };

    await runAll(options);

    // The row names Claude, but nothing called Claude, so the account's window
    // must be untouched and the replay must be counted on its own.
    expect(readdirSync(ledgerRoot)).toEqual([`${REPLAY_LEDGER_KEY}.json`]);
  }, 120_000);
});

describe('results live outside the repository', () => {
  test('the default results directory is under the OS temp root, not the repo', () => {
    expect(resolveResultsDir({})).toBe(RESULTS_ROOT);
    expect(RESULTS_ROOT.startsWith(resolve(import.meta.dirname, '..'))).toBe(false);
  });

  test('--results-dir overrides the default', () => {
    expect(resolveResultsDir({ 'results-dir': '/somewhere/else' })).toBe('/somewhere/else');
  });
});

describe('a full quota ledger throttles a run instead of spawning it', () => {
  test('reserveBudget denies the second run and no-wait records it as throttled', async () => {
    const resultsDir = mkdtempSync(join(tmpdir(), 'pyric-runner-'));
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'pyric-pacing-'));
    const options = optionsFor(resultsDir);
    options.tasks = [READ_TASK];
    options.rows = [{ ...ROW, seeds: [1, 2] }];
    options.pacing = { minGapMs: 0, budgetPerWindow: 1, ledgerRoot, noWait: true };

    const lines = await runAll(options);
    expect(lines).toHaveLength(2);
    const outcomes = lines.map((line) => line.outcome).sort();
    expect(outcomes).toEqual(['pass', 'throttled']);
  }, 60_000);
});
