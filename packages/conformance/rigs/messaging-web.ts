import type { RigManifestRecord } from './types.ts';

/**
 * The FCM web receive-plane rig (`src/rigs/messaging-web/harness.ts`).
 * Serves a real `firebase/messaging` app on localhost, launches HEADED
 * Chromium via Playwright against one reused persistent Chrome profile, and
 * drives token minting, foreground `onMessage`, service-worker
 * `onBackgroundMessage`, visibility routing, and `deleteToken` while a real
 * message is pushed from the send plane. Structural facts are captured as
 * `messaging-web-` observations. Real push delivery arrives over the browser's
 * live GCM channel, which needs a headed browser and a person able to confirm
 * the run — this rig cannot be trusted to run itself in CI.
 */
export const rig: RigManifestRecord = {
  description:
    'Serves a real firebase/messaging app and drives HEADED Chromium (Playwright, persistent profile) through token minting, onMessage, onBackgroundMessage, visibility routing, and deleteToken against live push; captures structural facts as messaging-web- observations.',
  script: 'packages/conformance/src/rigs/messaging-web/harness.ts',
  observationPrefixes: ['messaging-web-'],
  automation: 'human-witnessed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_MESSAGING_FIREBASE_CONFIG',
        description:
          'Web app config JSON (apiKey/projectId/appId/messagingSenderId/…) for the same project as the VAPID key and service account. Bundled into the served app so the client SDK talks to the real project.',
      },
      {
        name: 'PYRIC_MESSAGING_VAPID_KEY',
        description:
          'Web Push certificate public key (VAPID) for the project. Passed to getToken so the browser can subscribe to push.',
      },
      {
        name: 'PYRIC_MESSAGING_SA_BASE64',
        description:
          'Base64-encoded send-capable service-account JSON for the same project. The driver uses firebase-admin to push real messages to the minted token so the client and service worker can observe delivery.',
        permission: 'cloudmessaging.messages.create (FCM send)',
      },
    ],
    projectFeatures: [
      'Cloud Messaging enabled on the project, with a Web Push (VAPID) certificate configured.',
    ],
    local: [
      'Playwright with a Chromium build installed (resolved from packages/playground/node_modules — run bun install there).',
      'A headed display session: the harness re-execs under caffeinate on macOS and launches a HEADED, push-capable browser, so it cannot run on a headless CI worker.',
      'A persistent Chrome profile under TMPDIR (launchPersistentContext) — incognito disables web push, so a persistent profile is mandatory and is reused across scenarios in one run.',
    ],
  },
  safety: {
    writes:
      'Serves a localhost app and writes messaging-web- observation files. The driver pushes real FCM messages to the token the run itself minted; nothing else project-side is mutated.',
    cleanup:
      'The deleteToken scenario unregisters the token it minted. The persistent Chrome profile is left under TMPDIR by design so a subsequent run reuses its push subscription.',
    unattendedSafe: false,
  },
  freshness: {
    versionField: 'fbSdkVersion',
    policy:
      'Checked by packages/conformance/src/check-observation-versions.ts against the installed node_modules/firebase/package.json version — client-plane captures carry fbSdkVersion. The single cross-plane deleteToken-then-server-send capture additionally records adminSdkVersion for the transport that sent to the dead token.',
  },
};
