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

await deleteApp(app);
console.log('\nDone. Register the messaging- prefix and exceptions before running compat:validate.');
