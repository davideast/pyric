import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  QUEUE_LABEL,
  REFUSED_BRANCH,
  STAGING_BRANCH,
  formatStagingTrailers,
  parseStagingCommit,
  type QueueAction,
  type StagedMeta,
} from './merge-queue.ts';
import {
  SIMULATOR_PARITY_GLOBS,
  needsSimulatorParity,
  runQueuePass,
  type QueueIo,
} from './merge-queue-github.ts';

const MAIN = '1'.repeat(40);
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'd'.repeat(40);
const STAGED = 'c'.repeat(40);
const CHAIN = 'e'.repeat(40);
const WRAPPED = 'f'.repeat(40);
const NOW = Date.parse('2026-11-14T12:00:00Z');
const RUN_URL = 'https://github.com/owner/repo/actions/runs/500';
const GREEN_RUN = { id: 500, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: RUN_URL };

interface FakePull {
  number: number;
  title: string;
  headRef: string;
  headSha: string;
  labels: string[];
}

interface RunItem {
  id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  html_url: string;
}

/** A remote repository small enough to read: branches, pull requests, commit
 *  messages and trees by sha, and the runs of each workflow. */
interface Remote {
  main: string;
  branches: Record<string, string>;
  pulls: FakePull[];
  messages: Record<string, string>;
  trees: Record<string, string>;
  greenHeads: Set<string>;
  stagingRuns: RunItem[];
  mainRuns: Record<string, RunItem[]>;
  filesByPr: Record<number, string[]>;
  conflicts: Set<string>;
  /** What a push to main is refused with. */
  pushRefusal?: string;
  /** What a push to the staging branch is refused with. */
  stagingPushRefusal?: string;
  /** Called in place of moving main, to model someone else's push winning. */
  onPushMain?: () => void;
}

interface Harness {
  remote: Remote;
  gh: string[][];
  git: string[][];
  comments: Array<{ pull: number; text: string }>;
  logs: string[];
  io: QueueIo;
}

function pull(number: number, headSha: string, labels: string[] = [QUEUE_LABEL]): FakePull {
  return { number, title: `fix(cli): change ${number}`, headRef: `fix/change-${number}`, headSha, labels };
}

function stagedMessage(meta: StagedMeta): string {
  return `Merge queue batch\n\n${formatStagingTrailers(meta)}`;
}

