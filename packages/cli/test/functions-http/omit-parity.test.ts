import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { callableOnCallFamily, inspectOnCall } from '../../src/functions/callable/discovery.js';
import { firestoreTriggersFamily, inspectFirestoreTriggers } from '../../src/functions/firestore/discovery.js';
import {
  FUNCTION_TARGET_HEADER,
  startHttpChildServer,
} from '../../src/functions/http/child-server.js';
import { CHILD_TOKEN_HEADER } from '../../src/functions/http/child-token.js';
import { httpOnRequestFamily, inspectOnRequest } from '../../src/functions/http/discovery.js';
import { identityBlockingFamily, inspectIdentityTriggers } from '../../src/functions/identity/discovery.js';
import { inspectPubSubTriggers, pubsubTriggersFamily } from '../../src/functions/pubsub/discovery.js';
import { inspectRtdbValueTriggers, rtdbValueTriggerFamily } from '../../src/functions/rtdb/discovery.js';
import { inspectSchedulerTriggers, schedulerTriggersFamily } from '../../src/functions/scheduler/discovery.js';
import { inspectStorageTriggers, storageTriggersFamily } from '../../src/functions/storage/discovery.js';
import { inspectTasksTriggers, tasksTriggersFamily } from '../../src/functions/tasks/discovery.js';
import { findUnsupportedTriggers } from '../../src/functions/unsupported.js';

const conformancePackageJson = resolve(import.meta.dir, '../../../conformance/package.json');
const requireFromConformance = createRequire(conformancePackageJson);

const httpsV2 = requireFromConformance(
  'firebase-functions/v2/https',
) as typeof import('firebase-functions/v2/https');
const dbV2 = requireFromConformance(
  'firebase-functions/v2/database',
) as typeof import('firebase-functions/v2/database');
const firestoreV2 = requireFromConformance(
  'firebase-functions/v2/firestore',
) as typeof import('firebase-functions/v2/firestore');
const storageV2 = requireFromConformance(
  'firebase-functions/v2/storage',
) as typeof import('firebase-functions/v2/storage');
const schedulerV2 = requireFromConformance(
  'firebase-functions/v2/scheduler',
) as typeof import('firebase-functions/v2/scheduler');
const pubsubV2 = requireFromConformance(
  'firebase-functions/v2/pubsub',
) as typeof import('firebase-functions/v2/pubsub');
const tasksV2 = requireFromConformance(
  'firebase-functions/v2/tasks',
) as typeof import('firebase-functions/v2/tasks');
const identityV2 = requireFromConformance(
  'firebase-functions/v2/identity',
) as typeof import('firebase-functions/v2/identity');
const eventarcV2 = requireFromConformance(
  'firebase-functions/v2/eventarc',
) as typeof import('firebase-functions/v2/eventarc');
const optionsV2 = requireFromConformance(
  'firebase-functions/v2/options',
) as typeof import('firebase-functions/v2/options');
const v1 = requireFromConformance(
  'firebase-functions/v1',
) as typeof import('firebase-functions/v1');

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

