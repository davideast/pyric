import type { RigManifestRecord } from './types.ts';

/**
 * Modular one-file-per-probe Web/client SDK oracle runner
 * (`packages/conformance/src/sdk-probes.ts`). Executes probe files under
 * `packages/conformance/probes/<surface>/<name>.ts` declaring `rig: 'sdk-probes'`
 * so new client SDK observations never touch `run.ts`.
 */
export const rig: RigManifestRecord = {
  description:
    'Modular one-file-per-probe client SDK oracle runner over packages/conformance/probes/<surface>/<name>.ts with isolated pyric_oracle/<runId> namespaces, dedicated RTDB pinning, and SIGINT/SIGTERM rules restoration.',
  script: 'packages/conformance/src/sdk-probes.ts',
  observationPrefixes: [],
  probeDeclaredOwnership: true,
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_ORACLE_PROJECT_ID',
        description:
          'Oracle Firebase project id when authenticating through Workload Identity Federation or Application Default Credentials.',
        permission:
          'roles/firebase.viewer, roles/datastore.user, roles/firebaserules.admin, roles/firebasedatabase.admin',
      },
      {
        name: 'PYRIC_ORACLE_SA_PATH',
        description:
          'Optional service-account key JSON path when not using Application Default Credentials.',
        permission:
          'roles/firebase.viewer, roles/datastore.user, roles/firebaserules.admin, roles/firebasedatabase.admin',
      },
      {
        name: 'PYRIC_ORACLE_FIREBASE_CONFIG',
        description:
          'Optional Web SDK config JSON override for the dedicated oracle project; when unset, discovered automatically via the Firebase Management REST API.',
      },
      {
        name: 'PYRIC_ORACLE_RTDB_URL',
        description:
          'Dedicated non-default RTDB instance URL (e.g. https://pyric-oracle-rtdb-2.firebaseio.com), required by RTDB modular probes.',
        permission: 'roles/firebasedatabase.admin',
      },
    ],
    projectFeatures: [
      'Anonymous sign-in enabled on the dedicated oracle project.',
      'Cloud Firestore and a dedicated non-default Realtime Database instance provisioned.',
    ],
    local: ['Installed firebase and firebase-admin packages.'],
  },
  safety: {
    writes:
      'Run-scoped documents/nodes under pyric_oracle/<runId> and temporary rules merges restored on completion or SIGINT/SIGTERM.',
    cleanup:
      'Deletes anonymous users, recursively deletes pyric_oracle/<runId> documents/nodes, and restores + verifies live rules in finally and signal handlers.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy:
      'Checked by packages/conformance/src/check-observation-versions.ts against the installed firebase package version.',
  },
};
