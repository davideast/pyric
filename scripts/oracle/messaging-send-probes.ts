/**
 * Messaging send-plane probes — the first `messaging-*` observations.
 *
 * Captures what production FCM's send plane actually does, in the house
 * observation format, using the service account provisioned in wayfinder
 * ticket #54. Send-plane behavior is SERVER-side: unlike client-SDK
 * observations it is not pinned by an installed SDK version. Each capture
 * records `adminSdkVersion` (the transport used) and `observedAt`; drift is
 * detected by re-running and diffing, same as every other observation.
 *
 * Rows do not exist yet (the messaging surface is being admitted born
 * unverified under the CDD map, #43), so every capture ships with
 * `rowIds: []` and an observationExceptions entry, mirroring how the
 * admin-app captures landed pre-matrix.
 *
 * Requires: PYRIC_MESSAGING_SA_BASE64.
 * Run: bun run scripts/oracle/messaging-send-probes.ts
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert, deleteApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { ServiceAccount } from 'firebase-admin/app';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_DIR = join(HERE, 'observations');

const b64 = process.env.PYRIC_MESSAGING_SA_BASE64;
if (!b64) {
  console.error('✗ PYRIC_MESSAGING_SA_BASE64 is not set.');
  process.exit(1);
}
const sa = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as ServiceAccount & { project_id?: string };
const projectId = (sa.projectId ?? sa.project_id)!;

const adminSdkVersion = (
  JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('firebase-admin/package.json')), 'utf8')) as { version: string }
).version;

const app = initializeApp({ credential: cert(sa) }, 'messaging-send-probes');
const ENDPOINT = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

async function rawSend(payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const { access_token } = await app.options.credential!.getAccessToken();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function writeObservation(name: string, description: string, behavior: Record<string, unknown>): void {
  const obs = {
    name,
    matrixRow: 'messaging (no rows yet; surface admitted born-unverified under the CDD map)',
    rowIds: [] as string[],
    description,
    observedAt: new Date().toISOString(),
    adminSdkVersion,
    projectId,
    behavior,
  };
  writeFileSync(join(OBS_DIR, `${name}.json`), JSON.stringify(obs, null, 2) + '\n');
  console.log(`✓ ${name}`);
}

/** Strip run-specific noise: message ids vary per send; the FORMAT is the fact. */
function nameFacts(name: string) {
  const m = /^projects\/([^/]+)\/messages\/(.+)$/.exec(name);
  return {
    matchesProjectsMessagesFormat: m !== null,
    projectSegmentMatchesProject: m?.[1] === projectId,
    messageIdIsNumericString: m ? /^\d+$/.test(m[2]!) : false,
  };
}

/**
 * Capture an error case under BOTH validate_only=true and validate_only=false
 * for the same message, and report whether the two envelopes are byte-identical.
 * Real (validate_only=false) sends of an invalid message error during server-side
 * validation before any delivery, so this is safe and delivers nothing. The
 * envelope is a static server fact (fixed strings, no project data), so it is
 * captured whole; `realSendEnvelopeIdentical` is the parity fact callers care about.
 */
async function errorEnvelopeParity(message: unknown): Promise<{
  status: number;
  error: unknown;
  realStatus: number;
  realSendEnvelopeIdentical: boolean;
}> {
  const dry = await rawSend({ validate_only: true, message });
  const real = await rawSend({ validate_only: false, message });
  return {
    status: dry.status,
    error: dry.body.error,
    realStatus: real.status,
    realSendEnvelopeIdentical:
      dry.status === real.status && JSON.stringify(dry.body.error) === JSON.stringify(real.body.error),
  };
}

// Probe 1 — real send to a zero-subscriber topic: the accept path.
{
  const real = await getMessaging(app).send({
    topic: 'pyric-oracle-messaging-probe',
    notification: { title: 'oracle probe', body: 'accept-path capture; zero subscribers' },
    data: { source: 'messaging-send-probes' },
  });
  const dry = await getMessaging(app).send(
    { topic: 'pyric-oracle-messaging-probe', notification: { title: 'oracle probe', body: 'dry run' } },
    true,
  );
  writeObservation(
    'messaging-send-topic-accepted',
    'firebase-admin/messaging send() to a topic: FCM accepts and returns the message resource name projects/<projectId>/messages/<numeric id>. dryRun=true returns a name in the SAME format (fake id), so callers cannot distinguish validation from acceptance by shape alone.',
    {
      realSend: nameFacts(real),
      dryRunSend: nameFacts(dry),
      dryRunSameShapeAsReal: true,
    },
  );
}

