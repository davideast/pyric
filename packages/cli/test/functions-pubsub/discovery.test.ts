import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  MESSAGE_PUBLISHED_EVENT_TYPE,
  defaultProjectIdFromEnv,
  discoverPubSubTriggers,
  inspectPubSubTriggers,
  isPubSubEventType,
  matchesPubSubTopic,
  normalizePubSubTopic,
  pubsubTriggersFamily,
} from '../../src/functions/pubsub/discovery.js';
import { rtdbValueTriggerFamily } from '../../src/functions/rtdb/discovery.js';
import { storageTriggersFamily } from '../../src/functions/storage/discovery.js';
import { findUnsupportedTriggers } from '../../src/functions/unsupported.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const pubsubFunctions = requireFromConformance(
  'firebase-functions/v2/pubsub',
) as typeof import('firebase-functions/v2/pubsub');
const optionsModule = requireFromConformance(
  'firebase-functions/v2/options',
) as typeof import('firebase-functions/v2/options');
const databaseFunctions = requireFromConformance(
  'firebase-functions/v2/database',
) as typeof import('firebase-functions/v2/database');
const storageFunctions = requireFromConformance(
  'firebase-functions/v2/storage',
) as typeof import('firebase-functions/v2/storage');
const paramsModule = requireFromConformance(
  'firebase-functions/params',
) as typeof import('firebase-functions/params');

