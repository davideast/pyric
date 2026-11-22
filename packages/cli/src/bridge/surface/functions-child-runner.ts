/**
 * Isolated child process runner for `functions.listTriggers` and
 * `functions.fire` (`ADR 0023` Swap-or-Stop).
 *
 * Spawned with `--import @pyric/cli/register` and `buildFunctionsChildEnv`
 * (`GOOGLE_APPLICATION_CREDENTIALS` stripped), so user Functions code never
 * loads real `firebase-admin` / `@google-cloud/*`, sees host ADC credentials,
 * or reuses stale module cache entries across edits.
 */
import { REMOTE_SANDBOX_FACTORY, initializeSandbox } from 'pyric/sandbox';
import { LAZY_DEFAULT_AMBIENT_APP } from 'pyric/sandbox/internal';
import { loadFunctionsModuleExports } from '../../functions/module-loader.js';
import { serveInstanceAsDefault } from '../../functions/rtdb/child-runtime.js';
import {
  inspectOnValueCreated,
  type UnsupportedOnValueCreated,
} from '../../functions/rtdb/discovery.js';
import { executeOnValueCreated } from '../../functions/rtdb/event.js';
import { matchRtdbReference } from '../../functions/rtdb/reference-pattern.js';

export interface SerializedTriggerDescriptor {
  exportName: string;
  reference: string;
  instance: string;
  location?: string;
}

export interface SerializedListedTrigger {
  exportName: string;
  eventType: string;
  reference?: string;
  instance?: string;
  document?: string;
  database?: string;
  namespace?: string;
  bucket?: string;
  schedule?: string;
  timeZone?: string;
  topic?: string;
  topicResource?: string;
  regions?: string[];
  platform?: 'gcfv1' | 'gcfv2';
  location?: string;
}

export type FunctionsRunnerRequest =
  | {
      type: 'discover';
      entry: string;
      projectId: string;
      defaultInstance: string;
      databaseHost: string;
    }
  | {
      type: 'fire';
      entry: string;
      projectId: string;
      defaultInstance: string;
      databaseHost: string;
      triggerName: string;
      path: string;
      ref: string;
      value: unknown;
      eventId: string;
      eventTime: string;
    };

export type FunctionsRunnerReply =
  | {
      type: 'discovered';
      triggers: SerializedListedTrigger[];
      unsupported: UnsupportedOnValueCreated[];
    }
  | { type: 'not-found' }
  | { type: 'mismatch'; trigger: SerializedTriggerDescriptor }
  | { type: 'firing'; trigger: SerializedTriggerDescriptor; params: Record<string, string> }
  | {
      type: 'executed';
      status: 'fulfilled' | 'rejected';
      event: Record<string, unknown>;
      result?: unknown;
      errorMessage?: string;
    }
  | { type: 'fatal'; message: string; stack?: string };

export type FunctionsParentToChild = FunctionsRunnerRequest;

export const FUNCTIONS_RUNNER_CHILD_ENV = 'PYRIC_FUNCTIONS_RUNNER_CHILD';
const DEFAULT_LOCATION = 'us-central1';

function serializeTrigger(trigger: {
  exportName: string;
  reference: string;
  instance: string;
  location?: string;
}): SerializedTriggerDescriptor {
  const out: SerializedTriggerDescriptor = {
    exportName: trigger.exportName,
    reference: trigger.reference,
    instance: trigger.instance,
  };
  if (trigger.location !== undefined) out.location = trigger.location;
  return out;
}

