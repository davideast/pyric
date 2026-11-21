/**
 * Unit tests for `firebase-functions/v2/tasks` (`onTaskDispatched`) HTTP
 * request encoding, OIDC Bearer auth token synthesis, `onInit()` execution,
 * and `HttpsError` / `500` error mapping.
 */
import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Request as TaskRequest } from 'firebase-functions/v2/tasks';
import { discoverTasksTriggers } from '../../src/functions/tasks/discovery.js';
import {
  executeTaskTriggerAttempt,
  normalizeTaskScheduledTime,
} from '../../src/functions/tasks/event.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const { onInit } = requireFromConformance(
  'firebase-functions/v2/core',
) as typeof import('firebase-functions/v2/core');
const { HttpsError } = requireFromConformance(
  'firebase-functions/v2/https',
) as typeof import('firebase-functions/v2/https');
const { onTaskDispatched } = requireFromConformance(
  'firebase-functions/v2/tasks',
) as typeof import('firebase-functions/v2/tasks');

describe('functions/tasks event runner', () => {
  it('invokes real onTaskDispatched with onInit(), zero-based counts, JSON-cleaned data, and OIDC auth without mutating process.env', async () => {
    const envBefore = process.env.FUNCTIONS_EMULATOR;
    let initCalls = 0;
    onInit(() => {
      initCalls += 1;
    });

    const capturedRequests: Array<TaskRequest<{ orderId: string; optionalField?: string }>> = [];
    const processOrder = onTaskDispatched<{ orderId: string; optionalField?: string }>(
      async (req) => {
        capturedRequests.push(req);
      },
    );

    const [trigger] = discoverTasksTriggers({ processOrder });
    expect(trigger).toBeDefined();
    if (trigger === undefined) throw new Error('Expected trigger');

    const attempt = await executeTaskTriggerAttempt(trigger, {
      queueName: 'processOrder',
      taskId: 'task-001',
      data: { orderId: 'ord-42', optionalField: undefined },
      scheduledTime: '2026-07-01T08:30:00.000Z',
      retryCount: 0,
      executionCount: 0,
      headers: {
        'X-Custom-Header': 'custom-val',
        'X-CloudTasks-TaskRetryCount': '999',
      },
      projectId: 'shop-test',
    });

    expect(process.env.FUNCTIONS_EMULATOR).toBe(envBefore);
    expect(attempt.status).toBe('fulfilled');
    expect(attempt.statusCode).toBe(204);
    expect(initCalls).toBeGreaterThanOrEqual(1);
    expect(capturedRequests).toHaveLength(1);

    const received = capturedRequests[0];
    expect(received).toBeDefined();
    expect(received?.data).toEqual({ orderId: 'ord-42' });
    expect(Object.hasOwn(received?.data ?? {}, 'optionalField')).toBe(false);
    expect(received?.queueName).toBe('processOrder');
    expect(received?.id).toBe('task-001');
    expect(received?.retryCount).toBe(0);
    expect(received?.executionCount).toBe(0);
    expect(received?.scheduledTime).toBe('2026-07-01T08:30:00.000Z');
    expect(received?.headers?.['x-custom-header']).toBe('custom-val');
    expect(received?.auth?.uid).toBe('shop-test@appspot.gserviceaccount.com');
    expect(received?.auth?.token.aud).toBe('shop-test');
  });

  it('populates retry metadata and custom OIDC auth claims on retry attempts', async () => {
    let seen: TaskRequest<unknown> | undefined;
    const retryTarget = onTaskDispatched((req) => {
      seen = req;
    });
    const [trigger] = discoverTasksTriggers({ retryTarget });
    if (trigger === undefined) throw new Error('Expected trigger');

    const attempt = await executeTaskTriggerAttempt(trigger, {
      queueName: 'retryTarget',
      taskId: 'task-retry-7',
      data: null,
      scheduledTime: normalizeTaskScheduledTime(1_780_000_000_000, 0),
      retryCount: 2,
      executionCount: 2,
      previousResponse: 503,
      retryReason: 'HTTP 503 Service Unavailable',
      auth: {
        uid: 'custom-enqueuer@shop-test.iam.gserviceaccount.com',
        token: { customRole: 'dispatcher' },
      },
      projectId: 'shop-test',
    });

    expect(attempt.status).toBe('fulfilled');
    expect(seen?.data).toBeNull();
    expect(seen?.retryCount).toBe(2);
    expect(seen?.executionCount).toBe(2);
    expect(seen?.previousResponse).toBe(503);
    expect(seen?.retryReason).toBe('HTTP 503 Service Unavailable');
    expect(seen?.auth?.uid).toBe('custom-enqueuer@shop-test.iam.gserviceaccount.com');
    expect((seen?.auth?.token as Record<string, unknown> | undefined)?.customRole).toBe(
      'dispatcher',
    );
  });

  it('maps HttpsError status codes and unhandled Error throws to rejected attempts', async () => {
    const preconditionTask = onTaskDispatched(() => {
      throw new HttpsError('failed-precondition', 'ledger not initialized');
    });
    const crashingTask = onTaskDispatched(() => {
      throw new Error('unexpected worker crash');
    });

    const triggers = discoverTasksTriggers({ preconditionTask, crashingTask });
    const preconditionTrigger = triggers.find((t) => t.exportName === 'preconditionTask');
    const crashingTrigger = triggers.find((t) => t.exportName === 'crashingTask');
    if (!preconditionTrigger || !crashingTrigger) {
      throw new Error('Expected discovered triggers');
    }

    const first = await executeTaskTriggerAttempt(preconditionTrigger, {
      queueName: 'preconditionTask',
      taskId: 't-err-1',
      data: { a: 1 },
      scheduledTime: '2026-07-01T09:00:00.000Z',
      retryCount: 0,
      executionCount: 0,
    });
    expect(first.status).toBe('rejected');
    expect(first.statusCode).toBe(400);
    if (first.status === 'rejected') {
      expect(first.error.message).toContain('ledger not initialized');
    }

    const second = await executeTaskTriggerAttempt(crashingTrigger, {
      queueName: 'crashingTask',
      taskId: 't-err-2',
      data: { a: 2 },
      scheduledTime: '2026-07-01T09:00:00.000Z',
      retryCount: 0,
      executionCount: 0,
    });
    expect(second.status).toBe('rejected');
    expect(second.statusCode).toBe(500);
  });
});