function createHarness(initial: Partial<Remote>): Harness {
  const remote: Remote = {
    main: MAIN, branches: {}, pulls: [], messages: {}, trees: {}, greenHeads: new Set(), stagingRuns: [],
    mainRuns: {}, filesByPr: {}, conflicts: new Set(), ...initial,
  };
  const gh: string[][] = [];
  const git: string[][] = [];
  const comments: Harness['comments'] = [];
  const logs: string[] = [];
  const files = new Map<string, string>();
  // The local checkout: the messages of the commits made since the last checkout.
  let local: string[] = [];

  const treeOf = (sha: string): string => remote.trees[sha] ?? `tree-of-${sha}`;

  function push(args: string[]): string {
    if (args.includes('--delete')) {
      delete remote.branches[args.at(-1) ?? ''];
      return '';
    }
    const [sha, ref] = (args.at(-1) ?? '').split(':');
    const branch = (ref ?? '').replace('refs/heads/', '');
    if (branch !== 'main') {
      const touchesWorkflows = remote.pulls.some((item) => (remote.filesByPr[item.number] ?? []).some((file) => file.startsWith('.github/workflows/')) && item.labels.includes(QUEUE_LABEL));
      if (branch === STAGING_BRANCH && remote.stagingPushRefusal !== undefined && touchesWorkflows) throw new Error(remote.stagingPushRefusal);
      remote.branches[branch] = sha ?? '';
      return '';
    }
    if (remote.pushRefusal !== undefined) throw new Error(remote.pushRefusal);
    if (remote.onPushMain !== undefined) {
      remote.onPushMain();
      throw new Error('! [rejected] main -> main (fetch first)');
    }
    const landed = parseStagingCommit(remote.messages[sha ?? ''] ?? '')?.pulls ?? [];
    remote.pulls = remote.pulls.filter((item) => !landed.some((entry) => entry.number === item.number));
    remote.main = sha ?? '';
    return '';
  }

  function runGit(args: string[]): string {
    git.push(args);
    const [command] = args;
    if (command === 'ls-remote' && args.includes('refs/heads/main')) return `${remote.main}\trefs/heads/main\n`;
    if (command === 'ls-remote') {
      return Object.entries(remote.branches).map(([branch, sha]) => `${sha}\trefs/heads/${branch}\n`).join('');
    }
    if (command === 'checkout') local = [];
    if (command === 'merge' && args[1] === '--no-ff') {
      if (remote.conflicts.has(args.at(-1) ?? '')) throw new Error('CONFLICT (content): Merge conflict in packages/cli/src/serve/rules.ts');
      local.push(args[3] ?? '');
    }
    if (command === 'commit' && args[1] === '--amend') local[local.length - 1] = args[3] ?? '';
    if (command === 'rev-parse' && args[1] === 'HEAD') {
      remote.messages[CHAIN] = local.at(-1) ?? '';
      return `${CHAIN}\n`;
    }
    if (command === 'rev-parse') {
      const target = (args[1] ?? '').replace('^{tree}', '');
      return `${treeOf(target === 'HEAD' ? CHAIN : target)}\n`;
    }
    if (command === 'commit-tree') {
      remote.messages[WRAPPED] = args.at(-1) ?? '';
      return `${WRAPPED}\n`;
    }
    if (command === 'push') return push(args);
    return '';
  }

  function runsFor(path: string): RunItem[] {
    const workflow = /^actions\/workflows\/([^/]+)\/runs\?/.exec(path)?.[1] ?? '';
    if (path.includes('branch=main&')) return remote.mainRuns[workflow] ?? [];
    return remote.stagingRuns;
  }

  function runGh(args: string[]): string {
    gh.push(args);
    if (args[0] !== 'api') return '';
    const methodIdx = args.indexOf('-X');
    const method = methodIdx === -1 ? 'GET' : args[methodIdx + 1];
    const path = (args.find((arg) => arg.startsWith('repos/owner/repo/')) ?? '').replace('repos/owner/repo/', '');
    if (method === 'GET' && path === 'branches/main') return JSON.stringify({ commit: { sha: remote.main } });
    if (method === 'GET' && path.startsWith('pulls?')) {
      return JSON.stringify(remote.pulls.map((item) => ({
        number: item.number, title: item.title, state: 'open', draft: false, created_at: `2026-11-14T11:${item.number % 60}:00Z`,
        head: { ref: item.headRef, sha: item.headSha, repo: { full_name: 'owner/repo' } },
        labels: item.labels.map((name) => ({ name })),
      })));
    }
    const single = /^pulls\/(\d+)$/.exec(path);
    if (method === 'GET' && single) {
      const found = remote.pulls.find((item) => item.number === Number(single[1]));
      return JSON.stringify({ state: found ? 'open' : 'closed', head: { sha: found?.headSha ?? '' } });
    }
    if (method === 'GET' && /^issues\/\d+\/events\?/.test(path)) return '[]';
    const check = /^commits\/([0-9a-f]+)\/check-runs\?/.exec(path);
    if (method === 'GET' && check) {
      const green = remote.greenHeads.has(check[1] ?? '');
      return JSON.stringify({ check_runs: green ? [{ name: 'CI / required', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }] : [] });
    }
    const commit = /^commits\/([0-9a-f]+)$/.exec(path);
    if (method === 'GET' && commit) {
      return JSON.stringify({ commit: { message: remote.messages[commit[1] ?? ''] ?? '', committer: { date: '2026-11-14T11:55:00Z' } } });
    }
    if (method === 'GET' && path.startsWith('actions/workflows/')) return JSON.stringify({ workflow_runs: runsFor(path) });
    if (method === 'GET' && /^actions\/runs\/\d+\/attempts\/\d+\/jobs\?/.test(path)) return JSON.stringify({ jobs: [] });
    const filesOf = /^pulls\/(\d+)\/files\?/.exec(path);
    if (method === 'GET' && filesOf) return JSON.stringify((remote.filesByPr[Number(filesOf[1])] ?? []).map((filename) => ({ filename })));
    const label = /^issues\/(\d+)\/labels\/merge-queue$/.exec(path);
    if (method === 'DELETE' && label) {
      remote.pulls = remote.pulls.map((item) => (item.number === Number(label[1]) ? { ...item, labels: item.labels.filter((name) => name !== QUEUE_LABEL) } : item));
      return '{}';
    }
    const commented = /^issues\/(\d+)\/comments$/.exec(path);
    if (method === 'POST' && commented) {
      const file = (args.at(-1) ?? '').replace('body=@', '');
      comments.push({ pull: Number(commented[1]), text: files.get(file) ?? '' });
      return '{}';
    }
    throw new Error(`unexpected gh api ${method} ${path}`);
  }

  const io: QueueIo = {
    repo: 'owner/repo',
    now: () => NOW,
    log: (text) => { logs.push(text); },
    writeFile: (name, text) => {
      files.set(`/scratch/${name}`, text);
      return `/scratch/${name}`;
    },
    git: runGit,
    gh: runGh,
  };
  return { remote, gh, git, comments, logs, io };
}

