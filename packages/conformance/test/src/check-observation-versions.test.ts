import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ISOLATED_CRASHLYTICS_FIREBASE_VERSION,
  ISOLATED_CRASHLYTICS_PACKAGE_VERSION,
} from '../../src/capture/crashlytics-web/fixture.ts';
import {
  PENDING_RECAPTURE_TRANSITIONS,
  buildObservationVersionReport,
  checkObservationVersionProblems,
  type ObservationVersionReport,
} from '../../src/check-observation-versions.ts';
import { loadObservations, type Observation } from '../../observations/load.ts';
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

  test('report formats pending recapture counts in default mode and fails with exact mismatch counts in strict mode', () => {
    const installedFb = resolvedFirebaseVersion();
    const installedAdmin = resolvedAdminVersion();
    const fixture: Observation[] = [
      fakeObservation('ai-pending', 'ai', { fbSdkVersion: '12.19.0' }),
      fakeObservation('dual-pending', 'app-check', {
        fbSdkVersion: '12.19.0',
        adminSdkVersion: '13.10.0',
      }),
      fakeObservation('auth-recaptured', 'auth', { fbSdkVersion: installedFb }),
      fakeObservation('admin-recaptured', 'auth-admin', { adminSdkVersion: installedAdmin }),
      fakeObservation('crashlytics-current', 'crashlytics', {
        fbSdkVersion: ISOLATED_CRASHLYTICS_FIREBASE_VERSION,
        crashlyticsSdkVersion: ISOLATED_CRASHLYTICS_PACKAGE_VERSION,
      }),
    ];

    const defaultReport: ObservationVersionReport = buildObservationVersionReport(fixture, {
      allowPendingRecapture: true,
    });
    expect(defaultReport.exitCode).toBe(0);
    expect(defaultReport.stderr).toEqual([]);
    expect(defaultReport.stdout).toContain('# Oracle observation version guard');
    expect(defaultReport.stdout).toContain('Observations checked: 5');
    expect(defaultReport.stdout).toContain(
      `Pending oracle-recapture.yml: 2 observation(s) [fbSdkVersion] at prior certified baseline 12.19.0 -> ${installedFb}`,
    );
    expect(defaultReport.stdout).toContain(
      `Pending oracle-recapture.yml: 1 observation(s) [adminSdkVersion] at prior certified baseline 13.10.0 -> ${installedAdmin}`,
    );
    expect(defaultReport.stdout).toContain(
      '\n[OK] All non-pending observations match installed SDK versions (recapture pending on main).',
    );

    const strictReport: ObservationVersionReport = buildObservationVersionReport(fixture, {
      allowPendingRecapture: false,
    });
    expect(strictReport.exitCode).toBe(1);
    expect(strictReport.stdout.join('\n')).not.toContain('Pending oracle-recapture.yml:');
    expect(strictReport.stderr).toContain('\n[FAIL] 3 observation SDK version mismatch(es):');
    expect(strictReport.stderr).toContain(
      `  - ai/ai-pending.json [fbSdkVersion]: captured 12.19.0, installed ${installedFb}`,
    );
    expect(strictReport.stderr).toContain(
      `  - app-check/dual-pending.json [fbSdkVersion]: captured 12.19.0, installed ${installedFb}`,
    );
    expect(strictReport.stderr).toContain(
      `  - app-check/dual-pending.json [adminSdkVersion]: captured 13.10.0, installed ${installedAdmin}`,
    );
    expect(strictReport.stderr).toContain('Do not edit observation version fields by hand.');
  });

  test('report exits 0 with clean summary in both default and strict modes when all observations are current', () => {
    const installedFb = resolvedFirebaseVersion();
    const installedAdmin = resolvedAdminVersion();
    const fixture: Observation[] = [
      fakeObservation('auth-current', 'auth', { fbSdkVersion: installedFb }),
      fakeObservation('admin-current', 'auth-admin', { adminSdkVersion: installedAdmin }),
      fakeObservation('crashlytics-current', 'crashlytics', {
        fbSdkVersion: ISOLATED_CRASHLYTICS_FIREBASE_VERSION,
        crashlyticsSdkVersion: ISOLATED_CRASHLYTICS_PACKAGE_VERSION,
      }),
    ];

    for (const allowPendingRecapture of [true, false]) {
      const report = buildObservationVersionReport(fixture, { allowPendingRecapture });
      expect(report.exitCode).toBe(0);
      expect(report.stderr).toEqual([]);
      expect(report.stdout).toContain('Observations checked: 3');
      expect(report.stdout).toContain(
        '\n[OK] Every observation matches its installed Firebase SDK version.',
      );
      expect(report.stdout.join('\n')).not.toContain('Pending oracle-recapture.yml:');
    }
  });

  test('report exits 1 on missing fields and unexpected mismatches and caps printed detail lines at 20', () => {
    const installedFb = resolvedFirebaseVersion();
    const fixture: Observation[] = [
      fakeObservation('missing-version', 'auth', {}),
      fakeObservation('pending-client', 'ai', { fbSdkVersion: '12.19.0' }),
    ];
    for (let index = 0; index < 22; index += 1) {
      fixture.push(
        fakeObservation(`stale-${String(index).padStart(2, '0')}`, 'firestore', {
          fbSdkVersion: '12.12.0',
        }),
      );
    }

    const report = buildObservationVersionReport(fixture, { allowPendingRecapture: true });
    expect(report.exitCode).toBe(1);
    expect(report.stderr).toContain('\n[FAIL] 1 observation(s) missing an SDK version field:');
    expect(report.stderr).toContain('  - auth/missing-version.json (missing SDK version field)');
    expect(report.stderr).toContain('\n[FAIL] 22 observation SDK version mismatch(es):');

    const mismatchLines = report.stderr.filter((line) =>
      line.includes(`captured 12.12.0, installed ${installedFb}`),
    );
    expect(mismatchLines.length).toBe(20);
    expect(report.stderr).not.toContain(
      `  - firestore/stale-20.json [fbSdkVersion]: captured 12.12.0, installed ${installedFb}`,
    );
  });

  test('CLI on committed observations enforces structural invariants regardless of recapture progress', () => {
    const observations = loadObservations();
    expect(observations.length).toBeGreaterThan(0);

    const nonStrictCheck = checkObservationVersionProblems(observations, {
      allowPendingRecapture: true,
    });
    expect(nonStrictCheck.missing).toEqual([]);
    expect(nonStrictCheck.mismatched).toEqual([]);

    const pending = nonStrictCheck.pendingRecapture ?? [];
    const expectedPendingByKey = new Map<string, number>();
    for (const entry of pending) {
      const key = `${entry.field}|${entry.got}|${entry.want}`;
      const previous = expectedPendingByKey.get(key) ?? 0;
      expectedPendingByKey.set(key, previous + 1);
    }

    const defaultRun = Bun.spawnSync(['bun', 'run', SCRIPT_PATH], { cwd: REPO_ROOT });
    const defaultStdout = defaultRun.stdout.toString();
    const defaultStderr = defaultRun.stderr.toString();
    expect(defaultRun.exitCode).toBe(0);
    expect(defaultStderr).toBe('');
    expect(defaultStdout).toContain('# Oracle observation version guard');
    expect(defaultStdout).toContain(
      `Resolved firebase (node_modules/firebase/package.json): ${resolvedFirebaseVersion()}`,
    );
    expect(defaultStdout).toContain(
      `Resolved firebase-admin (node_modules/firebase-admin/package.json): ${resolvedAdminVersion()}`,
    );
    expect(defaultStdout).toContain(`Observations checked: ${observations.length}`);

    const pendingLinePattern =
      /^Pending oracle-recapture\.yml: (\d+) observation\(s\) \[([^\]]+)\] at prior certified baseline (\S+) -> (\S+)$/gm;
    const reportedPendingByKey = new Map<string, number>();
    for (const match of defaultStdout.matchAll(pendingLinePattern)) {
      const count = Number(match[1]);
      const field = match[2];
      const from = match[3];
      const to = match[4];
      expect(count).toBeGreaterThan(0);
      expect(PENDING_RECAPTURE_TRANSITIONS[field]).toEqual({ from, to });
      reportedPendingByKey.set(`${field}|${from}|${to}`, count);
    }

    expect(reportedPendingByKey).toEqual(expectedPendingByKey);
    if (pending.length > 0) {
      expect(defaultStdout).toContain(
        '[OK] All non-pending observations match installed SDK versions (recapture pending on main).',
      );
    } else {
      expect(defaultStdout).toContain(
        '[OK] Every observation matches its installed Firebase SDK version.',
      );
      expect(defaultStdout).not.toContain('Pending oracle-recapture.yml:');
    }

    const strictRun = Bun.spawnSync(['bun', 'run', SCRIPT_PATH, '--strict'], { cwd: REPO_ROOT });
    const strictStdout = strictRun.stdout.toString();
    const strictStderr = strictRun.stderr.toString();
    expect(strictStdout).toContain(`Observations checked: ${observations.length}`);
    expect(strictStdout).not.toContain('Pending oracle-recapture.yml:');

    if (pending.length > 0) {
      expect(strictRun.exitCode).toBe(1);
      expect(strictStderr).toContain(
        `[FAIL] ${pending.length} observation SDK version mismatch(es):`,
      );
    } else {
      expect(strictRun.exitCode).toBe(0);
      expect(strictStderr).toBe('');
      expect(strictStdout).toContain(
        '[OK] Every observation matches its installed Firebase SDK version.',
      );
    }
  }, 15_000);
});
