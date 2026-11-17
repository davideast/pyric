/**
 * Messaging send-plane probes - `messaging-send-*` observations.
 *
 * Captures what production FCM's send plane actually does, in the house
 * observation format. Send-plane behavior is server-side: unlike client-SDK
 * observations it is not pinned by an installed SDK version. Each capture
 * records `adminSdkVersion` (the transport used) and `observedAt`; drift is
 * detected by re-running and diffing, same as every other observation.
 *
 * Requires: PYRIC_MESSAGING_PROJECT_ID (or PYRIC_ORACLE_PROJECT_ID) with
 * Application Default Credentials, or PYRIC_MESSAGING_SA_BASE64. See
 * src/messaging-credential.ts and docs/oracle-project-setup.md.
 *
 * Run all probes:
 *   bun run packages/conformance/src/messaging-send-probes.ts
 * Run one probe:
 *   bun run packages/conformance/src/messaging-send-probes.ts --probe <name>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import {
  loadMessagingServiceAccount,
  messagingAccessToken,
  messagingSendEndpoint,
} from './messaging-credential.ts';
import {
  MESSAGING_SEND_PROBES,
  type MessagingSendProbeMetadata,
} from './messaging-send-probe-catalog.ts';
import { oracleAppOptions, type OracleServiceAccount } from './oracle-credential.ts';
import { resolvedAdminVersion } from './package-version.ts';

export { MESSAGING_SEND_PROBES, type MessagingSendProbeMetadata };

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_DIR = join(HERE, '..', 'observations', 'messaging-admin');

type RawSendPayload = {
  validate_only: boolean;
  message: Record<string, unknown>;
};

export type RawSendFn = (
  payload: RawSendPayload,
) => Promise<{ status: number; body: Record<string, unknown> }>;

/** Strip run-specific noise: message ids vary per send; the format is the fact. */
function nameFacts(name: string, projectId: string) {
  const m = /^projects\/([^/]+)\/messages\/(.+)$/.exec(name);
  const messageId = m?.[2] ?? '';
  return {
    matchesProjectsMessagesFormat: m !== null,
    projectSegmentMatchesProject: m?.[1] === projectId,
    messageIdIsNumericString: m !== null && /^\d+$/.test(messageId),
  };
}

export function selectMessagingSendProbes(args: readonly string[]): MessagingSendProbeMetadata[] {
  const requested: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--probe') {
      const name = args[i + 1];
      if (!name || name.startsWith('--')) {
        throw new Error('--probe requires a messaging-send probe name');
      }
      requested.push(name);
      i += 1;
    } else if (arg && arg.startsWith('--probe=')) {
      const name = arg.slice('--probe='.length);
      if (!name) throw new Error('--probe requires a messaging-send probe name');
      requested.push(name);
    }
  }
  if (requested.length === 0) return [...MESSAGING_SEND_PROBES];

  const byName = new Map(MESSAGING_SEND_PROBES.map((probe) => [probe.name, probe]));
  return requested.map((name) => {
    const found = byName.get(name);
    if (!found) {
      throw new Error(
        `Unknown messaging-send probe '${name}'. Available: ${MESSAGING_SEND_PROBES.map((item) => item.name).join(', ')}`,
      );
    }
    return found;
  });
}

async function evaluateTtlHeaderCase(
  rawSend: RawSendFn,
  projectId: string,
  headerValue: string,
): Promise<Record<string, unknown>> {
  const message: Record<string, unknown> = {
    topic: 'pyric-oracle-messaging-probe',
    notification: { title: 'oracle probe', body: `lowercase webpush ttl ${headerValue}` },
    webpush: { headers: { ttl: headerValue } },
  };
  const dry = await rawSend({ validate_only: true, message });
  const real = await rawSend({ validate_only: false, message });
  const out: Record<string, unknown> = {
    headerKey: 'ttl',
    headerValue,
    dryRunStatus: dry.status,
    dryRunAccepted: dry.status === 200,
  };
  if (typeof dry.body.name === 'string') {
    out.dryRunName = nameFacts(dry.body.name, projectId);
  }
  if (dry.body.error !== undefined) {
    out.dryRunError = dry.body.error;
  }
  out.realSendStatus = real.status;
  out.realSendAccepted = real.status === 200;
  if (typeof real.body.name === 'string') {
    out.realSendName = nameFacts(real.body.name, projectId);
  }
  if (real.body.error !== undefined) {
    out.realSendError = real.body.error;
  }
  out.dryRunMatchesRealSend =
    dry.status === real.status &&
    JSON.stringify(dry.body.error ?? null) === JSON.stringify(real.body.error ?? null);
  return out;
}