/** Two green pull requests staged together on a green run. */
function greenBatch(extra: Partial<Remote> = {}): Harness {
  const meta: StagedMeta = { baseSha: MAIN, pulls: [{ number: 101, headSha: HEAD_A }, { number: 102, headSha: HEAD_B }] };
  return createHarness({
    branches: { [STAGING_BRANCH]: STAGED },
    pulls: [pull(101, HEAD_A), pull(102, HEAD_B)],
    messages: { [STAGED]: stagedMessage(meta) },
    greenHeads: new Set([HEAD_A, HEAD_B, STAGED]),
    stagingRuns: [GREEN_RUN],
    ...extra,
  });
}

function mutations(h: Harness): { git: string[][]; gh: string[][] } {
  return {
    git: h.git.filter((args) => args[0] !== 'ls-remote'),
    gh: h.gh.filter((args) => args[0] !== 'api' || args.includes('-X')),
  };
}

describe('staging a batch', () => {
  test('merges every ready pull request in order, drops the one that conflicts, and stages one commit whose first parent is main', () => {
    const h = createHarness({
      pulls: [pull(101, HEAD_A), pull(102, HEAD_B), pull(103, HEAD_C, [QUEUE_LABEL, 'ci-packaging'])],
      greenHeads: new Set([HEAD_A, HEAD_B, HEAD_C]),
      conflicts: new Set([HEAD_B]),
    });
    const actions = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    expect(actions.map((action) => action.kind)).toEqual(['dequeue', 'stage']);
    expect(h.git).toContainEqual(['merge', '--abort']);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]).toMatchObject({ pull: 102 });
    expect(h.comments[0]?.text).toContain('produced a conflict');
    expect(h.remote.pulls.find((item) => item.number === 102)?.labels).toEqual([]);

    const merges = h.git.filter((args) => args[0] === 'merge' && args[1] === '--no-ff');
    expect(merges.map((args) => args.at(-1))).toEqual([HEAD_A, HEAD_B, HEAD_C]);
    expect(merges[0]?.[3]).toBe(`Merge pull request #101 from fix/change-101\n\nfix(cli): change 101\n\nMerge-Queue-Pull: #101 ${HEAD_A}`);
    const wrap = h.git.find((args) => args[0] === 'commit-tree');
    expect(wrap?.slice(0, 6)).toEqual(['commit-tree', `tree-of-${CHAIN}`, '-p', MAIN, '-p', CHAIN]);
    expect(h.remote.branches[STAGING_BRANCH]).toBe(WRAPPED);
    expect(parseStagingCommit(h.remote.messages[WRAPPED] ?? '')).toEqual({ baseSha: MAIN, pulls: [{ number: 101, headSha: HEAD_A }, { number: 103, headSha: HEAD_C }] });
    expect(h.remote.messages[WRAPPED]).toStartWith('Merge queue batch: #101, #103\n\n- #101 fix(cli): change 101\n- #103 fix(cli): change 103\n\n');
    expect(h.gh).toContainEqual(['workflow', 'run', 'build.yml', '--repo', 'owner/repo', '--ref', STAGING_BRANCH, '-f', 'release_proof=true']);
    expect(h.remote.main).toBe(MAIN);
  });

  test('a lone pull request is staged as its own merge commit, and a batch that conflicts entirely stages nothing', () => {
    const h = createHarness({ pulls: [pull(101, HEAD_A)], greenHeads: new Set([HEAD_A]) });
    expect(runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['stage']);
    expect(h.git.some((args) => args[0] === 'commit-tree')).toBe(false);
    expect(h.remote.branches[STAGING_BRANCH]).toBe(CHAIN);
    expect(h.remote.messages[CHAIN]).toStartWith('Merge pull request #101 from fix/change-101\n\nfix(cli): change 101\n\n');
    expect(parseStagingCommit(h.remote.messages[CHAIN] ?? '')).toEqual({ baseSha: MAIN, pulls: [{ number: 101, headSha: HEAD_A }] });

    const none = createHarness({ pulls: [pull(101, HEAD_A)], greenHeads: new Set([HEAD_A]), conflicts: new Set([HEAD_A]), branches: { [STAGING_BRANCH]: STAGED } });
    expect(runQueuePass(none.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['dequeue', 'idle']);
    expect(none.remote.branches[STAGING_BRANCH]).toBeUndefined();
  });
});

