import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import {
  classifyTriggerFamily,
  countTriggersByFamily,
  extractLiveExecutions,
  filterTriggers,
  fireCapability,
  formatDurationMs,
  groupTriggersByFamily,
  mergeExecutions,
  parseOptionalJsonPayload,
  parseOptionalStringMap,
  parseOptionalTimeoutMs,
  parseUnsupportedDiagnostic,
  sampleRtdbPathFromPattern,
  shortEventLabel,
  triggerEndpointUrls,
  triggerEventPattern,
  triggerMetaBadges,
  triggerRegions,
  type DiscoveredTrigger,
  type FunctionExecution,
} from '../../../src/features/functions/index.js';

const ALL_FAMILY_TRIGGERS: DiscoveredTrigger[] = [
  {
    exportName: 'apiHandler',
    eventType: 'https',
    regions: ['us-central1', 'europe-west1'],
    platform: 'gcfv2',
  },
  {
    exportName: 'computeScore',
    eventType: 'callable',
    regions: ['us-east1'],
    platform: 'gcfv2',
  },
  {
    exportName: 'onOrderCreated',
    eventType: 'google.cloud.firestore.document.v1.created',
    document: 'orders/{orderId}',
    database: 'analytics',
    location: 'us-central1',
  },
  {
    exportName: 'makeUppercase',
    eventType: 'google.firebase.database.ref.v1.created',
    reference: 'messages/{pushId}/original',
    instance: 'demo-default-rtdb',
    location: 'us-central1',
  },
  {
    exportName: 'syncProfileUpdate',
    eventType: 'google.firebase.database.ref.v1.updated',
    reference: 'profiles/{uid}',
    instance: '*',
  },
  {
    exportName: 'generateThumb',
    eventType: 'google.cloud.storage.object.v1.finalized',
    bucket: 'uploads-bucket',
    location: 'us-west1',
  },
  {
    exportName: 'enforceDomain',
    eventType: 'providers/cloud.auth/eventTypes/user.beforeCreate',
    location: 'us-central1',
  },
  {
    exportName: 'processEvents',
    eventType: 'google.cloud.pubsub.topic.v1.messagePublished',
    topic: 'order-events',
    topicResource: 'projects/demo-app/topics/order-events',
  },
  {
    exportName: 'nightlyCleanup',
    eventType: 'schedule',
    schedule: 'every day 00:00',
    timeZone: 'America/New_York',
    regions: ['us-central1'],
  },
  {
    exportName: 'sendDigestTask',
    eventType: 'task-queue',
    regions: ['us-central1'],
  },
];

