import type { RigManifestRecord } from './types.ts';

export const rig: RigManifestRecord = {
  description: 'Real-resource Storage-to-Firestore lookup budget, evaluation, type/path, and Firestore-rules independence probes with exact release restoration and run-scoped data cleanup verification.',
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
    local: ['Exclusive /tmp lock prevents overlapping real-resource runs from mutating the same Rules releases.'],
  },
  safety: {
    writes: 'Temporarily points the default bucket release at a ruleset containing one unique run namespace; advanced mode also points the Firestore release at rulesets that alter only that namespace. It writes three Firestore docs and only 5-byte objects beneath the namespace. IAM-enabled mode waits two minutes, then retries only the one-document case at 30-second intervals while waiting for role propagation.',
    cleanup: 'A finally block restores the exact prior Storage and, in advanced mode, Firestore ruleset pointers; deletes every run-scoped object/document with admin credentials; verifies release pointers; lists the object prefix; and requires every document read to return 404. Temporary-IAM mode also waits through a propagation interval, verifies the original policy again, and repeats restoration once if the binding reappears before writing an observation.',
    unattendedSafe: false,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy: 'Checked against the installed Firebase SDK by the conformance freshness guard.',
  },
};
