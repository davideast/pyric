import type { RigManifestRecord } from './types.ts';

/**
 * Pure-Node real-database Firestore rules capture rig for row
 * `firestore-rules#190` (`packages/conformance/src/run-firestore-sibling-merge.ts`).
 */
export const rig: RigManifestRecord = {
  description:
    'Captures Firestore getAfter() sibling-field merge verdicts across multi-document batches (firestore-rules#190) using pure Node Web and Admin SDKs with verified Firestore rules restoration.',
  script: 'packages/conformance/src/run-firestore-sibling-merge.ts',
  observationPrefixes: ['rules-firestore-atomic-batch-sibling-merge'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_ORACLE_PROJECT_ID',
        description:
          'Oracle Firebase project id when authenticating through Workload Identity Federation or Application Default Credentials.',
        permission:
          'roles/firebase.viewer, roles/datastore.user, roles/firebaserules.admin, roles/iam.serviceAccountTokenCreator',
      },
      {
        name: 'PYRIC_ORACLE_SA_PATH',
        description:
          'Optional service-account key JSON path for the dedicated oracle project when not using Application Default Credentials.',
        permission: 'roles/firebase.viewer, roles/datastore.user, roles/firebaserules.admin',
      },
      {
        name: 'PYRIC_ORACLE_FIREBASE_CONFIG',
        description:
          'Optional Web SDK config JSON override for the dedicated oracle project; discovered automatically via the Firebase Management REST API when unset.',
      },
    ],
    projectFeatures: [
      'Default Cloud Firestore database and registered Firebase Web App in the dedicated oracle project.',
    ],
    local: [
      'Installed firebase and firebase-admin packages.',
      'Exclusive /tmp/pyric-firestore-real.lock prevents concurrent Firestore release mutations.',
    ],
  },
  safety: {
    writes:
      'Temporarily activates a ruleset adding a run-scoped match block under __pyric_firestore_cdd/<runId> and writes synthetic companion and batch probe documents under that namespace.',
    cleanup:
      'Deletes all run-scoped documents and temporary Auth user records, and restores + verifies the exact prior cloud.firestore release pointer in finally and signal handlers.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy:
      'Checked by packages/conformance/src/check-observation-versions.ts against the installed firebase package version.',
  },
};
