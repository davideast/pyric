import type { RigManifestRecord } from './types.ts';

export const rig: RigManifestRecord = {
  description:
    'Credentialed firebase-admin Firestore behavior probes against the dedicated production oracle project.',
  script: 'packages/conformance/src/admin-firestore-probes.ts',
  observationPrefixes: ['admin-firestore-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_ORACLE_SA_PATH',
        description: 'Path to the dedicated oracle project service-account JSON.',
      },
    ],
    projectFeatures: ['Cloud Firestore provisioned in the dedicated oracle project.'],
    local: ['Installed firebase-admin package.'],
  },
  safety: {
    writes:
      'One run-scoped document under pyric_oracle, written through the Admin SDK in the dedicated oracle project.',
    cleanup:
      'The run-scoped document is deleted in a finally block and the temporary Admin app is deleted.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'adminSdkVersion',
    policy:
      'Checked against the installed firebase-admin package; live behavior drift is detected by verify-mode replay.',
  },
};