describe('a refused push of the staged commit', () => {
  const refusal = ' ! [remote rejected] HEAD -> merge-queue/staging (refusing to allow a GitHub App to create or update workflow `.github/workflows/build.yml` without `workflows` permission)';

  test('removes the pull requests that change workflow files with the refusal and stages the rest in the same pass', () => {
    const h = createHarness({
      pulls: [pull(101, HEAD_A), pull(102, HEAD_B)],
      greenHeads: new Set([HEAD_A, HEAD_B]),
      filesByPr: { 101: ['.github/workflows/build.yml', 'scripts/ci/plan.ts'] },
      stagingPushRefusal: refusal,
    });
    const actions = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    expect(actions).toMatchObject([{ kind: 'dequeue', reason: 'staging-push-refused', pulls: [{ number: 101 }] }, { kind: 'stage', pulls: [{ number: 102 }] }]);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]?.text).toContain('without `workflows` permission');
    expect(h.logs.join('\n')).toContain('refusing to allow a GitHub App');
    expect(h.remote.branches[STAGING_BRANCH]).toBe(CHAIN);
  });

  test('any other refusal fails the pass and removes nobody', () => {
    const h = createHarness({
      pulls: [pull(101, HEAD_A), pull(102, HEAD_B)],
      greenHeads: new Set([HEAD_A, HEAD_B]),
      filesByPr: { 101: ['.github/workflows/build.yml'] },
      stagingPushRefusal: 'fatal: unable to access the remote: The requested URL returned error: 503',
    });
    expect(() => runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true })).toThrow('503');
    expect(h.comments).toEqual([]);
    expect(h.remote.pulls.map((item) => item.labels)).toEqual([[QUEUE_LABEL], [QUEUE_LABEL]]);
  });
});

