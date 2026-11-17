import type { RigManifestRecord } from './types.ts';

/**
 * Real-database Firestore write `request.resource.data` projection capture rig
 * (`packages/conformance/src/run-firestore-write-request-resource.ts`).
 */
export const rig: RigManifestRecord = {
  description:
    'Captures what production Firestore rules observe on request.resource.data, resource.data, and map diff() across single-document client writes (dotted updateDoc, FieldPath literal dots, deleteField, setDoc merge/mergeFields, and full replace) with verified rules restoration.',
  script: 'packages/conformance/src/run-firestore-write-request-resource.ts',
  observationPrefixes: ['firestore-write-request-resource'],
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
      'Exclusive /tmp/pyric-firestore-real.lock prevents concurrent Firestore release mutations.',
    ],
  },
  safety: {
    writes:
      'Temporarily activates a ruleset adding a run-scoped match block under __pyric_firestore_cdd/<runId> and writes seeded single-document test cases.',
    cleanup:
      'Deletes all seeded documents and restores + verifies the exact prior cloud.firestore release pointer in a finally block.',
    unattendedSafe: false,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy:
      'Checked by packages/conformance/src/check-observation-versions.ts against the installed firebase package version.',
  },
};
