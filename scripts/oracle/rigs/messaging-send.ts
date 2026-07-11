import type { RigManifestRecord } from './types.ts';

/**
 * The FCM send-plane rig (`scripts/oracle/messaging-send-probes.ts`). Mints a
 * short-lived OAuth token from a provisioned service account and POSTs crafted
 * payloads to the production FCM v1 `messages:send` endpoint, capturing what
 * production accepts and the exact error envelopes it returns as
 * `messaging-send-` observations. Send-plane behavior is server-side and not
 * pinned to an installed client SDK; each capture records `adminSdkVersion`
 * (the firebase-admin transport used) and `observedAt`, and drift is detected
 * by re-running and diffing.
 */
export const rig: RigManifestRecord = {
  description:
    'Mints an OAuth token from a service account and POSTs crafted payloads to the production FCM v1 messages:send endpoint; captures what production accepts and the exact error envelopes as messaging-send- observations.',
  script: 'scripts/oracle/messaging-send-probes.ts',
  observationPrefixes: ['messaging-send-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_MESSAGING_SA_BASE64',
        description:
          'Base64-encoded service-account JSON for a project with Cloud Messaging enabled. The rig mints a short-lived OAuth access token from it and calls the FCM v1 send endpoint for that project.',
        permission: 'cloudmessaging.messages.create (FCM send)',
      },
    ],
    projectFeatures: [
      'Cloud Messaging (FCM v1) enabled on the project the service account belongs to.',
    ],
    local: [
      'Installed firebase-admin package in node_modules (already a workspace dependency) — used to mint the OAuth token; no client firebase SDK is involved on the send plane.',
    ],
  },
  safety: {
    writes:
      'POSTs real messages to the FCM v1 send endpoint. Accepted payloads target test tokens/topics and deliver nothing meaningful; the error-envelope captures are rejected by design. No project-side resource is provisioned or persisted.',
    cleanup:
      'Not applicable — sends are ephemeral and mutate no stored state. The firebase-admin app is deleted on exit so the process leaves no live handle.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'adminSdkVersion',
    policy:
      'Checked by scripts/oracle/check-observation-versions.ts against the installed node_modules/firebase-admin/package.json version — send observations carry adminSdkVersion, not fbSdkVersion. The value records the transport the capture ran through; the server behavior itself is not SDK-pinned, so drift is caught by re-running and diffing.',
  },
};