describe('landing a batch', () => {
  test('moves main to the staged commit without force, checks the tree, records the run on every pull request, and dispatches main once', () => {
    const h = greenBatch({ filesByPr: { 102: ['packages/rules/src/simulator/eval.ts'] } });
    const actions = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    expect(actions.map((action) => action.kind)).toEqual(['land', 'idle']);
    expect(h.git).toContainEqual(['push', 'origin', `${STAGED}:refs/heads/main`]);
    expect(h.git.filter((args) => args[0] === 'push' && args.at(-1)?.endsWith(':refs/heads/main'))).toHaveLength(1);
    expect(h.remote.main).toBe(STAGED);
    expect(h.git).toContainEqual(['rev-parse', `${STAGED}^{tree}`]);
    expect(h.comments.map((entry) => entry.pull)).toEqual([101, 102]);
    for (const entry of h.comments) {
      expect(entry.text).toContain(STAGED);
      expect(entry.text).toContain(RUN_URL);
    }
    expect(h.remote.branches[STAGING_BRANCH]).toBeUndefined();
    const mainDispatches = h.gh.filter((args) => args[0] === 'workflow' && args.at(-1) === 'main');
    expect(mainDispatches.map((args) => args[2])).toEqual(['build.yml', 'slow-scenarios.yml', 'simulator-parity.yml']);
    expect(h.logs.join('\n')).toContain(`Landed #101, #102 on main as ${STAGED}`);

    const withPat = greenBatch();
    runQueuePass(withPat.io, { dryRun: false, usingWorkflowToken: false });
    expect(withPat.gh.filter((args) => args[0] === 'workflow')).toEqual([]);
  });

  test('reports no landing when the tree on main is not the tree the run proved', () => {
    const h = greenBatch({ trees: { [STAGED]: 'tree-proven' } });
    const original = h.io.git;
    h.io.git = (args) => {
      const out = original(args);
      // Someone else's commit lands on top between the push and the check.
      if (args[0] === 'push' && args.at(-1) === `${STAGED}:refs/heads/main`) h.remote.main = '9'.repeat(40);
      return out;
    };
    expect(() => runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true })).toThrow(/proved c{40} with tree tree-proven/);
    expect(h.comments).toEqual([]);
    expect(h.logs.join('\n')).not.toContain('Landed');
  });

  test('lands nothing and rebuilds when main moved since the batch was staged', () => {
    const moved = '2'.repeat(40);
    const before = greenBatch();
    before.remote.onPushMain = () => { before.remote.main = moved; };
    const actions = runQueuePass(before.io, { dryRun: false, usingWorkflowToken: true });
    expect(actions.map((action) => action.kind)).toEqual(['land']);
    expect(before.remote.main).toBe(moved);
    expect(before.comments).toEqual([]);
    expect(before.remote.pulls.map((item) => item.labels)).toEqual([[QUEUE_LABEL], [QUEUE_LABEL]]);
    expect(before.remote.branches[STAGING_BRANCH]).toBeUndefined();

    const next = runQueuePass(before.io, { dryRun: false, usingWorkflowToken: true });
    expect(next.map((action) => action.kind)).toEqual(['stage']);
    expect(before.git).toContainEqual(['checkout', '--detach', moved]);
  });

  test('a first refused push changes nothing but a marker and shows the refusal; a second removes the batch', () => {
    const refusal = 'remote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: - Required status check "CI / required" is expected.';
    const h = greenBatch({ pushRefusal: refusal });
    const first = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    expect(first.map((action) => action.kind)).toEqual(['land']);
    expect(h.remote.main).toBe(MAIN);
    expect(h.comments).toEqual([]);
    expect(h.remote.pulls.map((item) => item.labels)).toEqual([[QUEUE_LABEL], [QUEUE_LABEL]]);
    expect(h.remote.branches).toEqual({ [STAGING_BRANCH]: STAGED, [REFUSED_BRANCH]: STAGED });
    expect(h.logs.join('\n')).toContain('GH013: Repository rule violations');
    expect(h.logs.join('\n')).toContain('Nothing landed and nobody was removed');
    expect(h.gh.filter((args) => args[0] === 'workflow')).toEqual([]);

    const second = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    expect(second.map((action) => action.kind)).toEqual(['dequeue', 'idle']);
    expect(h.remote.main).toBe(MAIN);
    expect(h.comments.map((entry) => entry.pull)).toEqual([101, 102]);
    expect(h.comments[0]?.text).toContain('GH013');
    expect(h.remote.branches).toEqual({});
    expect(h.logs.join('\n')).toContain('a second time');
  });

  test('a stale refusal marker for another commit does not count, and a landing after one refusal clears the marker', () => {
    const stale = greenBatch({ pushRefusal: 'remote: refused' });
    stale.remote.branches[REFUSED_BRANCH] = '7'.repeat(40);
    expect(runQueuePass(stale.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['land']);
    expect(stale.comments).toEqual([]);

    const retried = greenBatch();
    retried.remote.branches[REFUSED_BRANCH] = STAGED;
    expect(runQueuePass(retried.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['land', 'idle']);
    expect(retried.remote.main).toBe(STAGED);
    expect(retried.remote.branches).toEqual({});
  });

  test('a passing probe lands and keeps the staging branch, and the suspect left behind is removed in the same pass', () => {
    const suspects = [{ number: 101, headSha: HEAD_A }, { number: 102, headSha: HEAD_B }];
    const failedRunUrl = 'https://github.com/owner/repo/actions/runs/400';
    const h = createHarness({
      branches: { [STAGING_BRANCH]: STAGED },
      pulls: [pull(101, HEAD_A), pull(102, HEAD_B)],
      messages: { [STAGED]: stagedMessage({ baseSha: MAIN, pulls: [suspects[0]!], search: { suspects, failedRunUrl } }) },
      greenHeads: new Set([HEAD_A, HEAD_B, STAGED]),
      stagingRuns: [GREEN_RUN],
    });
    const actions = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    expect(actions.map((action) => action.kind)).toEqual(['land', 'dequeue', 'idle']);
    expect(h.remote.main).toBe(STAGED);
    expect(h.comments.map((entry) => entry.pull)).toEqual([101, 102]);
    expect(h.comments[1]?.text).toContain(failedRunUrl);
    expect(h.comments[1]?.text).toContain('splitting a failed batch');
    expect(h.remote.branches[STAGING_BRANCH]).toBeUndefined();
  });
});

