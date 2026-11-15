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
import type { SurfaceContext } from '../../types.js';
import {
  createCaptureStore,
  isHostedCaptureManaged,
  PREVIOUS_CAPTURE_RELATIVE_PATH,
  type CaptureStore,
} from '../../../../serve/capture-store.js';
import { liveCallValues } from '../../../../serve/worker/host/observe.js';
import {
  countDeniedEvents,
  formatCaptureEventCounts,
} from '../../../../verify/file-format.js';
import { buildVerifyFixture } from '../../../../verify/fixture.js';
import {
  captureRtdbInstances,
  defaultInstanceUrl,
} from '../../../../verify/rtdb-instance-capture.js';

interface PreservedCapture {
  json: string;
  eventCount: number;
  denialCount: number;
  hadDiskCapture: boolean;
}

async function buildLiveCaptureJson(
  sandbox: LocalSandbox,
  ctx: SurfaceContext,
  events: readonly SandboxEvent[],
): Promise<string> {
  const rawFirestoreRules = getInternalEnv(sandbox).getRules();
  const firestoreRules = rawFirestoreRules === '' ? null : rawFirestoreRules;
  const adminDb = getAdminDatabase(sandbox);
  const rtdbRules = getActiveDatabaseRules(adminDb);
  const hasRtdb = rtdbRules !== null || events.some((event) => event.service === 'rtdb');
  let rtdbState: ReturnType<typeof rtdbSandbox.snapshotState> | undefined;
  if (hasRtdb) {
    rtdbState = rtdbSandbox.snapshotState(adminDb, { includePriorities: true });
  }
  const catalog = await ctx.databaseInstances();
  const defaultInstance = catalog.known().defaultInstance;
  const storageResolution = getStorageRulesResolution(getAdminStorageSandbox(sandbox));
  const storageRules = storageResolution?.source ?? null;
  const auth = getAuth(sandbox);
  const fixture = buildVerifyFixture({
    sandbox,
    firestoreRules,
    rtdbRules,
    rtdbState,
    rtdbDatabaseUrl: defaultInstanceUrl(defaultInstance),
    rtdbInstances: captureRtdbInstances(sandbox, defaultInstance),
    storageRules,
    authState: {
      users: authSandbox.exportUsers(auth),
      currentUser: sandbox.currentUser,
    },
    capturedBy: 'sandbox-restore',
    observedCalls: Object.fromEntries(liveCallValues(sandbox)),
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

async function prepareCaptureBeforeRestore(
  ctx: SurfaceContext,
  store: CaptureStore,
): Promise<PreservedCapture | null> {
  const liveEvents = ctx.sandbox.history();
  if (liveEvents.length === 0) return null;
  const json = await buildLiveCaptureJson(ctx.sandbox, ctx, liveEvents);
  return {
    json,
    eventCount: liveEvents.length,
    denialCount: countDeniedEvents(liveEvents),
    hadDiskCapture: store.read() !== null,
  };
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
    const managedByHost = isHostedCaptureManaged(ctx.sandbox);
    let store: CaptureStore | null = null;
    let priorCapture: PreservedCapture | null = null;
    if (!managedByHost) {
      store = createCaptureStore(ctx.projectDir);
      priorCapture = await prepareCaptureBeforeRestore(ctx, store);
    }

    const restored = await restoreCheckpoint(ctx.sandbox, ctx, name);
    if (restored === null) {
      const known = await checkpointNames(ctx);
      const list = known.length === 0 ? 'none' : known.join(', ');
      return operationFailure(`No checkpoint named '${name}'. Known checkpoints: ${list}.`);
    }

    const counts = restored.counts;
    const baseSummary = `Restored checkpoint '${name}' (${counts.firestore} docs, ${counts.database} database entries, ${counts.storage} objects, ${counts.auth} users).`;
    if (store !== null && priorCapture !== null && store.preservePrevious(priorCapture.json)) {
      if (priorCapture.hadDiskCapture) {
        store.clearActive(clearEventsInCaptureJson(priorCapture.json));
      }
      const eventSummary = formatCaptureEventCounts(priorCapture.eventCount, priorCapture.denialCount);
      const previousCapture = {
        path: PREVIOUS_CAPTURE_RELATIVE_PATH,
        eventCount: priorCapture.eventCount,
        denialCount: priorCapture.denialCount,
      };
      return {
        ok: true,
        summary: `${baseSummary} Previous session capture (${eventSummary}) preserved at ${PREVIOUS_CAPTURE_RELATIVE_PATH}.`,
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
