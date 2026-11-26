#!/usr/bin/env bun
/**
 * CI guard: every SDK version named by an oracle observation must match the
 * version the workspace currently resolves (or an explicit pending-recapture
 * baseline transition during a two-step SDK upgrade).
 *
 * The observations in observations/<surface>/*.json are the pinned
 * record of real prod behavior the COMPAT matrices cite. If the workspace
 * bumps `firebase` but the observations aren't re-captured, every "matches
 * prod" claim silently drifts to a stale version -- the rot behind INF-3/INF-4
 * (an observation captured at one version vouching for behavior at another).
 *
 * Source of truth for "resolved version": the installed
 * node_modules/firebase/package.json (what tests actually ran against),
 * not the `^`-range in package.json or a lockfile scrape.
 *
 * Usage: bun run packages/conformance/src/check-observation-versions.ts [--strict]
 * Exit codes: 0 all match (or match pending recapture when not --strict),
 *             1 a mismatch / missing field / unresolvable package.
 */
import {
  ISOLATED_CRASHLYTICS_FIREBASE_VERSION,
  ISOLATED_CRASHLYTICS_PACKAGE_VERSION,
} from './capture/crashlytics-web/fixture.ts';
import { loadObservations, type Observation } from '../observations/load.ts';
import {
  resolvedAdminVersion,
  resolvedAndroidBomVersion,
  resolvedFirebaseVersion,
  resolvedFunctionsVersion,
  resolvedIosSdkVersion,
} from './package-version.ts';

export interface PendingRecaptureTransition {
  readonly from: string;
  readonly to: string;
}

/**
 * Explicit two-step SDK upgrade transitions whose committed observations stay
 * untouched at their prior certified baseline until `oracle-recapture.yml` runs
 * on `main`. Strict mode (`--strict` / default library calls) still reports all
 * pending-recapture observations as mismatches.
 */
export const PENDING_RECAPTURE_TRANSITIONS: Readonly<
  Partial<Record<string, PendingRecaptureTransition>>
> = {
  fbSdkVersion: { from: '12.19.0', to: '13.4.0' },
  adminSdkVersion: { from: '13.10.0', to: '14.5.1' },
};

export interface ObservationVersionCheckOptions {
  allowPendingRecapture?: boolean;
  transitions?: Readonly<Partial<Record<string, PendingRecaptureTransition>>>;
}

interface PendingRecaptureEntry {
  file: string;
  field: string;
  got: string;
  want: string;
}

export interface ObservationVersionCheckResult {
  missing: string[];
  mismatched: Array<{ file: string; got: string; want: string }>;
  pendingRecapture?: PendingRecaptureEntry[];
}

export interface ObservationVersionReport {
  exitCode: 0 | 1;
  stdout: string[];
  stderr: string[];
  result: ObservationVersionCheckResult;
}

export function checkObservationVersionProblems(
  observations: readonly Observation[] = loadObservations(),
  options?: ObservationVersionCheckOptions,
): ObservationVersionCheckResult {
  const allowPending = options?.allowPendingRecapture === true;
  const transitions = options?.transitions ?? PENDING_RECAPTURE_TRANSITIONS;
  const resolved = resolvedFirebaseVersion();
  // `admin-*` observations are captured against `firebase-admin` (the admin SDK),
  // not the firebase JS SDK, and are versioned by `adminSdkVersion`. They vouch
  // for admin behavior, so they must track the installed firebase-admin version.
  const resolvedAdmin = resolvedAdminVersion();
  const resolvedFunctions = resolvedFunctionsVersion();
  const resolvedAndroidBom = resolvedAndroidBomVersion();
  const resolvedIos = resolvedIosSdkVersion();

  const missing: string[] = [];
  const mismatched: Array<{ file: string; got: string; want: string }> = [];
  const pendingRecapture: PendingRecaptureEntry[] = [];

  const versionTargets = [
    { field: 'fbSdkVersion', resolved },
    { field: 'adminSdkVersion', resolved: resolvedAdmin },
    { field: 'functionsSdkVersion', resolved: resolvedFunctions },
    { field: 'androidBomVersion', resolved: resolvedAndroidBom },
    { field: 'iosSdkVersion', resolved: resolvedIos },
  ] as const;

  for (const obs of observations) {
    const file = obs.file;
    if (obs.surfaceDir === 'crashlytics') {
      const fbVersion = obs.raw.fbSdkVersion;
      const crashlyticsVersion = obs.raw.crashlyticsSdkVersion;
      if (typeof fbVersion !== 'string' || typeof crashlyticsVersion !== 'string') {
        missing.push(`${file} (missing isolated fbSdkVersion or crashlyticsSdkVersion field)`);
        continue;
      }
      if (fbVersion !== ISOLATED_CRASHLYTICS_FIREBASE_VERSION) {
        mismatched.push({
          file: `${file} [fbSdkVersion]`,
          got: fbVersion,
          want: ISOLATED_CRASHLYTICS_FIREBASE_VERSION,
        });
      }
      if (crashlyticsVersion !== ISOLATED_CRASHLYTICS_PACKAGE_VERSION) {
        mismatched.push({
          file: `${file} [crashlyticsSdkVersion]`,
          got: crashlyticsVersion,
          want: ISOLATED_CRASHLYTICS_PACKAGE_VERSION,
        });
      }
      continue;
    }
    const present = versionTargets.filter(({ field }) => typeof obs.raw[field] === 'string');
    if (present.length === 0) {
      missing.push(`${file} (missing SDK version field)`);
      continue;
    }
    for (const { field, resolved: want } of present) {
      const got = obs.raw[field] as string;
      if (got === want) continue;
      const transition = transitions[field];
      const matchesPending =
        allowPending &&
        transition !== undefined &&
        got === transition.from &&
        want === transition.to;
      if (matchesPending) {
        pendingRecapture.push({ file, field, got, want });
      } else {
        mismatched.push({ file: `${file} [${field}]`, got, want });
      }
    }
  }

  if (allowPending) {
    return { missing, mismatched, pendingRecapture };
  }
  return { missing, mismatched };
}