describe('a red main', () => {
  const failed = { id: 9, run_attempt: 2, status: 'completed', conclusion: 'failure', html_url: 'https://github.com/owner/repo/actions/runs/9' };

  test('holds a green staged batch while a watched workflow failed or is being rerun on the head of main, and not during a first attempt', () => {
    for (const run of [failed, { ...failed, status: 'in_progress', conclusion: null }]) {
      const h = greenBatch({ mainRuns: { 'slow-scenarios.yml': [run] } });
      expect(runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true })).toEqual([{ kind: 'hold-main-red', workflow: 'Slow app scenarios', runUrl: failed.html_url }]);
      expect(mutations(h)).toEqual({ git: [], gh: [] });
      expect(h.logs.join('\n')).toContain('Slow app scenarios is red on main');
    }
    const firstAttempt = greenBatch({ mainRuns: { 'build.yml': [{ ...failed, run_attempt: 1, status: 'in_progress', conclusion: null }] } });
    expect(runQueuePass(firstAttempt.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['land', 'idle']);
  });

  test('stages a revert ahead of the held batch', () => {
    const h = greenBatch({ mainRuns: { 'build.yml': [failed] } });
    h.remote.pulls.push({ ...pull(103, HEAD_C), title: 'revert: fix(cli): change 90' });
    h.remote.greenHeads.add(HEAD_C);
    const actions = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    expect(actions).toMatchObject([{ kind: 'stage', pulls: [{ number: 103 }] }]);
    expect(h.remote.main).toBe(MAIN);
  });
});

