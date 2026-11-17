import type { RigManifestRecord } from './types.ts';

/**
 * Modular firebase-admin Auth oracle runner (`packages/conformance/src/admin-auth-probes.ts`).
 */
export const rig: RigManifestRecord = {
  description:
    'Credentialed firebase-admin Auth behavior probes against the dedicated production oracle project.',
  script: 'packages/conformance/src/admin-auth-probes.ts',
  observationPrefixes: [],
  pendingPrefixes: ['admin-auth-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_ORACLE_PROJECT_ID',
        description:
          'Oracle Firebase project id when authenticating through Workload Identity Federation or Application Default Credentials.',
        permission: 'roles/firebaseauth.admin (identitytoolkit.googleapis.com)',
      },
      {
        name: 'PYRIC_ORACLE_SA_PATH',
        description:
          'Optional service-account key JSON path when not using Application Default Credentials.',
        permission: 'roles/firebaseauth.admin (identitytoolkit.googleapis.com)',
      },
    ],
    projectFeatures: ['Firebase Authentication / Identity Platform enabled in the dedicated oracle project.'],
    local: ['Installed firebase-admin package.'],
  },
  safety: {
    writes:
      'Run-scoped synthetic Auth users with pyric-probe-<runId> UIDs in the dedicated oracle project.',
    cleanup:
      'Every run-created UID is tracked prior to creation and deleted in a finally block before deleting the temporary Admin app.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'adminSdkVersion',
    policy:
      'Checked by packages/conformance/src/check-observation-versions.ts against the installed firebase-admin package version.',
  },
};
