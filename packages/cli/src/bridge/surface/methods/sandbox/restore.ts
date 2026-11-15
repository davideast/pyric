/** Replace the live sandbox with a saved checkpoint. */
import { z } from 'zod';
import type { LocalSandbox, SandboxEvent } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { getAdminDatabase, sandbox as rtdbSandbox } from 'pyric/database';
import { getActiveRules as getActiveDatabaseRules } from 'pyric/sandbox/database';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { getAdminStorageSandbox, getStorageRulesResolution } from 'pyric/storage/internal';
import { checkpointNames, restoreCheckpoint } from '../../checkpoints.js';
import { operationFailure } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';
import {
  createCaptureStore,
  PREVIOUS_CAPTURE_RELATIVE_PATH,
  summarizeCaptureJson,
  type CaptureStore,
} from '../../../../serve/capture-store.js';
import { buildVerifyFixture } from '../../../../verify/fixture.js';

interface PreservedCapture {
  json: string;
  eventCount: number;
  denialCount: number;
  hadDiskCapture: boolean;
}

function countDenials(events: readonly SandboxEvent[]): number {
  let denials = 0;
  for (const event of events) {
    if ('result' in event && event.result === 'deny') denials++;
  }
  return denials;
}

function buildLiveCaptureJson(sandbox: LocalSandbox, events: readonly SandboxEvent[]): string {
  const firestoreRules = getInternalEnv(sandbox).getRules();
  const hasRtdb = events.some((event) => event.service === 'rtdb');
  const hasStorage = events.some((event) => event.service === 'storage');
  let rtdbRules: ReturnType<typeof getActiveDatabaseRules> = null;
  let rtdbState: ReturnType<typeof rtdbSandbox.snapshotState> | undefined;
  if (hasRtdb) {
    const adminDb = getAdminDatabase(sandbox);
    rtdbRules = getActiveDatabaseRules(adminDb);
    rtdbState = rtdbSandbox.snapshotState(adminDb, { includePriorities: true });
  }
  let storageRules: string | null = null;
  if (hasStorage) {
    storageRules = getStorageRulesResolution(getAdminStorageSandbox(sandbox))?.source ?? null;
  }
  const auth = getAuth(sandbox);
  const fixture = buildVerifyFixture({
    sandbox,
    firestoreRules: firestoreRules === '' ? null : firestoreRules,
    rtdbRules,
    rtdbState,
    storageRules,
    authState: {
      users: authSandbox.exportUsers(auth),
      currentUser: sandbox.currentUser,
    },
  });
  return JSON.stringify(fixture);
}

function clearEventsInCaptureJson(captureJson: string): string {
  const parsed = JSON.parse(captureJson) as Record<string, unknown>;
  const cleared: Record<string, unknown> = { ...parsed, events: [] };
  delete cleared.observedCalls;
  delete cleared.storageDeniedWrites;
  return JSON.stringify(cleared);
}

function prepareCaptureBeforeRestore(
  sandbox: LocalSandbox,
  store: CaptureStore,
): PreservedCapture | null {
  const liveEvents = sandbox.history();
  const liveCount = liveEvents.length;
  const existingDisk = store.read();
  let diskSummary = null;
  if (existingDisk !== null) {
    diskSummary = summarizeCaptureJson(existingDisk);
  }
  let diskCount = 0;
  if (diskSummary !== null) {
    diskCount = diskSummary.eventCount;
  }

  if (existingDisk !== null && diskSummary !== null && diskCount > 0 && diskCount >= liveCount) {
    return {
      json: existingDisk,
      eventCount: diskSummary.eventCount,
      denialCount: diskSummary.denialCount,
      hadDiskCapture: true,
    };
  }
  if (liveCount > 0) {
    return {
      json: buildLiveCaptureJson(sandbox, liveEvents),
      eventCount: liveCount,
      denialCount: countDenials(liveEvents),
      hadDiskCapture: existingDisk !== null,
    };
  }
  return null;
}

export default {
  tool: 'sandbox',
  method: 'restore',
  runsIn: 'bridge',
  sdkOrigin: 'pyric',
  effect: 'destructive',
  signature: 'restore(name, confirm)',
  description: 'Replace live with a checkpoint.',
  args: z.object({
    name: z.string(),
    confirm: z
      .boolean()
      .optional()
      .describe('Must be true. Restore discards every change made since the checkpoint.'),
  }),
  operation: 'restore_sandbox',
  example: { name: 'before-migration', confirm: true },
  async handler(args, ctx) {
    const name = String(args.name);
    const store = createCaptureStore(ctx.projectDir);
    const priorCapture = prepareCaptureBeforeRestore(ctx.sandbox, store);

    const restored = await restoreCheckpoint(ctx.sandbox, ctx, name);
    if (restored === null) {
      const known = await checkpointNames(ctx);
      const list = known.length === 0 ? 'none' : known.join(', ');
      return operationFailure(`No checkpoint named '${name}'. Known checkpoints: ${list}.`);
    }

    const counts = restored.counts;
    const baseSummary = `Restored checkpoint '${name}' (${counts.firestore} docs, ${counts.database} database entries, ${counts.storage} objects, ${counts.auth} users).`;
    if (priorCapture !== null && store.preservePrevious(priorCapture.json)) {
      if (priorCapture.hadDiskCapture) {
        store.clearActive(clearEventsInCaptureJson(priorCapture.json));
      }
      const eventWord = priorCapture.eventCount === 1 ? 'event' : 'events';
      const denialWord = priorCapture.denialCount === 1 ? 'denial' : 'denials';
      const previousCapture = {
        path: PREVIOUS_CAPTURE_RELATIVE_PATH,
        eventCount: priorCapture.eventCount,
        denialCount: priorCapture.denialCount,
      };
      return {
        ok: true,
        summary: `${baseSummary} Previous session capture (${priorCapture.eventCount} ${eventWord}, ${priorCapture.denialCount} ${denialWord}) preserved at ${PREVIOUS_CAPTURE_RELATIVE_PATH}.`,
        data: { name, counts, previousCapture },
      };
    }

    return {
      ok: true,
      summary: baseSummary,
      data: { name, counts },
    };
  },
} satisfies MethodRecord;