async function discoverAllProjectTriggers(
  entry: string,
  projectId: string,
): Promise<{ triggers: SerializedListedTrigger[]; unsupported: UnsupportedOnValueCreated[] }> {
  const [
    { callableOnCallFamily, inspectOnCall },
    { listFirebaseEndpoints },
    { ACTIVE_FIRESTORE_EVENT_TYPES, firestoreTriggersFamily, inspectFirestoreTriggers },
    { httpOnRequestFamily, inspectOnRequest },
    { ACTIVE_IDENTITY_EVENT_TYPES, identityBlockingFamily, inspectIdentityTriggers },
    { inspectPubSubTriggers, pubsubTriggersFamily },
    { inspectRtdbValueTriggers, rtdbValueTriggerFamily },
    { inspectSchedulerTriggers, schedulerTriggersFamily },
    { defaultStorageBucketFromEnv, serveBucketAsDefault },
    { ACTIVE_STORAGE_EVENT_TYPES, inspectStorageTriggers, storageTriggersFamily },
    { inspectTasksTriggers, tasksTriggersFamily },
    { findUnsupportedTriggers },
  ] = await Promise.all([
    import('../../functions/callable/discovery.js'),
    import('../../functions/endpoints.js'),
    import('../../functions/firestore/discovery.js'),
    import('../../functions/http/discovery.js'),
    import('../../functions/identity/discovery.js'),
    import('../../functions/pubsub/discovery.js'),
    import('../../functions/rtdb/discovery.js'),
    import('../../functions/scheduler/discovery.js'),
    import('../../functions/storage/child-runtime.js'),
    import('../../functions/storage/discovery.js'),
    import('../../functions/tasks/discovery.js'),
    import('../../functions/unsupported.js'),
  ]);

  const defaultBucket = defaultStorageBucketFromEnv(process.env);
  serveBucketAsDefault(defaultBucket);
  const exported = await loadFunctionsModuleExports(entry);
  const byExportName = new Map<string, SerializedListedTrigger>();

  for (const trigger of inspectRtdbValueTriggers(exported).triggers) {
    const item: SerializedListedTrigger = {
      exportName: trigger.exportName,
      eventType: trigger.eventType,
      reference: trigger.reference,
      instance: trigger.instance,
    };
    if (trigger.location !== undefined) item.location = trigger.location;
    byExportName.set(trigger.exportName, item);
  }

  for (const trigger of inspectStorageTriggers(exported, {
    defaultBucket,
    activeEventTypes: ACTIVE_STORAGE_EVENT_TYPES,
  }).triggers) {
    const item: SerializedListedTrigger = {
      exportName: trigger.exportName,
      eventType: trigger.eventType,
    };
    if (trigger.bucket !== undefined) item.bucket = trigger.bucket;
    if (trigger.location !== undefined) item.location = trigger.location;
    byExportName.set(trigger.exportName, item);
  }

  for (const trigger of inspectFirestoreTriggers(exported, {
    admittedEventTypes: ACTIVE_FIRESTORE_EVENT_TYPES,
  }).triggers) {
    const item: SerializedListedTrigger = {
      exportName: trigger.exportName,
      eventType: trigger.eventType,
      document: trigger.document,
      database: trigger.database,
      namespace: trigger.namespace,
    };
    if (trigger.location !== undefined) item.location = trigger.location;
    byExportName.set(trigger.exportName, item);
  }

  for (const trigger of inspectSchedulerTriggers(exported).triggers) {
    const item: SerializedListedTrigger = {
      exportName: trigger.exportName,
      eventType: 'schedule',
      schedule: trigger.schedule,
      regions: trigger.regions,
    };
    if (trigger.timeZone !== undefined) item.timeZone = trigger.timeZone;
    if (trigger.location !== undefined) item.location = trigger.location;
    byExportName.set(trigger.exportName, item);
  }

  for (const trigger of inspectIdentityTriggers(exported, {
    activeEventTypes: ACTIVE_IDENTITY_EVENT_TYPES,
  }).triggers) {
    const item: SerializedListedTrigger = {
      exportName: trigger.exportName,
      eventType: trigger.eventType,
    };
    if (trigger.location !== undefined) item.location = trigger.location;
    byExportName.set(trigger.exportName, item);
  }

  for (const trigger of inspectPubSubTriggers(exported, {
    projectId,
    env: process.env,
  }).triggers) {
    const item: SerializedListedTrigger = {
      exportName: trigger.exportName,
      eventType: trigger.eventType,
      topic: trigger.topic,
      topicResource: trigger.topicResource,
    };
    if (trigger.location !== undefined) item.location = trigger.location;
    byExportName.set(trigger.exportName, item);
  }

  for (const trigger of inspectTasksTriggers(exported).triggers) {
    const item: SerializedListedTrigger = {
      exportName: trigger.exportName,
      eventType: 'task-queue',
      regions: trigger.regions,
    };
    if (trigger.location !== undefined) item.location = trigger.location;
    byExportName.set(trigger.exportName, item);
  }

  for (const fn of inspectOnRequest(exported)) {
    byExportName.set(fn.exportName, {
      exportName: fn.exportName,
      eventType: 'https',
      regions: fn.regions,
      platform: fn.platform,
    });
  }

  for (const fn of inspectOnCall(exported)) {
    byExportName.set(fn.exportName, {
      exportName: fn.exportName,
      eventType: 'callable',
      regions: fn.regions,
      platform: fn.platform,
    });
  }

  const triggers: SerializedListedTrigger[] = [];
  for (const { exportName } of listFirebaseEndpoints(exported)) {
    const matched = byExportName.get(exportName);
    if (matched !== undefined) triggers.push(matched);
  }

  const unsupported = findUnsupportedTriggers(exported, [
    rtdbValueTriggerFamily,
    storageTriggersFamily,
    firestoreTriggersFamily,
    schedulerTriggersFamily,
    identityBlockingFamily,
    pubsubTriggersFamily,
    tasksTriggersFamily,
    httpOnRequestFamily,
    callableOnCallFamily,
  ]);
  return { triggers, unsupported };
}