describe('firebase-functions/v2/pubsub trigger discovery', () => {
  test('claims messagePublished endpoints and ignores sibling trigger families', () => {
    const { onMessagePublished } = pubsubFunctions;
    const { onValueCreated } = databaseFunctions;
    const { onObjectFinalized } = storageFunctions;

    const onOrder = onMessagePublished('orders', () => undefined);
    const onAudit = onMessagePublished(
      {
        topic: 'projects/custom-proj/topics/audit-events',
        retry: true,
        region: 'europe-west1',
        timeoutSeconds: 180,
      },
      () => undefined,
    );
    const onRtdb = onValueCreated('/orders/{id}', () => undefined);
    const onStorage = onObjectFinalized({ bucket: 'media-bucket' }, () => undefined);

    expect(isPubSubEventType(MESSAGE_PUBLISHED_EVENT_TYPE)).toBe(true);
    expect(isPubSubEventType('google.cloud.storage.object.v1.finalized')).toBe(false);
    expect(isPubSubEventType(null)).toBe(false);

    expect(pubsubTriggersFamily.claims(onOrder.__endpoint)).toBe(true);
    expect(pubsubTriggersFamily.claims(onAudit.__endpoint)).toBe(true);
    expect(pubsubTriggersFamily.claims(onRtdb.__endpoint)).toBe(false);
    expect(pubsubTriggersFamily.claims(onStorage.__endpoint)).toBe(false);

    const discovered = discoverPubSubTriggers(
      { onOrder, onAudit, onRtdb, onStorage },
      { projectId: 'demo-project' },
    );
    expect(
      discovered.map((item) => ({
        exportName: item.exportName,
        eventType: item.eventType,
        rawTopic: item.rawTopic,
        topic: item.topic,
        topicProject: item.topicProject,
        topicResource: item.topicResource,
        retry: item.retry,
        location: item.location,
        timeoutSeconds: item.timeoutSeconds,
      })),
    ).toEqual([
      {
        exportName: 'onOrder',
        eventType: MESSAGE_PUBLISHED_EVENT_TYPE,
        rawTopic: 'orders',
        topic: 'orders',
        topicProject: undefined,
        topicResource: 'projects/demo-project/topics/orders',
        retry: false,
        location: undefined,
        timeoutSeconds: undefined,
      },
      {
        exportName: 'onAudit',
        eventType: MESSAGE_PUBLISHED_EVENT_TYPE,
        rawTopic: 'projects/custom-proj/topics/audit-events',
        topic: 'audit-events',
        topicProject: 'custom-proj',
        topicResource: 'projects/custom-proj/topics/audit-events',
        retry: true,
        location: 'europe-west1',
        timeoutSeconds: 180,
      },
    ]);
  });

  test('resolves ResetValue sentinels, undefined retry option, and multi-region arrays', () => {
    const { onMessagePublished } = pubsubFunctions;
    const { RESET_VALUE } = optionsModule;

    const resetOptions = onMessagePublished(
      {
        topic: 'billing.v1',
        region: RESET_VALUE,
        timeoutSeconds: RESET_VALUE,
        retry: RESET_VALUE,
      },
      () => undefined,
    );
    const explicitUndefinedRetry = onMessagePublished(
      {
        topic: 'billing.v2',
        retry: undefined,
        region: ['asia-northeast1', 'us-east1'],
      },
      () => undefined,
    );

    const triggers = discoverPubSubTriggers(
      { resetOptions, explicitUndefinedRetry },
      { projectId: 'demo-project' },
    );

    expect(
      triggers.map((item) => ({
        exportName: item.exportName,
        topic: item.topic,
        retry: item.retry,
        location: item.location,
        timeoutSeconds: item.timeoutSeconds,
      })),
    ).toEqual([
      {
        exportName: 'resetOptions',
        topic: 'billing.v1',
        retry: false,
        location: undefined,
        timeoutSeconds: undefined,
      },
      {
        exportName: 'explicitUndefinedRetry',
        topic: 'billing.v2',
        retry: false,
        location: 'asia-northeast1',
        timeoutSeconds: undefined,
      },
    ]);
  });

  test('honors omit: true, dynamic Expression options, and invalid topic strings via findUnsupportedTriggers', () => {
    const { onMessagePublished } = pubsubFunctions;
    const { defineBoolean, defineInt, defineString } = paramsModule;

    const active = onMessagePublished({ topic: 'jobs', omit: false }, () => undefined);
    const omitted = onMessagePublished({ topic: 'jobs', omit: true }, () => undefined);
    const dynamicOmit = onMessagePublished(
      { topic: 'jobs', omit: defineBoolean('OMIT_JOBS') },
      () => undefined,
    );
    const dynamicTopic = onMessagePublished(
      { topic: defineString('JOBS_TOPIC') as unknown as string },
      () => undefined,
    );
    const invalidTopicSlash = onMessagePublished('invalid/topic', () => undefined);
    const invalidQualifiedTopic = onMessagePublished(
      'projects/demo-project/subscriptions/not-a-topic',
      () => undefined,
    );
    const dynamicRegion = onMessagePublished(
      { topic: 'jobs', region: defineString('JOBS_REGION') },
      () => undefined,
    );
    const dynamicRetry = onMessagePublished(
      { topic: 'jobs', retry: defineBoolean('JOBS_RETRY') },
      () => undefined,
    );
    const dynamicTimeout = onMessagePublished(
      { topic: 'jobs', timeoutSeconds: defineInt('JOBS_TIMEOUT') },
      () => undefined,
    );

    const exported = {
      active,
      omitted,
      dynamicOmit,
      dynamicTopic,
      invalidTopicSlash,
      invalidQualifiedTopic,
      dynamicRegion,
      dynamicRetry,
      dynamicTimeout,
    };

    const inspected = inspectPubSubTriggers(exported, { projectId: 'demo-project' });
    expect(inspected.triggers.map((item) => item.exportName)).toEqual(['active']);
    expect(inspected.unsupported).toEqual([
      {
        exportName: 'omitted',
        eventType: `${MESSAGE_PUBLISHED_EVENT_TYPE} (omitted from emulation)`,
      },
      {
        exportName: 'dynamicOmit',
        eventType: `${MESSAGE_PUBLISHED_EVENT_TYPE} (unsupported dynamic omit option)`,
      },
      {
        exportName: 'dynamicTopic',
        eventType: `${MESSAGE_PUBLISHED_EVENT_TYPE} (unsupported dynamic topic option)`,
      },
      {
        exportName: 'invalidTopicSlash',
        eventType: `${MESSAGE_PUBLISHED_EVENT_TYPE} (invalid topic filter)`,
      },
      {
        exportName: 'invalidQualifiedTopic',
        eventType: `${MESSAGE_PUBLISHED_EVENT_TYPE} (invalid topic filter)`,
      },
      {
        exportName: 'dynamicRegion',
        eventType: `${MESSAGE_PUBLISHED_EVENT_TYPE} (unsupported dynamic region option)`,
      },
      {
        exportName: 'dynamicRetry',
        eventType: `${MESSAGE_PUBLISHED_EVENT_TYPE} (unsupported dynamic retry option)`,
      },
      {
        exportName: 'dynamicTimeout',
        eventType: `${MESSAGE_PUBLISHED_EVENT_TYPE} (unsupported dynamic timeoutSeconds option)`,
      },
    ]);

    const unsupportedViaFamily = findUnsupportedTriggers(exported, [
      rtdbValueTriggerFamily,
      storageTriggersFamily,
      pubsubTriggersFamily,
    ]);
    expect(unsupportedViaFamily).toEqual(inspected.unsupported);
  });

  test('recursively discovers nested export groups and terminates on cyclic export graphs', () => {
    const { onMessagePublished } = pubsubFunctions;
    const notify = onMessagePublished('alerts', () => undefined);
    const group: Record<string, unknown> = { sendAlert: notify };
    group.loop = group;

    const triggers = discoverPubSubTriggers(
      { ops: group, mirror: { sendAlert: notify } },
      { projectId: 'demo-project' },
    );
    expect(triggers.map((item) => item.exportName)).toEqual([
      'ops-sendAlert',
      'mirror-sendAlert',
    ]);
  });

  test('normalizes short vs qualified topics and isolates cross-project and non-matching topics', () => {
    const { onMessagePublished } = pubsubFunctions;

    expect(normalizePubSubTopic('orders', 'proj-a')).toEqual({
      projectId: 'proj-a',
      topicId: 'orders',
      resourceName: 'projects/proj-a/topics/orders',
    });
    expect(normalizePubSubTopic('projects/proj-b/topics/orders', 'proj-a')).toEqual({
      projectId: 'proj-b',
      topicId: 'orders',
      explicitProject: 'proj-b',
      resourceName: 'projects/proj-b/topics/orders',
    });
    expect(() => normalizePubSubTopic('')).toThrow(/Invalid Pub\/Sub topic/);
    expect(() => normalizePubSubTopic('bad topic')).toThrow(/Invalid Pub\/Sub topic/);
    expect(() => normalizePubSubTopic('projects/proj-a/topics/')).toThrow(
      /Invalid Pub\/Sub topic/,
    );

    const [shortTrigger, sameProjQualified, otherProjQualified] = discoverPubSubTriggers(
      {
        shortSub: onMessagePublished('orders', () => undefined),
        qualifiedSub: onMessagePublished('projects/proj-a/topics/orders', () => undefined),
        foreignSub: onMessagePublished('projects/proj-b/topics/orders', () => undefined),
      },
      { projectId: 'proj-a' },
    );
    if (
      shortTrigger === undefined ||
      sameProjQualified === undefined ||
      otherProjQualified === undefined
    ) {
      throw new Error('expected three discovered pubsub triggers');
    }

    expect(matchesPubSubTopic(shortTrigger, 'orders', 'proj-a')).toBe(true);
    expect(
      matchesPubSubTopic(shortTrigger, 'projects/proj-a/topics/orders', 'proj-a'),
    ).toBe(true);
    expect(
      matchesPubSubTopic(shortTrigger, 'projects/proj-b/topics/orders', 'proj-a'),
    ).toBe(false);
    expect(matchesPubSubTopic(shortTrigger, 'invoices', 'proj-a')).toBe(false);
    expect(matchesPubSubTopic(shortTrigger, 'invalid/topic', 'proj-a')).toBe(false);

    expect(matchesPubSubTopic(sameProjQualified, 'orders', 'proj-a')).toBe(true);
    expect(matchesPubSubTopic(sameProjQualified, 'orders', 'proj-b')).toBe(false);

    expect(matchesPubSubTopic(otherProjQualified, 'orders', 'proj-a')).toBe(false);
    expect(
      matchesPubSubTopic(otherProjQualified, 'projects/proj-b/topics/orders', 'proj-a'),
    ).toBe(true);
  });

  test('defaultProjectIdFromEnv resolves FIREBASE_CONFIG, GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT, and GCP_PROJECT', () => {
    expect(
      defaultProjectIdFromEnv({
        FIREBASE_CONFIG: JSON.stringify({ projectId: 'cfg-proj' }),
        GCLOUD_PROJECT: 'gcloud-proj',
      }),
    ).toBe('cfg-proj');
    expect(
      defaultProjectIdFromEnv({
        FIREBASE_CONFIG: 'not-json',
        GCLOUD_PROJECT: 'gcloud-proj',
      }),
    ).toBe('gcloud-proj');
    expect(
      defaultProjectIdFromEnv({
        GOOGLE_CLOUD_PROJECT: 'google-proj',
      }),
    ).toBe('google-proj');
    expect(
      defaultProjectIdFromEnv({
        GCP_PROJECT: 'gcp-proj',
      }),
    ).toBe('gcp-proj');
    expect(defaultProjectIdFromEnv({}, 'fallback-proj')).toBe('fallback-proj');
  });
});
