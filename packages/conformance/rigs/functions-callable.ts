import type { RigManifestRecord } from './types.ts';

export const rig: RigManifestRecord = {
  description:
    'Deploys the isolated firebase-functions callable onCall fixture (4 v2 callables and 1 v1 callable) plus a short-lived Hosting preview channel, provisions one run-scoped Firebase Auth user and App Check debug token, captures all wire and Chromium client probes, and deletes every deployed resource.',
  script: 'packages/conformance/src/capture/functions-callable/harness.ts',
  observationPrefixes: [],
  pendingPrefixes: ['functions-callable-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_ORACLE_PROJECT_ID',
        description:
          'Oracle Firebase project id when authenticating through Workload Identity Federation or Application Default Credentials.',
        permission:
          'Cloud Functions Developer, Service Account User on the runtime identity, Cloud Run Admin, Firebase Hosting Admin, Firebase Authentication Admin, Firebase App Check Admin, Logs Viewer, Artifact Registry Repository Administrator, and Firebase Viewer.',
      },
      {
        name: 'PYRIC_ORACLE_SA_PATH',
        description:
          'Optional path to the deployer service-account key JSON when not using Application Default Credentials.',
        permission:
          'Cloud Functions Developer, Service Account User on the runtime identity, Cloud Run Admin, Firebase Hosting Admin, Firebase Authentication Admin, Firebase App Check Admin, Logs Viewer, Artifact Registry Repository Administrator, and Firebase Viewer.',
      },
      {
        name: 'PYRIC_ORACLE_FIREBASE_CONFIG',
        description:
          'Optional Firebase web app config JSON for the oracle project; when unset, read from the project web app via the Firebase Management API.',
        permission: 'firebase.projects.get and firebase.clients.get',
      },
    ],
    projectFeatures: [
      'Blaze billing, Firebase Authentication, Firebase App Check, and Firebase Hosting enabled in the dedicated oracle project.',
      'Cloud Functions v2, Cloud Run, Cloud Build, Artifact Registry, Eventarc, and Firebase Hosting APIs enabled.',
    ],
    local: [
      'Pinned workspace firebase-tools 15.23.0, Playwright Chromium, and the fixture package under src/capture/functions-callable/fixture.',
    ],
  },
  safety: {
    writes:
      'Deploys only pyricCallable*-prefixed fixture functions in codebase pyric-functions-callable-oracle, one 1-day Hosting preview channel named pyric-fn-call-<runId>, one run-scoped Auth user, and one run-scoped App Check debug token.',
    cleanup:
      'Deletes the run-scoped Auth user, App Check debug token, Hosting preview channel, every fixture function across regions, and their gcf-artifacts container images in a finally block (and recovers interrupted runs via capture-state.json) unless --keep-deployed is explicitly supplied.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'functionsSdkVersion',
    policy:
      'Checked against the installed firebase-functions package by check-observation-versions.ts; captures must be regenerated after a Functions SDK version change.',
  },
};
