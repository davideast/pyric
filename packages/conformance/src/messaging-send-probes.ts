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
import type { Probe } from '../rigs/types.ts';
import {
  formatInertPreviewFooter,
  requireCaptureMode,
  stripCaptureFlags,
} from './capture-mode-guard.ts';
import { loadMessagingServiceAccount } from './messaging-credential.ts';
import {
  MESSAGING_SEND_PROBES,
  type MessagingSendProbeMetadata,
} from './messaging-send-probe-catalog.ts';
import {
  assertFcmProbeHttpStatus,
  createRawSendFunctions,
  type ErrorEnvelopeParityOutcome,
  nameFacts,
  type RawSendFn,
} from './messaging-send-probe-session.ts';
import { readObservationLinkage } from './observation-linkage.ts';
import { oracleAppOptions, type OracleServiceAccount } from './oracle-credential.ts';
import { resolvedAdminVersion } from './package-version.ts';
import { readProbeSelectors } from './probe-cli-args.ts';
import { loadModularProbes, type LoadedModularProbe } from './sdk-probes.ts';

export { assertFcmProbeHttpStatus, nameFacts, type RawSendFn };

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_DIR = join(HERE, '..', 'observations', 'messaging-admin');

export type MessagingSendTarget =
  | {
      kind: 'catalog';
      name: string;
      pendingRowLink: boolean;
      catalog: MessagingSendProbeMetadata;
    }
  | {
      kind: 'modular';
      name: string;
      pendingRowLink: boolean;
      surfaceDir: string;
      probe: Probe;
    };

