import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../lib/private-job-tmpdir.ts';
import type { Gh } from './github-issues.ts';
import {
  areObservationsSupersededEquivalent,
  formatReconciledDivertedSummary,
  parseDivertedCaptureBranch,
  reconcileSupersededDivertedCapturePrs,
  type OpenCapturePrCandidate,
} from './oracle-capture-reconcile-diverted.ts';

const ROOT = resolve(import.meta.dir, '../..');
const VALID_RIGS = new Set([
  'admin-auth',
  'rules-firestore',
  'rules-storage',
  'sdk-probes',
  'storage-stdlib-discovery',
]);

function makeObsJson(overrides: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    name: 'sample-obs',
    description: 'Observes sample behavior against Firebase.',
    projectId: 'demo-oracle',
    fbSdkVersion: '12.19.0',
    matrixRow: '',
    rowIds: [],
    observedAt: '2026-11-18T10:00:00.000Z',
    behavior: {
      rejected: true,
      code: 'auth/argument-error',
      nested: { b: 2, a: 1 },
    },
  };
  return `${JSON.stringify({ ...base, ...overrides }, null, 2)}\n`;
}

function initGitPair(): {
  repoDir: string;
  remoteDir: string;
  gitRepo: (...args: string[]) => string;
  gitRemote: (...args: string[]) => string;
  cleanup: () => void;
} {
  const base = createPrivateJobTmpDir('reconcile-ut');
  const remoteDir = join(base, 'remote.git');
  const repoDir = join(base, 'work');
  mkdirSync(remoteDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  execFileSync('git', ['init', '--bare', remoteDir]);
  execFileSync('git', ['init', '-b', 'main', repoDir]);

  const gitRepo = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
  const gitRemote = (...args: string[]): string =>
    execFileSync('git', ['--git-dir', remoteDir, ...args], { encoding: 'utf8' }).trim();

  gitRepo('config', 'user.name', 'github-actions[bot]');
  gitRepo('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  gitRepo('remote', 'add', 'origin', remoteDir);

  writeFileSync(join(repoDir, 'README.md'), 'seed\n');
  gitRepo('add', 'README.md');
  gitRepo('commit', '-m', 'chore: seed main');
  gitRepo('push', '-u', 'origin', 'main');

  return {
    repoDir,
    remoteDir,
    gitRepo,
    gitRemote,
    cleanup: () => {
      removePrivateJobTmpDir(base);
    },
  };
}

function writeRepoFile(repoDir: string, relPath: string, content: string): void {
  const full = join(repoDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe('parseDivertedCaptureBranch', () => {
  test('matches diverted capture branches and rejects canonical or unrelated branches', () => {
    expect(parseDivertedCaptureBranch('chore/oracle-capture-sdk-probes-65e5d9c9', VALID_RIGS)).toEqual({
      rig: 'sdk-probes',
      suffix: '65e5d9c9',
    });
    expect(
      parseDivertedCaptureBranch('chore/oracle-capture-rules-storage-610da19d-2', VALID_RIGS),
    ).toEqual({
      rig: 'rules-storage',
      suffix: '610da19d-2',
    });
    expect(parseDivertedCaptureBranch('chore/oracle-capture-admin-auth-capture', VALID_RIGS)).toEqual({
      rig: 'admin-auth',
      suffix: 'capture',
    });

    expect(parseDivertedCaptureBranch('chore/oracle-capture-sdk-probes', VALID_RIGS)).toBeNull();
    expect(parseDivertedCaptureBranch('chore/oracle-capture-admin-auth', VALID_RIGS)).toBeNull();
    expect(parseDivertedCaptureBranch('chore/oracle-capture-rules-storage', VALID_RIGS)).toBeNull();
    expect(parseDivertedCaptureBranch('chore/oracle-capture-unknown-65e5d9c9', VALID_RIGS)).toBeNull();
    expect(parseDivertedCaptureBranch('chore/oracle-capture-sdk-probes-notasha', VALID_RIGS)).toBeNull();
    expect(parseDivertedCaptureBranch('feat/auth-parity', VALID_RIGS)).toBeNull();
  });
});

describe('areObservationsSupersededEquivalent', () => {
  const obsPath = 'packages/conformance/observations/auth/sample-obs.json';

  test('allows only matrixRow, rowIds, and observedAt differences while requiring identical behavior and metadata', () => {
    const staged = makeObsJson();
    const linked = makeObsJson({
      matrixRow: 'auth#50',
      rowIds: ['auth#50', 'auth#52'],
      observedAt: '2026-11-18T19:00:00.000Z',
      behavior: {
        nested: { a: 1, b: 2 },
        code: 'auth/argument-error',
        rejected: true,
      },
    });
    expect(areObservationsSupersededEquivalent(obsPath, staged, linked)).toEqual({
      equivalent: true,
      reason: 'equivalent',
    });

    expect(
      areObservationsSupersededEquivalent(
        obsPath,
        staged,
        makeObsJson({ behavior: { rejected: false } }),
      ).reason,
    ).toBe('behavior-diff');

    expect(
      areObservationsSupersededEquivalent(
        obsPath,
        staged,
        makeObsJson({ description: 'Changed description.' }),
      ).reason,
    ).toBe('description-diff');

    expect(
      areObservationsSupersededEquivalent(obsPath, staged, makeObsJson({ fbSdkVersion: '12.20.0' }))
        .reason,
    ).toBe('fbSdkVersion-diff');

    expect(
      areObservationsSupersededEquivalent(obsPath, staged, makeObsJson({ projectId: 'other-proj' }))
        .reason,
    ).toBe('projectId-diff');

    expect(
      areObservationsSupersededEquivalent(
        obsPath,
        staged,
        makeObsJson({ adminSdkVersion: '13.1.0' }),
      ).reason,
    ).toBe('envelope-diff');
  });
});

describe('reconcileSupersededDivertedCapturePrs', () => {
  test('closes and deletes branch only when every changed observation is superseded on main with identical behavior and metadata', async () => {
    const { repoDir, gitRepo, gitRemote, cleanup } = initGitPair();
    try {
      const baseMainSha = gitRepo('rev-parse', 'HEAD');

    const obsA = 'packages/conformance/observations/auth/obs-a.json';
    const obsB = 'packages/conformance/observations/auth/obs-b.json';
    const obsUnmerged = 'packages/conformance/observations/auth/obs-unmerged.json';

    // Branch 1 (#201): diverted PR whose 2 files later land on main (one byte-identical, one row-linked).
    const bSuperseded = 'chore/oracle-capture-sdk-probes-1111aaaa';
    gitRepo('checkout', '-b', bSuperseded, baseMainSha);
    writeRepoFile(repoDir, obsA, makeObsJson({ name: 'obs-a' }));
    writeRepoFile(repoDir, obsB, makeObsJson({ name: 'obs-b' }));
    gitRepo('add', obsA, obsB);
    gitRepo('commit', '-m', 'chore(conformance): capture sdk-probes oracle observations');
    const shaSuperseded = gitRepo('rev-parse', 'HEAD');

    // Canonical branch (#202): has unmerged file, must never even be touched.
    const bCanonical = 'chore/oracle-capture-sdk-probes';
    gitRepo('checkout', '-b', bCanonical, baseMainSha);
    writeRepoFile(repoDir, obsUnmerged, makeObsJson({ name: 'obs-unmerged' }));
    gitRepo('add', obsUnmerged);
    gitRepo('commit', '-m', 'chore(conformance): capture sdk-probes oracle observations');
    const shaCanonical = gitRepo('rev-parse', 'HEAD');

    // Branch 3 (#203): diverted PR with an unmerged observation file.
    const bUnmerged = 'chore/oracle-capture-sdk-probes-2222bbbb';
    gitRepo('checkout', '-b', bUnmerged, baseMainSha);
    writeRepoFile(repoDir, obsUnmerged, makeObsJson({ name: 'obs-unmerged' }));
    gitRepo('add', obsUnmerged);
    gitRepo('commit', '-m', 'chore(conformance): capture sdk-probes oracle observations');
    const shaUnmerged = gitRepo('rev-parse', 'HEAD');

    // Branch 4 (#204): diverted PR whose behavior differs from main.
    const bBehaviorDiff = 'chore/oracle-capture-sdk-probes-3333cccc';
    gitRepo('checkout', '-b', bBehaviorDiff, baseMainSha);
    writeRepoFile(
      repoDir,
      obsA,
      makeObsJson({ name: 'obs-a', behavior: { rejected: false, code: 'none' } }),
    );
    gitRepo('add', obsA);
    gitRepo('commit', '-m', 'chore(conformance): capture sdk-probes oracle observations');
    const shaBehaviorDiff = gitRepo('rev-parse', 'HEAD');

    // Branch 5 (#205): diverted PR touching a non-observation path.
    const bNonObs = 'chore/oracle-capture-sdk-probes-4444dddd';
    gitRepo('checkout', '-b', bNonObs, baseMainSha);
    writeRepoFile(repoDir, obsA, makeObsJson({ name: 'obs-a' }));
    writeRepoFile(repoDir, 'README.md', 'tampered\n');
    gitRepo('add', obsA, 'README.md');
    gitRepo('commit', '-m', 'chore(conformance): capture sdk-probes oracle observations');
    const shaNonObs = gitRepo('rev-parse', 'HEAD');

    // Branch 6 (#206): diverted PR labeled merge-queue (must not race merge-queue).
    const bQueued = 'chore/oracle-capture-sdk-probes-5555eeee';
    gitRepo('checkout', '-b', bQueued, baseMainSha);
    writeRepoFile(repoDir, obsA, makeObsJson({ name: 'obs-a' }));
    gitRepo('add', obsA);
    gitRepo('commit', '-m', 'chore(conformance): capture sdk-probes oracle observations');
    const shaQueued = gitRepo('rev-parse', 'HEAD');

    // Branch 7 (#207): diverted PR whose remote tip moved after PR list snapshot.
    const bMoved = 'chore/oracle-capture-sdk-probes-6666ffff';
    gitRepo('checkout', '-b', bMoved, baseMainSha);
    writeRepoFile(repoDir, obsA, makeObsJson({ name: 'obs-a' }));
    gitRepo('add', obsA);
    gitRepo('commit', '-m', 'chore(conformance): capture sdk-probes oracle observations');
    const staleOidMoved = gitRepo('rev-parse', 'HEAD');
    writeRepoFile(repoDir, obsB, makeObsJson({ name: 'obs-b' }));
    gitRepo('add', obsB);
    gitRepo('commit', '--amend', '--no-edit');

    // Advance main with obsA (byte-identical) and obsB (linked matrixRow/rowIds + newer observedAt).
    gitRepo('checkout', 'main');
    writeRepoFile(repoDir, obsA, makeObsJson({ name: 'obs-a' }));
    writeRepoFile(
      repoDir,
      obsB,
      makeObsJson({
        name: 'obs-b',
        matrixRow: 'auth#50',
        rowIds: ['auth#50'],
        observedAt: '2026-11-18T18:00:00.000Z',
      }),
    );
    gitRepo('add', obsA, obsB);
    gitRepo('commit', '-m', 'Merge pull request #2900 from feat/auth-linked-parity');
    gitRepo(
      'push',
      'origin',
      'main',
      bSuperseded,
      bCanonical,
      bUnmerged,
      bBehaviorDiff,
      bNonObs,
      bQueued,
      bMoved,
    );
    const advancedMainSha = gitRepo('rev-parse', 'HEAD');

    const openPrs: OpenCapturePrCandidate[] = [
      {
        number: 201,
        url: 'https://example.com/pull/201',
        title: 'chore(conformance): capture sdk-probes oracle observations',
        headRefName: bSuperseded,
        headRefOid: shaSuperseded,
        baseRefName: 'main',
        author: { login: 'app/github-actions', is_bot: true },
        labels: [],
      },
      {
        number: 202,
        url: 'https://example.com/pull/202',
        title: 'chore(conformance): capture sdk-probes oracle observations',
        headRefName: bCanonical,
        headRefOid: shaCanonical,
        baseRefName: 'main',
        author: { login: 'app/github-actions', is_bot: true },
        labels: [],
      },
      {
        number: 203,
        url: 'https://example.com/pull/203',
        title: 'chore(conformance): capture sdk-probes oracle observations',
        headRefName: bUnmerged,
        headRefOid: shaUnmerged,
        baseRefName: 'main',
        author: { login: 'app/github-actions', is_bot: true },
        labels: [],
      },
      {
        number: 204,
        url: 'https://example.com/pull/204',
        title: 'chore(conformance): capture sdk-probes oracle observations',
        headRefName: bBehaviorDiff,
        headRefOid: shaBehaviorDiff,
        baseRefName: 'main',
        author: { login: 'app/github-actions', is_bot: true },
        labels: [],
      },
      {
        number: 205,
        url: 'https://example.com/pull/205',
        title: 'chore(conformance): capture sdk-probes oracle observations',
        headRefName: bNonObs,
        headRefOid: shaNonObs,
        baseRefName: 'main',
        author: { login: 'app/github-actions', is_bot: true },
        labels: [],
      },
      {
        number: 206,
        url: 'https://example.com/pull/206',
        title: 'chore(conformance): capture sdk-probes oracle observations',
        headRefName: bQueued,
        headRefOid: shaQueued,
        baseRefName: 'main',
        author: { login: 'app/github-actions', is_bot: true },
        labels: [{ name: 'merge-queue' }],
      },
      {
        number: 207,
        url: 'https://example.com/pull/207',
        title: 'chore(conformance): capture sdk-probes oracle observations',
        headRefName: bMoved,
        headRefOid: staleOidMoved,
        baseRefName: 'main',
        author: { login: 'app/github-actions', is_bot: true },
        labels: [],
      },
    ];

    const ghCalls: string[][] = [];
    const fakeGh: Gh = (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify(openPrs);
      }
      return '{}';
    };

    const result = await reconcileSupersededDivertedCapturePrs({
      cwd: repoDir,
      repository: 'owner/repo',
      primaryGh: fakeGh,
      validRigIds: VALID_RIGS,
    });

    expect(result.mainSha).toBe(advancedMainSha);
    expect(result.outcomes.map((o) => ({ number: o.number, action: o.action, reason: o.reason }))).toEqual([
      { number: 201, action: 'closed', reason: 'superseded-on-main' },
      { number: 203, action: 'kept', reason: `unmerged-file:${obsUnmerged}` },
      { number: 204, action: 'kept', reason: `behavior-diff:${obsA}` },
      { number: 205, action: 'kept', reason: 'non-observation-path:README.md' },
      { number: 206, action: 'kept', reason: 'labeled-merge-queue' },
      { number: 207, action: 'kept', reason: 'head-oid-changed' },
    ]);

    const closedOutcome = result.outcomes[0];
    expect(closedOutcome?.branchDeleted).toBe(true);
    expect(closedOutcome?.comment).toContain(advancedMainSha.slice(0, 10));
    expect(closedOutcome?.comment).toContain('#2900');

    // Only #201 received comment + close API calls.
    const mutationCalls = ghCalls.filter((c) => c[0] === 'api');
    expect(mutationCalls.length).toBe(2);
    expect(mutationCalls[0]).toContain('repos/owner/repo/issues/201/comments');
    expect(mutationCalls[1]).toContain('repos/owner/repo/pulls/201');

    // Remote branch for #201 is deleted; canonical (#202) and kept branches remain intact on origin.
    const remoteBranches = gitRemote('for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n');
    expect(remoteBranches).not.toContain(bSuperseded);
    expect(remoteBranches).toContain(bCanonical);
    expect(remoteBranches).toContain(bUnmerged);
    expect(remoteBranches).toContain(bBehaviorDiff);
    expect(remoteBranches).toContain(bNonObs);
    expect(remoteBranches).toContain(bQueued);
    expect(remoteBranches).toContain(bMoved);

    const summary = formatReconciledDivertedSummary(result.mainSha, result.outcomes);
    expect(summary).toContain('#201');
    expect(summary).toContain('closed as superseded (remote branch deleted)');
    expect(summary).toContain('#203');
    } finally {
      cleanup();
    }
  }, 30_000);

  test('oracle-capture.yml wires reconcile-diverted-prs without GCP credentials and build.yml runs this test', () => {
    const captureRaw = readFileSync(resolve(ROOT, '.github/workflows/oracle-capture.yml'), 'utf8');
    const wf = Bun.YAML.parse(captureRaw) as {
      jobs: Record<
        string,
        {
          needs?: string[];
          if?: string;
          permissions?: Record<string, string>;
          steps?: Array<{ uses?: string; run?: string; env?: Record<string, string> }>;
        }
      >;
    };
    const reconcileJob = wf.jobs['reconcile-diverted-prs'];
    expect(reconcileJob).toBeDefined();
    expect(reconcileJob?.needs).toEqual(['capture', 'open-pr']);
    expect(reconcileJob?.if).toContain('always()');
    expect(reconcileJob?.if).toContain("github.ref == 'refs/heads/main'");
    expect(reconcileJob?.if).toContain("github.event_name != 'pull_request'");
    expect(reconcileJob?.permissions).toEqual({
      contents: 'write',
      'pull-requests': 'write',
    });
    expect(reconcileJob?.steps?.some((s) => s.uses?.startsWith('google-github-actions/auth'))).toBe(
      false,
    );
    const runStep = reconcileJob?.steps?.find((s) =>
      s.run?.includes('oracle-capture-pr.ts reconcile-diverted'),
    );
    expect(runStep).toBeDefined();
    expect(runStep?.env?.PYRIC_ORACLE_FIREBASE_CONFIG).toBeUndefined();

    const buildRaw = readFileSync(resolve(ROOT, '.github/workflows/build.yml'), 'utf8');
    expect(buildRaw).toContain('scripts/ci/oracle-capture-reconcile-diverted.test.ts');
  });
});
