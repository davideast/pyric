import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertStagedPathsAreObservationsOnly,
  createOrUpdatePullRequestWithFallback,
  formatPullRequestOutcomesSummary,
  formatShortCaptureSha,
  hasCapturePullRequestActivity,
  resolveCaptureTargetBranch,
} from './oracle-capture-open-pr.ts';

const ROOT = resolve(import.meta.dir, '../..');

function initRepoWithRemoteBranch(): {
  repoDir: string;
  remoteDir: string;
  branch: string;
  initialHeadSha: string;
  cleanup: () => void;
} {
  const base = mkdtempSync(join(tmpdir(), 'oracle-open-pr-fallback-'));
  const remoteDir = join(base, 'remote.git');
  const repoDir = join(base, 'work');
  const branch = 'chore/oracle-capture-rules-firestore';
  mkdirSync(remoteDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  execFileSync('git', ['init', '--bare', '--initial-branch=main', remoteDir]);
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'bot@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
  execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: repoDir });

  writeFileSync(join(repoDir, 'README.md'), 'baseline\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoDir });

  execFileSync('git', ['checkout', '-B', branch, 'origin/main'], { cwd: repoDir });
  writeFileSync(join(repoDir, 'obs.json'), '{"ok":true}\n');
  execFileSync('git', ['add', 'obs.json'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'chore(conformance): capture rules-firestore oracle observations'], {
    cwd: repoDir,
  });
  execFileSync('git', ['push', '--force', 'origin', `HEAD:refs/heads/${branch}`], { cwd: repoDir });
  const initialHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf8',
  }).trim();

  return {
    repoDir,
    remoteDir,
    branch,
    initialHeadSha,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

describe('oracle-capture-open-pr PAT fallback and CI synchronize push', () => {
  test('falls back to github.token when PAT lacks createPullRequest and re-pushes amended SHA with PAT to fire synchronize', () => {
    const { repoDir, remoteDir, branch, initialHeadSha, cleanup } = initRepoWithRemoteBranch();
    const bodyFile = join(repoDir, 'pr-body.md');
    writeFileSync(bodyFile, 'PR body\n');

    try {
      const patCalls: string[][] = [];
      const fallbackCalls: string[][] = [];

      const outcome = createOrUpdatePullRequestWithFallback({
        cwd: repoDir,
        target: {
          repository: 'davideast/pyric',
          rig: 'rules-firestore',
          branch,
          title: 'chore(conformance): capture rules-firestore oracle observations',
          bodyFile,
        },
        auth: {
          primaryGh: (args) => {
            patCalls.push(args);
            if (args[0] === 'pr' && args[1] === 'list') return '[]';
            throw new Error(
              'gh pr create failed: GraphQL: Resource not accessible by personal access token (createPullRequest)',
            );
          },
          fallbackGh: (args) => {
            fallbackCalls.push(args);
            if (args[0] === 'pr' && args[1] === 'list') return '[]';
            if (args[0] === 'pr' && args[1] === 'create') {
              return 'https://github.com/davideast/pyric/pull/2673\n';
            }
            return '';
          },
          hasPatPushAuth: true,
        },
      });

      expect(outcome).toEqual({
        rig: 'rules-firestore',
        branch,
        action: 'created',
        prUrl: 'https://github.com/davideast/pyric/pull/2673',
        authMode: 'github-token-with-pat-synchronize',
      });
      expect(patCalls.some((c) => c[0] === 'pr' && c[1] === 'create')).toBe(true);
      expect(fallbackCalls.some((c) => c[0] === 'pr' && c[1] === 'create')).toBe(true);

      const newRemoteSha = execFileSync(
        'git',
        ['--git-dir', remoteDir, 'rev-parse', `refs/heads/${branch}`],
        { encoding: 'utf8' },
      ).trim();
      expect(newRemoteSha).not.toBe(initialHeadSha);

      const initialTree = execFileSync('git', ['rev-parse', `${initialHeadSha}^{tree}`], {
        cwd: repoDir,
        encoding: 'utf8',
      }).trim();
      const newTree = execFileSync('git', ['rev-parse', `${newRemoteSha}^{tree}`], {
        cwd: repoDir,
        encoding: 'utf8',
      }).trim();
      expect(newTree).toBe(initialTree);

      const summary = formatPullRequestOutcomesSummary([outcome]);
      expect(summary).toContain('github.token fallback + PAT synchronize push');
      expect(summary).toContain('https://github.com/davideast/pyric/pull/2673');
    } finally {
      cleanup();
    }
  }, 20_000);

  test('skips duplicate synchronize push when fallback edits an already-open PR', () => {
    const { repoDir, remoteDir, branch, initialHeadSha, cleanup } = initRepoWithRemoteBranch();
    const bodyFile = join(repoDir, 'pr-body.md');
    writeFileSync(bodyFile, 'Updated PR body\n');

    try {
      const outcome = createOrUpdatePullRequestWithFallback({
        cwd: repoDir,
        target: {
          repository: 'davideast/pyric',
          rig: 'rules-firestore',
          branch,
          title: 'chore(conformance): capture rules-firestore oracle observations',
          bodyFile,
        },
        auth: {
          primaryGh: (args) => {
            if (args[0] === 'pr' && args[1] === 'list') {
              return JSON.stringify([{ number: 2673, url: 'https://github.com/davideast/pyric/pull/2673' }]);
            }
            throw new Error('gh pr edit failed: Resource not accessible by personal access token');
          },
          fallbackGh: (args) => {
            if (args[0] === 'pr' && args[1] === 'list') {
              return JSON.stringify([{ number: 2673, url: 'https://github.com/davideast/pyric/pull/2673' }]);
            }
            return '';
          },
          hasPatPushAuth: true,
        },
      });

      expect(outcome).toEqual({
        rig: 'rules-firestore',
        branch,
        action: 'updated',
        prUrl: 'https://github.com/davideast/pyric/pull/2673',
        authMode: 'pat',
      });
      const remoteSha = execFileSync(
        'git',
        ['--git-dir', remoteDir, 'rev-parse', `refs/heads/${branch}`],
        { encoding: 'utf8' },
      ).trim();
      expect(remoteSha).toBe(initialHeadSha);
    } finally {
      cleanup();
    }
  }, 20_000);

  test('uses PAT directly without amending when PAT succeeds on pr create', () => {
    const { repoDir, remoteDir, branch, initialHeadSha, cleanup } = initRepoWithRemoteBranch();
    const bodyFile = join(repoDir, 'pr-body.md');
    writeFileSync(bodyFile, 'PR body\n');

    try {
      let fallbackUsed = false;
      const outcome = createOrUpdatePullRequestWithFallback({
        cwd: repoDir,
        target: {
          repository: 'davideast/pyric',
          rig: 'rules-firestore',
          branch,
          title: 'chore(conformance): capture rules-firestore oracle observations',
          bodyFile,
        },
        auth: {
          primaryGh: (args) => {
            if (args[0] === 'pr' && args[1] === 'list') return '[]';
            return 'https://github.com/davideast/pyric/pull/2674\n';
          },
          fallbackGh: () => {
            fallbackUsed = true;
            return '';
          },
          hasPatPushAuth: true,
        },
      });

      expect(fallbackUsed).toBe(false);
      expect(outcome.authMode).toBe('pat');
      const remoteSha = execFileSync(
        'git',
        ['--git-dir', remoteDir, 'rev-parse', `refs/heads/${branch}`],
        { encoding: 'utf8' },
      ).trim();
      expect(remoteSha).toBe(initialHeadSha);
    } finally {
      cleanup();
    }
  }, 20_000);

  test('oracle-capture.yml isolates per-rig concurrency and separate parity vs capture WIF identities', () => {
    const raw = readFileSync(resolve(ROOT, '.github/workflows/oracle-capture.yml'), 'utf8');
    const wf = Bun.YAML.parse(raw) as {
      concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
      jobs: Record<string, { steps?: Array<{ id?: string; env?: Record<string, string>; run?: string }> }>;
    };

    expect(wf.concurrency?.group).toContain('inputs.rig');
    expect(wf.concurrency?.['cancel-in-progress']).toBe(false);

    const captureSteps = wf.jobs.capture?.steps ?? [];
    const planStep = captureSteps.find((s) => s.id === 'plan');
    expect(planStep?.env?.GCP_WIF_PROVIDER).toContain('vars.GCP_WIF_PROVIDER');
    expect(planStep?.env?.PARITY_SA_EMAIL).toContain('vars.PARITY_SA_EMAIL');
    expect(planStep?.env?.CAPTURE_WIF_PROVIDER).toContain('vars.CAPTURE_WIF_PROVIDER');
    expect(planStep?.env?.CAPTURE_SA_EMAIL).toContain('vars.CAPTURE_SA_EMAIL');

    const openPrSteps = wf.jobs['open-pr']?.steps ?? [];
    const prStep = openPrSteps.find((s) => s.run?.includes('oracle-capture-pr.ts open-pr'));
    expect(prStep?.env?.PAT_TOKEN).toContain('secrets.MERGE_QUEUE_TOKEN');
    expect(prStep?.env?.GITHUB_TOKEN).toContain('github.token');
  });

  test('detects merge-queue and review activity, allocates fresh branches on collision, and enforces observations-only staging', () => {
    expect(hasCapturePullRequestActivity({ number: 1, url: 'https://example.com/1' })).toBe(false);
    expect(
      hasCapturePullRequestActivity({
        number: 1,
        url: 'https://example.com/1',
        labels: [{ name: 'documentation' }],
        reviews: [],
        reviewRequests: [],
        reviewDecision: '',
        comments: [],
      }),
    ).toBe(false);
    expect(
      hasCapturePullRequestActivity({
        number: 1,
        url: 'https://example.com/1',
        labels: [{ name: 'merge-queue' }],
      }),
    ).toBe(true);
    expect(
      hasCapturePullRequestActivity({
        number: 1,
        url: 'https://example.com/1',
        reviews: [{ state: 'COMMENTED' }],
      }),
    ).toBe(true);
    expect(
      hasCapturePullRequestActivity({
        number: 1,
        url: 'https://example.com/1',
        reviewRequests: [{ login: 'reviewer' }],
      }),
    ).toBe(true);
    expect(
      hasCapturePullRequestActivity({
        number: 1,
        url: 'https://example.com/1',
        reviewDecision: 'REVIEW_REQUIRED',
      }),
    ).toBe(true);
    expect(
      hasCapturePullRequestActivity({
        number: 1,
        url: 'https://example.com/1',
        comments: [{ body: '<!-- advisor-verdict: spec=MERGE -->' }],
      }),
    ).toBe(true);

    expect(formatShortCaptureSha('642C609A7545D22231843D24370AFC124738742D')).toBe('642c609a');
    expect(formatShortCaptureSha('not-hex-!@#')).toBe('nothex');

    // Diverts past both canonical (under review) and first -<shortsha> (labeled merge-queue) to -<shortsha>-2 via fallbackGh.
    const resolved = resolveCaptureTargetBranch({
      repository: 'davideast/pyric',
      rig: 'sdk-probes',
      sourceSha: '642c609a7545d22231843d24370afc124738742d',
      auth: {
        primaryGh: () => {
          throw new Error('PAT lacks read pull-requests');
        },
        fallbackGh: (args) => {
          const headIdx = args.indexOf('--head');
          let head = '';
          if (headIdx >= 0) head = args[headIdx + 1] ?? '';
          if (head === 'chore/oracle-capture-sdk-probes') {
            return JSON.stringify([{ number: 10, url: 'https://example.com/10', comments: [{ id: 1 }] }]);
          }
          if (head === 'chore/oracle-capture-sdk-probes-642c609a') {
            return JSON.stringify([{ number: 11, url: 'https://example.com/11', labels: [{ name: 'merge-queue' }] }]);
          }
          return '[]';
        },
        hasPatPushAuth: true,
      },
    });
    expect(resolved).toEqual({
      branch: 'chore/oracle-capture-sdk-probes-642c609a-2',
      divertedFromBranch: 'chore/oracle-capture-sdk-probes',
    });

    const { repoDir, cleanup } = initRepoWithRemoteBranch();
    try {
      execFileSync('git', ['checkout', '-B', 'test-stage', 'origin/main'], { cwd: repoDir });
      expect(() => assertStagedPathsAreObservationsOnly(repoDir)).toThrow(/empty staged diff/);

      writeFileSync(join(repoDir, 'README.md'), 'tampered\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
      expect(() => assertStagedPathsAreObservationsOnly(repoDir)).toThrow(/outside packages\/conformance\/observations/);
    } finally {
      cleanup();
    }
  });
});
