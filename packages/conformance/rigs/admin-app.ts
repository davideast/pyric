import type { RigManifestRecord } from './types.ts';

/**
 * The admin app-registry rig (`packages/conformance/src/admin-app-probes.ts`). Pure
 * in-process probes of the INSTALLED firebase-admin package's default-app
 * registry — initializeApp/getApp/getApps/deleteApp, no-arg accessor
 * resolution, and FirebaseAppError shapes. No credentials, no project, no
 * network: every fact it measures lives inside the installed
 * firebase-admin package itself. Captures `admin-app-` observations.
 */
export const rig: RigManifestRecord = {
  description:
    'Pure in-process probes of the installed firebase-admin app registry (initializeApp/getApp/getApps/deleteApp, no-arg accessor resolution, FirebaseAppError shapes); no credentials or network. Captures admin-app- observations.',
  script: 'packages/conformance/src/admin-app-probes.ts',
  observationPrefixes: ['admin-app-'],
  automation: 'unattended',
  network: 'none',
  requires: {
    env: [],
    projectFeatures: [],
    local: [
      'Installed firebase-admin package in node_modules (already a workspace dependency) — no service-account file, project, or credential of any kind is needed.',
    ],
  },
  safety: {
    writes:
      'None — probes call the in-process App registry only (initializeApp/getApp/getApps/deleteApp) and never reach a real project.',
    cleanup:
      'deleteApp() is called between probes so the process-global app registry starts clean for the next probe; probes stay independent.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'adminSdkVersion',
    policy:
      'Checked by packages/conformance/src/check-observation-versions.ts against the installed node_modules/firebase-admin/package.json version — NOT the firebase/package.json version the other three rigs track.',
  },
};
