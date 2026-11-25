import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ISOLATED_CRASHLYTICS_FIREBASE_VERSION,
  ISOLATED_CRASHLYTICS_PACKAGE_VERSION,
} from '../../src/capture/crashlytics-web/fixture.ts';
import {
  PENDING_RECAPTURE_TRANSITIONS,
  checkObservationVersionProblems,
} from '../../src/check-observation-versions.ts';
import type { Observation } from '../../src/ledger.ts';
import { resolvedAdminVersion, resolvedFirebaseVersion } from '../../src/package-version.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const SCRIPT_PATH = 'packages/conformance/src/check-observation-versions.ts';

function fakeObservation(
  name: string,
  surfaceDir: string,
  raw: Record<string, unknown>,
): Observation {
  return {
    name,
    file: `${surfaceDir}/${name}.json`,
    surfaceDir,
    matrixRow: name,
    rowIds: [],
    behavior: {},
    raw,
  };
}

describe('checkObservationVersionProblems', () => {
  test('strict mode (default) flags pending-recapture observations as mismatches', () => {
    const installedFb = resolvedFirebaseVersion();
    const installedAdmin = resolvedAdminVersion();
    expect(installedFb).toBe('13.4.0');
    expect(installedAdmin).toBe('14.5.1');
    expect(PENDING_RECAPTURE_TRANSITIONS.fbSdkVersion).toEqual({
      from: '12.19.0',
      to: '13.4.0',
    });
    expect(PENDING_RECAPTURE_TRANSITIONS.adminSdkVersion).toEqual({
      from: '13.10.0',
      to: '14.5.1',
    });

    const fbObs = fakeObservation('ai-sample', 'ai', { fbSdkVersion: '12.19.0' });
    const adminObs = fakeObservation('admin-sample', 'auth-admin', {
      adminSdkVersion: '13.10.0',
    });
    expect(checkObservationVersionProblems([fbObs, adminObs])).toEqual({
      missing: [],
      mismatched: [
        {
          file: 'ai/ai-sample.json [fbSdkVersion]',
          got: '12.19.0',
          want: '13.4.0',
        },
        {
          file: 'auth-admin/admin-sample.json [adminSdkVersion]',
          got: '13.10.0',
          want: '14.5.1',
        },
      ],
    });
  });

  test('allowPendingRecapture records exact 12.19.0 -> 13.4.0 and 13.10.0 -> 14.5.1 transitions without flagging mismatches', () => {
    const pendingClient = fakeObservation('ai-sample', 'ai', { fbSdkVersion: '12.19.0' });
    const pendingAdmin = fakeObservation('admin-sample', 'auth-admin', {
      adminSdkVersion: '13.10.0',
    });
    const currentCrashlytics = fakeObservation('crashlytics-sample', 'crashlytics', {
      fbSdkVersion: ISOLATED_CRASHLYTICS_FIREBASE_VERSION,
      crashlyticsSdkVersion: ISOLATED_CRASHLYTICS_PACKAGE_VERSION,
    });

    expect(
      checkObservationVersionProblems([pendingClient, pendingAdmin, currentCrashlytics], {
        allowPendingRecapture: true,
      }),
    ).toEqual({
      missing: [],
      mismatched: [],
      pendingRecapture: [
        {
          file: 'ai/ai-sample.json',
          field: 'fbSdkVersion',
          got: '12.19.0',
          want: '13.4.0',
        },
        {
          file: 'auth-admin/admin-sample.json',
          field: 'adminSdkVersion',
          got: '13.10.0',
          want: '14.5.1',
        },
      ],
    });
  });

  test('allowPendingRecapture still fails closed on arbitrary stale versions, missing fields, and crashlytics drift', () => {
    const arbitraryStaleFb = fakeObservation('auth-old', 'auth', { fbSdkVersion: '12.12.0' });
    const arbitraryStaleAdmin = fakeObservation('admin-old', 'auth-admin', {
      adminSdkVersion: '13.6.0',
    });
    const missingField = fakeObservation('auth-missing', 'auth', {});
    const driftedCrashlytics = fakeObservation('crashlytics-bad', 'crashlytics', {
      fbSdkVersion: '12.19.0',
      crashlyticsSdkVersion: ISOLATED_CRASHLYTICS_PACKAGE_VERSION,
    });

    const result = checkObservationVersionProblems(
      [arbitraryStaleFb, arbitraryStaleAdmin, missingField, driftedCrashlytics],
      { allowPendingRecapture: true },
    );
    expect(result.missing).toEqual(['auth/auth-missing.json (missing SDK version field)']);
    expect(result.mismatched).toEqual([
      {
        file: 'auth/auth-old.json [fbSdkVersion]',
        got: '12.12.0',
        want: '13.4.0',
      },
      {
        file: 'auth-admin/admin-old.json [adminSdkVersion]',
        got: '13.6.0',
        want: '14.5.1',
      },
      {
        file: 'crashlytics/crashlytics-bad.json [fbSdkVersion]',
        got: '12.19.0',
        want: ISOLATED_CRASHLYTICS_FIREBASE_VERSION,
      },
    ]);
    expect(result.pendingRecapture).toEqual([]);
  });

  test('CLI default mode exits 0 with pending recapture summary while --strict exits 1', () => {
    const defaultRun = Bun.spawnSync(['bun', 'run', SCRIPT_PATH], { cwd: REPO_ROOT });
    const defaultStdout = defaultRun.stdout.toString();
    expect(defaultRun.exitCode).toBe(0);
    expect(defaultStdout).toContain(
      'Pending oracle-recapture.yml: 663 observation(s) [fbSdkVersion] at prior certified baseline 12.19.0 -> 13.4.0',
    );
    expect(defaultStdout).toContain(
      'Pending oracle-recapture.yml: 87 observation(s) [adminSdkVersion] at prior certified baseline 13.10.0 -> 14.5.1',
    );

    const strictRun = Bun.spawnSync(['bun', 'run', SCRIPT_PATH, '--strict'], { cwd: REPO_ROOT });
    const strictStderr = strictRun.stderr.toString();
    expect(strictRun.exitCode).toBe(1);
    expect(strictStderr).toContain('750 observation SDK version mismatch(es)');
  });
});
