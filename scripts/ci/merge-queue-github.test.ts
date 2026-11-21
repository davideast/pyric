import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { QUEUE_LABEL, REFUSED_BRANCH, STAGING_BRANCH, parseStagingCommit, type QueueAction } from './merge-queue.ts';
import { SIMULATOR_PARITY_GLOBS, needsSimulatorParity, runQueuePass } from './merge-queue-github.ts';
import { batchMembers, bisectBranch } from './auto-revert-batch.ts';
import {
  CHAIN, GREEN_RUN, HEAD_A, HEAD_B, HEAD_C, MAIN, RUN_URL, STAGED, WRAPPED,
  createHarness, gitSh as sh, greenBatch, mutations,
  pull, realBatchIo, stagedMessage, wireRealRemote, type Harness, type RunItem,
} from './merge-queue-harness.ts';

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
    expect(parseStagingCommit(h.remote.messages[WRAPPED] ?? '')).toEqual({
      baseSha: MAIN,
      pulls: [{ number: 101, headSha: HEAD_A }, { number: 103, headSha: HEAD_C }],
    });
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

  test('removes the pull requests that change or rename out of workflow files with the refusal and stages the rest in the same pass', () => {
    const h = createHarness({
      pulls: [pull(101, HEAD_A), pull(102, HEAD_B)],
      greenHeads: new Set([HEAD_A, HEAD_B]),
      filesByPr: { 101: [{ filename: 'docs/old-workflow.yml', previous_filename: '.github/workflows/build.yml' }] },
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
    const h = greenBatch({
      filesByPr: { 102: [{ filename: 'docs/moved.ts', previous_filename: 'packages/rules/src/simulator/eval.ts' }] },
    });
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
    expect(actions.map((action) => action.kind)).toEqual(['land', 'stage']);
    expect(before.remote.main).toBe(moved);
    expect(before.comments).toEqual([]);
    expect(before.remote.pulls.map((item) => item.labels)).toEqual([[QUEUE_LABEL], [QUEUE_LABEL]]);
    expect(before.git).toContainEqual(['checkout', '--detach', moved]);
  });

  test('a first refused push changes nothing but a marker and shows the refusal; a second removes the batch', () => {
    const refusal = 'remote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: - Required status check "CI / required" is expected.';
    const mergeRefusal = 'gh: At least 1 approving review is required by reviewers with write access. (HTTP 405)';
    const h = greenBatch({ pushRefusal: refusal, mergeRefusal });
    const first = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    expect(first.map((action) => action.kind)).toEqual(['land']);
    expect(h.remote.main).toBe(MAIN);
    expect(h.comments).toEqual([]);
    expect(h.remote.pulls.map((item) => item.labels)).toEqual([[QUEUE_LABEL], [QUEUE_LABEL]]);
    expect(h.remote.branches).toEqual({ [STAGING_BRANCH]: STAGED, [REFUSED_BRANCH]: STAGED });
    expect(h.logs.join('\n')).toContain('At least 1 approving review is required');
    expect(h.logs.join('\n')).toContain('Nothing landed and nobody was removed');
    expect(h.gh.filter((args) => args[0] === 'workflow')).toEqual([]);

    const second = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    expect(second.map((action) => action.kind)).toEqual(['dequeue', 'idle']);
    expect(h.remote.main).toBe(MAIN);
    expect(h.comments.map((entry) => entry.pull)).toEqual([101, 102]);
    expect(h.comments[0]?.text).toContain('At least 1 approving review is required');
    expect(h.remote.branches).toEqual({});
    expect(h.logs.join('\n')).toContain('a second time');
  });

  test('when a ruleset refuses direct push of a proven batch, lands via PR merge API in order and checks the tree', () => {
    const refusal = 'remote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: - Required status check "CI / required" is expected.';
    const h = greenBatch({
      pushRefusal: refusal,
      filesByPr: { 102: ['packages/rules/src/simulator/eval.ts'] },
    });
    const actions = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    expect(actions.map((action) => action.kind)).toEqual(['land', 'idle']);
    const mergeCalls = h.gh.filter((args) => args.includes('PUT') && args.some((arg) => arg.endsWith('/merge')));
    expect(mergeCalls).toEqual([
      ['api', '-X', 'PUT', 'repos/owner/repo/pulls/101/merge', '-f', 'merge_method=merge', '-f', `sha=${HEAD_A}`],
      ['api', '-X', 'PUT', 'repos/owner/repo/pulls/102/merge', '-f', 'merge_method=merge', '-f', `sha=${HEAD_B}`],
    ]);
    expect(h.remote.main).not.toBe(MAIN);
    expect(h.remote.main).not.toBe(STAGED);
    expect(h.remote.branches[STAGING_BRANCH]).toBeUndefined();
    expect(h.comments.map((entry) => entry.pull)).toEqual([101, 102]);
    for (const entry of h.comments) {
      expect(entry.text).toContain(h.remote.main);
      expect(entry.text).toContain(STAGED);
      expect(entry.text).toContain('same tree as staged commit');
      expect(entry.text).toContain(RUN_URL);
    }
    const mainDispatches = h.gh.filter((args) => args[0] === 'workflow' && args.at(-1) === 'main');
    expect(mainDispatches.map((args) => args[2])).toEqual(['build.yml', 'slow-scenarios.yml', 'simulator-parity.yml']);

    const withPat = greenBatch({ pushRefusal: refusal });
    expect(runQueuePass(withPat.io, { dryRun: false, usingWorkflowToken: false }).map((action) => action.kind)).toEqual(['land', 'idle']);
    expect(withPat.gh.filter((args) => args[0] === 'workflow')).toEqual([]);
  });

  test('retries a transient base-branch-modified race once during PR merge API fallback', () => {
    const refusal = 'remote: error: GH013: Repository rule violations found for refs/heads/main.';
    let secondAttempts = 0;
    const h = greenBatch({
      pushRefusal: refusal,
      onMergePull: (number, headSha) => {
        if (number === 101) {
          expect(headSha).toBe(HEAD_A);
          h.remote.pulls = h.remote.pulls.filter((item) => item.number !== 101);
          h.remote.mergedPulls?.add(101);
          h.remote.main = '9'.repeat(39) + '1';
          return h.remote.main;
        }
        secondAttempts += 1;
        if (secondAttempts === 1) throw new Error('gh: Base branch was modified. Review and try the merge again. (HTTP 405)');
        expect(headSha).toBe(HEAD_B);
        h.remote.pulls = h.remote.pulls.filter((item) => item.number !== 102);
        h.remote.mergedPulls?.add(102);
        h.remote.main = '9'.repeat(39) + '2';
        h.remote.trees[h.remote.main] = `tree-of-${STAGED}`;
        return h.remote.main;
      },
    });
    const actions = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: false });
    expect(actions.map((action) => action.kind)).toEqual(['land', 'idle']);
    expect(secondAttempts).toBe(2);
    expect(h.comments.map((entry) => entry.pull)).toEqual([101, 102]);
  });

  test('a mid-batch PR merge failure comments and unlabels what landed and re-stages the rest on the new main', () => {
    const refusal = 'remote: error: GH013: Repository rule violations found for refs/heads/main.';
    const firstMergeSha = '9'.repeat(39) + '1';
    const h = greenBatch({
      pushRefusal: refusal,
      onMergePull: (number) => {
        if (number === 101) {
          h.remote.pulls = h.remote.pulls.filter((item) => item.number !== 101);
          h.remote.mergedPulls?.add(101);
          h.remote.main = firstMergeSha;
          return firstMergeSha;
        }
        throw new Error('gh: Head branch was modified. Review and try the merge again. (HTTP 409)');
      },
    });
    const actions = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    expect(actions.map((action) => action.kind)).toEqual(['land', 'stage']);
    expect(h.remote.main).toBe(firstMergeSha);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]?.pull).toBe(101);
    expect(h.comments[0]?.text).toContain(firstMergeSha);
    expect(h.comments[0]?.text).toContain('remaining pull requests will be re-staged');
    expect(h.git).toContainEqual(['checkout', '--detach', firstMergeSha]);
    expect(h.remote.pulls.map((item) => item.number)).toEqual([102]);
  });

  test('a passing multi-PR culprit-search probe landed via PR merge API continues searching remaining suspects in the same pass', () => {
    const headD = '4'.repeat(40);
    const suspects = [
      { number: 101, headSha: HEAD_A },
      { number: 102, headSha: HEAD_B },
      { number: 103, headSha: HEAD_C },
      { number: 104, headSha: headD },
    ];
    const failedRunUrl = 'https://github.com/owner/repo/actions/runs/400';
    const h = createHarness({
      branches: { [STAGING_BRANCH]: STAGED },
      pulls: [pull(101, HEAD_A), pull(102, HEAD_B), pull(103, HEAD_C), pull(104, headD)],
      messages: {
        [STAGED]: stagedMessage({
          baseSha: MAIN,
          pulls: suspects.slice(0, 2),
          search: { suspects, failedRunUrl },
        }),
      },
      greenHeads: new Set([HEAD_A, HEAD_B, HEAD_C, headD, STAGED]),
      stagingRuns: [GREEN_RUN],
      pushRefusal: 'remote: error: GH013: Repository rule violations found for refs/heads/main.',
    });
    const actions = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: false });
    expect(actions.map((action) => action.kind)).toEqual(['land', 'stage']);
    expect(actions[1]).toMatchObject({
      kind: 'stage',
      baseSha: h.remote.main,
      pulls: [{ number: 103 }],
      search: { suspects: suspects.slice(2), failedRunUrl },
    });
    expect(h.comments.map((entry) => entry.pull)).toEqual([101, 102]);
    expect(h.remote.branches[STAGING_BRANCH]).toBe(CHAIN);
    expect(parseStagingCommit(h.remote.messages[CHAIN] ?? '')).toEqual({
      baseSha: h.remote.main,
      pulls: [{ number: 103, headSha: HEAD_C }],
      search: { suspects: suspects.slice(2), failedRunUrl },
    });
  });

  test('reads check-runs through ghChecks when provided so fine-grained PATs never hit the Checks API', () => {
    const h = greenBatch();
    runQueuePass(h.io, { dryRun: true, usingWorkflowToken: false });
    expect(h.ghChecks.length).toBeGreaterThanOrEqual(3);
    expect(h.ghChecks.every((args) => args.some((arg) => arg.includes('/check-runs?')))).toBe(true);
    expect(h.gh.some((args) => args.some((arg) => arg.includes('/check-runs?')))).toBe(false);

    // Falls back to `io.gh` when `ghChecks` is omitted.
    const fallback = greenBatch();
    delete fallback.io.ghChecks;
    expect(runQueuePass(fallback.io, { dryRun: true, usingWorkflowToken: false }).map((action) => action.kind)).toEqual(['land']);
    expect(fallback.gh.some((args) => args.some((arg) => arg.includes('/check-runs?')))).toBe(true);
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
  const failedTrunk: RunItem = {
    id: 9,
    run_attempt: 2,
    status: 'completed',
    conclusion: 'failure',
    html_url: 'https://github.com/owner/repo/actions/runs/9',
    event: 'push',
    head_branch: 'main',
    actor: { login: 'github-actions[bot]' },
  };
  const passedTrunk: RunItem = { ...failedTrunk, id: 10, run_attempt: 1, conclusion: 'success' };

  test('holds a green staged batch while a watched trunk run failed or is being rerun on main, and not during a first attempt', () => {
    const botDispatchFailed: RunItem = { ...failedTrunk, event: 'workflow_dispatch', actor: { login: 'github-actions[bot]' } };
    const rerunning: RunItem = { ...failedTrunk, status: 'in_progress', conclusion: null };
    for (const run of [failedTrunk, botDispatchFailed, rerunning]) {
      const h = greenBatch({ mainRuns: { 'slow-scenarios.yml': [run] } });
      expect(runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true })).toEqual([
        { kind: 'hold-main-red', workflow: 'Slow app scenarios', runUrl: failedTrunk.html_url },
      ]);
      expect(mutations(h)).toEqual({ git: [], gh: [] });
      expect(h.logs.join('\n')).toContain('Slow app scenarios is red on main');
    }
    const firstAttempt = greenBatch({
      mainRuns: { 'build.yml': [{ ...failedTrunk, run_attempt: 1, status: 'in_progress', conclusion: null }] },
    });
    expect(runQueuePass(firstAttempt.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['land', 'idle']);
  });

  test('ignores nightly schedule and manual dispatch runs so they neither cause false holds nor shadow a failed trunk run', () => {
    const nightlyFailed: RunItem = {
      id: 20, run_attempt: 1, status: 'completed', conclusion: 'failure',
      html_url: 'https://github.com/owner/repo/actions/runs/20', event: 'schedule', head_branch: 'main', actor: { login: 'github-actions[bot]' },
    };
    const nightlyOnly = greenBatch({ mainRuns: { 'slow-scenarios.yml': [nightlyFailed] } });
    expect(runQueuePass(nightlyOnly.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['land', 'idle']);

    const nightlyRunning: RunItem = { ...nightlyFailed, id: 21, status: 'in_progress', conclusion: null };
    const manualPass: RunItem = {
      id: 22, run_attempt: 1, status: 'completed', conclusion: 'success',
      html_url: 'https://github.com/owner/repo/actions/runs/22', event: 'workflow_dispatch', head_branch: 'main', actor: { login: 'contributor' },
    };
    for (const nonTrunk of [nightlyRunning, manualPass]) {
      const shadowed = greenBatch({ mainRuns: { 'slow-scenarios.yml': [nonTrunk, failedTrunk] } });
      expect(runQueuePass(shadowed.io, { dryRun: false, usingWorkflowToken: true })).toEqual([
        { kind: 'hold-main-red', workflow: 'Slow app scenarios', runUrl: failedTrunk.html_url },
      ]);
      expect(mutations(shadowed)).toEqual({ git: [], gh: [] });
    }
  });

  test('holds normal pull requests while a bisect probe branch is active after main moved, until main is proven green', () => {
    const oldBatch = '7'.repeat(40);
    const probe = bisectBranch({ commit: oldBatch, workflowId: 5, index: 0 });
    const inProgressFirst: RunItem = { ...passedTrunk, status: 'in_progress', conclusion: null };
    const activeBisect = greenBatch({
      branches: { [STAGING_BRANCH]: STAGED, [probe]: '8'.repeat(40) },
      mainRuns: { 'build.yml': [passedTrunk], 'slow-scenarios.yml': [inProgressFirst] },
    });
    const held = runQueuePass(activeBisect.io, { dryRun: false, usingWorkflowToken: true });
    expect(held).toMatchObject([{ kind: 'hold-main-red', runUrl: `https://github.com/owner/repo/commit/${oldBatch}` }]);
    expect(mutations(activeBisect)).toEqual({ git: [], gh: [] });

    const provenGreen = greenBatch({
      branches: { [STAGING_BRANCH]: STAGED, [probe]: '8'.repeat(40) },
      mainRuns: { 'build.yml': [passedTrunk], 'slow-scenarios.yml': [passedTrunk] },
    });
    expect(runQueuePass(provenGreen.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['land', 'idle']);
  });

  test('stages a revert ahead of the held batch', () => {
    const h = greenBatch({ mainRuns: { 'build.yml': [failedTrunk] } });
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
      const before = JSON.stringify({ ...h.remote, greenHeads: [...h.remote.greenHeads], ancestors: [...h.remote.ancestors] });
      expect(runQueuePass(h.io, { dryRun: true, usingWorkflowToken: true }).map((action) => action.kind)).toEqual([kind]);
      expect(mutations(h)).toEqual({ git: [], gh: [] });
      expect(JSON.stringify({ ...h.remote, greenHeads: [...h.remote.greenHeads], ancestors: [...h.remote.ancestors] })).toBe(before);
      expect(h.comments).toEqual([]);
    }
  });
});

