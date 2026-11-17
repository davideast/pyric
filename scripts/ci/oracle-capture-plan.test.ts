import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { planCaptureRun } from './oracle-capture-plan.ts';
import { executeCapturePlan, type CaptureBundleManifest } from './oracle-capture-pr.ts';
import {
  assertCleanWorkingTreeForCapture,
  collectTimestampCleanObservations,
  validateObservationRelativePath,
} from './oracle-observation-diff.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');

function initTempGitRepo(options: { copyRepoGitignore?: boolean } = {}): {
  repoDir: string;
  cleanup: () => void;
} {
  const base = mkdtempSync(join(tmpdir(), 'oracle-capture-sibling-'));
  const repoDir = join(base, 'work');
  mkdirSync(join(repoDir, 'packages/conformance/observations/firestore-rules'), {
    recursive: true,
  });
  execFileSync('git', ['init', '-b', 'main', repoDir]);
  execFileSync('git', ['config', 'user.name', 'Test Bot'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'bot@example.com'], { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'fixture\n');
  if (options.copyRepoGitignore) {
    copyFileSync(join(REPO_ROOT, '.gitignore'), join(repoDir, '.gitignore'));
  }
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir });
  return {
    repoDir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

describe('oracle-capture-plan WIF SDK write flags and sibling invocation isolation', () => {
  test('passes --write and --probe for admin-firestore and storage-admin dispatches', async () => {
    const baseEnv = {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      GCP_WIF_PROVIDER: 'projects/1/locations/global/workloadIdentityPools/p/providers/gh',
      PARITY_SA_EMAIL: 'parity-test-sa@digame-mas.iam.gserviceaccount.com',
    };

    const adminFsPlan = await planCaptureRun({
      ...baseEnv,
      INPUT_RIG: 'admin-firestore',
      INPUT_FILTER: 'admin-firestore-document-snapshot-get',
    });
    expect(adminFsPlan.invocations).toEqual([
      {
        rig: 'admin-firestore',
        script: 'packages/conformance/src/admin-firestore-probes.ts',
        args: ['--write', '--probe', 'admin-firestore-document-snapshot-get'],
      },
    ]);

    const storageAdminPlan = await planCaptureRun({
      ...baseEnv,
      INPUT_RIG: 'storage-admin',
      INPUT_FILTER: 'admin-storage-metadata-download-url',
    });
    expect(storageAdminPlan.invocations).toEqual([
      {
        rig: 'storage-admin',
        script: 'packages/conformance/src/storage-admin-probes.ts',
        args: ['--write', '--probe', 'admin-storage-metadata-download-url'],
      },
    ]);
  });

  test('executeCapturePlan preserves passing sibling --scenario captures when one sibling fails', () => {
    const { repoDir, cleanup } = initTempGitRepo();
    const artifactDir = mkdtempSync(join(tmpdir(), 'oracle-capture-sibling-bundle-'));
    const outputFile = join(artifactDir, 'gh-out.txt');
    const summaryFile = join(artifactDir, 'gh-summary.md');

    try {
      const result = executeCapturePlan({
        cwd: repoDir,
        artifactDir: join(artifactDir, 'bundle'),
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_OUTPUT: outputFile,
          GITHUB_STEP_SUMMARY: summaryFile,
        },
        plan: {
          shouldRun: true,
          needsWif: true,
          invocations: [
            {
              rig: 'rules-firestore',
              script: 'packages/conformance/src/run-rules.ts',
              args: ['--scenario', 'first-ok'],
            },
            {
              rig: 'rules-firestore',
              script: 'packages/conformance/src/run-rules.ts',
              args: ['--scenario', 'second-fails'],
            },
            {
              rig: 'rules-firestore',
              script: 'packages/conformance/src/run-rules.ts',
              args: ['--scenario', 'third-ok'],
            },
          ],
        },
        runInvocation: (inv) => {
          const scenarioId = inv.args[1] ?? '';
          if (scenarioId === 'second-fails') {
            return { status: 1, stderr: 'HTTP 403 PERMISSION_DENIED on second-fails' };
          }
          const name = `rules-firestore-${scenarioId}`;
          const obsPath = join(
            repoDir,
            'packages/conformance/observations/firestore-rules',
            `${name}.json`,
          );
          mkdirSync(dirname(obsPath), { recursive: true });
          writeFileSync(
            obsPath,
            `${JSON.stringify(
              {
                name,
                matrixRow: '',
                rowIds: [],
                description: `capture for ${scenarioId}`,
                observedAt: '2026-11-17T00:00:00.000Z',
                fbSdkVersion: '12.19.0',
                behavior: { probe: 'ALLOW' },
              },
              null,
              2,
            )}\n`,
          );
          return { status: 0, stdout: `wrote ${name}` };
        },
      });

      expect(result).toEqual({ hasCaptures: true, hadRigFailure: true });
      const manifest = JSON.parse(
        readFileSync(join(artifactDir, 'bundle/manifest.json'), 'utf8'),
      ) as CaptureBundleManifest;
      expect(manifest.rigs).toEqual([
        {
          rig: 'rules-firestore',
          filter: 'first-ok, third-ok',
          files: [
            {
              path: 'packages/conformance/observations/firestore-rules/rules-firestore-first-ok.json',
              kind: 'added',
            },
            {
              path: 'packages/conformance/observations/firestore-rules/rules-firestore-third-ok.json',
              kind: 'added',
            },
          ],
        },
      ]);
      expect(readFileSync(outputFile, 'utf8')).toContain('has_captures=true');
      expect(readFileSync(summaryFile, 'utf8')).toContain('PERMISSION_DENIED');
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
      cleanup();
    }
  });

  test('anchors .gitignore to root gha-creds-*.json files only and excludes observation-shaped root creds without .gitignore', () => {
    const checkIgnore = (relPath: string): number | null =>
      spawnSync('git', ['check-ignore', '-q', relPath], { cwd: REPO_ROOT }).status;

    expect(checkIgnore('gha-creds-b2de1f6be4030177.json')).toBe(0);
    expect(checkIgnore('nested/gha-creds-b2de1f6be4030177.json')).toBe(1);
    expect(
      checkIgnore('packages/conformance/observations/auth/gha-creds-b2de1f6be4030177.json'),
    ).toBe(1);
    expect(checkIgnore('gha-creds-dir.json/')).toBe(1);
    expect(checkIgnore('gha-creds-dir.json/payload.ts')).toBe(1);

    // Without .gitignore: root gha-creds-*.json carrying observation-shaped JSON is still excluded
    const { repoDir, cleanup } = initTempGitRepo({ copyRepoGitignore: false });
    const artifactDir = mkdtempSync(join(tmpdir(), 'oracle-capture-gha-creds-bare-'));
    try {
      writeFileSync(
        join(repoDir, 'gha-creds-b2de1f6be4030177.json'),
        `${JSON.stringify({
          name: 'gha-creds-b2de1f6be4030177',
          matrixRow: '',
          rowIds: [],
          description: 'observation-shaped credential decoy',
          observedAt: '2026-11-17T00:00:00.000Z',
          fbSdkVersion: '12.19.0',
          behavior: { decoy: true },
        })}\n`,
      );

      const bundlePath = join(artifactDir, 'bundle');
      const result = executeCapturePlan({
        cwd: repoDir,
        artifactDir: bundlePath,
        env: { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' },
        plan: {
          shouldRun: true,
          needsWif: true,
          invocations: [
            {
              rig: 'rules-firestore',
              script: 'packages/conformance/src/run-rules.ts',
              args: ['--scenario', 'sample-probe'],
            },
          ],
        },
        runInvocation: () => {
          const obsPath = join(
            repoDir,
            'packages/conformance/observations/firestore-rules/rules-firestore-sample-probe.json',
          );
          mkdirSync(dirname(obsPath), { recursive: true });
          writeFileSync(
            obsPath,
            `${JSON.stringify(
              {
                name: 'rules-firestore-sample-probe',
                matrixRow: '',
                rowIds: [],
                description: 'sample probe',
                observedAt: '2026-11-17T00:00:00.000Z',
                fbSdkVersion: '12.19.0',
                behavior: { probe: 'ALLOW' },
              },
              null,
              2,
            )}\n`,
          );
          return { status: 0, stdout: 'wrote rules-firestore-sample-probe' };
        },
      });

      expect(result).toEqual({ hasCaptures: true, hadRigFailure: false });
      expect(existsSync(join(bundlePath, 'gha-creds-b2de1f6be4030177.json'))).toBe(false);
      const manifest = JSON.parse(
        readFileSync(join(bundlePath, 'manifest.json'), 'utf8'),
      ) as CaptureBundleManifest;
      expect(manifest.rigs.flatMap((r) => r.files.map((f) => f.path))).toEqual([
        'packages/conformance/observations/firestore-rules/rules-firestore-sample-probe.json',
      ]);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
      cleanup();
    }
  });

  test('with committed .gitignore present, fails closed on nested paths, observations stem, directories, symlinks, malformed names, and tracked/staged/renamed creds', () => {
    const { repoDir, cleanup } = initTempGitRepo({ copyRepoGitignore: true });
    const scratchOut = mkdtempSync(join(tmpdir(), 'oracle-capture-gitignore-bypass-'));

    try {
      // Valid regular root gha-creds-*.json passes with committed .gitignore
      const validCredsPath = join(repoDir, 'gha-creds-b2de1f6be4030177.json');
      writeFileSync(validCredsPath, '{"type":"external_account"}\n');
      expect(() => assertCleanWorkingTreeForCapture(repoDir)).not.toThrow();
      expect(collectTimestampCleanObservations(repoDir, scratchOut)).toEqual([]);

      // 1. Nested, observations-tree, and malformed root file paths all fail closed
      const bypassFiles = [
        'nested/gha-creds-b2de1f6be4030177.json',
        'packages/conformance/observations/auth/gha-creds-b2de1f6be4030177.json',
        'gha-creds-.json',
        'gha-creds-bad space.json',
        'stray-untracked.json',
      ];
      for (const rel of bypassFiles) {
        const abs = join(repoDir, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, '{"type":"external_account"}\n');
        try {
          expect(() => assertCleanWorkingTreeForCapture(repoDir)).toThrow();
          expect(() => collectTimestampCleanObservations(repoDir, scratchOut)).toThrow();
        } finally {
          rmSync(abs, { force: true });
        }
      }

      // 2. Directory named gha-creds-dir.json/x fails closed (and git check-ignore does not ignore it)
      const dirCreds = join(repoDir, 'gha-creds-dir.json');
      mkdirSync(dirCreds, { recursive: true });
      writeFileSync(join(dirCreds, 'x.ts'), 'export const x = 1;\n');
      try {
        expect(
          spawnSync('git', ['check-ignore', '-q', 'gha-creds-dir.json/x.ts'], { cwd: repoDir })
            .status,
        ).toBe(1);
        expect(() => assertCleanWorkingTreeForCapture(repoDir)).toThrow();
        expect(() => collectTimestampCleanObservations(repoDir, scratchOut)).toThrow();
      } finally {
        rmSync(dirCreds, { recursive: true, force: true });
      }

      // 3. Root symlink named gha-creds-*.json fails closed
      rmSync(validCredsPath, { force: true });
      symlinkSync(join(repoDir, 'README.md'), validCredsPath);
      try {
        expect(() => assertCleanWorkingTreeForCapture(repoDir)).toThrow(/non-regular/);
        expect(() => collectTimestampCleanObservations(repoDir, scratchOut)).toThrow(/non-regular/);
      } finally {
        rmSync(validCredsPath, { force: true });
      }

      // 4. Staged (`git add -f`), tracked/modified, and renamed (`git mv`) gha-creds-*.json fail closed
      writeFileSync(validCredsPath, '{"type":"external_account"}\n');
      execFileSync('git', ['add', '-f', 'gha-creds-b2de1f6be4030177.json'], { cwd: repoDir });
      expect(() => assertCleanWorkingTreeForCapture(repoDir)).toThrow(
        /Working tree must be clean/,
      );
      expect(() => collectTimestampCleanObservations(repoDir, scratchOut)).toThrow();

      execFileSync('git', ['commit', '-m', 'track creds for test'], { cwd: repoDir });
      writeFileSync(validCredsPath, '{"type":"external_account","modified":true}\n');
      expect(() => assertCleanWorkingTreeForCapture(repoDir)).toThrow(
        /Working tree must be clean/,
      );
      expect(() => collectTimestampCleanObservations(repoDir, scratchOut)).toThrow();
      execFileSync('git', ['checkout', '--', 'gha-creds-b2de1f6be4030177.json'], { cwd: repoDir });

      execFileSync(
        'git',
        ['mv', 'README.md', 'gha-creds-renamed.json'],
        { cwd: repoDir },
      );
      expect(() => assertCleanWorkingTreeForCapture(repoDir)).toThrow(
        /Working tree must be clean/,
      );
      expect(() => collectTimestampCleanObservations(repoDir, scratchOut)).toThrow();

      expect(() =>
        validateObservationRelativePath(
          'packages/conformance/observations/auth/gha-creds-b2de1f6be4030177.json',
        ),
      ).toThrow(/gha-creds-/);
    } finally {
      rmSync(scratchOut, { recursive: true, force: true });
      cleanup();
    }
  });
});
