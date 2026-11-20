import type { RigManifestRecord } from './types.ts';

export const rig: RigManifestRecord = {
  description:
    'Deploys the isolated firebase-functions HTTP onRequest fixture (11 v2 functions and 1 v1 function) plus a short-lived Hosting preview channel, sends every HTTP probe, freezes structured observations, and deletes all deployed resources.',
  script: 'packages/conformance/src/capture/functions-http/harness.ts',
  observationPrefixes: [],
  pendingPrefixes: ['functions-http-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_ORACLE_PROJECT_ID',
        description:
          'Oracle Firebase project id when authenticating through Workload Identity Federation or Application Default Credentials.',
        permission:
          'Cloud Functions Developer, Service Account User on the runtime identity, Cloud Run Admin, Firebase Hosting Admin, Logs Viewer, Artifact Registry Repository Administrator, and Firebase Viewer.',
      },
      {
        name: 'PYRIC_ORACLE_SA_PATH',
        description:
          'Optional path to the deployer service-account key JSON when not using Application Default Credentials.',
        permission:
          'Cloud Functions Developer, Service Account User on the runtime identity, Cloud Run Admin, Firebase Hosting Admin, Logs Viewer, Artifact Registry Repository Administrator, and Firebase Viewer.',
      },
    ],
    projectFeatures: [
      'Blaze billing and Firebase Hosting enabled in the dedicated oracle project.',
      'Cloud Functions v2, Cloud Run, Cloud Build, Artifact Registry, Eventarc, and Firebase Hosting APIs enabled.',
    ],
    local: [
      'Pinned workspace firebase-tools 15.23.0 and the fixture package under src/capture/functions-http/fixture.',
    ],
  },
  safety: {
    writes:
      'Deploys only pyricHttp*-prefixed fixture functions in codebase pyric-functions-http-oracle and one 1-day Hosting preview channel named pyric-fn-http-<runId>.',
    cleanup:
      'Deletes the Hosting preview channel, every fixture function across regions, and their gcf-artifacts container images in a finally block (and recovers interrupted runs via capture-state.json) unless --keep-deployed is explicitly supplied.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'functionsSdkVersion',
    policy:
      'Checked against the installed firebase-functions package by check-observation-versions.ts; captures must be regenerated after a Functions SDK version change.',
  },
};
