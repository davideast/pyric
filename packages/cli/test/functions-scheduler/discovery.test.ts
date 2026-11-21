import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { rtdbValueTriggerFamily } from '../../src/functions/rtdb/discovery.js';
import {
  discoverSchedulerTriggers,
  inspectSchedulerTriggers,
  isScheduleEndpoint,
  schedulerTriggersFamily,
  validateSchedulerRetryConfig,
} from '../../src/functions/scheduler/discovery.js';
import { storageTriggersFamily } from '../../src/functions/storage/discovery.js';
import { findUnsupportedTriggers } from '../../src/functions/unsupported.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const schedulerFunctions = requireFromConformance(
  'firebase-functions/v2/scheduler',
) as typeof import('firebase-functions/v2/scheduler');
const databaseFunctions = requireFromConformance(
  'firebase-functions/v2/database',
) as typeof import('firebase-functions/v2/database');
const v2Options = requireFromConformance(
  'firebase-functions/v2',
) as typeof import('firebase-functions/v2');
const v1Functions = requireFromConformance(
  'firebase-functions/v1',
) as typeof import('firebase-functions/v1');
const paramsModule = requireFromConformance(
  'firebase-functions/params',
) as typeof import('firebase-functions/params');

describe('firebase-functions/v2/scheduler trigger discovery', () => {
  test('captures schedule, timeZone, retryConfig, region, timeoutSeconds, and nested export paths', () => {
    const { onSchedule } = schedulerFunctions;
    const { onValueCreated } = databaseFunctions;

    const hourly = onSchedule('0 * * * *', () => undefined);
    const configured = onSchedule(
      {
        schedule: 'every 15 minutes',
        timeZone: 'America/Los_Angeles',
        retryCount: 3,
        maxRetrySeconds: 120,
        minBackoffSeconds: 5,
        maxBackoffSeconds: 60,
        maxDoublings: 4,
        region: ['europe-west1', 'us-east1'],
        timeoutSeconds: 90,
      },
      () => undefined,
    );
    const rtdb = onValueCreated('/items/{id}', () => undefined);

    expect(isScheduleEndpoint(hourly.__endpoint)).toBe(true);
    expect(isScheduleEndpoint(rtdb.__endpoint)).toBe(false);
    expect(schedulerTriggersFamily.claims(hourly.__endpoint)).toBe(true);
    expect(schedulerTriggersFamily.claims(rtdb.__endpoint)).toBe(false);

    const exported = {
      hourly,
      jobs: { configured },
      rtdb,
    };

    const inspected = inspectSchedulerTriggers(exported);
    expect(inspected.unsupported).toEqual([]);
    expect(
      inspected.triggers.map((item) => ({
        exportName: item.exportName,
        schedule: item.schedule,
        parsedKind: item.parsedSchedule?.kind,
        timeZone: item.timeZone,
        retryConfig: item.retryConfig,
        region: item.region,
        regions: item.regions,
        location: item.location,
        timeoutSeconds: item.timeoutSeconds,
      })),
    ).toEqual([
      {
        exportName: 'hourly',
        schedule: '0 * * * *',
        parsedKind: 'cron',
        timeZone: undefined,
        retryConfig: {},
        region: 'us-central1',
        regions: ['us-central1'],
        location: undefined,
        timeoutSeconds: undefined,
      },
      {
        exportName: 'jobs-configured',
        schedule: 'every 15 minutes',
        parsedKind: 'interval',
        timeZone: 'America/Los_Angeles',
        retryConfig: {
          retryCount: 3,
          maxRetrySeconds: 120,
          minBackoffSeconds: 5,
          maxBackoffSeconds: 60,
          maxDoublings: 4,
        },
        region: 'europe-west1',
        regions: ['europe-west1', 'us-east1'],
        location: 'europe-west1',
        timeoutSeconds: 90,
      },
    ]);

    expect(
      findUnsupportedTriggers(exported, [
        rtdbValueTriggerFamily,
        storageTriggersFamily,
        schedulerTriggersFamily,
      ]),
    ).toEqual([]);
  });

  test('honors omit: true, classifies v1 pubsub.schedule, and refuses dynamic or invalid options', () => {
    const { onSchedule } = schedulerFunctions;
    const prevProject = process.env.GCLOUD_PROJECT;
    process.env.GCLOUD_PROJECT = 'demo-project';

    try {
      const dynamicOmit = paramsModule.defineBoolean('SCHED_OMIT');
      const dynamicZone = paramsModule.defineString('SCHED_TZ');
      const dynamicRetry = paramsModule.defineInt('SCHED_RETRY');
      const dynamicRegion = paramsModule.defineString('SCHED_REGION');
      const dynamicTimeout = paramsModule.defineInt('SCHED_TIMEOUT');

      const exported = {
        active: onSchedule('every 10 minutes', () => undefined),
        omitted: onSchedule({ schedule: '0 * * * *', omit: true }, () => undefined),
        dynOmit: onSchedule({ schedule: '0 * * * *', omit: dynamicOmit }, () => undefined),
        dynZone: onSchedule({ schedule: '0 * * * *', timeZone: dynamicZone }, () => undefined),
        badZone: onSchedule(
          { schedule: '0 * * * *', timeZone: 'Invalid/NoSuchZone' as never },
          () => undefined,
        ),
        badCron: onSchedule('99 * * * *', () => undefined),
        dynRetry: onSchedule({ schedule: '0 * * * *', retryCount: dynamicRetry }, () => undefined),
        badRetry: onSchedule({ schedule: '0 * * * *', retryCount: -1 }, () => undefined),
        dynRegion: onSchedule({ schedule: '0 * * * *', region: dynamicRegion }, () => undefined),
        dynTimeout: onSchedule(
          { schedule: '0 * * * *', timeoutSeconds: dynamicTimeout },
          () => undefined,
        ),
        badTimeout: onSchedule({ schedule: '0 * * * *', timeoutSeconds: 0 }, () => undefined),
        legacyV1: v1Functions.pubsub.schedule('every 5 minutes').onRun(() => null),
      };

      const active = discoverSchedulerTriggers(exported);
      expect(active.map((item) => item.exportName)).toEqual(['active']);

      const unsupported = findUnsupportedTriggers(exported, [schedulerTriggersFamily]);
      expect(unsupported).toEqual([
        { exportName: 'omitted', eventType: 'schedule (omitted from emulation)' },
        { exportName: 'dynOmit', eventType: 'schedule (unsupported dynamic omit option)' },
        { exportName: 'dynZone', eventType: 'schedule (unsupported dynamic timeZone option)' },
        { exportName: 'badZone', eventType: 'schedule (invalid timeZone: Invalid/NoSuchZone)' },
        {
          exportName: 'badCron',
          eventType: "schedule (invalid schedule: value '99' out of range for minute field)",
        },
        { exportName: 'dynRetry', eventType: 'schedule (unsupported dynamic retryConfig option)' },
        {
          exportName: 'badRetry',
          eventType: 'schedule (invalid retryConfig: retryCount must be a non-negative integer)',
        },
        { exportName: 'dynRegion', eventType: 'schedule (unsupported dynamic region option)' },
        {
          exportName: 'dynTimeout',
          eventType: 'schedule (unsupported dynamic timeoutSeconds option)',
        },
        { exportName: 'badTimeout', eventType: 'schedule (invalid timeoutSeconds option)' },
        { exportName: 'legacyV1', eventType: 'schedule (v1 pubsub.schedule is not supported)' },
      ]);

      const unvalidated = discoverSchedulerTriggers(
        { badCron: exported.badCron },
        { validateSchedule: false },
      );
      expect(unvalidated.map((item) => item.exportName)).toEqual(['badCron']);
    } finally {
      if (prevProject === undefined) {
        delete process.env.GCLOUD_PROJECT;
      } else {
        process.env.GCLOUD_PROJECT = prevProject;
      }
    }
  });

  test('validates retryConfig duration strings, backoff ordering, and ResetValue sentinels', () => {
    expect(validateSchedulerRetryConfig(undefined)).toEqual({
      ok: true,
      retryConfig: {},
    });

    expect(
      validateSchedulerRetryConfig({
        retryCount: { toJSON: () => null },
        maxRetrySeconds: '45s',
        minBackoffSeconds: '2.5s',
        maxBackoffSeconds: '30s',
        maxDoublings: 3,
      }),
    ).toEqual({
      ok: true,
      retryConfig: {
        maxRetrySeconds: 45,
        minBackoffSeconds: 2.5,
        maxBackoffSeconds: 30,
        maxDoublings: 3,
      },
    });

    expect(
      validateSchedulerRetryConfig({
        minBackoffSeconds: 60,
        maxBackoffSeconds: 10,
      }),
    ).toEqual({
      ok: false,
      kind: 'invalid',
      reason: 'minBackoffSeconds cannot exceed maxBackoffSeconds',
    });

    expect(validateSchedulerRetryConfig({ maxDoublings: 1.5 })).toEqual({
      ok: false,
      kind: 'invalid',
      reason: 'maxDoublings must be a non-negative integer',
    });

    expect(validateSchedulerRetryConfig({ maxRetrySeconds: '10m' })).toEqual({
      ok: false,
      kind: 'invalid',
      reason: "maxRetrySeconds duration string '10m' is invalid",
    });
  });

  test('inherits region and timeoutSeconds from setGlobalOptions when options omit them', () => {
    const { onSchedule } = schedulerFunctions;
    v2Options.setGlobalOptions({ region: 'asia-northeast1', timeoutSeconds: 45 });
    try {
      const inherited = onSchedule('0 0 * * *', () => undefined);
      const overridden = onSchedule(
        { schedule: '0 6 * * *', region: 'us-west2', timeoutSeconds: 180 },
        () => undefined,
      );
      const triggers = discoverSchedulerTriggers({ inherited, overridden });
      expect(
        triggers.map((item) => ({
          exportName: item.exportName,
          region: item.region,
          timeoutSeconds: item.timeoutSeconds,
        })),
      ).toEqual([
        { exportName: 'inherited', region: 'asia-northeast1', timeoutSeconds: 45 },
        { exportName: 'overridden', region: 'us-west2', timeoutSeconds: 180 },
      ]);
    } finally {
      v2Options.setGlobalOptions({});
    }
  });
});
