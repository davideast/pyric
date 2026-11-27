import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { callableOnCallFamily, inspectOnCall } from '../../src/functions/callable/discovery.js';
import {
  ACTIVE_FIRESTORE_EVENT_TYPES,
  firestoreTriggersFamily,
  inspectFirestoreTriggers,
} from '../../src/functions/firestore/discovery.js';
import {
  httpFunctionInfo,
  httpOnRequestFamily,
  inspectOnRequest,
} from '../../src/functions/http/discovery.js';
import {
  ACTIVE_IDENTITY_EVENT_TYPES,
  identityBlockingFamily,
  inspectIdentityTriggers,
} from '../../src/functions/identity/discovery.js';
import {
  inspectPubSubTriggers,
  pubsubTriggersFamily,
} from '../../src/functions/pubsub/discovery.js';
import {
  inspectRtdbValueTriggers,
  rtdbValueTriggerFamily,
} from '../../src/functions/rtdb/discovery.js';
import {
  inspectSchedulerTriggers,
  schedulerTriggersFamily,
} from '../../src/functions/scheduler/discovery.js';
import {
  ACTIVE_STORAGE_EVENT_TYPES,
  inspectStorageTriggers,
  storageTriggersFamily,
} from '../../src/functions/storage/discovery.js';
import {
  inspectTasksTriggers,
  tasksTriggersFamily,
} from '../../src/functions/tasks/discovery.js';
import { findUnsupportedTriggers } from '../../src/functions/unsupported.js';

const requireFromConformance = createRequire(
  resolve(import.meta.dir, '../../../conformance/package.json'),
);

const params = requireFromConformance(
  'firebase-functions/params',
) as typeof import('firebase-functions/params');
const httpsV2 = requireFromConformance(
  'firebase-functions/v2/https',
) as typeof import('firebase-functions/v2/https');
const firestoreV2 = requireFromConformance(
  'firebase-functions/v2/firestore',
) as typeof import('firebase-functions/v2/firestore');
const dbV2 = requireFromConformance(
  'firebase-functions/v2/database',
) as typeof import('firebase-functions/v2/database');
const storageV2 = requireFromConformance(
  'firebase-functions/v2/storage',
) as typeof import('firebase-functions/v2/storage');
const identityV2 = requireFromConformance(
  'firebase-functions/v2/identity',
) as typeof import('firebase-functions/v2/identity');
const pubsubV2 = requireFromConformance(
  'firebase-functions/v2/pubsub',
) as typeof import('firebase-functions/v2/pubsub');
const schedulerV2 = requireFromConformance(
  'firebase-functions/v2/scheduler',
) as typeof import('firebase-functions/v2/scheduler');
const tasksV2 = requireFromConformance(
  'firebase-functions/v2/tasks',
) as typeof import('firebase-functions/v2/tasks');
const eventarcV2 = requireFromConformance(
  'firebase-functions/v2/eventarc',
) as typeof import('firebase-functions/v2/eventarc');
const optionsV2 = requireFromConformance(
  'firebase-functions/v2/options',
) as typeof import('firebase-functions/v2/options');

const ALL_FAMILIES = [
  rtdbValueTriggerFamily,
  storageTriggersFamily,
  firestoreTriggersFamily,
  schedulerTriggersFamily,
  identityBlockingFamily,
  pubsubTriggersFamily,
  tasksTriggersFamily,
  httpOnRequestFamily,
  callableOnCallFamily,
] as const;

