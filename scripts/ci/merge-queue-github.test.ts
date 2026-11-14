import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  QUEUE_LABEL,
  STAGING_BRANCH,
  formatStagingCommit,
} from './merge-queue.ts';
import {
  SIMULATOR_PARITY_GLOBS,
  needsSimulatorParity,
  runQueuePass,
  type QueueIo,
} from './merge-queue-github.ts';

const MAIN = '1'.repeat(40);
const MAIN_2 = '2'.repeat(40);
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const STAGED = 'c'.repeat(40);
const NOW = Date.parse('2026-11-14T12:00:00Z');

interface Harness {
  gh: string[][];
  git: string[][];
  comments: string[];
  io: QueueIo;
  setState: (next: {
    mainSha?: string;
    remoteStagingSha?: string;
    pulls?: Array<{
      number: number;
      title: string;
      state?: string;
      draft?: boolean;
      headRef: string;
      headSha: string;
      headRepo?: string;
      labels: string[];
      createdAt?: string;
    }>;
    eventsByPr?: Record<number, Array<{ event: string; created_at: string; label?: { name: string } }>>;
    checkBySha?: Record<string, { status: string; conclusion: string | null } | undefined>;
    stagingCommit?: { message: string; date: string };
    stagingRuns?: Array<{ id: number; run_attempt: number; status: string; conclusion: string | null; html_url: string }>;
    failedJobsByAttempt?: Record<string, string[]>;
    filesByPr?: Record<number, string[]>;
    mergeConflictOn?: Set<string>;
    mergeRefusalOn?: Record<number, string>;
    onMergePr?: (prNumber: number) => void;
  }) => void;
}

function createHarness(): Harness {
  const gh: string[][] = [];
  const git: string[][] = [];
  const comments: string[] = [];
  let state: Parameters<Harness['setState']>[0] = {};

  const io: QueueIo = {
    repo: 'owner/repo',
    now: () => NOW,
    log: () => {},
    writeFile: (name, text) => {
      comments.push(text);
      return `/tmp/${name}`;
    },
    git: (args) => {
      git.push(args);
      if (args[0] === 'ls-remote') {
        return state.remoteStagingSha ? `${state.remoteStagingSha}\trefs/heads/${STAGING_BRANCH}\n` : '';
      }
      if (args[0] === 'merge' && args[1] === '--no-ff') {
        const targetSha = args.at(-1) ?? '';
        if (state.mergeConflictOn?.has(targetSha)) {
          throw new Error('CONFLICT (content): Merge conflict in packages/cli/src/serve/rules.ts');
        }
      }
      if (args[0] === 'push' && args.includes('--delete')) {
        state.remoteStagingSha = undefined;
      }
      return '';
    },
    gh: (args) => {
      gh.push(args);
      if (args[0] !== 'api') return '';
      const methodIdx = args.indexOf('-X');
      const method = methodIdx === -1 ? 'GET' : args[methodIdx + 1];
      const pathArg = args.find((arg) => arg.startsWith('repos/owner/repo/')) ?? '';
      const path = pathArg.replace('repos/owner/repo/', '');

      if (method === 'GET' && path === 'branches/main') {
        return JSON.stringify({ commit: { sha: state.mainSha ?? MAIN } });
      }
      if (method === 'GET' && path.startsWith('pulls?')) {
        const pulls = (state.pulls ?? []).map((item) => ({
          number: item.number,
          title: item.title,
          state: item.state ?? 'open',
          draft: item.draft ?? false,
          created_at: item.createdAt ?? '2026-11-14T11:00:00Z',
          head: { ref: item.headRef, sha: item.headSha, repo: { full_name: item.headRepo ?? 'owner/repo' } },
          labels: item.labels.map((name) => ({ name })),
        }));
        return JSON.stringify(pulls);
      }
      const singlePullMatch = /^pulls\/(\d+)$/.exec(path);
      if (method === 'GET' && singlePullMatch) {
        const found = (state.pulls ?? []).find((item) => item.number === Number(singlePullMatch[1]));
        return JSON.stringify({
          state: found?.state ?? 'open',
          head: { sha: found?.headSha ?? '' },
        });
      }
      const eventsMatch = /^issues\/(\d+)\/events\?/.exec(path);
      if (method === 'GET' && eventsMatch) {
        return JSON.stringify(state.eventsByPr?.[Number(eventsMatch[1])] ?? []);
      }
      const checkMatch = /^commits\/([0-9a-f]+)\/check-runs\?/.exec(path);
      if (method === 'GET' && checkMatch) {
        const check = state.checkBySha?.[checkMatch[1]!];
        return JSON.stringify({
          check_runs: check ? [{ name: 'CI / required', status: check.status, conclusion: check.conclusion, app: { slug: 'github-actions' } }] : [],
        });
      }
      if (method === 'GET' && path === `commits/${state.remoteStagingSha}`) {
        return JSON.stringify({
          sha: state.remoteStagingSha,
          commit: {
            message: state.stagingCommit?.message ?? '',
            committer: { date: state.stagingCommit?.date ?? '2026-11-14T11:55:00Z' },
          },
        });
      }
      if (method === 'GET' && path.startsWith('actions/workflows/build.yml/runs?')) {
        return JSON.stringify({ workflow_runs: state.stagingRuns ?? [] });
      }
      const jobsMatch = /^actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?/.exec(path);
      if (method === 'GET' && jobsMatch) {
        const failed = state.failedJobsByAttempt?.[`${jobsMatch[1]}:${jobsMatch[2]}`] ?? [];
        return JSON.stringify({ jobs: failed.map((name) => ({ name, conclusion: 'failure' })) });
      }
      const filesMatch = /^pulls\/(\d+)\/files\?/.exec(path);
      if (method === 'GET' && filesMatch) {
        const files = state.filesByPr?.[Number(filesMatch[1])] ?? [];
        return JSON.stringify(files.map((filename) => ({ filename })));
      }
      const deleteLabelMatch = /^issues\/(\d+)\/labels\/merge-queue$/.exec(path);
      if (method === 'DELETE' && deleteLabelMatch) {
        const prNum = Number(deleteLabelMatch[1]);
        state.pulls = (state.pulls ?? []).map((item) => {
          if (item.number !== prNum) return item;
          return { ...item, labels: item.labels.filter((label) => label !== QUEUE_LABEL) };
        });
        return '{}';
      }
      const mergeMatch = /^pulls\/(\d+)\/merge$/.exec(path);
      if (method === 'PUT' && mergeMatch) {
        const prNum = Number(mergeMatch[1]);
        const refusal = state.mergeRefusalOn?.[prNum];
        if (refusal !== undefined) throw new Error(refusal);
        state.pulls = (state.pulls ?? []).filter((item) => item.number !== prNum);
        state.onMergePr?.(prNum);
        return JSON.stringify({ merged: true, sha: MAIN_2 });
      }
      if (method === 'POST' && /^issues\/\d+\/comments$/.test(path)) {
        return JSON.stringify({ id: 1 });
      }
      throw new Error(`unexpected gh api ${method} ${path}`);
    },
  };

  return { gh, git, comments, io, setState: (next) => { state = next; } };
}