// Probe 2 — target-less send: the malformed-request error envelope.
{
  const { status, body } = await rawSend({ validate_only: true, message: {} });
  writeObservation(
    'messaging-send-no-target-error-envelope',
    'v1 messages:send with no recipient: HTTP 400, google.rpc envelope with status INVALID_ARGUMENT, details carrying BOTH google.rpc.BadRequest (fieldViolations naming the field) and google.firebase.fcm.v1.FcmError (errorCode). Detail ORDER differs across error cases and is not a contract.',
    { status, error: body.error },
  );
}

// Probe 3 — invalid registration token: the bad-token error envelope.
{
  const { status, body } = await rawSend({
    validate_only: true,
    message: { token: 'not-a-real-fcm-registration-token' },
  });
  writeObservation(
    'messaging-send-invalid-token-error-envelope',
    'v1 messages:send with a syntactically invalid registration token: HTTP 400 INVALID_ARGUMENT; fieldViolations names message.token; FcmError errorCode INVALID_ARGUMENT. Note details array order differs from the no-target case.',
    { status, error: body.error },
  );
}

// Probe 4 — condition-target acceptance: the "'a' in topics && 'b' in topics" shape.
{
  const condition = "'pyric-oracle-a' in topics && 'pyric-oracle-b' in topics";
  const real = await getMessaging(app).send({
    condition,
    notification: { title: 'oracle probe', body: 'condition accept-path; zero subscribers' },
    data: { source: 'messaging-send-probes' },
  });
  const dry = await getMessaging(app).send(
    { condition, notification: { title: 'oracle probe', body: 'condition dry run' } },
    true,
  );
  writeObservation(
    'messaging-send-condition-accepted',
    "firebase-admin/messaging send() with a condition target of the form \"'a' in topics && 'b' in topics\": FCM accepts and returns projects/<projectId>/messages/<numeric id>, the same resource-name shape as a direct topic send, with no subscribers required. dryRun=true returns the same shape. rowIds land with the registry-admission ticket.",
    {
      realSend: nameFacts(real),
      dryRunSend: nameFacts(dry),
      dryRunSameShapeAsReal: true,
    },
  );
}

// Probe 5 — invalid condition: the malformed-condition error envelope (+ validate_only parity).
{
  const parity = await errorEnvelopeParity({
    condition: "'pyric-oracle-a' in topics &&",
    notification: { title: 'oracle probe', body: 'invalid condition' },
  });
  writeObservation(
    'messaging-send-invalid-condition-error-envelope',
    'v1 messages:send with a syntactically malformed condition ("\'a\' in topics &&", dangling operator): the error envelope FCM returns (HTTP status + google.rpc envelope). realSendEnvelopeIdentical records whether validate_only=false returns the byte-identical envelope. rowIds land with the registry-admission ticket.',
    parity,
  );
}

// Probe 6 — invalid topic NAME: the bad-topic-name error envelope (+ validate_only parity).
{
  const parity = await errorEnvelopeParity({
    topic: 'bad#topic!name',
    notification: { title: 'oracle probe', body: 'invalid topic name' },
  });
  writeObservation(
    'messaging-send-invalid-topic-name-error-envelope',
    "v1 messages:send with a topic name containing characters outside the documented [a-zA-Z0-9-_.~%] set ('bad#topic!name'): the error envelope FCM returns. realSendEnvelopeIdentical records validate_only=false parity. rowIds land with the registry-admission ticket.",
    parity,
  );
}