describe('dynamic firebase-functions/params resolution across all 9 discovery modules', () => {
  test('resolves dynamic options cleanly across http, callable, firestore, rtdb, storage, identity, pubsub, scheduler, and tasks', () => {
    const env: Record<string, string> = {
      FIREBASE_CONFIG: JSON.stringify({
        projectId: 'demo-params',
        storageBucket: 'demo-params.firebasestorage.app',
      }),
      DEPLOY_ENV: 'staging',
      OMIT_ACTIVE: 'false',
      OMIT_SKIPPED: 'true',
      HTTP_REGIONS: '["europe-west1","us-east1"]',
      HTTP_TIMEOUT: '120',
      CALL_REGION: 'asia-northeast1',
      CALL_TIMEOUT: '45',
      FS_TENANT: 'org-a',
      FS_DB: 'analytics-db',
      FS_NS: 'tenant-ns',
      FS_REGION: 'us-west1',
      FS_RETRY: 'true',
      RTDB_REF: '/rooms/{roomId}/messages/{msgId}',
      RTDB_INSTANCE: 'custom-rtdb-instance',
      RTDB_REGION: 'europe-west1',
      STORAGE_BUCKET: 'media-uploads-bucket',
      STORAGE_REGION: 'us-central1',
      ID_REGION: 'us-east4',
      ID_TIMEOUT: '30',
      ID_TOKEN_FLAG: 'true',
      PUBSUB_TOPIC: 'order-events',
      PUBSUB_REGION: 'europe-west3',
      PUBSUB_RETRY: 'true',
      PUBSUB_TIMEOUT: '90',
      SCHED_CRON: 'every 15 minutes',
      SCHED_TZ: 'America/New_York',
      SCHED_RETRY_COUNT: '4',
      SCHED_MAX_RETRY: '300',
      SCHED_REGION: 'us-west2',
      SCHED_TIMEOUT: '75',
      TASK_MAX_ATTEMPTS: '5',
      TASK_MIN_BACKOFF: '10',
      TASK_MAX_BACKOFF: '60',
      TASK_CONCURRENT: '12',
      TASK_RATE: '20',
      TASK_REGION: 'europe-west2',
      TASK_TIMEOUT: '240',
    };

    const deployEnv = params.defineString('DEPLOY_ENV');
    const omitActive = params.defineBoolean('OMIT_ACTIVE');
    const omitSkipped = params.defineBoolean('OMIT_SKIPPED');
    const omitByCompare = deployEnv.equals('prod');
    const regionByTernary = deployEnv.equals('staging').thenElse('europe-west4', 'us-central1');

    const httpFn = httpsV2.onRequest(
      {
        omit: omitByCompare,
        region: params.defineList('HTTP_REGIONS'),
        timeoutSeconds: params.defineInt('HTTP_TIMEOUT'),
      },
      (_req, res) => res.end('ok'),
    );
    const omittedHttp = httpsV2.onRequest({ omit: omitSkipped }, (_req, res) => res.end());

    const callFn = httpsV2.onCall(
      {
        omit: omitActive,
        region: [params.defineString('CALL_REGION'), regionByTernary],
        timeoutSeconds: params.defineInt('CALL_TIMEOUT'),
      },
      () => 'ok',
    );

    const fsDocExpr = params.expr`tenants/${params.defineString('FS_TENANT')}/orders/{orderId}`;
    const firestoreFn = firestoreV2.onDocumentCreated(
      {
        document: fsDocExpr,
        database: params.defineString('FS_DB'),
        namespace: params.defineString('FS_NS'),
        region: params.defineString('FS_REGION'),
        retry: params.defineBoolean('FS_RETRY'),
        omit: omitActive,
      },
      () => undefined,
    );

    // RTDB v2 manifest with dynamic Expression values on ref, instance, region, and omit.
    const rtdbFn = dbV2.onValueCreated(
      {
        ref: '/placeholder/{id}',
        region: params.defineString('RTDB_REGION'),
        omit: omitActive,
      },
      () => undefined,
    );
    const rtdbEp = rtdbFn.__endpoint as {
      eventTrigger: {
        eventFilters: Record<string, unknown>;
        eventFilterPathPatterns: Record<string, unknown>;
      };
    };
    rtdbEp.eventTrigger.eventFilterPathPatterns.ref = params.defineString('RTDB_REF');
    rtdbEp.eventTrigger.eventFilters.instance = params.defineString('RTDB_INSTANCE');
    delete rtdbEp.eventTrigger.eventFilterPathPatterns.instance;

    const storageFn = storageV2.onObjectFinalized(
      {
        bucket: params.defineString('STORAGE_BUCKET'),
        region: params.defineString('STORAGE_REGION'),
        omit: omitActive,
      },
      () => undefined,
    );
    const storageDefaultBucketFn = storageV2.onObjectFinalized(
      { bucket: params.storageBucket },
      () => undefined,
    );

    const identityFn = identityV2.beforeUserCreated(
      {
        region: params.defineString('ID_REGION'),
        timeoutSeconds: params.defineInt('ID_TIMEOUT'),
        omit: omitActive,
      },
      () => undefined,
    );
    const idEp = identityFn.__endpoint as {
      blockingTrigger: { options: Record<string, unknown> };
    };
    idEp.blockingTrigger.options.idToken = params.defineBoolean('ID_TOKEN_FLAG');

    const pubsubTopicExpr = params.expr`projects/${params.projectID}/topics/${params.defineString('PUBSUB_TOPIC')}`;
    const pubsubFn = pubsubV2.onMessagePublished(
      {
        topic: pubsubTopicExpr as unknown as string,
        region: params.defineString('PUBSUB_REGION'),
        retry: params.defineBoolean('PUBSUB_RETRY'),
        timeoutSeconds: params.defineInt('PUBSUB_TIMEOUT'),
        omit: omitActive,
      },
      () => undefined,
    );

    const schedulerFn = schedulerV2.onSchedule(
      {
        schedule: params.defineString('SCHED_CRON'),
        timeZone: params.defineString('SCHED_TZ'),
        retryCount: params.defineInt('SCHED_RETRY_COUNT'),
        maxRetrySeconds: params.defineInt('SCHED_MAX_RETRY'),
        region: params.defineString('SCHED_REGION'),
        timeoutSeconds: params.defineInt('SCHED_TIMEOUT'),
        omit: omitActive,
      },
      () => undefined,
    );

    const tasksFn = tasksV2.onTaskDispatched(
      {
        retryConfig: {
          maxAttempts: params.defineInt('TASK_MAX_ATTEMPTS'),
          minBackoffSeconds: params.defineInt('TASK_MIN_BACKOFF'),
          maxBackoffSeconds: params.defineInt('TASK_MAX_BACKOFF'),
        },
        rateLimits: {
          maxConcurrentDispatches: params.defineInt('TASK_CONCURRENT'),
          maxDispatchesPerSecond: params.defineInt('TASK_RATE'),
        },
        region: params.defineString('TASK_REGION'),
        timeoutSeconds: params.defineInt('TASK_TIMEOUT'),
        omit: omitActive,
      },
      () => undefined,
    );

    const omittedCustom = eventarcV2.onCustomEventPublished(
      { eventType: 'custom.v1.ping', omit: omitSkipped },
      () => undefined,
    );

    const exported = {
      httpFn,
      omittedHttp,
      callFn,
      firestoreFn,
      rtdbFn,
      storageFn,
      storageDefaultBucketFn,
      identityFn,
      pubsubFn,
      schedulerFn,
      tasksFn,
      omittedCustom,
    };

    expect(inspectOnRequest(exported, { env }).map(httpFunctionInfo)).toEqual([
      {
        exportName: 'httpFn',
        regions: ['europe-west1', 'us-east1'],
        platform: 'gcfv2',
        privateInvoker: false,
        timeoutSeconds: 120,
      },
    ]);

    expect(inspectOnCall(exported, { env }).map(httpFunctionInfo)).toEqual([
      {
        exportName: 'callFn',
        kind: 'callable',
        regions: ['asia-northeast1', 'europe-west4'],
        platform: 'gcfv2',
        privateInvoker: false,
        timeoutSeconds: 45,
      },
    ]);

    const fsDiscovered = inspectFirestoreTriggers(exported, {
      admittedEventTypes: ACTIVE_FIRESTORE_EVENT_TYPES,
      env,
    });
    expect(fsDiscovered.unsupported).toEqual([]);
    expect(fsDiscovered.triggers).toHaveLength(1);
    expect(fsDiscovered.triggers[0]).toMatchObject({
      exportName: 'firestoreFn',
      document: 'tenants/org-a/orders/{orderId}',
      database: 'analytics-db',
      namespace: 'tenant-ns',
      location: 'us-west1',
    });

    const rtdbDiscovered = inspectRtdbValueTriggers(exported, { env });
    expect(rtdbDiscovered.unsupported).toEqual([]);
    expect(rtdbDiscovered.triggers[0]).toMatchObject({
      exportName: 'rtdbFn',
      reference: 'rooms/{roomId}/messages/{msgId}',
      instance: 'custom-rtdb-instance',
      location: 'europe-west1',
    });

    const storageDiscovered = inspectStorageTriggers(exported, {
      activeEventTypes: ACTIVE_STORAGE_EVENT_TYPES,
      env,
    });
    expect(storageDiscovered.unsupported).toEqual([]);
    expect(
      storageDiscovered.triggers.map((t) => ({
        exportName: t.exportName,
        bucket: t.bucket,
        targetsDefaultBucket: t.targetsDefaultBucket,
        location: t.location,
      })),
    ).toEqual([
      {
        exportName: 'storageFn',
        bucket: 'media-uploads-bucket',
        targetsDefaultBucket: false,
        location: 'us-central1',
      },
      {
        exportName: 'storageDefaultBucketFn',
        bucket: 'demo-params.firebasestorage.app',
        targetsDefaultBucket: true,
        location: undefined,
      },
    ]);

    const identityDiscovered = inspectIdentityTriggers(exported, {
      activeEventTypes: ACTIVE_IDENTITY_EVENT_TYPES,
      env,
    });
    expect(identityDiscovered.unsupported).toEqual([]);
    expect(identityDiscovered.triggers[0]).toMatchObject({
      exportName: 'identityFn',
      location: 'us-east4',
      timeoutSeconds: 30,
      options: { idToken: true, accessToken: false, refreshToken: false },
    });

    const pubsubDiscovered = inspectPubSubTriggers(exported, {
      projectId: 'demo-params',
      env,
    });
    expect(pubsubDiscovered.unsupported).toEqual([]);
    expect(pubsubDiscovered.triggers[0]).toMatchObject({
      exportName: 'pubsubFn',
      topic: 'order-events',
      topicResource: 'projects/demo-params/topics/order-events',
      location: 'europe-west3',
      retry: true,
      timeoutSeconds: 90,
    });

    const schedDiscovered = inspectSchedulerTriggers(exported, { env });
    expect(schedDiscovered.unsupported).toEqual([]);
    expect(schedDiscovered.triggers[0]).toMatchObject({
      exportName: 'schedulerFn',
      schedule: 'every 15 minutes',
      timeZone: 'America/New_York',
      retryConfig: { retryCount: 4, maxRetrySeconds: 300 },
      region: 'us-west2',
      timeoutSeconds: 75,
    });

    const tasksDiscovered = inspectTasksTriggers(exported, { env });
    expect(tasksDiscovered.unsupported).toEqual([]);
    expect(tasksDiscovered.triggers[0]).toMatchObject({
      exportName: 'tasksFn',
      retryConfig: { maxAttempts: 5, minBackoffSeconds: 10, maxBackoffSeconds: 60 },
      rateLimits: { maxConcurrentDispatches: 12, maxDispatchesPerSecond: 20 },
      region: 'europe-west2',
      timeoutSeconds: 240,
    });

    // Only explicitly omitted exports appear in unsupported; zero dynamic failures.
    expect(findUnsupportedTriggers(exported, ALL_FAMILIES, { env })).toEqual([
      { exportName: 'omittedHttp', eventType: 'https (omitted from emulation)' },
      { exportName: 'omittedCustom', eventType: 'custom.v1.ping (omitted from emulation)' },
    ]);
  });

  test('never leaks secret values in unsupported discovery diagnostics when a secret expression yields an invalid pattern or zone', () => {
    const secretVal = 'synth_secret_bad_zone_7777';
    const env = { BAD_SECRET: secretVal };
    const secretParam = params.defineSecret('BAD_SECRET');

    const badSched = schedulerV2.onSchedule(
      { schedule: '0 * * * *', timeZone: secretParam as unknown as string },
      () => undefined,
    );
    const badFs = firestoreV2.onDocumentCreated(
      { document: secretParam as unknown as string },
      () => undefined,
    );

    const unsupported = findUnsupportedTriggers({ badSched, badFs }, ALL_FAMILIES, { env });
    expect(unsupported).toHaveLength(2);
    expect(JSON.stringify(unsupported)).not.toContain(secretVal);
  });

  test('treats TernaryExpression resolving to RESET_VALUE, null, or undefined as reset/unset across omit, timeoutSeconds, retry, timeZone, and retryConfig', () => {
    const flag = params.defineBoolean('USE_EXPLICIT');
    const reset = optionsV2.RESET_VALUE;

    const ternaryOmit = httpsV2.onRequest(
      {
        omit: flag.thenElse(true, reset as unknown as boolean),
        timeoutSeconds: flag.thenElse(90, reset as unknown as number),
      },
      (_req, res) => res.end('ok'),
    );
    const ternaryPubSub = pubsubV2.onMessagePublished(
      {
        topic: 'jobs',
        retry: flag.thenElse(true, null as unknown as boolean),
        timeoutSeconds: flag.thenElse(60, reset as unknown as number),
      },
      () => undefined,
    );
    const ternarySched = schedulerV2.onSchedule(
      {
        schedule: '0 * * * *',
        timeZone: flag.thenElse('UTC', reset as unknown as string),
        retryCount: flag.thenElse(3, reset as unknown as number),
        maxRetrySeconds: flag.thenElse(120, null as unknown as number),
        timeoutSeconds: flag.thenElse(45, reset as unknown as number),
      },
      () => undefined,
    );
    const ternaryTask = tasksV2.onTaskDispatched(
      {
        retryConfig: {
          maxAttempts: flag.thenElse(4, reset as unknown as number),
          maxRetrySeconds: flag.thenElse(60, null as unknown as number),
        },
        rateLimits: {
          maxDispatchesPerSecond: flag.thenElse(10, reset as unknown as number),
        },
        timeoutSeconds: flag.thenElse(120, reset as unknown as number),
      },
      () => undefined,
    );

    const exported = { ternaryOmit, ternaryPubSub, ternarySched, ternaryTask };
    const envFalse = { USE_EXPLICIT: 'false' };

    expect(inspectOnRequest(exported, { env: envFalse }).map(httpFunctionInfo)).toEqual([
      {
        exportName: 'ternaryOmit',
        regions: ['us-central1'],
        platform: 'gcfv2',
        privateInvoker: false,
        timeoutSeconds: null,
      },
    ]);
    const pubsubTrigger = inspectPubSubTriggers(exported, {
      projectId: 'demo',
      env: envFalse,
    }).triggers[0];
    expect(pubsubTrigger).toMatchObject({
      exportName: 'ternaryPubSub',
      retry: false,
    });
    expect(pubsubTrigger?.timeoutSeconds).toBeUndefined();

    const schedTrigger = inspectSchedulerTriggers(exported, { env: envFalse }).triggers[0];
    expect(schedTrigger).toMatchObject({
      exportName: 'ternarySched',
      retryConfig: {},
    });
    expect(schedTrigger?.timeZone).toBeUndefined();
    expect(schedTrigger?.timeoutSeconds).toBeUndefined();

    const taskTrigger = inspectTasksTriggers(exported, { env: envFalse }).triggers[0];
    expect(taskTrigger).toMatchObject({
      exportName: 'ternaryTask',
      retryConfig: {},
      rateLimits: {},
    });
    expect(taskTrigger?.timeoutSeconds).toBeUndefined();

    expect(findUnsupportedTriggers(exported, ALL_FAMILIES, { env: envFalse })).toEqual([]);
  });
});
