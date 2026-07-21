import type { RigManifestRecord } from './types.ts';

export const rig: RigManifestRecord = {
  description: 'Real-resource Storage-to-Firestore lookup budget/caching probe with exact Storage release restoration and run-scoped data cleanup verification.',
  script: 'packages/conformance/src/run-storage-stdlib-real.ts',
  observationPrefixes: ['stdlib-realstorage-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      { name: 'PYRIC_ORACLE_SA_PATH', description: 'Service-account JSON path for the dedicated oracle project. Base and --iam-enabled modes need Firestore data, Storage object, and Rules management permissions; --temporary-iam additionally requires IAM policy read/write.', permission: 'Firestore data write/delete, Storage object admin, Firebase Rules ruleset/release management; resourcemanager.projects.getIamPolicy/setIamPolicy for --temporary-iam' },
      { name: 'PYRIC_AI_FIREBASE_CONFIG', description: 'Web SDK config whose projectId must match the oracle service account; supplies the API key for anonymous Storage requests.' },
    ],
    projectFeatures: ['Default Firestore database and default Storage bucket provisioned. Pass --iam-enabled only after the Firebase Storage service agent has roles/firebaserules.firestoreServiceAgent.'],
    local: [],
  },
  safety: {
    writes: 'Temporarily points the default bucket release at a ruleset containing one unique run namespace; writes three Firestore docs and only small objects beneath that namespace.',
    cleanup: 'A finally block restores the exact prior Storage ruleset pointer, deletes every run-scoped object/document with admin credentials, verifies the release pointer, lists the object prefix, and requires every document read to return 404 before writing an observation.',
    unattendedSafe: false,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy: 'Checked against the installed Firebase SDK by the conformance freshness guard.',
  },
};
