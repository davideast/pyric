import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import { listExecutions } from '../../src/functions/execution-log.js';
import { startSchedulerTriggerExecution } from '../../src/functions/scheduler/execution.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const schedulerFunctions = requireFromConformance(
  'firebase-functions/v2/scheduler',
) as typeof import('firebase-functions/v2/scheduler');

describe('startSchedulerTriggerExecution', () => {
  test('fires scheduled triggers deterministically without wall-clock timers and records outcomes in execution-log', async () => {
    const { onSchedule } = schedulerFunctions;
    const sandbox = initializeSandbox();
    const fixedEpoch = Date.UTC(2026, 10, 21, 9, 30, 0);
    getClock(sandbox).set(fixedEpoch);

    const seenOrder: string[] = [];

    const firstJob = onSchedule(
      {
        schedule: '0 9 * * *',
        timeZone: 'UTC',
        retryCount: 2,
        maxRetrySeconds: 60,
        region: 'europe-west1',
      },
      async (event) => {
        seenOrder.push(`first:${event.jobName}:${event.scheduleTime}`);
      },
    );

    const failingJob = onSchedule(
      {
        schedule: 'every 30 minutes',
        retryCount: 4,
        minBackoffSeconds: 5,
        maxBackoffSeconds: 30,
      },
      async (event) => {
        seenOrder.push(`failing:${event.scheduleTime}`);
        throw new Error('transient downstream error');
      },
    );

    const siblingJob = onSchedule('*/10 * * * *', async (event) => {
      seenOrder.push(`sibling:${event.scheduleTime}`);
    });

    const host = startSchedulerTriggerExecution({
      exported: { firstJob, failingJob, nested: { siblingJob } },
      defaultLocation: 'us-central1',
      projectId: 'demo-project',
      sandbox,
    });
    await host.ready;
    expect(host.triggerCount).toBe(3);

    // Zero automatic timer executions happen before explicit triggerScheduled calls.
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 30));
    expect(seenOrder).toEqual([]);
    expect(listExecutions(sandbox)).toEqual([]);

    const run1 = await host.triggerScheduled('firstJob');
    expect(run1.status).toBe('fulfilled');
    expect(run1.jobName).toBe('firebase-schedule-firstJob-europe-west1');
    expect(run1.scheduleTime).toBe('2026-11-21T09:30:00.000Z');
    expect(run1.retryConfig).toEqual({ retryCount: 2, maxRetrySeconds: 60 });

    const run2 = await host.triggerScheduled('failingJob', {
      scheduleTime: '2026-11-21T10:00:00.000Z',
    });
    expect(run2.status).toBe('rejected');
    expect(run2.error).toContain('HTTP status 500');
    expect(run2.retryConfig).toEqual({
      retryCount: 4,
      minBackoffSeconds: 5,
      maxBackoffSeconds: 30,
    });

    // Sibling trigger still executes cleanly after `failingJob` threw.
    const run3 = await host.triggerScheduled('nested-siblingJob', {
      scheduleTime: '2026-11-21T10:10:00.000Z',
    });
    expect(run3.status).toBe('fulfilled');
    expect(run3.jobName).toBe('firebase-schedule-nested-siblingJob-us-central1');

    await host.idle();

    expect(seenOrder).toEqual([
      'first:firebase-schedule-firstJob-europe-west1:2026-11-21T09:30:00.000Z',
      'failing:2026-11-21T10:00:00.000Z',
      'sibling:2026-11-21T10:10:00.000Z',
    ]);

    const executions = listExecutions(sandbox);
    expect(executions).toHaveLength(3);
    expect(executions.map((item) => [item.id, item.trigger, item.status])).toEqual([
      ['1', 'firstJob', 'fulfilled'],
      ['2', 'failingJob', 'rejected'],
      ['3', 'nested-siblingJob', 'fulfilled'],
    ]);
    expect(executions[0]?.retryConfig).toEqual({ retryCount: 2, maxRetrySeconds: 60 });
    expect(executions[1]?.retryConfig).toEqual({
      retryCount: 4,
      minBackoffSeconds: 5,
      maxBackoffSeconds: 30,
    });
    expect(executions[1]?.error).toContain('HTTP status 500');

    await expect(host.triggerScheduled('missingExport')).rejects.toThrow(
      /not an active onSchedule export/,
    );

    host.close();
    await expect(host.triggerScheduled('firstJob')).rejects.toThrow(/closed/);
  });

  test('serializes concurrent triggerScheduled calls without interleaving async handler work', async () => {
    const { onSchedule } = schedulerFunctions;
    const sandbox = initializeSandbox();
    const trace: string[] = [];

    const slowJob = onSchedule('0 * * * *', async (event) => {
      trace.push(`enter:${event.scheduleTime}`);
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
      trace.push(`exit:${event.scheduleTime}`);
    });

    const host = startSchedulerTriggerExecution({
      exported: { slowJob },
      sandbox,
    });
    await host.ready;

    const [a, b, c] = await Promise.all([
      host.triggerScheduled('slowJob', { scheduleTime: '2026-11-21T01:00:00.000Z' }),
      host.triggerScheduled('slowJob', { scheduleTime: '2026-11-21T02:00:00.000Z' }),
      host.triggerScheduled('slowJob', { scheduleTime: '2026-11-21T03:00:00.000Z' }),
    ]);

    expect([a.status, b.status, c.status]).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(trace).toEqual([
      'enter:2026-11-21T01:00:00.000Z',
      'exit:2026-11-21T01:00:00.000Z',
      'enter:2026-11-21T02:00:00.000Z',
      'exit:2026-11-21T02:00:00.000Z',
      'enter:2026-11-21T03:00:00.000Z',
      'exit:2026-11-21T03:00:00.000Z',
    ]);
    expect(listExecutions(sandbox).map((rec) => rec.id)).toEqual(['1', '2', '3']);
    host.close();
  });
});