describe('executing a queue pass', () => {
  test('merges a green staged PR, dispatches main workflows under the workflow token, and stages the next queued PR in one pass', () => {
    const h = createHarness();
    h.setState({
      mainSha: MAIN,
      remoteStagingSha: STAGED,
      pulls: [
        { number: 101, title: 'fix(rules): simulator parity', headRef: 'fix/sim', headSha: HEAD_A, labels: [QUEUE_LABEL] },
        { number: 102, title: 'fix(cli): packaging flag', headRef: 'fix/pkg', headSha: HEAD_B, labels: [QUEUE_LABEL, 'ci-packaging'] },
      ],
      eventsByPr: {
        101: [{ event: 'labeled', created_at: '2026-11-14T11:40:00Z', label: { name: QUEUE_LABEL } }],
        102: [{ event: 'labeled', created_at: '2026-11-14T11:45:00Z', label: { name: QUEUE_LABEL } }],
      },
      checkBySha: {
        [HEAD_A]: { status: 'completed', conclusion: 'success' },
        [HEAD_B]: { status: 'completed', conclusion: 'success' },
        [STAGED]: { status: 'completed', conclusion: 'success' },
      },
      stagingCommit: {
        message: formatStagingCommit({ prNumber: 101, headSha: HEAD_A, baseSha: MAIN }),
        date: '2026-11-14T11:50:00Z',
      },
      stagingRuns: [{ id: 500, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/repo/actions/runs/500' }],
      filesByPr: { 101: ['packages/rules/src/simulator/eval.ts'] },
      onMergePr: () => {
        h.setState({
          mainSha: MAIN_2,
          remoteStagingSha: undefined,
          pulls: [{ number: 102, title: 'fix(cli): packaging flag', headRef: 'fix/pkg', headSha: HEAD_B, labels: [QUEUE_LABEL, 'ci-packaging'] }],
          eventsByPr: { 102: [{ event: 'labeled', created_at: '2026-11-14T11:45:00Z', label: { name: QUEUE_LABEL } }] },
          checkBySha: { [HEAD_B]: { status: 'completed', conclusion: 'success' } },
        });
      },
    });

    const actions = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    expect(actions.map((action) => action.kind)).toEqual(['merge', 'stage']);
    expect(h.gh).toContainEqual(['api', '-X', 'PUT', 'repos/owner/repo/pulls/101/merge', '-f', 'merge_method=merge', '-f', `sha=${HEAD_A}`]);
    expect(h.gh).toContainEqual(['workflow', 'run', 'build.yml', '--repo', 'owner/repo', '--ref', 'main']);
    expect(h.gh).toContainEqual(['workflow', 'run', 'slow-scenarios.yml', '--repo', 'owner/repo', '--ref', 'main']);
    expect(h.gh).toContainEqual(['workflow', 'run', 'simulator-parity.yml', '--repo', 'owner/repo', '--ref', 'main']);
    expect(h.git).toContainEqual(['checkout', '--detach', MAIN_2]);
    expect(h.gh).toContainEqual(['workflow', 'run', 'build.yml', '--repo', 'owner/repo', '--ref', STAGING_BRANCH, '-f', 'release_proof=true']);
  });

  test('dequeues a PR when GitHub persistently refuses PUT /pulls/{n}/merge and advances to the next PR without looping', () => {
    const h = createHarness();
    h.setState({
      mainSha: MAIN,
      remoteStagingSha: STAGED,
      pulls: [
        { number: 101, title: 'fix(cli): blocked', headRef: 'fix/blocked', headSha: HEAD_A, labels: [QUEUE_LABEL] },
        { number: 102, title: 'fix(cli): next', headRef: 'fix/next', headSha: HEAD_B, labels: [QUEUE_LABEL] },
      ],
      eventsByPr: {
        101: [{ event: 'labeled', created_at: '2026-11-14T11:40:00Z', label: { name: QUEUE_LABEL } }],
        102: [{ event: 'labeled', created_at: '2026-11-14T11:45:00Z', label: { name: QUEUE_LABEL } }],
      },
      checkBySha: {
        [HEAD_A]: { status: 'completed', conclusion: 'success' },
        [HEAD_B]: { status: 'completed', conclusion: 'success' },
        [STAGED]: { status: 'completed', conclusion: 'success' },
      },
      stagingCommit: {
        message: formatStagingCommit({ prNumber: 101, headSha: HEAD_A, baseSha: MAIN }),
        date: '2026-11-14T11:50:00Z',
      },
      stagingRuns: [{ id: 500, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/repo/actions/runs/500' }],
      mergeRefusalOn: { 101: 'HTTP 405: Pull Request is not mergeable' },
    });

    const actions = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: false });
    expect(actions.map((action) => action.kind)).toEqual(['dequeue', 'stage']);
    expect(h.gh).toContainEqual(['api', '-X', 'DELETE', 'repos/owner/repo/issues/101/labels/merge-queue']);
    expect(h.comments[0]).toContain('HTTP 405');
    expect(h.git).toContainEqual(['merge', '--no-ff', '-m', formatStagingCommit({ prNumber: 102, headSha: HEAD_B, baseSha: MAIN }), HEAD_B]);
  });

  test('aborts a conflicting merge, dequeues the conflicting PR with a comment, and stages the next PR immediately', () => {
    const h = createHarness();
    h.setState({
      mainSha: MAIN,
      pulls: [
        { number: 101, title: 'fix(cli): conflict', headRef: 'fix/conflict', headSha: HEAD_A, labels: [QUEUE_LABEL] },
        { number: 102, title: 'fix(cli): clean', headRef: 'fix/clean', headSha: HEAD_B, labels: [QUEUE_LABEL] },
      ],
      eventsByPr: {
        101: [{ event: 'labeled', created_at: '2026-11-14T11:40:00Z', label: { name: QUEUE_LABEL } }],
        102: [{ event: 'labeled', created_at: '2026-11-14T11:45:00Z', label: { name: QUEUE_LABEL } }],
      },
      checkBySha: {
        [HEAD_A]: { status: 'completed', conclusion: 'success' },
        [HEAD_B]: { status: 'completed', conclusion: 'success' },
      },
      mergeConflictOn: new Set([HEAD_A]),
    });

    const actions = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    expect(actions.map((action) => action.kind)).toEqual(['dequeue', 'stage']);
    expect(h.git).toContainEqual(['merge', '--abort']);
    expect(h.comments[0]).toContain('produced a conflict');
  });

  test('dryRun computes the next action without mutating git or GitHub, and simulator globs match simulator-parity.yml', () => {
    const h = createHarness();
    h.setState({
      mainSha: MAIN,
      pulls: [{ number: 101, title: 'fix(cli): clean', headRef: 'fix/clean', headSha: HEAD_A, labels: [QUEUE_LABEL] }],
      checkBySha: { [HEAD_A]: { status: 'completed', conclusion: 'success' } },
    });
    const actions = runQueuePass(h.io, { dryRun: true, usingWorkflowToken: true });
    expect(actions.map((action) => action.kind)).toEqual(['stage']);
    expect(h.git.filter((args) => args[0] !== 'ls-remote')).toEqual([]);
    expect(h.gh.filter((args) => args[0] !== 'api' || args.includes('-X'))).toEqual([]);

    const simWorkflow = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../../.github/workflows/simulator-parity.yml'), 'utf8')) as {
      on: { push?: { paths?: string[] } };
    };
    expect([...SIMULATOR_PARITY_GLOBS]).toEqual(simWorkflow.on.push?.paths ?? []);
    expect(needsSimulatorParity(['packages/rules/src/grammar/firestore.ohm'])).toBe(true);
    expect(needsSimulatorParity(['packages/cli/src/serve/rules.ts'])).toBe(false);
  });
});