export function buildObservationVersionReport(
  observations: readonly Observation[] = loadObservations(),
  options?: ObservationVersionCheckOptions,
): ObservationVersionReport {
  const resolved = resolvedFirebaseVersion();
  const resolvedAdmin = resolvedAdminVersion();
  const resolvedFunctions = resolvedFunctionsVersion();
  const resolvedAndroidBom = resolvedAndroidBomVersion();
  const resolvedIos = resolvedIosSdkVersion();
  const result = checkObservationVersionProblems(observations, options);
  const pendingRecapture = result.pendingRecapture ?? [];

  const stdout: string[] = [
    '# Oracle observation version guard',
    `Resolved firebase (node_modules/firebase/package.json): ${resolved}`,
    `Resolved isolated crashlytics web SDK: firebase@${ISOLATED_CRASHLYTICS_FIREBASE_VERSION} (@firebase/crashlytics@${ISOLATED_CRASHLYTICS_PACKAGE_VERSION})`,
    `Resolved firebase-admin (node_modules/firebase-admin/package.json): ${resolvedAdmin}`,
    `Resolved firebase-functions (node_modules/firebase-functions/package.json): ${resolvedFunctions}`,
    `Resolved firebase-bom (rigs/native-android-oracle/gradle.properties): ${resolvedAndroidBom}`,
    `Resolved firebase-ios-sdk (rigs/native-ios-oracle/sdk-version.properties): ${resolvedIos}`,
    `Observations checked: ${observations.length}`,
  ];
  const stderr: string[] = [];

  if (pendingRecapture.length > 0) {
    const countsByPair = new Map<string, number>();
    for (const entry of pendingRecapture) {
      const key = `${entry.field}|${entry.got}|${entry.want}`;
      const previous = countsByPair.get(key) ?? 0;
      countsByPair.set(key, previous + 1);
    }
    for (const [key, count] of countsByPair) {
      const [field, from, to] = key.split('|');
      stdout.push(
        `Pending oracle-recapture.yml: ${count} observation(s) [${field}] at prior certified baseline ${from} -> ${to}`,
      );
    }
  }

  if (result.missing.length === 0 && result.mismatched.length === 0) {
    if (pendingRecapture.length > 0) {
      stdout.push(
        '\n[OK] All non-pending observations match installed SDK versions (recapture pending on main).',
      );
    } else {
      stdout.push('\n[OK] Every observation matches its installed Firebase SDK version.');
    }
    return { exitCode: 0, stdout, stderr, result };
  }

  if (result.missing.length > 0) {
    stderr.push(`\n[FAIL] ${result.missing.length} observation(s) missing an SDK version field:`);
    for (const file of result.missing.slice(0, 20)) {
      stderr.push(`  - ${file}`);
    }
  }
  if (result.mismatched.length > 0) {
    stderr.push(`\n[FAIL] ${result.mismatched.length} observation SDK version mismatch(es):`);
    for (const { file, got, want } of result.mismatched.slice(0, 20)) {
      stderr.push(`  - ${file}: captured ${got}, installed ${want}`);
    }
    stderr.push('\nRe-run the owning oracle capture against the installed SDK versions.');
    stderr.push('Do not edit observation version fields by hand.');
  }
  return { exitCode: 1, stdout, stderr, result };
}

if (import.meta.main) {
  const strict = process.argv.includes('--strict');
  const report = buildObservationVersionReport(loadObservations(), {
    allowPendingRecapture: !strict,
  });
  for (const line of report.stdout) {
    console.log(line);
  }
  for (const line of report.stderr) {
    console.error(line);
  }
  process.exit(report.exitCode);
}
