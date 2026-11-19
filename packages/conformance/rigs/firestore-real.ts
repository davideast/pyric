import type { RigManifestRecord } from './types.ts';

/**
 * Real-database and headless-Chromium Firestore capture rig
 * (`packages/conformance/src/run-firestore-real.ts`).
 */
export const rig: RigManifestRecord = {
  description:
    'Captures real-database Firestore transaction contention retries, collectionGroup listener behavior, Chromium persistence/lifecycle behavior, and getAfter()/existsAfter() atomic batch verdicts with verified Firestore rules restoration.',
  script: 'packages/conformance/src/run-firestore-real.ts',
  observationPrefixes: [
    'firestore-transaction-contention-retries',
    'firestore-browser-lifecycle',
    'firestore-collection-group-listener',
    'rules-firestore-get-after-and-exists-after',
  ],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_ORACLE_SA_PATH',
        description:
          'Optional service-account JSON path for the dedicated oracle project. Unset, Application Default Credentials are used with PYRIC_ORACLE_PROJECT_ID.',
        permission: 'Firestore data access, Firebase Auth custom token signing, Firebase Rules release management',
      },
      {
        name: 'PYRIC_ORACLE_PROJECT_ID',
        description:
          'Oracle Firebase project id read when PYRIC_ORACLE_SA_PATH is unset.',
        permission: 'Firestore data access, Firebase Auth custom token signing, Firebase Rules release management',
      },
    ],
    projectFeatures: [
      'Default Cloud Firestore database and registered Firebase Web App in the dedicated oracle project.',
    ],
    local: [
      'Playwright Chromium installed.',
      'Exclusive /tmp/pyric-firestore-real.lock prevents concurrent Firestore release mutations.',
    ],
  },
  safety: {
    writes:
      'Temporarily activates a ruleset adding a run-scoped match block under __pyric_firestore_cdd/<runId>, writes synthetic documents under that namespace, and runs headless Chromium against it.',
    cleanup:
      'Restores and verifies the exact prior cloud.firestore release pointer in a finally block and deletes run-scoped documents through the Admin SDK.',
    unattendedSafe: false,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy:
      'Checked by packages/conformance/src/check-observation-versions.ts against the installed firebase package version.',
  },
};
