import type { RigManifestRecord } from './types.ts';

/**
 * The FCM send-plane rig (`packages/conformance/src/messaging-send-probes.ts`). Gets a
 * short-lived OAuth token from the messaging credential (Application Default
 * Credentials on the oracle project, or a base64 key) and POSTs crafted
 * payloads to the production FCM v1 `messages:send` endpoint, capturing what
 * production accepts and the exact error envelopes it returns as
 * `messaging-send-` observations. Send-plane behavior is server-side and not
 * pinned to an installed client SDK; each capture records `adminSdkVersion`
 * (the firebase-admin transport used) and `observedAt`, and drift is detected
 * by re-running and diffing.
 */
export const rig: RigManifestRecord = {
  description:
    'Gets an OAuth token from the messaging credential (ADC or a key) and POSTs crafted payloads to the production FCM v1 messages:send endpoint; captures what production accepts and the exact error envelopes as messaging-send- observations.',
  script: 'packages/conformance/src/messaging-send-probes.ts',
  observationPrefixes: ['messaging-send-'],
  automation: 'credentialed',
  network: 'firebase-production',
  requires: {
    env: [
      {
        name: 'PYRIC_MESSAGING_PROJECT_ID',
        description:
          'The messaging project id, read when PYRIC_MESSAGING_SA_BASE64 is unset. Optional: unset, the rig sends for PYRIC_ORACLE_PROJECT_ID, the oracle project (digame-mas). The rig then authenticates with Application Default Credentials from `gcloud auth application-default login --impersonate-service-account=<project service account>`, through src/messaging-credential.ts, and refuses an account that is not a service account of this project.',
        permission: 'cloudmessaging.messages.create (FCM send)',
      },
      {
        name: 'PYRIC_ORACLE_PROJECT_ID',
        description:
          'The oracle project id. The messaging project when PYRIC_MESSAGING_PROJECT_ID and PYRIC_MESSAGING_SA_BASE64 are both unset.',
      },
      {
        name: 'PYRIC_MESSAGING_SA_BASE64',
        description:
          'Optional base64-encoded service-account key JSON. When set, the rig sends with the key instead of Application Default Credentials, and the key names the project. A set PYRIC_MESSAGING_PROJECT_ID must match it.',
        permission: 'cloudmessaging.messages.create (FCM send)',
      },
    ],
    projectFeatures: [
      'Cloud Messaging (FCM v1) enabled on the messaging project (the oracle project, digame-mas, unless PYRIC_MESSAGING_PROJECT_ID names another).',
    ],
    local: [
      'Installed firebase-admin package in node_modules (already a workspace dependency), the send transport; no client firebase SDK is involved on the send plane.',
      'Under ADC: a gcloud application-default login that impersonates a service account of the messaging project, as packages/conformance/docs/oracle-project-setup.md describes.',
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
      'Checked by packages/conformance/src/check-observation-versions.ts against the installed node_modules/firebase-admin/package.json version — send observations carry adminSdkVersion, not fbSdkVersion. The value records the transport the capture ran through; the server behavior itself is not SDK-pinned, so drift is caught by re-running and diffing.',
  },
};
