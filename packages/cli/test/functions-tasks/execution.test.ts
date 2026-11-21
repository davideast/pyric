/**
 * Unit and in-process integration tests for `startTasksTriggerExecution`:
 * verifies `pyric-admin/functions` `getFunctions(app).taskQueue(name)` bridge,
 * task ID deduplication + tombstoning, `scheduleDelaySeconds` / `scheduleTime`
 * + `delete(id)` cancellation, `rateLimits.maxConcurrentDispatches`,
 * `retryConfig.maxAttempts` + `maxRetrySeconds`, and `execution-log.ts` recording.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Request as TaskRequest } from 'firebase-functions/v2/tasks';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from 'pyric-admin/app';
import { getFunctions } from 'pyric-admin/functions';
import { listExecutions } from '../../src/functions/execution-log.js';
import { startTasksTriggerExecution } from '../../src/functions/tasks/execution.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const { onTaskDispatched } = requireFromConformance(
  'firebase-functions/v2/tasks',
) as typeof import('firebase-functions/v2/tasks');

afterEach(async () => {
  for (const app of [...getApps()]) {
    await deleteApp(app);
  }
});

describe('functions/tasks execution host', () => {
  it('bridges pyric-admin getFunctions(app).taskQueue(name).enqueue() end-to-end and records execution-log entries', async () => {
    const sandbox = initializeSandbox({ projectId: 'tasks-e2e' });
    const fixedEpoch = Date.parse('2026-09-10T14:00:00.000Z');
    getClock(sandbox).set(fixedEpoch);
    const adminApp = initializeApp({ sandbox, projectId: 'tasks-e2e' });

    const handled: Array<{ id: string; email: string; scheduledTime: string }> = [];
    const sendWelcomeEmail = onTaskDispatched<{ email: string }>(async (req) => {
      handled.push({
        id: req.id,
        email: req.data.email,
        scheduledTime: req.scheduledTime,
      });
    });

    const host = startTasksTriggerExecution({
      exported: { sendWelcomeEmail },
      sandbox,
      projectId: 'tasks-e2e',
    });

    try {
      const queue = getFunctions(adminApp).taskQueue<{ email: string }>('sendWelcomeEmail');
      await queue.enqueue(
        { email: 'ada@example.com' },
        { id: 'welcome-ada', headers: { 'x-source': 'signup' } },
      );
      await host.drainTasks();

      expect(handled).toEqual([
        {
          id: 'welcome-ada',
          email: 'ada@example.com',
          scheduledTime: '2026-09-10T14:00:00.000Z',
        },
      ]);

      const log = listExecutions(sandbox);
      expect(log).toHaveLength(1);
      expect(log[0]?.trigger).toBe('sendWelcomeEmail');
      expect(log[0]?.status).toBe('fulfilled');
      expect(log[0]?.cause.params.taskId).toBe('welcome-ada');
    } finally {
      host.close();
    }
  });

  it('schedules delayed tasks, cancels via delete(id) before dispatch, tombstones duplicate IDs, and drains deterministically on clock advance', async () => {
    const sandbox = initializeSandbox({ projectId: 'tasks-delay' });
    const baseMs = Date.parse('2026-09-10T15:00:00.000Z');
    getClock(sandbox).set(baseMs);
    const adminApp = initializeApp({ sandbox, projectId: 'tasks-delay' });

    const executedIds: string[] = [];
    const delayedWorker = onTaskDispatched(async (req) => {
      executedIds.push(req.id);
    });

    const host = startTasksTriggerExecution({
      exported: { delayedWorker },
      sandbox,
      projectId: 'tasks-delay',
      enableTimers: false,
    });

    try {
      const queue = getFunctions(adminApp).taskQueue('delayedWorker');
      await queue.enqueue({ n: 1 }, { id: 'cancel-me', scheduleDelaySeconds: 60 });
      await queue.enqueue(
        { n: 2 },
        { id: 'run-at-plus-120', scheduleTime: new Date(baseMs + 120_000) },
      );

      // Neither task is due at T+0.
      await host.drainTasks();
      expect(executedIds).toEqual([]);

      // Cancel 'cancel-me' before T+60s; re-enqueuing the same ID must still fail with
      // functions/task-already-exists.
      await queue.delete('cancel-me');
      let duplicateCode: unknown;
      let duplicateName: unknown;
      try {
        await queue.enqueue({ n: 3 }, { id: 'cancel-me' });
      } catch (err: unknown) {
        duplicateCode = (err as { code?: unknown }).code;
        duplicateName = (err as { name?: unknown }).name;
      }
      expect(duplicateCode).toBe('functions/task-already-exists');
      expect(duplicateName).toBe('FirebaseFunctionsError');

      // Advance clock to T+90s: 'cancel-me' was deleted, 'run-at-plus-120' not yet due.
      getClock(sandbox).set(baseMs + 90_000);
      await host.drainTasks();
      expect(executedIds).toEqual([]);

      // Advance clock to T+120s: 'run-at-plus-120' dispatches deterministically.
      getClock(sandbox).set(baseMs + 120_000);
      await host.drainTasks();
      expect(executedIds).toEqual(['run-at-plus-120']);
    } finally {
      host.close();
    }
  });

  it('enforces rateLimits.maxConcurrentDispatches across simultaneous enqueues', async () => {
    const sandbox = initializeSandbox({ projectId: 'tasks-concurrency' });
    let inFlight = 0;
    let maxObservedInFlight = 0;
    const releaseGates: Array<() => void> = [];

    const boundedQueue = onTaskDispatched(
      { rateLimits: { maxConcurrentDispatches: 2 } },
      async () => {
        inFlight += 1;
        if (inFlight > maxObservedInFlight) {
          maxObservedInFlight = inFlight;
        }
        await new Promise<void>((resolve) => {
          releaseGates.push(resolve);
        });
        inFlight -= 1;
      },
    );

    const host = startTasksTriggerExecution({
      exported: { boundedQueue },
      sandbox,
      projectId: 'tasks-concurrency',
    });

    try {
      for (let i = 0; i < 5; i += 1) {
        await host.enqueueTask('boundedQueue', { index: i }, { id: `job-${i}` });
      }
      await Promise.resolve();
      expect(maxObservedInFlight).toBe(2);

      while (releaseGates.length > 0) {
        const nextGate = releaseGates.shift();
        nextGate?.();
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      await host.drainTasks();

      expect(maxObservedInFlight).toBe(2);
      expect(listExecutions(sandbox)).toHaveLength(5);
    } finally {
      host.close();
    }
  });

  it('retries failed attempts up to retryConfig.maxAttempts and honors maxRetrySeconds', async () => {
    const sandbox = initializeSandbox({ projectId: 'tasks-retry' });
    let clockMs = Date.parse('2026-09-10T16:00:00.000Z');
    getClock(sandbox).set(clockMs);

    const observedAttempts: Array<{
      retryCount: number;
      executionCount: number;
      previousResponse?: number;
    }> = [];

    const flakyWorker = onTaskDispatched(
      { retryConfig: { maxAttempts: 3, minBackoffSeconds: 1 } },
      (req: TaskRequest<{ succeedOnAttempt: number }>) => {
        const snapshot: {
          retryCount: number;
          executionCount: number;
          previousResponse?: number;
        } = {
          retryCount: req.retryCount,
          executionCount: req.executionCount,
        };
        if (req.previousResponse !== undefined) {
          snapshot.previousResponse = req.previousResponse;
        }
        observedAttempts.push(snapshot);
        if (req.retryCount + 1 < req.data.succeedOnAttempt) {
          throw new Error('transient downstream timeout');
        }
      },
    );

    const windowExpiredWorker = onTaskDispatched(
      { retryConfig: { maxAttempts: 5, maxRetrySeconds: 10 } },
      () => {
        clockMs += 15_000;
        getClock(sandbox).set(clockMs);
        throw new Error('always fails and advances clock');
      },
    );

    const host = startTasksTriggerExecution({
      exported: { flakyWorker, windowExpiredWorker },
      sandbox,
      projectId: 'tasks-retry',
    });

    try {
      await host.enqueueTask('flakyWorker', { succeedOnAttempt: 3 }, { id: 'flaky-1' });
      await host.drainTasks();

      expect(observedAttempts).toEqual([
        { retryCount: 0, executionCount: 0 },
        { retryCount: 1, executionCount: 1, previousResponse: 500 },
        { retryCount: 2, executionCount: 2, previousResponse: 500 },
      ]);

      await host.enqueueTask('windowExpiredWorker', {}, { id: 'expired-1' });
      await host.drainTasks();

      const log = listExecutions(sandbox);
      const flakyRecords = log.filter((entry) => entry.trigger === 'flakyWorker');
      const expiredRecords = log.filter((entry) => entry.trigger === 'windowExpiredWorker');

      expect(flakyRecords.map((r) => r.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
      expect(flakyRecords[0]?.retryConfig).toEqual({
        maxAttempts: 3,
        minBackoffSeconds: 1,
      });
      // First attempt runs at T+0, advances clock by 15s (> maxRetrySeconds: 10), stopping retries!
      expect(expiredRecords).toHaveLength(1);
      expect(expiredRecords[0]?.status).toBe('rejected');
    } finally {
      host.close();
    }
  });
});