function sendReply(message: FunctionsRunnerReply): Promise<void> {
  return new Promise((resolve) => {
    if (typeof process.send !== 'function' || !process.connected) {
      resolve();
      return;
    }
    process.send(message, () => resolve());
  });
}

function installLocalFallbackFactory(): () => void {
  const local = initializeSandbox();
  (globalThis as Record<symbol, unknown>)[REMOTE_SANDBOX_FACTORY] = () => local;
  return () => {
    local.dispose();
  };
}

async function handleRunnerRequest(req: FunctionsRunnerRequest): Promise<void> {
  const usesHostedUrl = (process.env.PYRIC_SANDBOX ?? '').startsWith('remote:');
  let cleanupSandbox: () => void = () => {};
  if (!usesHostedUrl) {
    cleanupSandbox = installLocalFallbackFactory();
  }

  const { getApps, deleteApp, isSandboxAdminApp } = await import('pyric-admin/app');
  serveInstanceAsDefault(req.defaultInstance);
  (globalThis as Record<symbol, unknown>)[LAZY_DEFAULT_AMBIENT_APP] = true;
  const keepAlive = setInterval(() => {}, 60_000);

  try {
    if (req.type === 'discover') {
      const discovered = await discoverAllProjectTriggers(req.entry, req.projectId);
      await sendReply({
        type: 'discovered',
        triggers: discovered.triggers,
        unsupported: discovered.unsupported,
      });
      return;
    }

    const exported = await loadFunctionsModuleExports(req.entry);
    const inspected = inspectOnValueCreated(exported);
    const trigger = inspected.triggers.find((candidate) => candidate.exportName === req.triggerName);
    if (trigger === undefined) {
      await sendReply({ type: 'not-found' });
      return;
    }

    const params = matchRtdbReference(trigger.reference, req.path);
    const serialized = serializeTrigger(trigger);
    if (params === null) {
      await sendReply({ type: 'mismatch', trigger: serialized });
      return;
    }

    await sendReply({ type: 'firing', trigger: serialized, params });

    const instance = trigger.instance === '*' ? req.defaultInstance : trigger.instance;
    const executed = await executeOnValueCreated(
      trigger,
      { ref: req.ref, params, value: req.value },
      {
        id: req.eventId,
        time: req.eventTime,
        instance,
        location: trigger.location ?? DEFAULT_LOCATION,
        databaseHost: req.databaseHost,
      },
    );

    if (executed.status === 'fulfilled') {
      await sendReply({
        type: 'executed',
        status: 'fulfilled',
        event: executed.event,
        result: executed.result,
      });
    } else {
      const errorMessage =
        executed.error instanceof Error ? executed.error.message : String(executed.error);
      await sendReply({
        type: 'executed',
        status: 'rejected',
        event: executed.event,
        errorMessage,
      });
    }
  } finally {
    clearInterval(keepAlive);
    delete (globalThis as Record<symbol, unknown>)[LAZY_DEFAULT_AMBIENT_APP];
    const registeredApps = getApps();
    for (const app of registeredApps) {
      if (isSandboxAdminApp(app) && 'close' in app.sandbox && typeof app.sandbox.close === 'function') {
        app.sandbox.close();
      }
    }
    await Promise.all(registeredApps.map((app) => deleteApp(app).catch(() => undefined)));
    cleanupSandbox();
  }
}

if (process.env[FUNCTIONS_RUNNER_CHILD_ENV] === '1') {
  const onInitialMessage = (raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) return;
    const msg = raw as { type?: unknown };
    if (msg.type !== 'discover' && msg.type !== 'fire') return;
    process.off('message', onInitialMessage);
    void handleRunnerRequest(raw as FunctionsRunnerRequest)
      .then(() => {
        if (typeof process.disconnect === 'function' && process.connected) {
          process.disconnect();
        }
        process.exit(0);
      })
      .catch(async (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        await sendReply({ type: 'fatal', message, stack });
        if (typeof process.disconnect === 'function' && process.connected) {
          process.disconnect();
        }
        process.exit(1);
      });
  };
  process.on('message', onInitialMessage);
}
