import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { discoverSchedulerTriggers } from '../../src/functions/scheduler/discovery.js';
import {
  buildScheduledEvent,
  defaultSchedulerJobName,
  executeSchedulerTrigger,
  normalizeScheduleTime,
} from '../../src/functions/scheduler/event.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const schedulerFunctions = requireFromConformance(
  'firebase-functions/v2/scheduler',
) as typeof import('firebase-functions/v2/scheduler');
const coreFunctions = requireFromConformance(
  'firebase-functions/v2/core',
) as typeof import('firebase-functions/v2/core');

describe('ScheduledEvent encoding and handler invocation', () => {
  test('normalizes scheduleTime across ISO strings, timezone offsets, Dates, and epoch ms', () => {
    const fallbackMs = Date.UTC(2026, 10, 21, 12, 0, 0);
    expect(normalizeScheduleTime(undefined, fallbackMs)).toBe('2026-11-21T12:00:00.000Z');
    expect(normalizeScheduleTime('2026-11-21T15:30:00Z', fallbackMs)).toBe(
      '2026-11-21T15:30:00.000Z',
    );
    expect(normalizeScheduleTime('2026-11-21T10:30:00-05:00', fallbackMs)).toBe(
      '2026-11-21T15:30:00.000Z',
    );
    expect(normalizeScheduleTime(new Date(fallbackMs), 0)).toBe('2026-11-21T12:00:00.000Z');
    expect(normalizeScheduleTime(fallbackMs, 0)).toBe('2026-11-21T12:00:00.000Z');

    expect(() => normalizeScheduleTime('not-a-timestamp', fallbackMs)).toThrow(
      /Invalid scheduleTime/,
    );
    expect(() => normalizeScheduleTime(Number.NaN, fallbackMs)).toThrow(/Invalid scheduleTime/);
    expect(() => normalizeScheduleTime(new Date('invalid'), fallbackMs)).toThrow(
      /Invalid scheduleTime/,
    );
  });

  test('builds ScheduledEvent with default jobName and non-enumerable v1-compat context getter', () => {
    expect(defaultSchedulerJobName('dailyBilling', 'europe-west1')).toBe(
      'firebase-schedule-dailyBilling-europe-west1',
    );

    const event = buildScheduledEvent({
      jobName: 'firebase-schedule-dailyBilling-europe-west1',
      scheduleTime: '2026-11-21T00:00:00.000Z',
      projectId: 'acme-prod',
    });
    expect(event).toEqual({
      jobName: 'firebase-schedule-dailyBilling-europe-west1',
      scheduleTime: '2026-11-21T00:00:00.000Z',
    });
    expect(Object.keys(event)).toEqual(['jobName', 'scheduleTime']);

    const withContext = event as unknown as {
      context: {
        eventId: string;
        timestamp: string;
        eventType: string;
        resource: { service: string; name: string };
        params: Record<string, string>;
      };
    };
    expect(withContext.context).toEqual({
      eventId: 'firebase-schedule-dailyBilling-europe-west1',
      timestamp: '2026-11-21T00:00:00.000Z',
      eventType: 'google.pubsub.topic.publish',
      resource: {
        service: 'pubsub.googleapis.com',
        name: 'projects/acme-prod/topics/firebase-schedule-dailyBilling-europe-west1',
      },
      params: {},
    });
  });

  test('executes real firebase-functions/v2/scheduler onSchedule with onInit() and rejects on handler throw', async () => {
    const prevProject = process.env.GCLOUD_PROJECT;
    process.env.GCLOUD_PROJECT = 'demo-project';

    try {
      let initRuns = 0;
      coreFunctions.onInit(async () => {
        await Promise.resolve();
        initRuns += 1;
      });

      const receivedEvents: Array<{
        jobName: string | undefined;
        scheduleTime: string;
        contextResource: string;
      }> = [];

      const okJob = schedulerFunctions.onSchedule('0 * * * *', async (event) => {
        const ctx = (event as unknown as { context?: { resource?: { name?: string } } }).context;
        receivedEvents.push({
          jobName: event.jobName,
          scheduleTime: event.scheduleTime,
          contextResource: ctx?.resource?.name ?? '',
        });
      });

      const throwingJob = schedulerFunctions.onSchedule('every 5 minutes', async () => {
        throw new Error('database quota exceeded');
      });

      const discovered = discoverSchedulerTriggers({ okJob, throwingJob });
      const okTrigger = discovered.find((item) => item.exportName === 'okJob');
      const throwingTrigger = discovered.find((item) => item.exportName === 'throwingJob');
      if (!okTrigger || !throwingTrigger) {
        throw new Error('expected okJob and throwingJob to be discovered');
      }

      const firstRun = await executeSchedulerTrigger(okTrigger, {
        jobName: 'firebase-schedule-okJob-us-central1',
        scheduleTime: '2026-11-21T16:00:00.000Z',
        projectId: 'demo-project',
      });
      expect(firstRun.status).toBe('fulfilled');
      expect(initRuns).toBe(1);
      expect(receivedEvents).toEqual([
        {
          jobName: 'firebase-schedule-okJob-us-central1',
          scheduleTime: '2026-11-21T16:00:00.000Z',
          contextResource: 'projects/demo-project/topics/firebase-schedule-okJob-us-central1',
        },
      ]);

      const manualRun = await executeSchedulerTrigger(okTrigger, {
        scheduleTime: '2026-11-21T17:00:00.000Z',
        projectId: 'demo-project',
      });
      expect(manualRun.status).toBe('fulfilled');
      expect(initRuns).toBe(1);
      expect(receivedEvents[1]).toEqual({
        jobName: undefined,
        scheduleTime: '2026-11-21T17:00:00.000Z',
        contextResource: 'projects/demo-project/topics/unknown-job',
      });

      const failedRun = await executeSchedulerTrigger(throwingTrigger, {
        jobName: 'firebase-schedule-throwingJob-us-central1',
        scheduleTime: '2026-11-21T18:00:00.000Z',
        projectId: 'demo-project',
      });
      expect(failedRun.status).toBe('rejected');
      if (failedRun.status === 'rejected') {
        expect(failedRun.error).toBeInstanceOf(Error);
        expect((failedRun.error as Error).message).toContain('HTTP status 500');
      }
    } finally {
      coreFunctions.onInit(() => undefined);
      if (prevProject === undefined) {
        delete process.env.GCLOUD_PROJECT;
      } else {
        process.env.GCLOUD_PROJECT = prevProject;
      }
    }
  });

  test('propagates onInit() failures, survives null throws in scheduler.js, and supports direct callable handlers', async () => {
    coreFunctions.onInit(async () => {
      throw new Error('secret manager unreachable');
    });
    try {
      const guardedJob = schedulerFunctions.onSchedule('0 * * * *', async () => undefined);
      const [discovered] = discoverSchedulerTriggers({ guardedJob });
      if (!discovered) throw new Error('expected guardedJob');

      const initFailed = await executeSchedulerTrigger(discovered, {
        jobName: 'firebase-schedule-guardedJob-us-central1',
        scheduleTime: '2026-11-21T19:00:00.000Z',
      });
      expect(initFailed.status).toBe('rejected');
      if (initFailed.status === 'rejected') {
        expect((initFailed.error as Error).message).toContain('secret manager unreachable');
      }
    } finally {
      coreFunctions.onInit(() => undefined);
    }

    // Throwing `null` inside `scheduler.js` triggers `err.message` TypeError in upstream catch;
    // executeSchedulerTrigger catches that outer rejection cleanly instead of crashing the child.
    const nullThrowingJob = schedulerFunctions.onSchedule('0 * * * *', async () => {
      throw null;
    });
    const [nullTrigger] = discoverSchedulerTriggers({ nullThrowingJob });
    if (!nullTrigger) throw new Error('expected nullThrowingJob');
    const nullResult = await executeSchedulerTrigger(nullTrigger, {
      scheduleTime: '2026-11-21T19:05:00.000Z',
    });
    expect(nullResult.status).toBe('rejected');

    // Synthetic unit callable without `.run` receives ScheduledEvent directly and preserves return value.
    const synthetic = Object.assign(
      async (event: { scheduleTime: string; jobName?: string }) =>
        `ran:${event.jobName ?? 'manual'}@${event.scheduleTime}`,
      {
        __endpoint: {
          platform: 'gcfv2',
          scheduleTrigger: { schedule: 'every 10 minutes' },
        },
      },
    );
    const [syntheticTrigger] = discoverSchedulerTriggers({ synthetic });
    if (!syntheticTrigger) throw new Error('expected synthetic trigger');
    const directResult = await executeSchedulerTrigger(syntheticTrigger, {
      jobName: '',
      scheduleTime: '2026-11-21T19:10:00.000Z',
    });
    expect(directResult).toEqual({
      status: 'fulfilled',
      event: {
        jobName: undefined,
        scheduleTime: '2026-11-21T19:10:00.000Z',
      },
      result: 'ran:manual@2026-11-21T19:10:00.000Z',
    });
  });
});