describe('against a real git remote', () => {
  function initPair(): { origin: string; seed: string; work: string; commit: (file: string, text: string, message: string) => string } {
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
    sh(root, ['clone', '--quiet', origin, work]);
    return { origin, seed, work, commit };
  }

  test('the staged commit has main as first parent and holds both heads, and landing makes main that very commit', () => {
    const { origin, seed, work, commit } = initPair();
    const heads: string[] = [];
    for (const name of ['one', 'two']) {
      sh(seed, ['checkout', '--quiet', '-b', `fix/${name}`, 'main']);
      heads.push(commit(`${name}.txt`, `${name}\n`, `fix: ${name}`));
      sh(seed, ['push', '--quiet', 'origin', `fix/${name}`]);
    }
    const { h, syncStaging } = wireRealRemote(origin, work, [pull(101, heads[0]!), pull(102, heads[1]!)]);
    const base = sh(origin, ['rev-parse', 'refs/heads/main']);
    expect(runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['stage']);
    const tip = syncStaging();
    const [firstParent, chain] = sh(origin, ['log', '-1', '--format=%P', tip]).split(' ');
    expect(firstParent).toBe(base);
    expect(sh(origin, ['rev-parse', `${tip}^{tree}`])).toBe(sh(origin, ['rev-parse', `${chain}^{tree}`]));
    expect(sh(origin, ['ls-tree', '--name-only', tip]).split('\n')).toEqual(['base.txt', 'one.txt', 'two.txt']);
    expect(sh(origin, ['log', '--first-parent', '--format=%P', `${base}..${chain}`]).split('\n').map((line) => line.split(' ')[1])).toEqual([heads[1], heads[0]]);
    expect(parseStagingCommit(h.remote.messages[tip] ?? '')?.pulls.map((entry) => entry.headSha)).toEqual(heads);

    expect(runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['land', 'idle']);
    expect(sh(origin, ['rev-parse', 'refs/heads/main'])).toBe(tip);
    for (const head of heads) sh(origin, ['merge-base', '--is-ancestor', head, 'refs/heads/main']);
    expect(h.comments.map((entry) => entry.pull)).toEqual([101, 102]);

    const firstMerge = sh(origin, ['rev-list', '--first-parent', `${base}..${chain}`]).split('\n').at(-1) ?? '';
    sh(work, ['fetch', '--quiet', 'origin', 'main']);
    sh(work, ['checkout', '--quiet', '--detach', 'origin/main']);
    sh(work, ['revert', '--no-edit', '-m', '1', firstMerge]);
    expect(sh(work, ['ls-tree', '--name-only', 'HEAD']).split('\n')).toEqual(['base.txt', 'two.txt']);
  }, 60_000);

  test('stacked pull requests in one batch keep a 1-to-1 bisectable merge chain even when the child is queued first', () => {
    const { origin, seed, work, commit } = initPair();
    sh(seed, ['checkout', '--quiet', '-b', 'stack/base', 'main']);
    const head101 = commit('c1.txt', 'c1\n', 'feat: c1');
    sh(seed, ['push', '--quiet', 'origin', 'stack/base']);
    sh(seed, ['checkout', '--quiet', '-b', 'stack/child', 'stack/base']);
    const head102 = commit('c2.txt', 'c2\n', 'feat: c2');
    sh(seed, ['push', '--quiet', 'origin', 'stack/child']);
    sh(seed, ['checkout', '--quiet', '-b', 'fix/other', 'main']);
    const head103 = commit('other.txt', 'other\n', 'fix: other');
    sh(seed, ['push', '--quiet', 'origin', 'fix/other']);

    const batchPulls = [
      { ...pull(102, head102), labeledAt: '2026-11-14T11:01:00Z' },
      { ...pull(101, head101), labeledAt: '2026-11-14T11:02:00Z' },
      { ...pull(103, head103), labeledAt: '2026-11-14T11:03:00Z' },
    ];
    const { h, syncStaging } = wireRealRemote(origin, work, batchPulls);
    expect(runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['stage']);
    const tip = syncStaging();
    expect(runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['land', 'idle']);

    const parents = sh(origin, ['log', '-1', '--format=%P', tip]).split(' ');
    const message = sh(origin, ['log', '-1', '--format=%B', tip]);
    const members = batchMembers(realBatchIo(origin, batchPulls), { sha: tip, parents, message });
    expect(members?.map((entry) => entry.pull?.number)).toEqual([101, 102, 103]);

    // Reverting only the stacked child (#102) keeps #101 and #103 on main.
    const childCommit = members?.[1]?.sha;
    if (childCommit === undefined) throw new Error('missing stacked child commit');
    sh(work, ['fetch', '--quiet', 'origin', 'main']);
    sh(work, ['checkout', '--quiet', '--detach', 'origin/main']);
    sh(work, ['revert', '--no-edit', '-m', '1', childCommit]);
    expect(sh(work, ['ls-tree', '--name-only', 'HEAD']).split('\n')).toEqual(['base.txt', 'c1.txt', 'other.txt']);
  }, 60_000);

  test('two pull requests sharing the same head commit still produce a 1-to-1 bisectable merge chain', () => {
    const { origin, seed, work, commit } = initPair();
    sh(seed, ['checkout', '--quiet', '-b', 'fix/dup-a', 'main']);
    const sharedHead = commit('dup.txt', 'dup\n', 'fix: dup');
    sh(seed, ['push', '--quiet', 'origin', 'fix/dup-a']);
    sh(seed, ['push', '--quiet', 'origin', 'fix/dup-a:refs/heads/fix/dup-b']);

    const batchPulls = [pull(101, sharedHead), pull(102, sharedHead)];
    const { h, syncStaging } = wireRealRemote(origin, work, batchPulls);
    expect(runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['stage']);
    const tip = syncStaging();
    expect(runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['land', 'idle']);

    const parents = sh(origin, ['log', '-1', '--format=%P', tip]).split(' ');
    const message = sh(origin, ['log', '-1', '--format=%B', tip]);
    const members = batchMembers(realBatchIo(origin, batchPulls), { sha: tip, parents, message });
    expect(members?.map((entry) => entry.pull?.number)).toEqual([101, 102]);
  }, 60_000);

  test('a pull request whose head is already an ancestor of main is dequeued cleanly without amending main', () => {
    const { origin, seed, work, commit } = initPair();
    sh(seed, ['checkout', '--quiet', '-b', 'stack/parent', 'main']);
    const head101 = commit('c1.txt', 'c1\n', 'feat: c1');
    sh(seed, ['push', '--quiet', 'origin', 'stack/parent']);
    sh(seed, ['checkout', '--quiet', 'main']);
    sh(seed, ['merge', '--quiet', '--no-ff', 'stack/parent', '-m', 'land stacked child']);
    sh(seed, ['push', '--quiet', 'origin', 'main']);
    const mainBefore = sh(origin, ['rev-parse', 'refs/heads/main']);

    const { h } = wireRealRemote(origin, work, [pull(101, head101)]);
    const actions = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    expect(actions.map((action) => action.kind)).toEqual(['dequeue', 'idle']);
    expect(sh(origin, ['rev-parse', 'refs/heads/main'])).toBe(mainBefore);
    expect(sh(origin, ['ls-remote', origin, `refs/heads/${STAGING_BRANCH}`])).toBe('');
    expect(h.gh.filter((args) => args[0] === 'workflow')).toEqual([]);
    expect(h.comments[0]?.text).toContain('already in `main`');
  }, 60_000);

  test('git refuses the landing when main moved after staging, and main keeps the other commit', () => {
    const { origin, seed, work, commit } = initPair();
    const heads: string[] = [];
    for (const name of ['one', 'two']) {
      sh(seed, ['checkout', '--quiet', '-b', `fix/${name}`, 'main']);
      heads.push(commit(`${name}.txt`, `${name}\n`, `fix: ${name}`));
      sh(seed, ['push', '--quiet', 'origin', `fix/${name}`]);
    }
    const { h, syncStaging } = wireRealRemote(origin, work, [pull(101, heads[0]!), pull(102, heads[1]!)]);
    runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    const tip = syncStaging();
    const other = sh(origin, ['commit-tree', sh(origin, ['rev-parse', 'refs/heads/main^{tree}']), '-p', 'refs/heads/main', '-m', 'someone else']);
    const git = h.io.git;
    h.io.git = (args) => {
      if (args[0] === 'push' && args.at(-1) === `${tip}:refs/heads/main`) sh(origin, ['update-ref', 'refs/heads/main', other]);
      return git(args);
    };
    const frozen = Object.getOwnPropertyDescriptor(h.remote, 'main')!;
    let reads = 0;
    Object.defineProperty(h.remote, 'main', {
      get: () => {
        reads += 1;
        if (reads <= 2) return sh(origin, ['rev-parse', `${tip}^1`]);
        return frozen.get?.() as string;
      },
      set: () => {},
    });
    expect(runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true }).map((action) => action.kind)).toEqual(['land', 'stage']);
    expect(sh(origin, ['rev-parse', 'refs/heads/main'])).toBe(other);
    expect(h.comments).toEqual([]);
    expect(h.logs.join('\n')).toContain('main or a pull request head moved');
  }, 60_000);

  test('when a ruleset refuses direct push on a real remote, PR merge API fallback lands both normal and duplicate-head batches with exact tree proof', () => {
    const { origin, seed, work, commit } = initPair();
    sh(seed, ['checkout', '--quiet', '-b', 'fix/one', 'main']);
    const head1 = commit('one.txt', 'one\n', 'fix: one');
    sh(seed, ['push', '--quiet', 'origin', 'fix/one']);
    sh(seed, ['push', '--quiet', 'origin', 'fix/one:refs/heads/fix/one-dup']);
    sh(seed, ['checkout', '--quiet', '-b', 'fix/two', 'main']);
    const head2 = commit('two.txt', 'two\n', 'fix: two');
    sh(seed, ['push', '--quiet', 'origin', 'fix/two']);

    const { h, syncStaging } = wireRealRemote(origin, work, [pull(101, head1), pull(102, head1), pull(103, head2)]);
    expect(runQueuePass(h.io, { dryRun: false, usingWorkflowToken: false }).map((action) => action.kind)).toEqual(['stage']);
    const tip = syncStaging();

    // Simulate GitHub Ruleset GH013 rejecting direct push of the multi-PR wrapper commit,
    // and real server-side PR merge API commits on `origin.git` (auto-closing #102 when #101 merges).
    const realGit = h.io.git;
    h.io.git = (args) => {
      if (args[0] === 'push' && args.at(-1) === `${tip}:refs/heads/main`) {
        throw new Error('git push failed: remote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: - Required status check "CI / required" is expected.');
      }
      return realGit(args);
    };
    h.remote.onMergePull = (number, requestedSha) => {
      const found = h.remote.pulls.find((item) => item.number === number);
      if (found === undefined) throw new Error(`gh: Pull Request #${number} is not mergeable (HTTP 405)`);
      expect(requestedSha).toBe(found.headSha);
      sh(seed, ['fetch', '--quiet', 'origin', 'main']);
      sh(seed, ['checkout', '--quiet', 'main']);
      sh(seed, ['reset', '--quiet', '--hard', 'origin/main']);
      sh(seed, ['merge', '--quiet', '--no-ff', found.headSha, '-m', `Merge pull request #${number} from ${found.headRef}`]);
      sh(seed, ['push', '--quiet', 'origin', 'main']);
      const mergeSha = sh(origin, ['rev-parse', 'refs/heads/main']);
      h.remote.pulls = h.remote.pulls.filter((item) => {
        if (item.number === number || item.headSha === found.headSha) {
          h.remote.mergedPulls?.add(item.number);
          return false;
        }
        return true;
      });
      return mergeSha;
    };

    expect(runQueuePass(h.io, { dryRun: false, usingWorkflowToken: false }).map((action) => action.kind)).toEqual(['land', 'idle']);
    const mainAfter = sh(origin, ['rev-parse', 'refs/heads/main']);
    expect(mainAfter).not.toBe(tip);
    expect(sh(origin, ['rev-parse', `${mainAfter}^{tree}`])).toBe(sh(origin, ['rev-parse', `${tip}^{tree}`]));
    expect(sh(origin, ['ls-tree', '--name-only', mainAfter]).split('\n')).toEqual(['base.txt', 'one.txt', 'two.txt']);
    expect(h.comments.map((entry) => entry.pull)).toEqual([101, 102, 103]);
    expect(h.comments[0]?.text).toContain(mainAfter);
    expect(h.comments[0]?.text).toContain(tip);
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
