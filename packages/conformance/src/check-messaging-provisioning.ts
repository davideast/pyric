/**
 * Messaging provisioning check — resolves wayfinder ticket #54's criterion:
 * a headless dry-run send succeeds against the FCM HTTP v1 API, and
 * deliberately malformed sends return their real error envelopes.
 *
 * This is provisioning VERIFICATION, not observation capture: results print
 * to stdout as JSON for the ticket's resolution comment. Registry-linked
 * observation captures come later under the FCM domain-model ticket (#45),
 * in the house observation format, once rows exist to cite them.
 *
 * Requires a credential whose account carries cloudmessaging.messages.create
 * (for example Firebase Cloud Messaging API Admin), from
 * src/messaging-credential.ts: PYRIC_MESSAGING_PROJECT_ID (or
 * PYRIC_ORACLE_PROJECT_ID) with Application Default Credentials, or
 * PYRIC_MESSAGING_SA_BASE64, whose key names its own project.
 *
 * Run: bun run packages/conformance/src/check-messaging-provisioning.ts
 *
 * No VAPID key needed here: that is browser-side token registration, which
 * stays deferred. This script exercises only the send plane.
 */
import { loadMessagingServiceAccount, messagingAccessToken, messagingSendEndpoint } from './messaging-credential.ts';

const sa = await loadMessagingServiceAccount().catch((error: unknown) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
const projectId = sa.project_id;
const ENDPOINT = messagingSendEndpoint(sa);

interface ProbeResult {
  status: number;
  body: unknown;
}

async function post(payload: unknown): Promise<ProbeResult> {
  const access_token = await messagingAccessToken(sa);
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  return { status: res.status, body };
}

// Probe 1 — the success criterion. A dry-run send to a TOPIC needs no
// registration token, so it can succeed with zero browser setup. Expect
// HTTP 200 and a message name of the form projects/<id>/messages/<mid>.
const dryRunTopic = await post({
  validate_only: true,
  message: {
    topic: 'pyric-provision-check',
    notification: { title: 'provision check', body: 'dry run, never delivered' },
  },
});

// Probe 2 — malformed send (no target at all). Captures the real
// google.rpc error envelope the local send server (#50) must mirror.
const malformed = await post({ validate_only: true, message: {} });

// Probe 3 — invalid registration token. The other error shape #50 needs:
// what a bad token looks like on the wire.
const badToken = await post({
  validate_only: true,
  message: { token: 'not-a-real-fcm-registration-token' },
});

const report = {
  projectId,
  endpoint: ENDPOINT,
  probes: {
    dryRunTopic,
    malformed,
    badToken,
  },
};
console.log(JSON.stringify(report, null, 2));

const ok =
  dryRunTopic.status === 200 &&
  malformed.status >= 400 &&
  typeof malformed.body === 'object' &&
  badToken.status >= 400 &&
  typeof badToken.body === 'object';

if (ok) {
  console.error('\n✓ Provisioning verified: dry-run send succeeds; error envelopes captured.');
} else {
  console.error('\n✗ Provisioning incomplete — see report above. Common causes: FCM v1 API not enabled, service-account role missing cloudmessaging.messages.create.');
  process.exit(1);
}
