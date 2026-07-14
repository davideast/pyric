import type { RigManifestRecord } from './types.ts';

export const rig: RigManifestRecord = {
  description:
    'Deploys an isolated firebase-functions v2 RTDB onValueCreated fixture, writes namespaced inputs, and freezes the structured events observed from production.',
  script: 'packages/conformance/src/capture/functions-rtdb/harness.ts',
  observationPrefixes: ['functions-rtdb-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_FUNCTIONS_RTDB_SA_PATH',
        description: 'Path to the deployer service-account JSON.',
        permission:
          'Cloud Functions Developer, Service Account User on the runtime identity, Firebase/RTDB Admin, Service Usage API Keys Viewer, and Logs Viewer.',
      },
    ],
    projectFeatures: [
      'Blaze billing and an active Realtime Database in the same region as the fixture.',
      'Cloud Functions v2, Cloud Run, Cloud Build, Artifact Registry, Eventarc, Pub/Sub, and Realtime Database APIs enabled.',
    ],
    local: ['Firebase CLI and the fixture package under src/capture/functions-rtdb/fixture.'],
  },
  safety: {
    writes:
      'Deploys only pyric-prefixed fixture functions and writes only below /pyric_oracle/functions/<runId>.',
    cleanup:
      'Removes the run namespace and deletes fixture functions in a finally block unless --keep-deployed is explicitly supplied.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'functionsSdkVersion',
    policy:
      'Checked against the installed firebase-functions package by check-observation-versions.ts; captures must be regenerated after a Functions SDK version change.',
  },
};