// Probe 7 — payload-size limit: documented cap is 4096 bytes; capture the oversized
// error envelope, then bisect the actual accept/reject boundary (validate_only only, cheap).
{
  const DOCUMENTED_CAP_BYTES = 4096;
  const oversizedValueLen = 8192; // comfortably over the 4KB documented cap
  const mkMessage = (len: number) => ({
    topic: 'pyric-oracle-messaging-probe',
    data: { p: 'x'.repeat(len) },
  });

  // The oversized error envelope (with validate_only parity).
  const parity = await errorEnvelopeParity(mkMessage(oversizedValueLen));

  // Bisect the boundary: largest accepted vs smallest rejected single data value
  // length under a minimal topic message. validate_only=true => nothing delivered.
  const accepts = async (len: number) =>
    (await rawSend({ validate_only: true, message: mkMessage(len) })).status === 200;
  let lo = 0; // known-accepted floor
  let hi = oversizedValueLen; // known-rejected ceiling
  let bisectRequests = 0;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await accepts(mid)) lo = mid;
    else hi = mid;
    bisectRequests++;
  }

  writeObservation(
    'messaging-send-oversized-payload-error-envelope',
    `v1 messages:send with a data payload over the documented 4096-byte cap: the error envelope FCM returns, plus the bisected accept/reject boundary. behavior.documentedCapBytes is the published cap; largestAcceptedDataValueLen/smallestRejectedDataValueLen pin where a minimal single-field topic message actually flips (value length, not total bytes — total includes JSON framing). realSendEnvelopeIdentical records validate_only parity. rowIds land with the registry-admission ticket.`,
    {
      documentedCapBytes: DOCUMENTED_CAP_BYTES,
      oversizedDataValueLen: oversizedValueLen,
      ...parity,
      largestAcceptedDataValueLen: lo,
      smallestRejectedDataValueLen: hi,
      bisectRequests,
    },
  );
}

// Probe 8 — notification-only vs data-only acceptance.
{
  const notifOnly = await getMessaging(app).send({
    topic: 'pyric-oracle-messaging-probe',
    notification: { title: 'oracle probe', body: 'notification-only accept path' },
  });
  const dataOnly = await getMessaging(app).send({
    topic: 'pyric-oracle-messaging-probe',
    data: { source: 'messaging-send-probes', kind: 'data-only' },
  });
  writeObservation(
    'messaging-send-notification-only-vs-data-only-accepted',
    'firebase-admin/messaging send() to a topic with ONLY a notification block, and separately with ONLY a data block: FCM accepts both and returns the same projects/<projectId>/messages/<numeric id> resource-name shape; neither a data nor a notification block is individually required. rowIds land with the registry-admission ticket.',
    {
      notificationOnly: nameFacts(notifOnly),
      dataOnly: nameFacts(dataOnly),
      bothAccepted: true,
    },
  );
}

// Probe 9 — webpush-specific config acceptance: webpush.headers.TTL + webpush.fcmOptions.link.
{
  const real = await getMessaging(app).send({
    topic: 'pyric-oracle-messaging-probe',
    notification: { title: 'oracle probe', body: 'webpush config accept path' },
    webpush: {
      headers: { TTL: '3600' },
      fcmOptions: { link: 'https://example.com/oracle' },
    },
  });
  const dry = await getMessaging(app).send(
    {
      topic: 'pyric-oracle-messaging-probe',
      notification: { title: 'oracle probe', body: 'webpush dry run' },
      webpush: { headers: { TTL: '3600' }, fcmOptions: { link: 'https://example.com/oracle' } },
    },
    true,
  );
  writeObservation(
    'messaging-send-webpush-config-accepted',
    'firebase-admin/messaging send() with a webpush config carrying headers.TTL="3600" and fcmOptions.link="https://example.com/oracle": FCM accepts and returns the standard resource-name shape. dryRun=true matches. rowIds land with the registry-admission ticket.',
    {
      realSend: nameFacts(real),
      dryRunSend: nameFacts(dry),
      dryRunSameShapeAsReal: true,
    },
  );
}

// Probe 10 — invalid webpush TTL value: the error envelope (+ validate_only parity).
{
  const parity = await errorEnvelopeParity({
    topic: 'pyric-oracle-messaging-probe',
    notification: { title: 'oracle probe', body: 'invalid webpush TTL' },
    webpush: { headers: { TTL: 'not-a-number' } },
  });
  writeObservation(
    'messaging-send-webpush-invalid-ttl-error-envelope',
    'v1 messages:send with webpush.headers.TTL set to a non-numeric value ("not-a-number"): the error envelope FCM returns. realSendEnvelopeIdentical records validate_only=false parity. rowIds land with the registry-admission ticket.',
    parity,
  );
}

await deleteApp(app);
console.log('\nDone. Register the messaging- prefix and exceptions before running compat:validate.');
