#!/usr/bin/env bun
/**
 * CI guard: every SDK version named by an oracle observation must match the
 * version the workspace currently resolves.
 *
 * The observations in observations/<surface>/*.json are the pinned
 * record of real prod behavior the COMPAT matrices cite. If the workspace
 * bumps `firebase` but the observations aren't re-captured, every "matches
 * prod" claim silently drifts to a stale version — exactly the rot behind
 * INF-3/INF-4 (an observation captured at one version vouching for behavior
 * at another).
 *
 * Source of truth for "resolved version": the installed
 * node_modules/firebase/package.json (what tests actually ran against),
 * not the `^`-range in package.json or a lockfile scrape.
 *
 * Usage: bun run packages/conformance/src/check-observation-versions.ts
 * Exit codes: 0 all match, 1 a mismatch / missing field / unresolvable package.
 */
import {
  ISOLATED_CRASHLYTICS_FIREBASE_VERSION,
  ISOLATED_CRASHLYTICS_PACKAGE_VERSION,
} from './capture/crashlytics-web/fixture.ts';
import { loadObservations, type Observation } from './ledger.ts';
import {
  resolvedAdminVersion,
  resolvedAndroidBomVersion,
  resolvedFirebaseVersion,
  resolvedFunctionsVersion,
  resolvedIosSdkVersion,
} from './package-version.ts';

export interface ObservationVersionCheckResult {
  missing: string[];
  mismatched: Array<{ file: string; got: string; want: string }>;
}

export function checkObservationVersionProblems(
  observations: readonly Observation[] = loadObservations(),
): ObservationVersionCheckResult {
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
      if (got !== want) mismatched.push({ file: `${file} [${field}]`, got, want });
    }
  }

  return { missing, mismatched };
}

if (import.meta.main) {
  const resolved = resolvedFirebaseVersion();
  const resolvedAdmin = resolvedAdminVersion();
  const resolvedFunctions = resolvedFunctionsVersion();
  const resolvedAndroidBom = resolvedAndroidBomVersion();
  const resolvedIos = resolvedIosSdkVersion();
  const observations = loadObservations();
  const { missing, mismatched } = checkObservationVersionProblems(observations);

  console.log(`# Oracle observation version guard`);
  console.log(`Resolved firebase (node_modules/firebase/package.json): ${resolved}`);
  console.log(
    `Resolved isolated crashlytics web SDK: firebase@${ISOLATED_CRASHLYTICS_FIREBASE_VERSION} (@firebase/crashlytics@${ISOLATED_CRASHLYTICS_PACKAGE_VERSION})`,
  );
  console.log(`Resolved firebase-admin (node_modules/firebase-admin/package.json): ${resolvedAdmin}`);
  console.log(`Resolved firebase-functions (node_modules/firebase-functions/package.json): ${resolvedFunctions}`);
  console.log(`Resolved firebase-bom (rigs/native-android-oracle/gradle.properties): ${resolvedAndroidBom}`);
  console.log(`Resolved firebase-ios-sdk (rigs/native-ios-oracle/sdk-version.properties): ${resolvedIos}`);
  console.log(`Observations checked: ${observations.length}`);

  if (missing.length === 0 && mismatched.length === 0) {
    console.log('\n✓ Every observation matches its installed Firebase SDK version.');
    process.exit(0);
  }

  if (missing.length > 0) {
    console.error(`\n✗ ${missing.length} observation(s) missing an SDK version field:`);
    for (const f of missing.slice(0, 20)) console.error(`  - ${f}`);
  }
  if (mismatched.length > 0) {
    console.error(`\n✗ ${mismatched.length} observation SDK version mismatch(es):`);
    for (const { file, got, want } of mismatched.slice(0, 20)) {
      console.error(`  - ${file}: captured ${got}, installed ${want}`);
    }
    console.error('\nRe-run the owning oracle capture against the installed SDK versions.');
    console.error('Do not edit observation version fields by hand.');
  }
  process.exit(1);
}
