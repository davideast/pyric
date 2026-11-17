import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planCaptureRun } from './oracle-capture-plan.ts';
import { executeCapturePlan, type CaptureBundleManifest } from './oracle-capture-pr.ts';

function initTempGitRepo(): { repoDir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'oracle-capture-sibling-'));
  const repoDir = join(base, 'work');
  mkdirSync(join(repoDir, 'packages/conformance/observations/firestore-rules'), {
    recursive: true,
  });
  execFileSync('git', ['init', '-b', 'main', repoDir]);
  execFileSync('git', ['config', 'user.name', 'Test Bot'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'bot@example.com'], { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'fixture\n');
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
});
