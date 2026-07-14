import type { RigManifestRecord } from './types.ts';

/**
 * The client app-registry rig (`packages/conformance/src/app-registry-probes.ts`).
 * Pure in-process probes of the INSTALLED `firebase/app` package's app registry
 * — initializeApp default/named/duplicate semantics, getApp/getApps/deleteApp,
 * the `app/no-app` / `app/duplicate-app` / `app/app-deleted` error shapes,
 * `SDK_VERSION`, the `FirebaseError` class, and the observable
 * onLog/setLogLevel/registerVersion logging seam, and default/named service
 * container association. No credentials, no project,
 * no network: every fact it measures lives inside the installed `firebase`
 * package itself. Captures `app-registry-` observations.
 *
 * The client analog of the admin-app rig (rigs/admin-app.ts): that one probes
 * firebase-admin's in-process AppStore; this one probes firebase (client)'s.
 */
export const rig: RigManifestRecord = {
  description:
    'Pure in-process probes of the installed firebase/app client app registry (initializeApp default/named/duplicate, getApp/getApps/deleteApp, default/named service containers, app/no-app + app/duplicate-app + app/app-deleted error shapes, SDK_VERSION, FirebaseError, onLog/setLogLevel/registerVersion logging seam); no credentials or network. Captures app-registry- observations.',
  script: 'packages/conformance/src/app-registry-probes.ts',
  observationPrefixes: ['app-registry-'],
  automation: 'unattended',
  network: 'none',
  requires: {
    env: [],
    projectFeatures: [],
    local: [
      'Installed firebase package in node_modules (already a workspace dependency) — no Firebase project or credential is needed. initializeApp is fed placeholder FirebaseOptions; service handles are constructed for container-identity probes, but no service operation or network request is issued.',
    ],
  },
  safety: {
    writes:
      'None — probes call the in-process client App registry only (initializeApp/getApp/getApps/deleteApp) and the process-global logger (onLog/setLogLevel/registerVersion). No Firebase service is opened, so nothing reaches a real project.',
    cleanup:
      'deleteApp() is called for every registered app between probes so the process-global app registry starts empty for the next probe; the onLog probe clears its own log handler and restores the log level in a finally block. Probes stay independent.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy:
      'Checked by packages/conformance/src/check-observation-versions.ts against the installed node_modules/firebase/package.json version — the same firebase client SDK version the oracle-run rig tracks.',
  },
};