describe('Functions inspector domain model', () => {
  it('classifies every supported trigger family and unknown types', () => {
    expect(classifyTriggerFamily('https')).toBe('http');
    expect(classifyTriggerFamily('callable')).toBe('callable');
    expect(classifyTriggerFamily('google.cloud.firestore.document.v1.written.withAuthContext')).toBe('firestore');
    expect(classifyTriggerFamily('google.firebase.database.ref.v1.created')).toBe('rtdb');
    expect(classifyTriggerFamily('google.cloud.storage.object.v1.deleted')).toBe('storage');
    expect(classifyTriggerFamily('providers/cloud.auth/eventTypes/user.beforeSignIn')).toBe('identity');
    expect(classifyTriggerFamily('google.cloud.pubsub.topic.v1.messagePublished')).toBe('pubsub');
    expect(classifyTriggerFamily('schedule')).toBe('scheduler');
    expect(classifyTriggerFamily('task-queue')).toBe('tasks');
    expect(classifyTriggerFamily('google.firebase.analytics.event.v1.logged')).toBe('other');
  });

  it('produces short event labels, endpoint URLs, patterns, regions, and badges', () => {
    expect(shortEventLabel('https')).toBe('onRequest');
    expect(shortEventLabel('callable')).toBe('onCall');
    expect(shortEventLabel('schedule')).toBe('onSchedule');
    expect(shortEventLabel('task-queue')).toBe('onTaskDispatched');
    expect(shortEventLabel('google.cloud.firestore.document.v1.created')).toBe('document.created');
    expect(shortEventLabel('google.firebase.database.ref.v1.created')).toBe('ref.created');
    expect(shortEventLabel('google.cloud.storage.object.v1.finalized')).toBe('object.finalized');
    expect(shortEventLabel('providers/cloud.auth/eventTypes/user.beforeCreate')).toBe('user.beforeCreate');
    expect(shortEventLabel('google.cloud.pubsub.topic.v1.messagePublished')).toBe('messagePublished');

    expect(triggerEndpointUrls(ALL_FAMILY_TRIGGERS[0]!, 'http://localhost:3473', 'my-app')).toEqual([
      'http://localhost:3473/my-app/us-central1/apiHandler',
      'http://localhost:3473/my-app/europe-west1/apiHandler',
    ]);
    expect(triggerEndpointUrls(ALL_FAMILY_TRIGGERS[2]!, 'http://localhost:3473', 'my-app')).toEqual([]);
    expect(triggerRegions({ exportName: 'plainHttp', eventType: 'https' })).toEqual(['us-central1']);

    expect(triggerEventPattern(ALL_FAMILY_TRIGGERS[2]!)).toBe('orders/{orderId}');
    expect(triggerEventPattern(ALL_FAMILY_TRIGGERS[3]!)).toBe('/messages/{pushId}/original');
    expect(triggerEventPattern(ALL_FAMILY_TRIGGERS[5]!)).toBe('gs://uploads-bucket');
    expect(triggerEventPattern(ALL_FAMILY_TRIGGERS[7]!)).toBe('projects/demo-app/topics/order-events');
    expect(triggerEventPattern(ALL_FAMILY_TRIGGERS[8]!)).toBe('every day 00:00');
    expect(triggerEventPattern(ALL_FAMILY_TRIGGERS[9]!)).toBe('queue/sendDigestTask');

    expect(triggerMetaBadges(ALL_FAMILY_TRIGGERS[2]!)).toEqual([{ label: 'db', value: 'analytics' }]);
    expect(triggerMetaBadges(ALL_FAMILY_TRIGGERS[3]!)).toEqual([
      { label: 'instance', value: 'demo-default-rtdb' },
    ]);
    expect(triggerMetaBadges(ALL_FAMILY_TRIGGERS[8]!)).toEqual([
      { label: 'tz', value: 'America/New_York' },
    ]);
  });

  it('parses unsupported trigger diagnostics with and without parenthetical reasons', () => {
    const withReason = parseUnsupportedDiagnostic({
      exportName: 'brokenCron',
      eventType: 'schedule (invalid schedule: bad cron)',
    });
    expect(withReason).toMatchObject({
      exportName: 'brokenCron',
      eventType: 'schedule',
      family: 'scheduler',
      reason: 'invalid schedule: bad cron',
    });

    const bare = parseUnsupportedDiagnostic({
      exportName: 'onLog',
      eventType: 'google.firebase.analytics.event.v1.logged',
    });
    expect(bare).toMatchObject({
      exportName: 'onLog',
      eventType: 'google.firebase.analytics.event.v1.logged',
      family: 'other',
    });
    expect(bare.reason).toContain('not supported');
  });

  it('distinguishes fireable triggers from automatic-only triggers', () => {
    expect(fireCapability(ALL_FAMILY_TRIGGERS[0]!).mode).toBe('http');
    expect(fireCapability(ALL_FAMILY_TRIGGERS[1]!).mode).toBe('callable');
    expect(fireCapability(ALL_FAMILY_TRIGGERS[2]!).fireable).toBe(false);
    expect(fireCapability(ALL_FAMILY_TRIGGERS[3]!).mode).toBe('rtdb-fire');
    expect(fireCapability(ALL_FAMILY_TRIGGERS[4]!).fireable).toBe(false);
    expect(fireCapability(ALL_FAMILY_TRIGGERS[5]!).fireable).toBe(false);
    expect(fireCapability(ALL_FAMILY_TRIGGERS[6]!).fireable).toBe(false);
    expect(fireCapability(ALL_FAMILY_TRIGGERS[7]!).mode).toBe('pubsub');
    expect(fireCapability(ALL_FAMILY_TRIGGERS[8]!).mode).toBe('scheduler');
    expect(fireCapability(ALL_FAMILY_TRIGGERS[9]!).mode).toBe('tasks');
  });

  it('validates Fire payloads, RTDB paths, Pub/Sub attributes, and timeouts strictly', () => {
    expect(sampleRtdbPathFromPattern('/messages/{pushId}/original')).toBe(
      'messages/sample-pushId/original',
    );
    expect(parseOptionalJsonPayload('', { fallback: true })).toEqual({
      ok: true,
      value: { fallback: true },
      isEmpty: true,
    });
    expect(parseOptionalJsonPayload('{"hello":"world"}')).toEqual({
      ok: true,
      value: { hello: 'world' },
      isEmpty: false,
    });
    const badJson = parseOptionalJsonPayload('{not-json');
    expect(badJson.ok).toBe(false);

    expect(parseOptionalStringMap('')).toEqual({ ok: true, value: undefined });
    expect(parseOptionalStringMap('{"env":"dev"}')).toEqual({ ok: true, value: { env: 'dev' } });
    expect(parseOptionalStringMap('["a"]').ok).toBe(false);
    expect(parseOptionalStringMap('{"count":123}').ok).toBe(false);
    expect(parseOptionalStringMap('{bad').ok).toBe(false);

    expect(parseOptionalTimeoutMs('')).toEqual({ ok: true, value: undefined });
    expect(parseOptionalTimeoutMs('5000')).toEqual({ ok: true, value: 5000 });
    expect(parseOptionalTimeoutMs('0').ok).toBe(false);
    expect(parseOptionalTimeoutMs('60001').ok).toBe(false);
    expect(parseOptionalTimeoutMs('12.5').ok).toBe(false);
    expect(parseOptionalTimeoutMs('abc').ok).toBe(false);
  });

  it('filters, counts, and groups triggers in canonical family order', () => {
    const counts = countTriggersByFamily(ALL_FAMILY_TRIGGERS);
    expect(counts.rtdb).toBe(2);
    expect(counts.http).toBe(1);
    expect(counts.scheduler).toBe(1);

    const groups = groupTriggersByFamily(ALL_FAMILY_TRIGGERS);
    expect(groups.map((g) => g.family)).toEqual([
      'http',
      'callable',
      'firestore',
      'rtdb',
      'storage',
      'identity',
      'pubsub',
      'scheduler',
      'tasks',
    ]);

    expect(filterTriggers(ALL_FAMILY_TRIGGERS, { family: 'rtdb', query: '' })).toHaveLength(2);
    expect(filterTriggers(ALL_FAMILY_TRIGGERS, { family: 'all', query: 'europe-west1' })).toHaveLength(1);
    expect(filterTriggers(ALL_FAMILY_TRIGGERS, { family: 'all', query: 'order-events' })).toHaveLength(1);
  });

  it('folds live execution_finished events and deduplicates against bridge executions', () => {
    const events: SandboxEvent[] = [
      {
        kind: 'service_mutation',
        id: 'ev-auth',
        at: 1000,
        service: 'auth',
        op: 'create_user',
        path: 'u1',
        auth: null,
      } as SandboxEvent,
      {
        kind: 'service_mutation',
        id: 'ev-fn-1',
        at: 2050,
        service: 'functions',
        op: 'execution_finished',
        path: '/messages/m1/original',
        auth: null,
        detail: {
          trigger: 'makeUppercase',
          params: { pushId: 'm1' },
          startedAt: 2000,
          durationMs: 42,
          status: 'fulfilled',
          result: { upper: 'HELLO' },
        },
      } as SandboxEvent,
      {
        kind: 'service_mutation',
        id: 'ev-fn-2',
        at: 3090,
        service: 'functions',
        op: 'execution_finished',
        path: '/api/items',
        auth: null,
        detail: {
          function: 'apiHandler',
          params: { method: 'POST', path: '/api/items', status: '500' },
          startedAt: 3000,
          durationMs: 90,
          status: 'rejected',
          error: 'POST /api/items responded 500',
        },
      } as SandboxEvent,
    ];

    const live = extractLiveExecutions(events);
    expect(live).toHaveLength(2);
    expect(live[0]).toMatchObject({
      trigger: 'makeUppercase',
      status: 'fulfilled',
      durationMs: 42,
      result: { upper: 'HELLO' },
    });
    expect(live[1]).toMatchObject({
      trigger: 'apiHandler',
      status: 'rejected',
      error: 'POST /api/items responded 500',
    });

    const bridge: FunctionExecution[] = [
      {
        id: '1',
        trigger: 'makeUppercase',
        cause: { ref: '/messages/m1/original', params: { pushId: 'm1' } },
        startedAt: 2000,
        durationMs: 42,
        status: 'fulfilled',
        result: { upper: 'HELLO' },
      },
    ];
    const merged = mergeExecutions(bridge, live);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.trigger).toBe('apiHandler');
    expect(merged[1]!.trigger).toBe('makeUppercase');
    expect(formatDurationMs(0.4)).toBe('<1 ms');
    expect(formatDurationMs(42)).toBe('42 ms');
    expect(formatDurationMs(1500)).toBe('1.50 s');

    // Distinct executions under a frozen sandbox clock must never collapse.
    const sameClockBridge: FunctionExecution[] = [
      {
        id: '1',
        trigger: 'makeUppercase',
        cause: { ref: '/messages/m1/original', params: { pushId: 'm1' } },
        startedAt: 5000,
        durationMs: 10,
        status: 'fulfilled',
      },
      {
        id: '2',
        trigger: 'makeUppercase',
        cause: { ref: '/messages/m1/original', params: { pushId: 'm1' } },
        startedAt: 5000,
        durationMs: 12,
        status: 'fulfilled',
      },
    ];
    const sameClockLive: FunctionExecution[] = [
      { ...sameClockBridge[0]!, id: 'evt-1', source: 'live' },
      { ...sameClockBridge[1]!, id: 'evt-2', source: 'live' },
      { ...sameClockBridge[1]!, id: 'evt-3', source: 'live' },
    ];
    const sameClockMerged = mergeExecutions(sameClockBridge, sameClockLive);
    expect(sameClockMerged).toHaveLength(3);

    // Same startedAt but distinct durationMs between bridge and live must both survive.
    const diffDurationMerged = mergeExecutions([sameClockBridge[0]!], [sameClockLive[1]!]);
    expect(diffDurationMerged).toHaveLength(2);
  });
});
