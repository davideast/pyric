import { describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { diagnoseCaptureFailure, planCaptureRun } from './oracle-capture-plan.ts';
import {
  buildCapturePullRequestBody,
  verifyAndOpenCapturePullRequests,
  type CaptureBundleManifest,
} from './oracle-capture-pr.ts';
import { collectTimestampCleanObservations } from './oracle-observation-diff.ts';

const ROOT = resolve(import.meta.dir, '../..');

interface WorkflowStep {
  id?: string; name?: string; if?: string; uses?: string; run?: string;
  env?: Record<string, string>; with?: Record<string, unknown>;
}
interface WorkflowJob {
  if?: string; needs?: string[] | string; permissions?: Record<string, string>;
  outputs?: Record<string, string>; steps?: WorkflowStep[];
}
interface ParsedWorkflow {
  on: {
    push?: { branches?: string[]; paths?: string[] };
    workflow_dispatch?: { inputs?: Record<string, { required?: boolean; type?: string }> };
    pull_request?: unknown;
  };
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

function loadCaptureWorkflow(): ParsedWorkflow {
  const source = readFileSync(resolve(ROOT, '.github/workflows/oracle-capture.yml'), 'utf8');
  return Bun.YAML.parse(source) as ParsedWorkflow;
}

function initTempGitRepo(): { repoDir: string; remoteDir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'oracle-capture-test-'));
  const remoteDir = join(base, 'remote.git');
  const repoDir = join(base, 'work');
  mkdirSync(remoteDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  execFileSync('git', ['init', '--bare', '--initial-branch=main', remoteDir]);
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test Bot'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'bot@example.com'], { cwd: repoDir });
  execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: repoDir });

  const existingObs = join(
    repoDir,
    'packages/conformance/observations/firestore-rules/rules-firestore-existing.json',
  );
  mkdirSync(dirname(existingObs), { recursive: true });
  writeFileSync(
    existingObs,
    `${JSON.stringify(
      {
        name: 'rules-firestore-existing',
        matrixRow: 'firestore-rules#1',
        rowIds: ['firestore-rules#1'],
        description: 'Existing committed observation.',
        observedAt: '2026-10-01T00:00:00.000Z',
        fbSdkVersion: '12.19.0',
        behavior: { 'allow get': 'ALLOW' },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(repoDir, 'README.md'), 'baseline\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoDir });

  return {
    repoDir,
    remoteDir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

describe('oracle-capture.yml security and trigger contract', () => {
  test('triggers only on main push paths and workflow_dispatch, never on pull_request', () => {
    const wf = loadCaptureWorkflow();
    expect(wf.on.pull_request).toBeUndefined();
    expect(Object.keys(wf.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(wf.on.push?.branches).toEqual(['main']);
    expect(wf.on.push?.paths).toEqual([
      'packages/conformance/probes/**',
      'packages/conformance/rules-corpus/**',
      'packages/conformance/rigs/**',
      'packages/conformance/src/*probe*.ts',
    ]);
    expect(wf.on.workflow_dispatch?.inputs?.rig?.required).toBe(true);
    expect(wf.on.workflow_dispatch?.inputs?.rig?.type).toBe('string');
    expect(wf.on.workflow_dispatch?.inputs?.filter?.required).toBe(false);
    expect(wf.on.workflow_dispatch?.inputs?.filter?.type).toBe('string');
  });

  test('isolates WIF credentials in capture job and PR write permissions in open-pr job', () => {
    const wf = loadCaptureWorkflow();
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(wf.jobs)).toEqual(['capture', 'open-pr']);

    const captureJob = wf.jobs.capture;
    const openPrJob = wf.jobs['open-pr'];
    expect(captureJob?.if).toContain("github.ref == 'refs/heads/main'");
    expect(captureJob?.if).toContain("github.event_name != 'pull_request'");
    expect(captureJob?.permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
    });
    expect(captureJob?.steps?.some((s) => s.uses?.startsWith('google-github-actions/auth@v2'))).toBe(
      true,
    );

    expect(openPrJob?.if).toContain("github.ref == 'refs/heads/main'");
    expect(openPrJob?.if).toContain("needs.capture.outputs.has_captures == 'true'");
    expect(openPrJob?.permissions).toEqual({
      contents: 'write',
      'pull-requests': 'write',
    });
    expect(openPrJob?.steps?.some((s) => s.uses?.startsWith('google-github-actions/auth'))).toBe(
      false,
    );

    const checkout = openPrJob?.steps?.find((s) => s.uses?.startsWith('actions/checkout@v4'));
    expect(String(checkout?.with?.token ?? '')).toContain('secrets.MERGE_QUEUE_TOKEN');
    expect(String(checkout?.with?.token ?? '')).toContain('secrets.MERQUE_QUEUE_TOKEN');

    const prStep = openPrJob?.steps?.find((s) => s.run?.includes('oracle-capture-pr.ts open-pr'));
    expect(prStep?.env?.GH_TOKEN).toContain('secrets.MERGE_QUEUE_TOKEN');
    expect(prStep?.env?.GH_TOKEN).toContain('secrets.MERQUE_QUEUE_TOKEN');
    expect(prStep?.env?.PYRIC_ORACLE_FIREBASE_CONFIG).toBeUndefined();
  });
});

describe('planCaptureRun', () => {
  const validEnv = {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GCP_WIF_PROVIDER: 'projects/123/locations/global/workloadIdentityPools/pool/providers/gh',
    PARITY_SA_EMAIL: 'parity-test-sa@digame-mas.iam.gserviceaccount.com',
    CAPTURE_WIF_PROVIDER: 'projects/123/locations/global/workloadIdentityPools/pool/providers/capture',
    CAPTURE_SA_EMAIL: 'capture-sa@example.iam.gserviceaccount.com',
  };

  test('refuses non-main refs and pull_request events', async () => {
    await expect(
      planCaptureRun({ ...validEnv, GITHUB_REF: 'refs/heads/feat/branch', INPUT_RIG: 'admin-app' }),
    ).rejects.toThrow(/refs\/heads\/main/);
    await expect(
      planCaptureRun({ ...validEnv, GITHUB_EVENT_NAME: 'pull_request', INPUT_RIG: 'admin-app' }),
    ).rejects.toThrow(/pull_request/);
  });

  test('rejects unknown rigs, human-witnessed rigs, and live-mutating rigs cleanly', async () => {
    await expect(
      planCaptureRun({ ...validEnv, INPUT_RIG: 'nonexistent-rig' }),
    ).rejects.toThrow(/Unknown oracle rig/);
    await expect(
      planCaptureRun({ ...validEnv, INPUT_RIG: 'messaging-web' }),
    ).rejects.toThrow(/human-witnessed/);
    await expect(
      planCaptureRun({ ...validEnv, INPUT_RIG: 'rtdb-rules' }),
    ).rejects.toThrow(/mutates live project rules|excluded/i);
    await expect(
      planCaptureRun({ ...validEnv, INPUT_RIG: 'storage-stdlib-real' }),
    ).rejects.toThrow(/unattendedSafe/);
  });

  test('plans workflow_dispatch for unattended and WIF rigs with filter mapping', async () => {
    const rulesPlan = await planCaptureRun({
      ...validEnv,
      INPUT_RIG: 'rules-firestore',
      INPUT_FILTER: 'path-bind-forms',
    });
    expect(rulesPlan.shouldRun).toBe(true);
    expect(rulesPlan.needsWif).toBe(true);
    expect(rulesPlan.invocations).toEqual([
      {
        rig: 'rules-firestore',
        script: 'packages/conformance/src/run-rules.ts',
        args: ['--write', '--scenario', 'path-bind-forms'],
        wifTier: 'parity-readonly',
      },
    ]);

    const unattendedPlan = await planCaptureRun({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      INPUT_RIG: 'client-storage',
    });
    expect(unattendedPlan.shouldRun).toBe(true);
    expect(unattendedPlan.needsWif).toBe(false);
    expect(unattendedPlan.invocations).toEqual([
      {
        rig: 'client-storage',
        script: 'packages/conformance/src/client-storage-probes.ts',
        args: ['--write'],
        wifTier: 'none',
      },
    ]);
  });

  test('fails closed with actionable WIF diagnostic when a credentialed rig lacks WIF vars', async () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        planCaptureRun({
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          GITHUB_REF: 'refs/heads/main',
          INPUT_RIG: 'rules-firestore',
        }),
      ).rejects.toThrow(/GCP_WIF_PROVIDER/);
    } finally {
      errSpy.mockRestore();
    }
  });

  test('auto-detects uncaptured staged probes on push to main and skips when none exist', async () => {
    const emptyPlan = await planCaptureRun(
      {
        ...validEnv,
        GITHUB_EVENT_NAME: 'push',
      },
      { stagedTargets: [], pendingPrefixRigs: [] },
    );
    expect(emptyPlan.shouldRun).toBe(false);
    expect(emptyPlan.invocations).toEqual([]);

    const pushPlan = await planCaptureRun(
      {
        ...validEnv,
        GITHUB_EVENT_NAME: 'push',
      },
      {
        stagedTargets: [
          {
            rig: 'rules-firestore',
            observationName: 'rules-firestore-path-bind-forms',
            filterFlag: '--scenario',
            filterValue: 'path-bind-forms',
          },
          {
            rig: 'messaging-send',
            observationName: 'messaging-send-webpush-lowercase-ttl',
            filterFlag: '--probe',
            filterValue: 'messaging-send-webpush-lowercase-ttl',
          },
        ],
        pendingPrefixRigs: [],
      },
    );
    expect(pushPlan.shouldRun).toBe(true);
    expect(pushPlan.needsWif).toBe(true);
    expect(pushPlan.invocations).toEqual([
      {
        rig: 'messaging-send',
        script: 'packages/conformance/src/messaging-send-probes.ts',
        args: ['--write', '--probe', 'messaging-send-webpush-lowercase-ttl'],
        wifTier: 'capture-write',
      },
      {
        rig: 'rules-firestore',
        script: 'packages/conformance/src/run-rules.ts',
        args: ['--write', '--scenario', 'path-bind-forms'],
        wifTier: 'parity-readonly',
      },
    ]);
  });
});

describe('diagnoseCaptureFailure', () => {
  test('formats crystal-clear IAM / signBlob / missing secret guidance naming parity-test-sa@digame-mas.iam.gserviceaccount.com', () => {
    const fcmDenied = diagnoseCaptureFailure(
      'messaging-send',
      'HTTP 403 PERMISSION_DENIED: Permission cloudmessaging.messages.create denied',
      {},
    );
    expect(fcmDenied).toContain('parity-test-sa@digame-mas.iam.gserviceaccount.com');
    expect(fcmDenied).toContain('cloudmessaging.messages.create');
    expect(fcmDenied).toContain('Action:');

    const signBlob = diagnoseCaptureFailure(
      'admin-firestore',
      'IAM Credentials signBlob failed: 403 Permission iam.serviceAccounts.signBlob denied',
      {},
    );
    expect(signBlob).toContain('parity-test-sa@digame-mas.iam.gserviceaccount.com');
    expect(signBlob).toContain('roles/iam.serviceAccountTokenCreator');
    expect(signBlob).toContain('iam.serviceAccounts.signBlob');

    const missingConfig = diagnoseCaptureFailure(
      'oracle-run',
      'Error: PYRIC_ORACLE_FIREBASE_CONFIG is not set',
      {},
    );
    expect(missingConfig).toContain('PYRIC_ORACLE_FIREBASE_CONFIG');
    expect(missingConfig).toContain('Action:');
  });
});

describe('collectTimestampCleanObservations', () => {
  test('reverts observedAt-only changes and collects genuine new or modified observations', () => {
    const { repoDir, cleanup } = initTempGitRepo();
    const bundleDir = mkdtempSync(join(tmpdir(), 'oracle-bundle-out-'));
    try {
      // Rewrite existing file with ONLY a newer observedAt timestamp.
      const existingObs = join(
        repoDir,
        'packages/conformance/observations/firestore-rules/rules-firestore-existing.json',
      );
      writeFileSync(
        existingObs,
        `${JSON.stringify(
          {
            name: 'rules-firestore-existing',
            matrixRow: 'firestore-rules#1',
            rowIds: ['firestore-rules#1'],
            description: 'Existing committed observation.',
            observedAt: '2026-11-16T23:59:59.000Z',
            fbSdkVersion: '12.19.0',
            behavior: { 'allow get': 'ALLOW' },
          },
          null,
          2,
        )}\n`,
      );

      // Write one genuine new observation file.
      const newObs = join(
        repoDir,
        'packages/conformance/observations/firestore-rules/rules-firestore-path-bind-forms.json',
      );
      writeFileSync(
        newObs,
        `${JSON.stringify(
          {
            name: 'rules-firestore-path-bind-forms',
            matrixRow: '',
            rowIds: [],
            description: 'New staged observation.',
            observedAt: '2026-11-16T23:59:59.000Z',
            fbSdkVersion: '12.19.0',
            behavior: { "path('/a/{x}').bind({'x': '1'})": 'ALLOW' },
          },
          null,
          2,
        )}\n`,
      );

      const collected = collectTimestampCleanObservations(repoDir, bundleDir);
      expect(collected).toEqual([
        {
          path: 'packages/conformance/observations/firestore-rules/rules-firestore-path-bind-forms.json',
          kind: 'added',
        },
      ]);
      // Existing timestamp-only file was reverted to HEAD.
      const statusExisting = execFileSync(
        'git',
        ['status', '--porcelain', '--', 'packages/conformance/observations/firestore-rules/rules-firestore-existing.json'],
        { cwd: repoDir, encoding: 'utf8' },
      );
      expect(statusExisting.trim()).toBe('');
      expect(
        existsSync(
          join(
            bundleDir,
            'packages/conformance/observations/firestore-rules/rules-firestore-path-bind-forms.json',
          ),
        ),
      ).toBe(true);
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
      cleanup();
    }
  }, 20_000);

  test('fails closed when any file outside packages/conformance/observations/** is modified or created', () => {
    const { repoDir, cleanup } = initTempGitRepo();
    const bundleDir = mkdtempSync(join(tmpdir(), 'oracle-bundle-bad-'));
    try {
      writeFileSync(join(repoDir, 'README.md'), 'tampered\n');
      expect(() => collectTimestampCleanObservations(repoDir, bundleDir)).toThrow(
        /outside packages\/conformance\/observations/,
      );
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
      cleanup();
    }
  }, 20_000);
});

describe('verifyAndOpenCapturePullRequests', () => {
  function writeObs(filePath: string, name: string, observedAt: string, behavior: Record<string, unknown>): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      `${JSON.stringify({ name, matrixRow: '', rowIds: [], description: 'Staged capture.', observedAt, fbSdkVersion: '12.19.0', behavior }, null, 2)}\n`,
    );
  }

  test('rejects symlinks and path traversal entries in the downloaded bundle', async () => {
    const { repoDir, cleanup } = initTempGitRepo();
    const symDir = mkdtempSync(join(tmpdir(), 'oracle-bad-artifact-'));
    const travDir = mkdtempSync(join(tmpdir(), 'oracle-traversal-artifact-'));
    try {
      const obsRel = 'packages/conformance/observations/firestore-rules/rules-firestore-evil.json';
      writeFileSync(
        join(symDir, 'manifest.json'),
        JSON.stringify({ sourceSha: 'deadbeef', rigs: [{ rig: 'rules-firestore', files: [{ path: obsRel, kind: 'added' }] }] }),
      );
      const obsDir = join(symDir, 'rigs/rules-firestore/packages/conformance/observations/firestore-rules');
      mkdirSync(obsDir, { recursive: true });
      symlinkSync(join(repoDir, 'README.md'), join(obsDir, 'rules-firestore-evil.json'));
      await expect(
        verifyAndOpenCapturePullRequests({ cwd: repoDir, artifactDir: symDir, repository: 'davideast/pyric', gh: () => '[]' }),
      ).rejects.toThrow(/symlink/i);

      writeFileSync(
        join(travDir, 'manifest.json'),
        JSON.stringify({
          sourceSha: 'deadbeef',
          rigs: [{ rig: 'rules-firestore', files: [{ path: 'packages/conformance/observations/firestore-rules/../../../evil.json', kind: 'added' }] }],
        }),
      );
      await expect(
        verifyAndOpenCapturePullRequests({ cwd: repoDir, artifactDir: travDir, repository: 'davideast/pyric', gh: () => '[]' }),
      ).rejects.toThrow(/Unsafe observation path rejected/);
    } finally {
      rmSync(symDir, { recursive: true, force: true });
      rmSync(travDir, { recursive: true, force: true });
      cleanup();
    }
  }, 20_000);

  test('omits project id in PR body and commit message, updates idle PR in place, and diverts when under review or merge-queue', async () => {
    const { repoDir, remoteDir, cleanup } = initTempGitRepo();
    const artifactDir = mkdtempSync(join(tmpdir(), 'oracle-good-artifact-'));
    const gitRemote = (...args: string[]): string =>
      execFileSync('git', ['--git-dir', remoteDir, ...args], { encoding: 'utf8' }).trim();
    try {
      const obsRel = 'packages/conformance/observations/firestore-rules/rules-firestore-path-bind-forms.json';
      writeFileSync(
        join(artifactDir, 'manifest.json'),
        JSON.stringify({
          sourceSha: 'abc123456789',
          runUrl: 'https://github.com/davideast/pyric/actions/runs/42',
          rigs: [{ rig: 'rules-firestore', filter: 'path-bind-forms', files: [{ path: obsRel, kind: 'added' }] }],
        }),
      );
      writeObs(join(artifactDir, 'rigs/rules-firestore', obsRel), 'rules-firestore-path-bind-forms', '2026-11-16T12:00:00.000Z', { caseA: 'ALLOW' });

      const ghCalls: Array<{ args: string[]; body?: string }> = [];
      const outcomes = await verifyAndOpenCapturePullRequests({
        cwd: repoDir,
        artifactDir,
        repository: 'davideast/pyric',
        gh: (args) => {
          const bodyIdx = args.indexOf('--body-file');
          let body: string | undefined;
          if (bodyIdx >= 0) {
            const bodyPath = args[bodyIdx + 1];
            if (bodyPath) body = readFileSync(bodyPath, 'utf8');
          }
          ghCalls.push({ args, body });
          if (args[0] === 'pr' && args[1] === 'list') return '[]';
          if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/davideast/pyric/pull/999\n';
          return '';
        },
      });
      expect(outcomes).toEqual([{
        rig: 'rules-firestore',
        branch: 'chore/oracle-capture-rules-firestore',
        action: 'created',
        prUrl: 'https://github.com/davideast/pyric/pull/999',
        authMode: 'pat',
      }]);

      const canonicalSha1 = gitRemote('rev-parse', 'refs/heads/chore/oracle-capture-rules-firestore');
      const commitMessage = gitRemote('log', '-1', '--format=%B', canonicalSha1);
      expect(commitMessage).toBe('chore(conformance): capture rules-firestore oracle observations');
      expect(commitMessage).not.toContain('digame-mas');

      const prBody = ghCalls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create')?.body ?? '';
      expect(prBody).toContain('against the oracle project.');
      expect(prBody).not.toContain('digame-mas');
      expect(prBody).toContain('## Risk');
      expect(prBody).toContain('<details>');
      expect(prBody).toContain('test/apps/');
      expect([...prBody].every((ch) => (ch.codePointAt(0) ?? 0) <= 127)).toBe(true);

      const directBody = buildCapturePullRequestBody({ rig: 'rules-firestore', files: [{ path: obsRel, kind: 'added' }], sourceSha: 'abc123456789' });
      expect(directBody).toContain('against the oracle project.');
      expect(directBody).not.toContain('digame-mas');

      // Idle open PR (no merge-queue label, no review activity) updates in place.
      const editCalls: string[][] = [];
      const updatedOutcomes = await verifyAndOpenCapturePullRequests({
        cwd: repoDir,
        artifactDir,
        repository: 'davideast/pyric',
        gh: (args) => {
          editCalls.push(args);
          if (args[0] === 'pr' && args[1] === 'list') {
            return JSON.stringify([{ number: 999, url: 'https://github.com/davideast/pyric/pull/999', labels: [], reviews: [], reviewRequests: [], reviewDecision: '', comments: [] }]);
          }
          return '';
        },
      });
      expect(updatedOutcomes[0]?.action).toBe('updated');
      expect(updatedOutcomes[0]?.branch).toBe('chore/oracle-capture-rules-firestore');
      expect(editCalls.some((args) => args[0] === 'pr' && args[1] === 'edit' && args[2] === '999')).toBe(true);
      const protectedSha = gitRemote('rev-parse', 'refs/heads/chore/oracle-capture-rules-firestore');

      // Busy open PR (merge-queue or review activity) diverts to chore/oracle-capture-<rig>-<shortsha> without force-pushing canonical.
      const secondRel = 'packages/conformance/observations/firestore-rules/rules-firestore-second-probe.json';
      writeFileSync(
        join(artifactDir, 'manifest.json'),
        JSON.stringify({ sourceSha: 'deadbeef9876543210', rigs: [{ rig: 'rules-firestore', files: [{ path: obsRel, kind: 'added' }, { path: secondRel, kind: 'added' }] }] }),
      );
      writeObs(join(artifactDir, 'rigs/rules-firestore', obsRel), 'rules-firestore-path-bind-forms', '2026-11-18T06:00:00.000Z', { caseA: 'ALLOW' });
      writeObs(join(artifactDir, 'rigs/rules-firestore', secondRel), 'rules-firestore-second-probe', '2026-11-18T06:00:00.000Z', { caseB: 'DENY' });

      const divertedCalls: string[][] = [];
      const divertedOutcomes = await verifyAndOpenCapturePullRequests({
        cwd: repoDir,
        artifactDir,
        repository: 'davideast/pyric',
        gh: (args) => {
          divertedCalls.push(args);
          if (args[0] === 'pr' && args[1] === 'list') {
            const headIdx = args.indexOf('--head');
            let head = '';
            if (headIdx >= 0) head = args[headIdx + 1] ?? '';
            if (head === 'chore/oracle-capture-rules-firestore') {
              return JSON.stringify([{ number: 999, url: 'https://github.com/davideast/pyric/pull/999', labels: [{ name: 'merge-queue' }] }]);
            }
            return '[]';
          }
          if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/davideast/pyric/pull/1000\n';
          return '';
        },
      });
      expect(divertedOutcomes[0]?.branch).toBe('chore/oracle-capture-rules-firestore-deadbeef');
      expect(divertedOutcomes[0]?.action).toBe('created');
      expect(gitRemote('rev-parse', 'refs/heads/chore/oracle-capture-rules-firestore')).toBe(protectedSha);
      expect(divertedCalls.some((args) => args[0] === 'pr' && args[1] === 'edit')).toBe(false);
      expect(gitRemote('diff', '--name-only', 'refs/heads/main..refs/heads/chore/oracle-capture-rules-firestore-deadbeef').split('\n')).toEqual([obsRel, secondRel]);
      expect(gitRemote('rev-parse', `refs/heads/chore/oracle-capture-rules-firestore-deadbeef:${obsRel}`)).toBe(
        gitRemote('rev-parse', `refs/heads/chore/oracle-capture-rules-firestore:${obsRel}`),
      );
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
      cleanup();
    }
  }, 20_000);
});
