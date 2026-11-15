import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { QUEUE_LABEL, STAGING_BRANCH } from './merge-queue.ts';
import {
  gatherFacts,
  mainHeadSha,
  pullChangedPaths,
  resolveWorkflowToken,
  type QueueIo,
} from './merge-queue-facts.ts';
import { runQueuePass } from './merge-queue-github.ts';
import {
  GREEN_RUN,
  HEAD_A,
  HEAD_B,
  MAIN,
  STAGED,
  createHarness,
  greenBatch,
  pull,
  stagedMessage,
  type Harness,
  type Remote,
  type RunItem,
} from './merge-queue-harness.ts';

interface SplitHarness {
  harness: Harness;
  io: QueueIo;
  patCalls: string[][];
  workflowCalls: string[][];
  legacyChecksCalls: string[][];
}

function isWorkflowOperation(args: readonly string[]): boolean {
  if (args[0] !== 'api') return false;
  const methodIdx = args.indexOf('-X');
  if (methodIdx === -1) return true;
  const method = args[methodIdx + 1];
  const path = args.find((arg) => arg.startsWith('repos/')) ?? '';
  if (method === 'POST' && /\/issues\/\d+\/comments$/.test(path)) return true;
  if (method === 'DELETE' && /\/issues\/\d+\/labels\//.test(path)) return true;
  return false;
}

function createSplitHarness(
  initial: Partial<Remote>,
  options: { includeLegacyChecks?: boolean; base?: Harness } = {},
): SplitHarness {
  const harness = options.base ?? createHarness(initial);
  const baseGh = harness.io.gh;
  const patCalls: string[][] = [];
  const workflowCalls: string[][] = [];
  const legacyChecksCalls: string[][] = [];

  const io: QueueIo = {
    ...harness.io,
    gh: (args) => {
      patCalls.push(args);
      if (isWorkflowOperation(args)) {
        throw new Error(`gh: Resource not accessible by personal access token (HTTP 403): ${args.join(' ')}`);
      }
      return baseGh(args);
    },
    ghWorkflow: (args) => {
      workflowCalls.push(args);
      if (!isWorkflowOperation(args)) {
        throw new Error(`gh: workflow token must not run PAT-only operation: ${args.join(' ')}`);
      }
      return baseGh(args);
    },
  };
  delete io.ghChecks;
  if (options.includeLegacyChecks) {
    io.ghChecks = (args) => {
      legacyChecksCalls.push(args);
      throw new Error(`ghChecks should not be called when ghWorkflow is set: ${args.join(' ')}`);
    };
  }
  return { harness, io, patCalls, workflowCalls, legacyChecksCalls };
}

describe('merge-queue workflow token routing', () => {
  test('resolveWorkflowToken prefers GH_WORKFLOW_TOKEN, falls back to legacy GH_CHECKS_TOKEN, and treats empty values as absent', () => {
    expect(resolveWorkflowToken({ GH_WORKFLOW_TOKEN: 'wf', GH_CHECKS_TOKEN: 'legacy' })).toBe('wf');
    expect(resolveWorkflowToken({ GH_WORKFLOW_TOKEN: '', GH_CHECKS_TOKEN: 'legacy' })).toBe('legacy');
    expect(resolveWorkflowToken({ GH_CHECKS_TOKEN: 'legacy' })).toBe('legacy');
    expect(resolveWorkflowToken({ GH_WORKFLOW_TOKEN: '', GH_CHECKS_TOKEN: '' })).toBeUndefined();
    expect(resolveWorkflowToken({})).toBeUndefined();
  });

  test('gatherFacts, mainHeadSha, and pullChangedPaths route all read-only API queries through ghWorkflow', () => {
    const failedRun: RunItem = {
      id: 501,
      run_attempt: 1,
      status: 'completed',
      conclusion: 'failure',
      html_url: 'https://github.com/owner/repo/actions/runs/501',
      event: 'workflow_dispatch',
      actor: { login: 'github-actions[bot]' },
    };
    const split = createSplitHarness(
      {
        branches: { [STAGING_BRANCH]: STAGED },
        pulls: [pull(101, HEAD_A), pull(102, HEAD_B)],
        messages: {
          [STAGED]: stagedMessage({
            baseSha: MAIN,
            pulls: [{ number: 101, headSha: HEAD_A }, { number: 102, headSha: HEAD_B }],
          }),
        },
        greenHeads: new Set([HEAD_A, HEAD_B]),
        stagingRuns: [failedRun],
        filesByPr: {
          101: [{ filename: 'docs/new-path.md', previous_filename: 'docs/old-path.md' }],
        },
      },
      { includeLegacyChecks: true },
    );

    expect(mainHeadSha(split.io)).toBe(MAIN);
    expect(pullChangedPaths(split.io, 101)).toEqual(['docs/new-path.md', 'docs/old-path.md']);
    const facts = gatherFacts(split.io);

    expect(facts.mainSha).toBe(MAIN);
    expect(facts.candidates.map((item) => item.number)).toEqual([101, 102]);
    expect(facts.activeStaging?.stagingSha).toBe(STAGED);
    expect(split.patCalls).toEqual([]);
    expect(split.legacyChecksCalls).toEqual([]);

    const paths = split.workflowCalls.map((args) => args.find((arg) => arg.startsWith('repos/')) ?? '');
    expect(paths).toContain('repos/owner/repo/branches/main');
    expect(paths).toContain('repos/owner/repo/pulls/101/files?per_page=100');
    expect(paths).toContain('repos/owner/repo/pulls?state=open&base=main&per_page=100');
    expect(paths).toContain('repos/owner/repo/issues/101/events?per_page=100');
    expect(paths.some((path) => path.includes(`commits/${HEAD_A}/check-runs?`))).toBe(true);
    expect(paths).toContain(`repos/owner/repo/commits/${STAGED}`);
    expect(paths.some((path) => path.includes('actions/workflows/build.yml/runs?'))).toBe(true);
    expect(paths.some((path) => path.includes('actions/workflows/slow-scenarios.yml/runs?'))).toBe(true);
    expect(paths).toContain('repos/owner/repo/actions/runs/501/attempts/1/jobs?per_page=100');
  });

  test('batch landing via ruleset PR merge API keeps PUT /merge on gh and routes reads, comments, and label removal through ghWorkflow', () => {
    const refusal = 'remote: error: GH013: Repository rule violations found for refs/heads/main.';
    const split = createSplitHarness({}, { base: greenBatch({ pushRefusal: refusal }) });

    const actions = runQueuePass(split.io, { dryRun: false, usingWorkflowToken: false });
    expect(actions.map((action) => action.kind)).toEqual(['land', 'idle']);
    expect(split.harness.comments.map((entry) => entry.pull)).toEqual([101, 102]);

    expect(split.patCalls).toEqual([
      ['api', '-X', 'PUT', 'repos/owner/repo/pulls/101/merge', '-f', 'merge_method=merge', '-f', `sha=${HEAD_A}`],
      ['api', '-X', 'PUT', 'repos/owner/repo/pulls/102/merge', '-f', 'merge_method=merge', '-f', `sha=${HEAD_B}`],
    ]);
    expect(split.workflowCalls.some((args) => args.includes('POST') && args.includes('repos/owner/repo/issues/101/comments'))).toBe(true);
    expect(split.workflowCalls.some((args) => args.includes('POST') && args.includes('repos/owner/repo/issues/102/comments'))).toBe(true);
    expect(split.workflowCalls).toContainEqual(['api', '-X', 'DELETE', `repos/owner/repo/issues/101/labels/${QUEUE_LABEL}`]);
    expect(split.workflowCalls).toContainEqual(['api', '-X', 'DELETE', `repos/owner/repo/issues/102/labels/${QUEUE_LABEL}`]);
  });

  test('workflow run, run rerun, and run cancel stay on gh while dequeue comments, label removals, and reads use ghWorkflow', () => {
    // 1. Dequeue conflicting PR + cancel stale staging run + dispatch new staging workflow run.
    const staleRunning: RunItem = {
      ...GREEN_RUN,
      id: 700,
      status: 'in_progress',
      conclusion: null,
    };
    const stageSplit = createSplitHarness({
      branches: { [STAGING_BRANCH]: STAGED },
      pulls: [pull(101, HEAD_A), pull(102, HEAD_B)],
      messages: { [STAGED]: stagedMessage({ baseSha: '0'.repeat(40), pulls: [{ number: 101, headSha: HEAD_A }] }) },
      greenHeads: new Set([HEAD_A, HEAD_B]),
      conflicts: new Set([HEAD_B]),
      stagingRuns: [staleRunning],
    });
    expect(runQueuePass(stageSplit.io, { dryRun: false, usingWorkflowToken: false }).map((action) => action.kind)).toEqual(['dequeue', 'stage']);
    expect(stageSplit.patCalls).toEqual([
      ['run', 'cancel', '700', '--repo', 'owner/repo'],
      ['workflow', 'run', 'build.yml', '--repo', 'owner/repo', '--ref', STAGING_BRANCH, '-f', 'release_proof=false'],
    ]);
    expect(stageSplit.workflowCalls).toContainEqual(['api', '-X', 'DELETE', `repos/owner/repo/issues/102/labels/${QUEUE_LABEL}`]);
    expect(stageSplit.workflowCalls.some((args) => args.includes('POST') && args.includes('repos/owner/repo/issues/102/comments'))).toBe(true);

    // 2. Failed attempt 1 on staging triggers `run rerun` on gh.
    const failedOnce: RunItem = {
      ...GREEN_RUN,
      id: 701,
      run_attempt: 1,
      status: 'completed',
      conclusion: 'failure',
    };
    const rerunSplit = createSplitHarness({
      branches: { [STAGING_BRANCH]: STAGED },
      pulls: [pull(101, HEAD_A)],
      messages: { [STAGED]: stagedMessage({ baseSha: MAIN, pulls: [{ number: 101, headSha: HEAD_A }] }) },
      greenHeads: new Set([HEAD_A]),
      stagingRuns: [failedOnce],
    });
    expect(runQueuePass(rerunSplit.io, { dryRun: false, usingWorkflowToken: false }).map((action) => action.kind)).toEqual(['rerun-staging']);
    expect(rerunSplit.patCalls).toEqual([
      ['run', 'rerun', '701', '--failed', '--repo', 'owner/repo'],
    ]);

    // 3. Post-merge workflow dispatches stay on gh while pullChangedPaths, comment, and label removal use ghWorkflow.
    const landSplit = createSplitHarness(
      {},
      { base: greenBatch({ filesByPr: { 102: ['packages/rules/src/simulator/eval.ts'] } }) },
    );
    expect(runQueuePass(landSplit.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['land', 'idle']);
    expect(landSplit.patCalls).toEqual([
      ['workflow', 'run', 'build.yml', '--repo', 'owner/repo', '--ref', 'main'],
      ['workflow', 'run', 'slow-scenarios.yml', '--repo', 'owner/repo', '--ref', 'main'],
      ['workflow', 'run', 'simulator-parity.yml', '--repo', 'owner/repo', '--ref', 'main'],
    ]);
    expect(landSplit.workflowCalls).toContainEqual(['api', 'repos/owner/repo/pulls/102/files?per_page=100']);

    // 4. Mid-batch partial PR merge failure routes partial comments, label removal, and pullAlreadyLanded reads through ghWorkflow.
    const firstMergeSha = '9'.repeat(39) + '1';
    const partialBase = greenBatch({
      pushRefusal: 'remote: error: GH013: Repository rule violations found for refs/heads/main.',
      onMergePull: (number) => {
        if (number === 101) {
          partialBase.remote.pulls = partialBase.remote.pulls.filter((item) => item.number !== 101);
          partialBase.remote.mergedPulls?.add(101);
          partialBase.remote.main = firstMergeSha;
          return firstMergeSha;
        }
        throw new Error('gh: Head branch was modified. Review and try the merge again. (HTTP 409)');
      },
    });
    const partialSplit = createSplitHarness({}, { base: partialBase });
    expect(runQueuePass(partialSplit.io, { dryRun: false, usingWorkflowToken: false }).map((action) => action.kind)).toEqual(['land', 'stage']);
    expect(partialSplit.patCalls).toEqual([
      ['api', '-X', 'PUT', 'repos/owner/repo/pulls/101/merge', '-f', 'merge_method=merge', '-f', `sha=${HEAD_A}`],
      ['api', '-X', 'PUT', 'repos/owner/repo/pulls/102/merge', '-f', 'merge_method=merge', '-f', `sha=${HEAD_B}`],
      ['workflow', 'run', 'build.yml', '--repo', 'owner/repo', '--ref', STAGING_BRANCH, '-f', 'release_proof=false'],
    ]);
    expect(partialSplit.workflowCalls.some((args) => args.includes('POST') && args.includes('repos/owner/repo/issues/101/comments'))).toBe(true);
    expect(partialSplit.workflowCalls).toContainEqual(['api', '-X', 'DELETE', `repos/owner/repo/issues/101/labels/${QUEUE_LABEL}`]);
  });

  test('falls back to gh for reads, comments, and label removals when ghWorkflow is omitted', () => {
    const refusal = 'remote: error: GH013: Repository rule violations found for refs/heads/main.';
    const h = greenBatch({ pushRefusal: refusal, filesByPr: { 101: ['README.md'] } });
    delete h.io.ghChecks;
    delete h.io.ghWorkflow;

    expect(mainHeadSha(h.io)).toBe(MAIN);
    expect(pullChangedPaths(h.io, 101)).toEqual(['README.md']);
    const actions = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: false });
    expect(actions.map((action) => action.kind)).toEqual(['land', 'idle']);
    expect(h.gh.some((args) => args.includes('repos/owner/repo/branches/main'))).toBe(true);
    expect(h.gh.some((args) => args.includes('repos/owner/repo/pulls/101/files?per_page=100'))).toBe(true);
    expect(h.gh.some((args) => args.includes('POST') && args.includes('repos/owner/repo/issues/101/comments'))).toBe(true);
    expect(h.gh).toContainEqual(['api', '-X', 'DELETE', `repos/owner/repo/issues/101/labels/${QUEUE_LABEL}`]);
    expect(h.gh.some((args) => args.includes('PUT') && args.includes('repos/owner/repo/pulls/101/merge'))).toBe(true);
  });

  test('CLI defaultIo wires GH_WORKFLOW_TOKEN first, falls back to GH_CHECKS_TOKEN, then GH_TOKEN', () => {
    const root = mkdtempSync(join(tmpdir(), 'mq-token-env-'));
    const scriptPath = resolve(import.meta.dir, 'merge-queue-github.ts');
    try {
      const logFile = join(root, 'gh-invocations.log');
      const fakeGh = join(root, 'gh');
      const fakeGit = join(root, 'git');
      writeFileSync(
        fakeGh,
        [
          '#!/usr/bin/env sh',
          'printf "%s\\t%s\\n" "${GH_TOKEN:-}" "$*" >> "$FAKE_GH_LOG"',
          'case "$*" in',
          `  *"branches/main"*) printf '{"commit":{"sha":"${MAIN}"}}' ;;`,
          '  *"pulls?state=open"*) printf "[]" ;;',
          '  *"actions/workflows/"*) printf \'{"workflow_runs":[]}\' ;;',
          '  *) printf "{}" ;;',
          'esac',
        ].join('\n'),
      );
      writeFileSync(fakeGit, '#!/usr/bin/env sh\nexit 0\n');
      chmodSync(fakeGh, 0o755);
      chmodSync(fakeGit, 0o755);

      const runWith = (extraEnv: Record<string, string | undefined>): string[] => {
        writeFileSync(logFile, '');
        const env: Record<string, string> = {
          PATH: `${root}:${process.env.PATH ?? ''}`,
          GITHUB_REPOSITORY: 'owner/repo',
          DRY_RUN: 'true',
          USING_WORKFLOW_TOKEN: 'false',
          FAKE_GH_LOG: logFile,
          GH_TOKEN: 'pat-token',
        };
        if (extraEnv.GH_WORKFLOW_TOKEN !== undefined) env.GH_WORKFLOW_TOKEN = extraEnv.GH_WORKFLOW_TOKEN;
        if (extraEnv.GH_CHECKS_TOKEN !== undefined) env.GH_CHECKS_TOKEN = extraEnv.GH_CHECKS_TOKEN;
        const out = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env });
        if (out.status !== 0) throw new Error(`CLI failed (${out.status}): ${out.stderr}`);
        return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
      };

      const withWorkflow = runWith({ GH_WORKFLOW_TOKEN: 'workflow-token', GH_CHECKS_TOKEN: 'legacy-token' });
      expect(withWorkflow.length).toBeGreaterThanOrEqual(4);
      expect(withWorkflow.every((line) => line.startsWith('workflow-token\t'))).toBe(true);

      const withLegacy = runWith({ GH_CHECKS_TOKEN: 'legacy-token' });
      expect(withLegacy.length).toBeGreaterThanOrEqual(4);
      expect(withLegacy.every((line) => line.startsWith('legacy-token\t'))).toBe(true);

      const withPatOnly = runWith({});
      expect(withPatOnly.length).toBeGreaterThanOrEqual(4);
      expect(withPatOnly.every((line) => line.startsWith('pat-token\t'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