export function selectMessagingSendProbes(args: readonly string[]): MessagingSendProbeMetadata[] {
  const requested = readProbeSelectors(args);
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

export interface SelectMessagingSendTargetsOptions {
  args: readonly string[];
  modularProbes: readonly LoadedModularProbe[];
  includeUncapturedStaged: boolean;
  observationExists?: (name: string) => boolean;
}

export function selectMessagingSendTargets(
  options: SelectMessagingSendTargetsOptions,
): MessagingSendTarget[] {
  const obsExists =
    options.observationExists ?? ((name: string) => existsSync(join(OBS_DIR, `${name}.json`)));
  const allTargets: MessagingSendTarget[] = [];

  for (const catalog of MESSAGING_SEND_PROBES) {
    allTargets.push({
      kind: 'catalog',
      name: catalog.name,
      pendingRowLink: catalog.pendingRowLink === true,
      catalog,
    });
  }
  for (const entry of options.modularProbes) {
    allTargets.push({
      kind: 'modular',
      name: entry.id,
      pendingRowLink: entry.probe.pendingRowLink === true,
      surfaceDir: entry.surfaceDir,
      probe: entry.probe,
    });
  }

  const requested = readProbeSelectors(options.args);
  if (requested.length > 0) {
    const byName = new Map(allTargets.map((target) => [target.name, target]));
    const selected: MessagingSendTarget[] = [];
    for (const selector of requested) {
      const found = byName.get(selector);
      if (!found) {
        throw new Error(
          `Unknown messaging-send probe '${selector}'. Available: ${allTargets.map((item) => item.name).join(', ')}`,
        );
      }
      if (!selected.some((existing) => existing.name === found.name)) {
        selected.push(found);
      }
    }
    return selected;
  }

  if (options.includeUncapturedStaged) {
    return allTargets;
  }

  return allTargets.filter((target) => {
    if (!target.pendingRowLink) {
      return true;
    }
    return obsExists(target.name);
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
  errorEnvelopeParity: (message: Record<string, unknown>) => Promise<ErrorEnvelopeParityOutcome>;
}

const PROBE_RUNNERS: Readonly<
  Record<string, (ctx: ProbeExecutionContext) => Promise<Record<string, unknown>>>
> = {
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

function resolveCatalogEnvelopeMeta(
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
    let matrixRow = '';
    if (typeof existing.matrixRow === 'string') {
      matrixRow = existing.matrixRow;
    }
    let description = probe.description;
    if (typeof existing.description === 'string') {
      description = existing.description;
    }
    return { rowIds, matrixRow, description };
  }
  return {
    rowIds: [],
    matrixRow: '',
    description: probe.description,
  };
}

function resolveModularEnvelopeMeta(
  probe: Probe,
  path: string,
): { rowIds: string[]; matrixRow: string; description: string } {
  let existing = { matrixRow: '', rowIds: [] as string[] };
  if (existsSync(path)) {
    existing = readObservationLinkage(path);
  }
  let matrixRow = existing.matrixRow;
  if (probe.matrixRow !== '') {
    matrixRow = probe.matrixRow;
  }
  let rowIds = existing.rowIds;
  if (probe.rowIds.length > 0) {
    rowIds = [...probe.rowIds];
  }
  return {
    rowIds,
    matrixRow,
    description: probe.description,
  };
}

async function runMessagingSendProbes(args: readonly string[]): Promise<void> {
  const cleanedArgs = stripCaptureFlags(args);
  const modularProbes = await loadModularProbes('messaging-send');
  const previewTargets = selectMessagingSendTargets({
    args: cleanedArgs,
    modularProbes,
    includeUncapturedStaged: true,
  });
  requireCaptureMode({
    label: 'messaging-send',
    scriptPath: 'packages/conformance/src/messaging-send-probes.ts',
    argv: args,
    extraFlags: '[--probe <name>]',
    preview: () => {
      console.log(
        '[messaging-send] INERT preview (no --write flag): zero credential reads, zero network calls.',
      );
      for (const item of previewTargets) {
        let stagedSuffix = '';
        if (item.pendingRowLink) {
          stagedSuffix = ' [pendingRowLink]';
        }
        console.log(`  - ${item.name}${stagedSuffix}`);
      }
      console.log(
        `  ${formatInertPreviewFooter('packages/conformance/src/messaging-send-probes.ts', '[--probe <name>]')}`,
      );
    },
  });

  const writeTargets = selectMessagingSendTargets({
    args: cleanedArgs,
    modularProbes,
    includeUncapturedStaged: false,
  });

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
  const { rawSend, errorEnvelopeParity } = createRawSendFunctions(sa);
  mkdirSync(OBS_DIR, { recursive: true });

  try {
    for (const target of writeTargets) {
      if (target.kind === 'catalog') {
        const runner = PROBE_RUNNERS[target.name];
        if (!runner) {
          throw new Error(`No execution runner defined for messaging-send probe '${target.name}'`);
        }
        const behavior = await runner({ app, projectId, rawSend, errorEnvelopeParity });
        const path = join(OBS_DIR, `${target.name}.json`);
        const meta = resolveCatalogEnvelopeMeta(target.catalog, path);
        const obs = {
          name: target.name,
          matrixRow: meta.matrixRow,
          rowIds: meta.rowIds,
          description: meta.description,
          observedAt: new Date().toISOString(),
          adminSdkVersion,
          projectId,
          behavior,
        };
        writeFileSync(path, `${JSON.stringify(obs, null, 2)}\n`);
        console.log(`wrote ${target.name}`);
      } else {
        const outDir = join(HERE, '..', 'observations', target.surfaceDir);
        mkdirSync(outDir, { recursive: true });
        const path = join(outDir, `${target.name}.json`);
        const meta = resolveModularEnvelopeMeta(target.probe, path);
        const behavior = await target.probe.observe();
        const obs = {
          name: target.name,
          matrixRow: meta.matrixRow,
          rowIds: meta.rowIds,
          description: meta.description,
          observedAt: new Date().toISOString(),
          adminSdkVersion,
          projectId,
          behavior,
        };
        writeFileSync(path, `${JSON.stringify(obs, null, 2)}\n`);
        console.log(`wrote ${target.name}`);
      }
    }
  } finally {
    await deleteApp(app);
  }
}

if (import.meta.main) {
  await runMessagingSendProbes(process.argv.slice(2));
}