describe('dry run', () => {
  test('reports the next step for an idle, a ready, a green, and a refused queue without changing anything', () => {
    const states: Array<[Harness, QueueAction['kind']]> = [
      [createHarness({}), 'idle'],
      [createHarness({ pulls: [pull(101, HEAD_A)], greenHeads: new Set([HEAD_A]) }), 'stage'],
      [greenBatch(), 'land'],
      [greenBatch({ branches: { [STAGING_BRANCH]: STAGED, [REFUSED_BRANCH]: STAGED } }), 'land'],
    ];
    for (const [h, kind] of states) {
      const before = JSON.stringify({ ...h.remote, greenHeads: [...h.remote.greenHeads] });
      expect(runQueuePass(h.io, { dryRun: true, usingWorkflowToken: true }).map((action) => action.kind)).toEqual([kind]);
      expect(mutations(h)).toEqual({ git: [], gh: [] });
      expect(JSON.stringify({ ...h.remote, greenHeads: [...h.remote.greenHeads] })).toBe(before);
      expect(h.comments).toEqual([]);
    }
  });
});

describe('against a real git remote', () => {
  function sh(cwd: string, args: string[]): string {
    // Only the repositories' own configuration applies, not the machine's.
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const out = spawnSync('git', args, { cwd, encoding: 'utf8', env });
    if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
    return out.stdout.trim();
  }

  /** A bare remote with main and two pull request branches that touch
   *  different files, and a clone the queue works in. */
  function repositories(): { origin: string; work: string; heads: [string, string] } {
    const root = mkdtempSync(join(tmpdir(), 'merge-queue-git-'));
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    const work = join(root, 'work');
    sh(root, ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
    sh(root, ['clone', '--quiet', origin, seed]);
    const commit = (file: string, text: string, message: string): string => {
      writeFileSync(join(seed, file), text);
      sh(seed, ['add', file]);
      sh(seed, ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '--quiet', '-m', message]);
      return sh(seed, ['rev-parse', 'HEAD']);
    };
    sh(seed, ['checkout', '--quiet', '-b', 'main']);
    commit('base.txt', 'base\n', 'base');
    sh(seed, ['push', '--quiet', 'origin', 'main']);
    const heads: string[] = [];
    for (const name of ['one', 'two']) {
      sh(seed, ['checkout', '--quiet', '-b', `fix/${name}`, 'main']);
      heads.push(commit(`${name}.txt`, `${name}\n`, `fix: ${name}`));
      sh(seed, ['push', '--quiet', 'origin', `fix/${name}`]);
    }
    sh(root, ['clone', '--quiet', origin, work]);
    return { origin, work, heads: [heads[0]!, heads[1]!] };
  }

  function realHarness(): { h: Harness; origin: string; work: string; heads: [string, string]; syncStaging: () => string } {
    const { origin, work, heads } = repositories();
    const h = createHarness({ pulls: [pull(101, heads[0]), pull(102, heads[1])], greenHeads: new Set(heads) });
    Object.defineProperty(h.remote, 'main', { get: () => sh(origin, ['rev-parse', 'refs/heads/main']), set: () => {} });
    h.io.git = (args) => sh(work, args);
    const syncStaging = (): string => {
      const tip = sh(origin, ['rev-parse', `refs/heads/${STAGING_BRANCH}`]);
      h.remote.messages[tip] = sh(origin, ['log', '-1', '--format=%B', tip]);
      h.remote.greenHeads.add(tip);
      h.remote.stagingRuns = [GREEN_RUN];
      return tip;
    };
    return { h, origin, work, heads, syncStaging };
  }

  test('the staged commit has main as first parent and holds both heads, and landing makes main that very commit', () => {
    const { h, origin, work, heads, syncStaging } = realHarness();
    const base = sh(origin, ['rev-parse', 'refs/heads/main']);
    expect(runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['stage']);
    const tip = syncStaging();
    const [firstParent, chain] = sh(origin, ['log', '-1', '--format=%P', tip]).split(' ');
    expect(firstParent).toBe(base);
    expect(sh(origin, ['rev-parse', `${tip}^{tree}`])).toBe(sh(origin, ['rev-parse', `${chain}^{tree}`]));
    expect(sh(origin, ['ls-tree', '--name-only', tip]).split('\n')).toEqual(['base.txt', 'one.txt', 'two.txt']);
    // The chain is one two-parent merge per pull request, each revertible by itself.
    expect(sh(origin, ['log', '--first-parent', '--format=%P', `${base}..${chain}`]).split('\n').map((line) => line.split(' ')[1])).toEqual([heads[1], heads[0]]);
    expect(parseStagingCommit(h.remote.messages[tip] ?? '')?.pulls.map((entry) => entry.headSha)).toEqual(heads);

    expect(runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['land', 'idle']);
    expect(sh(origin, ['rev-parse', 'refs/heads/main'])).toBe(tip);
    for (const head of heads) sh(origin, ['merge-base', '--is-ancestor', head, 'refs/heads/main']);
    expect(h.comments.map((entry) => entry.pull)).toEqual([101, 102]);

    // What the auto-revert lane does for one pull request of a landed batch: revert its merge commit alone.
    const firstMerge = sh(origin, ['rev-list', '--first-parent', `${base}..${chain}`]).split('\n').at(-1) ?? '';
    sh(work, ['fetch', '--quiet', 'origin', 'main']);
    sh(work, ['checkout', '--quiet', '--detach', 'origin/main']);
    sh(work, ['revert', '--no-edit', '-m', '1', firstMerge]);
    expect(sh(work, ['ls-tree', '--name-only', 'HEAD']).split('\n')).toEqual(['base.txt', 'two.txt']);
  }, 60_000);

  test('git refuses the landing when main moved after staging, and main keeps the other commit', () => {
    const { h, origin, syncStaging } = realHarness();
    runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    const tip = syncStaging();
    const other = sh(origin, ['commit-tree', sh(origin, ['rev-parse', 'refs/heads/main^{tree}']), '-p', 'refs/heads/main', '-m', 'someone else']);
    // The move happens after the queue has read main, as a concurrent push would.
    const git = h.io.git;
    h.io.git = (args) => {
      if (args[0] === 'push' && args.at(-1) === `${tip}:refs/heads/main`) sh(origin, ['update-ref', 'refs/heads/main', other]);
      return git(args);
    };
    const frozen = Object.getOwnPropertyDescriptor(h.remote, 'main')!;
    let reads = 0;
    Object.defineProperty(h.remote, 'main', { get: () => (reads++ < 2 ? sh(origin, ['rev-parse', `${tip}^1`]) : (frozen.get?.() as string)), set: () => {} });
    expect(runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['land']);
    expect(sh(origin, ['rev-parse', 'refs/heads/main'])).toBe(other);
    expect(h.comments).toEqual([]);
    expect(h.logs.join('\n')).toContain('main or a pull request head moved');
  }, 60_000);
});

describe('simulator parity paths', () => {
  test('match the push paths of simulator-parity.yml', () => {
    const simWorkflow = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../../.github/workflows/simulator-parity.yml'), 'utf8')) as {
      on: { push?: { paths?: string[] } };
    };
    expect([...SIMULATOR_PARITY_GLOBS]).toEqual(simWorkflow.on.push?.paths ?? []);
    expect(needsSimulatorParity(['packages/rules/src/grammar/firestore.ohm'])).toBe(true);
    expect(needsSimulatorParity(['packages/cli/src/serve/rules.ts'])).toBe(false);
  });
});
