import type { RigManifestRecord } from './types.ts';

export const rig: RigManifestRecord = {
  description:
    'Runs the installed Firebase Web SDK in real headless Chromium against the dedicated production oracle project; captures equal-config multi-app backend, Auth-session, deletion-listener, retained-Auth, and same-app cross-tab persistence topology.',
  script: 'packages/conformance/src/app-production-browser-probes.ts',
  observationPrefixes: ['app-production-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [{
      name: 'PYRIC_ORACLE_FIREBASE_CONFIG',
      description: 'Web SDK config JSON for the dedicated oracle Firebase project.',
    }],
    projectFeatures: [
      'Anonymous sign-in enabled.',
      'Firestore and RTDB rules permit authenticated access below /pyric_oracle/*.',
      'A Realtime Database instance is configured in the Web SDK config.',
    ],
    local: ['Playwright Chromium is installed.'],
  },
  safety: {
    writes: 'One run-scoped Firestore document, one RTDB value, and anonymous users in the dedicated oracle project.',
    cleanup:
      'The document, RTDB value, app-B users, and the cross-tab user are removed. The auth-A user, data-A user, and any user unexpectedly created through a retained deleted Auth handle may remain because their owning app is deliberately deleted before cleanup.',
    unattendedSafe: false,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy: 'Checked against the installed firebase package by the observation-version gate.',
  },
};