export async function probeWebpushLowercaseTtl(
  rawSend: RawSendFn,
  projectId: string,
): Promise<Record<string, unknown>> {
  const validSixtySeconds = await evaluateTtlHeaderCase(rawSend, projectId, '60');
  const negativeOne = await evaluateTtlHeaderCase(rawSend, projectId, '-1');
  const nonNumericAbc = await evaluateTtlHeaderCase(rawSend, projectId, 'abc');
  return {
    validSixtySeconds,
    negativeOne,
    nonNumericAbc,
  };
}

interface ProbeExecutionContext {
  app: App;
  projectId: string;
  rawSend: RawSendFn;
  errorEnvelopeParity: (message: Record<string, unknown>) => Promise<{
    status: number;
    error: unknown;
    realStatus: number;
    realSendEnvelopeIdentical: boolean;
  }>;
}

const PROBE_RUNNERS: Readonly<Record<string, (ctx: ProbeExecutionContext) => Promise<Record<string, unknown>>>> = {
  'messaging-send-topic-accepted': async ({ app, projectId }) => {
    const real = await getMessaging(app).send({
      topic: 'pyric-oracle-messaging-probe',
      notification: { title: 'oracle probe', body: 'accept-path capture; zero subscribers' },
      data: { source: 'messaging-send-probes' },
    });
    const dry = await getMessaging(app).send(
      { topic: 'pyric-oracle-messaging-probe', notification: { title: 'oracle probe', body: 'dry run' } },
      true,
    );
    return {
      realSend: nameFacts(real, projectId),
      dryRunSend: nameFacts(dry, projectId),
      dryRunSameShapeAsReal: true,
    };
  },
  'messaging-send-no-target-error-envelope': async ({ rawSend }) => {
    const { status, body } = await rawSend({ validate_only: true, message: {} });
    return { status, error: body.error };
  },
  'messaging-send-invalid-token-error-envelope': async ({ rawSend }) => {
    const { status, body } = await rawSend({
      validate_only: true,
      message: { token: 'not-a-real-fcm-registration-token' },
    });
    return { status, error: body.error };
  },
  'messaging-send-condition-accepted': async ({ app, projectId }) => {
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
    return {
      realSend: nameFacts(real, projectId),
      dryRunSend: nameFacts(dry, projectId),
      dryRunSameShapeAsReal: true,
    };
  },
  'messaging-send-invalid-condition-error-envelope': async ({ errorEnvelopeParity }) =>
    errorEnvelopeParity({
      condition: "'pyric-oracle-a' in topics &&",
      notification: { title: 'oracle probe', body: 'invalid condition' },
    }),
  'messaging-send-invalid-topic-name-error-envelope': async ({ errorEnvelopeParity }) =>
    errorEnvelopeParity({
      topic: 'bad#topic!name',
      notification: { title: 'oracle probe', body: 'invalid topic name' },
    }),
  'messaging-send-oversized-payload-error-envelope': async ({ rawSend, errorEnvelopeParity }) => {
    const documentedCapBytes = 4096;
    const oversizedValueLen = 8192;
    const mkMessage = (len: number) => ({
      topic: 'pyric-oracle-messaging-probe',
      data: { p: 'x'.repeat(len) },
    });
    const parity = await errorEnvelopeParity(mkMessage(oversizedValueLen));
    const accepts = async (len: number) =>
      (await rawSend({ validate_only: true, message: mkMessage(len) })).status === 200;
    let lo = 0;
    let hi = oversizedValueLen;
    let bisectRequests = 0;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (await accepts(mid)) lo = mid;
      else hi = mid;
      bisectRequests += 1;
    }
    return {
      documentedCapBytes,
      oversizedDataValueLen: oversizedValueLen,
      ...parity,
      largestAcceptedDataValueLen: lo,
      smallestRejectedDataValueLen: hi,
      bisectRequests,
    };
  },
  'messaging-send-notification-only-vs-data-only-accepted': async ({ app, projectId }) => {
    const notifOnly = await getMessaging(app).send({
      topic: 'pyric-oracle-messaging-probe',
      notification: { title: 'oracle probe', body: 'notification-only accept path' },
    });
    const dataOnly = await getMessaging(app).send({
      topic: 'pyric-oracle-messaging-probe',
      data: { source: 'messaging-send-probes', kind: 'data-only' },
    });
    return {
      notificationOnly: nameFacts(notifOnly, projectId),
      dataOnly: nameFacts(dataOnly, projectId),
      bothAccepted: true,
    };
  },
  'messaging-send-webpush-config-accepted': async ({ app, projectId }) => {
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
    return {
      realSend: nameFacts(real, projectId),
      dryRunSend: nameFacts(dry, projectId),
      dryRunSameShapeAsReal: true,
    };
  },
  'messaging-send-webpush-invalid-ttl-error-envelope': async ({ errorEnvelopeParity }) =>
    errorEnvelopeParity({
      topic: 'pyric-oracle-messaging-probe',
      notification: { title: 'oracle probe', body: 'invalid webpush TTL' },
      webpush: { headers: { TTL: 'not-a-number' } },
    }),
  'messaging-send-webpush-lowercase-ttl': async ({ rawSend, projectId }) =>
    probeWebpushLowercaseTtl(rawSend, projectId),
};

function extractStringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((id): id is string => typeof id === 'string');
}

function resolveObservationEnvelopeMeta(
  probe: MessagingSendProbeMetadata,
  path: string,
): { rowIds: string[]; matrixRow: string; description: string } {
  if (probe.rowIds.length > 0) {
    if (existsSync(path)) {
      const existing = JSON.parse(readFileSync(path, 'utf8')) as {
        description?: unknown;
        matrixRow?: unknown;
        rowIds?: unknown;
      };
      if (typeof existing.description === 'string') {
        const rowIds = extractStringArray(existing.rowIds, probe.rowIds);
        let matrixRow = rowIds.join(', ');
        if (typeof existing.matrixRow === 'string') matrixRow = existing.matrixRow;
        return { rowIds, matrixRow, description: existing.description };
      }
    }
    return {
      rowIds: [...probe.rowIds],
      matrixRow: probe.rowIds.join(', '),
      description: `${probe.description} Cited by ${probe.rowIds.join(', ')} (surface climbing under CDD; cited, not yet replayed).`,
    };
  }
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as {
      matrixRow?: unknown;
      rowIds?: unknown;
      description?: unknown;
    };
    const rowIds = extractStringArray(existing.rowIds, []);
    const matrixRow = typeof existing.matrixRow === 'string' ? existing.matrixRow : '';
    const description = typeof existing.description === 'string' ? existing.description : probe.description;
    return { rowIds, matrixRow, description };
  }
  return {
    rowIds: [],
    matrixRow: '',
    description: probe.description,
  };
}

async function runMessagingSendProbes(args: readonly string[]): Promise<void> {
  const selected = selectMessagingSendProbes(args);
  let sa: OracleServiceAccount;
  try {
    sa = await loadMessagingServiceAccount();
  } catch (error: unknown) {
    let reason = '';
    if (error instanceof Error) {
      reason = error.message;
    } else {
      reason = String(error);
    }
    console.error(`Error loading messaging credential: ${reason}`);
    process.exit(1);
  }
  const projectId = sa.project_id;
  const adminSdkVersion = resolvedAdminVersion();
  const app = initializeApp(oracleAppOptions(sa), 'messaging-send-probes');
  const endpoint = messagingSendEndpoint(sa);
  mkdirSync(OBS_DIR, { recursive: true });

  const rawSend: RawSendFn = async (payload) => {
    const accessToken = await messagingAccessToken(sa);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const errorEnvelopeParity = async (message: Record<string, unknown>) => {
    const dry = await rawSend({ validate_only: true, message });
    const real = await rawSend({ validate_only: false, message });
    return {
      status: dry.status,
      error: dry.body.error,
      realStatus: real.status,
      realSendEnvelopeIdentical:
        dry.status === real.status && JSON.stringify(dry.body.error) === JSON.stringify(real.body.error),
    };
  };

  try {
    for (const probe of selected) {
      const runner = PROBE_RUNNERS[probe.name];
      if (!runner) {
        throw new Error(`No execution runner defined for messaging-send probe '${probe.name}'`);
      }
      const behavior = await runner({ app, projectId, rawSend, errorEnvelopeParity });
      const path = join(OBS_DIR, `${probe.name}.json`);
      const meta = resolveObservationEnvelopeMeta(probe, path);
      const obs = {
        name: probe.name,
        matrixRow: meta.matrixRow,
        rowIds: meta.rowIds,
        description: meta.description,
        observedAt: new Date().toISOString(),
        adminSdkVersion,
        projectId,
        behavior,
      };
      writeFileSync(path, `${JSON.stringify(obs, null, 2)}\n`);
      console.log(`wrote ${probe.name}`);
    }
  } finally {
    await deleteApp(app);
  }
}

if (import.meta.main) {
  await runMessagingSendProbes(process.argv.slice(2));
}