describe('omit: true parity across every trigger family (#1938)', () => {
  test('skips omitted endpoints across all 9 supported families plus unclaimed triggers', () => {
    const prevProject = process.env.GCLOUD_PROJECT;
    const prevConfig = process.env.FIREBASE_CONFIG;
    process.env.GCLOUD_PROJECT = 'demo-project';
    process.env.FIREBASE_CONFIG = JSON.stringify({
      projectId: 'demo-project',
      databaseURL: 'https://demo-project-default-rtdb.firebaseio.com',
      storageBucket: 'demo-project.firebasestorage.app',
    });

    try {
      const exported = {
        omittedHttpV2: httpsV2.onRequest({ omit: true }, (_req, res) => res.send('no')),
        omittedHttpV1: v1.runWith({ omit: true }).https.onRequest((_req, res) => res.send('no')),
        omittedCallV2: httpsV2.onCall({ omit: true }, () => 'no'),
        omittedCallV1: v1.runWith({ omit: true }).https.onCall(() => 'no'),
        omittedRtdb: dbV2.onValueCreated({ ref: '/items/{id}', omit: true }, () => undefined),
        omittedFirestore: firestoreV2.onDocumentCreated(
          { document: 'items/{id}', omit: true },
          () => undefined,
        ),
        omittedStorage: storageV2.onObjectFinalized({ omit: true }, () => undefined),
        omittedScheduleV2: schedulerV2.onSchedule(
          { schedule: 'every 5 minutes', omit: true },
          () => undefined,
        ),
        omittedScheduleV1: v1
          .runWith({ omit: true })
          .pubsub.schedule('every 5 minutes')
          .onRun(() => null),
        omittedPubsub: pubsubV2.onMessagePublished({ topic: 'jobs', omit: true }, () => undefined),
        omittedTaskV2: tasksV2.onTaskDispatched({ omit: true }, () => undefined),
        omittedTaskV1: v1.runWith({ omit: true }).tasks.taskQueue().onDispatch(() => undefined),
        omittedIdentityV2: identityV2.beforeUserCreated({ omit: true }, () => undefined),
        omittedIdentityV1: v1
          .runWith({ omit: true } as never)
          .auth.user()
          .beforeCreate(() => undefined),
        omittedCustomEvent: eventarcV2.onCustomEventPublished(
          { eventType: 'custom.v1.happened', omit: true },
          () => undefined,
        ),
      };

      expect(inspectOnRequest(exported)).toEqual([]);
      expect(inspectOnCall(exported)).toEqual([]);
      expect(inspectRtdbValueTriggers(exported).triggers).toEqual([]);
      expect(inspectFirestoreTriggers(exported).triggers).toEqual([]);
      expect(inspectStorageTriggers(exported).triggers).toEqual([]);
      expect(inspectSchedulerTriggers(exported).triggers).toEqual([]);
      expect(inspectPubSubTriggers(exported).triggers).toEqual([]);
      expect(inspectTasksTriggers(exported).triggers).toEqual([]);
      expect(inspectIdentityTriggers(exported).triggers).toEqual([]);

      const unsupported = findUnsupportedTriggers(exported, ALL_FAMILIES);
      expect(unsupported).toEqual([
        {
          exportName: 'omittedRtdb',
          eventType: 'google.firebase.database.ref.v1.created (omitted from emulation)',
        },
        {
          exportName: 'omittedStorage',
          eventType: 'google.cloud.storage.object.v1.finalized (omitted from emulation)',
        },
        {
          exportName: 'omittedFirestore',
          eventType: 'google.cloud.firestore.document.v1.created (omitted from emulation)',
        },
        { exportName: 'omittedScheduleV2', eventType: 'schedule (omitted from emulation)' },
        { exportName: 'omittedScheduleV1', eventType: 'schedule (omitted from emulation)' },
        {
          exportName: 'omittedIdentityV2',
          eventType: 'providers/cloud.auth/eventTypes/user.beforeCreate (omitted from emulation)',
        },
        {
          exportName: 'omittedIdentityV1',
          eventType: 'providers/cloud.auth/eventTypes/user.beforeCreate (omitted from emulation)',
        },
        {
          exportName: 'omittedPubsub',
          eventType: 'google.cloud.pubsub.topic.v1.messagePublished (omitted from emulation)',
        },
        { exportName: 'omittedTaskV2', eventType: 'task-queue (omitted from emulation)' },
        { exportName: 'omittedTaskV1', eventType: 'task-queue (omitted from emulation)' },
        { exportName: 'omittedHttpV2', eventType: 'https (omitted from emulation)' },
        { exportName: 'omittedHttpV1', eventType: 'https (omitted from emulation)' },
        { exportName: 'omittedCallV2', eventType: 'callable (omitted from emulation)' },
        { exportName: 'omittedCallV1', eventType: 'callable (omitted from emulation)' },
        {
          exportName: 'omittedCustomEvent',
          eventType: 'custom.v1.happened (omitted from emulation)',
        },
      ]);
    } finally {
      if (prevProject === undefined) delete process.env.GCLOUD_PROJECT;
      else process.env.GCLOUD_PROJECT = prevProject;
      if (prevConfig === undefined) delete process.env.FIREBASE_CONFIG;
      else process.env.FIREBASE_CONFIG = prevConfig;
    }
  });

  test('does not mount omitted onRequest or onCall endpoints on the HTTP child server', async () => {
    const exported = {
      liveHttp: httpsV2.onRequest((_req, res) => res.status(200).send('live')),
      omittedHttp: httpsV2.onRequest({ omit: true }, (_req, res) => res.status(200).send('omitted')),
      omittedCall: httpsV2.onCall({ omit: true }, () => ({ ok: true })),
    };

    const httpFunctions = [...inspectOnRequest(exported), ...inspectOnCall(exported)];
    expect(httpFunctions.map((fn) => fn.exportName)).toEqual(['liveHttp']);

    const token = 'test-child-token';
    const server = await startHttpChildServer(conformancePackageJson, httpFunctions, { token });
    try {
      const liveRes = await fetch(`http://127.0.0.1:${server.port}/liveHttp`, {
        headers: {
          [CHILD_TOKEN_HEADER]: token,
          [FUNCTION_TARGET_HEADER]: 'liveHttp',
        },
      });
      expect(liveRes.status).toBe(200);
      expect(await liveRes.text()).toBe('live');

      const omittedGet = await fetch(`http://127.0.0.1:${server.port}/omittedHttp`, {
        headers: {
          [CHILD_TOKEN_HEADER]: token,
          [FUNCTION_TARGET_HEADER]: 'omittedHttp',
        },
      });
      expect(omittedGet.status).toBe(404);

      const omittedPost = await fetch(`http://127.0.0.1:${server.port}/omittedCall`, {
        method: 'POST',
        headers: {
          [CHILD_TOKEN_HEADER]: token,
          [FUNCTION_TARGET_HEADER]: 'omittedCall',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ data: {} }),
      });
      expect(omittedPost.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  // Last: setGlobalOptions mutates module-global state in firebase-functions.
  test('honors setGlobalOptions({ omit: true }) and per-function omit: false / RESET_VALUE overrides across all v2 families', () => {
    optionsV2.setGlobalOptions({ omit: true });
    try {
      const reset = optionsV2.RESET_VALUE;
      const exported = {
        globalHttp: httpsV2.onRequest((_req, res) => res.end()),
        resetHttp: httpsV2.onRequest({ omit: reset }, (_req, res) => res.end()),
        falseCall: httpsV2.onCall({ omit: false }, () => 'ok'),
        resetCall: httpsV2.onCall({ omit: reset }, () => 'ok'),
        globalRtdb: dbV2.onValueCreated('/items/{id}', () => undefined),
        resetRtdb: dbV2.onValueCreated({ ref: '/items/{id}', omit: reset }, () => undefined),
        resetFirestore: firestoreV2.onDocumentCreated(
          { document: 'items/{id}', omit: reset },
          () => undefined,
        ),
        resetStorage: storageV2.onObjectFinalized({ omit: reset }, () => undefined),
        resetSchedule: schedulerV2.onSchedule(
          { schedule: 'every 5 minutes', omit: reset },
          () => undefined,
        ),
        resetPubsub: pubsubV2.onMessagePublished({ topic: 'jobs', omit: reset }, () => undefined),
        resetTask: tasksV2.onTaskDispatched({ omit: reset }, () => undefined),
        resetIdentity: identityV2.beforeUserCreated({ omit: reset }, () => undefined),
      };

      expect(inspectOnRequest(exported).map((fn) => fn.exportName)).toEqual(['resetHttp']);
      expect(inspectOnCall(exported).map((fn) => fn.exportName)).toEqual(['falseCall', 'resetCall']);
      expect(inspectRtdbValueTriggers(exported).triggers.map((t) => t.exportName)).toEqual([
        'resetRtdb',
      ]);
      expect(inspectFirestoreTriggers(exported).triggers.map((t) => t.exportName)).toEqual([
        'resetFirestore',
      ]);
      expect(inspectStorageTriggers(exported).triggers.map((t) => t.exportName)).toEqual([
        'resetStorage',
      ]);
      expect(inspectSchedulerTriggers(exported).triggers.map((t) => t.exportName)).toEqual([
        'resetSchedule',
      ]);
      expect(
        inspectPubSubTriggers(exported, { projectId: 'demo-project' }).triggers.map(
          (t) => t.exportName,
        ),
      ).toEqual(['resetPubsub']);
      expect(inspectTasksTriggers(exported).triggers.map((t) => t.exportName)).toEqual([
        'resetTask',
      ]);
      expect(inspectIdentityTriggers(exported).triggers.map((t) => t.exportName)).toEqual([
        'resetIdentity',
      ]);

      expect(findUnsupportedTriggers(exported, ALL_FAMILIES)).toEqual([
        {
          exportName: 'globalRtdb',
          eventType: 'google.firebase.database.ref.v1.created (omitted from emulation)',
        },
        { exportName: 'globalHttp', eventType: 'https (omitted from emulation)' },
      ]);
    } finally {
      optionsV2.setGlobalOptions({});
    }
  });
});
