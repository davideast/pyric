/**
 * Unit and contract parity tests for `pyric-admin/functions` (`getFunctions`,
 * `Functions`, `TaskQueue.enqueue`, and `TaskQueue.delete`).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { REMOTE_SANDBOX, getClock, initializeSandbox } from 'pyric/sandbox';
import {
  ADMIN_APP_TARGET,
  deleteApp,
  getApps,
  initializeApp,
  type PyricAdminApp,
} from '../../src/app/index.js';
import { Functions, TaskQueue, getFunctions } from '../../src/functions/index.js';
import { listStandaloneLocalTasks } from '../../src/functions/local-task-store.js';
import {
  PROCESS_TASK_QUEUE_DISPATCHER,
  SANDBOX_TASK_QUEUE_DISPATCHER,
  type AdminTaskQueueDispatcher,
  type NormalizedAdminTaskDelete,
  type NormalizedAdminTaskEnqueue,
} from '../../src/functions/types.js';

async function cleanupAdminApps(): Promise<void> {
  const existing = [...getApps()];
  for (const app of existing) {
    await deleteApp(app);
  }
}

async function expectErrorCode(
  run: () => unknown | Promise<unknown>,
  expectedCode: string,
): Promise<Error> {
  try {
    await run();
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: unknown }).code).toBe(expectedCode);
    return err as Error;
  }
  throw new Error(`Expected call to fail with code '${expectedCode}'`);
}

afterEach(async () => {
  const globalRecord = globalThis as Record<symbol, unknown>;
  delete globalRecord[PROCESS_TASK_QUEUE_DISPATCHER];
  delete globalRecord[SANDBOX_TASK_QUEUE_DISPATCHER];
  await cleanupAdminApps();
});

describe('pyric-admin/functions getFunctions() and constructors', () => {
  it('caches one Functions service per app and exposes app reference', () => {
    const sandboxA = initializeSandbox({ projectId: 'proj-alpha' });
    const sandboxB = initializeSandbox({ projectId: 'proj-beta' });
    const defaultApp = initializeApp({ sandbox: sandboxA, projectId: 'proj-alpha' });
    const secondaryApp = initializeApp(
      { sandbox: sandboxB, projectId: 'proj-beta' },
      'secondary',
    );

    const fnDefault1 = getFunctions();
    const fnDefault2 = getFunctions(defaultApp);
    const fnSecondary = getFunctions(secondaryApp);

    expect(fnDefault1).toBeInstanceOf(Functions);
    expect(fnDefault1).toBe(fnDefault2);
    expect(fnDefault1.app).toBe(defaultApp);
    expect(fnSecondary).not.toBe(fnDefault1);
    expect(fnSecondary.app).toBe(secondaryApp);
  });

  it('rejects uninitialized default app, invalid app, deleted app, and direct constructors', async () => {
    await expectErrorCode(() => getFunctions(), 'app/no-app');
    await expectErrorCode(
      () => getFunctions({} as unknown as PyricAdminApp),
      'functions/invalid-argument',
    );
    await expectErrorCode(() => new Functions(), 'functions/invalid-argument');
    await expectErrorCode(() => new TaskQueue(''), 'functions/invalid-argument');
    await expectErrorCode(() => new TaskQueue('sendWelcomeEmail'), 'functions/invalid-argument');

    const sandbox = initializeSandbox({ projectId: 'proj-deleted' });
    const app = initializeApp({ sandbox, projectId: 'proj-deleted' });
    const queue = getFunctions(app).taskQueue('sendWelcomeEmail');
    await deleteApp(app);

    await expectErrorCode(() => getFunctions(app), 'app/app-deleted');
    await expectErrorCode(() => queue.enqueue({ userId: 'u1' }), 'app/app-deleted');
    await expectErrorCode(() => queue.delete('task-1'), 'app/app-deleted');
  });
});

describe('pyric-admin/functions TaskQueue standalone store and tombstoning', () => {
  it('enqueues JSON-roundtripped payloads, computes deterministic scheduledTime, and supports frozen sandboxes', async () => {
    const sandbox = initializeSandbox({ projectId: 'proj-tasks' });
    const fixedEpochMs = Date.parse('2026-06-15T10:00:00.000Z');
    getClock(sandbox).set(fixedEpochMs);
    Object.freeze(sandbox);

    const app = initializeApp({ sandbox, projectId: 'proj-tasks' });
    const queue = getFunctions(app).taskQueue<{
      orderId: string;
      optionalNote?: string;
      toJSON?: () => unknown;
    }>('processOrder');

    await queue.enqueue(
      {
        orderId: 'ord-101',
        optionalNote: undefined,
      },
      {
        id: 'task_ord_101',
        scheduleDelaySeconds: 30,
        dispatchDeadlineSeconds: 120,
        headers: { 'x-trace-id': 'trace-abc' },
        uri: 'https://example.com/internal/processOrder',
      },
    );

    const pending = listStandaloneLocalTasks(sandbox, 'processOrder');
    expect(pending).toHaveLength(1);
    const first = pending[0];
    expect(first).toBeDefined();
    expect(first?.id).toBe('task_ord_101');
    expect(first?.projectId).toBe('proj-tasks');
    expect(first?.locationId).toBe('us-central1');
    expect(first?.data).toEqual({ orderId: 'ord-101' });
    expect(Object.hasOwn(first?.data as Record<string, unknown>, 'optionalNote')).toBe(false);
    expect(first?.scheduledTime).toBe('2026-06-15T10:00:30.000Z');
    expect(first?.dispatchDeadlineSeconds).toBe(120);
    expect(first?.headers).toEqual({
      'Content-Type': 'application/json',
      'x-trace-id': 'trace-abc',
    });
    expect(first?.uri).toBe('https://example.com/internal/processOrder');
  });

  it('rejects duplicate task IDs with functions/task-already-exists even after delete(id)', async () => {
    const sandbox = initializeSandbox({ projectId: 'proj-dedup' });
    const app = initializeApp({ sandbox, projectId: 'proj-dedup' });
    const queue = getFunctions(app).taskQueue('billingSync');

    await queue.enqueue({ invoiceId: 'inv-1' }, { id: 'dedup-key-1' });
    await expectErrorCode(
      () => queue.enqueue({ invoiceId: 'inv-1' }, { id: 'dedup-key-1' }),
      'functions/task-already-exists',
    );

    await queue.delete('dedup-key-1');
    expect(listStandaloneLocalTasks(sandbox, 'billingSync')).toHaveLength(0);

    // Deleting a non-existent ID is a clean no-op in standalone mode, while re-enqueuing a
    // tombstoned ID still throws functions/task-already-exists matching Cloud Tasks semantics.
    await queue.delete('never-existed-id');
    await expectErrorCode(
      () => queue.enqueue({ invoiceId: 'inv-2' }, { id: 'dedup-key-1' }),
      'functions/task-already-exists',
    );
  });
});

describe('pyric-admin/functions resource names and option validation', () => {
  it('parses bare names, location-qualified names, full project resource names, and extensionId', async () => {
    const sandbox = initializeSandbox({ projectId: 'default-proj' });
    const app = initializeApp({ sandbox, projectId: 'default-proj' });

    const recordedEnqueues: NormalizedAdminTaskEnqueue[] = [];
    const recordedDeletes: NormalizedAdminTaskDelete[] = [];
    const dispatcherMap = new WeakMap<object, AdminTaskQueueDispatcher>();
    dispatcherMap.set(sandbox, {
      async enqueue(req) {
        recordedEnqueues.push(req);
      },
      async delete(req) {
        recordedDeletes.push(req);
      },
    });
    (globalThis as Record<symbol, unknown>)[SANDBOX_TASK_QUEUE_DISPATCHER] = dispatcherMap;

    const bareQueue = getFunctions(app).taskQueue('resizeImage', 'image-resizer');
    await bareQueue.enqueue({ path: 'a.png' }, { id: 'img-1' });

    const regionalQueue = getFunctions(app).taskQueue('locations/europe-west1/functions/sendDigest');
    await regionalQueue.enqueue(
      { batch: 2 },
      { scheduleTime: new Date('2026-08-01T12:00:00.000Z') },
    );

    const fullQueue = getFunctions(app).taskQueue(
      'projects/override-proj/locations/asia-northeast1/functions/exportAudit',
    );
    await fullQueue.enqueue({ ok: true });
    await fullQueue.delete('audit-task-9');

    expect(recordedEnqueues).toHaveLength(3);
    expect(recordedEnqueues[0]).toEqual({
      queueName: 'ext-image-resizer-resizeImage',
      projectId: 'default-proj',
      extensionId: 'image-resizer',
      data: { path: 'a.png' },
      id: 'img-1',
    });
    expect(recordedEnqueues[1]).toEqual({
      queueName: 'sendDigest',
      projectId: 'default-proj',
      locationId: 'europe-west1',
      data: { batch: 2 },
      scheduleTimeIso: '2026-08-01T12:00:00.000Z',
    });
    expect(recordedEnqueues[2]).toEqual({
      queueName: 'exportAudit',
      projectId: 'override-proj',
      locationId: 'asia-northeast1',
      data: { ok: true },
    });
    expect(recordedDeletes).toEqual([
      {
        queueName: 'exportAudit',
        projectId: 'override-proj',
        locationId: 'asia-northeast1',
        id: 'audit-task-9',
      },
    ]);
  });

  it('routes RemoteSandbox apps through PROCESS_TASK_QUEUE_DISPATCHER when installed', async () => {
    const dispatched: NormalizedAdminTaskEnqueue[] = [];
    (globalThis as Record<symbol, unknown>)[PROCESS_TASK_QUEUE_DISPATCHER] = {
      async enqueue(req: NormalizedAdminTaskEnqueue) {
        dispatched.push(req);
      },
      async delete() {},
    } satisfies AdminTaskQueueDispatcher;

    const fakeRemoteApp = {
      name: 'remote-child-app',
      options: { projectId: 'child-proj' },
      sandbox: {
        [REMOTE_SANDBOX]: true,
        projectId: 'child-proj',
        channel: {
          async op() {
            return {};
          },
          subscribe() {
            return () => {};
          },
          close() {},
        },
      },
      [ADMIN_APP_TARGET]: 'sandbox',
    } as unknown as PyricAdminApp;

    const queue = getFunctions(fakeRemoteApp).taskQueue('workerQueue');
    await queue.enqueue({ step: 'reindex' }, { id: 'child-task-1' });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.queueName).toBe('workerQueue');
    expect(dispatched[0]?.projectId).toBe('child-proj');
    expect(dispatched[0]?.id).toBe('child-task-1');
  });

  it('validates functionName, extensionId, id, delivery schedule, deadline, uri, and headers', async () => {
    const sandbox = initializeSandbox({ projectId: 'proj-val' });
    const app = initializeApp({ sandbox, projectId: 'proj-val' });
    const fn = getFunctions(app);

    await expectErrorCode(() => fn.taskQueue(''), 'functions/invalid-argument');
    await expectErrorCode(
      () => fn.taskQueue('worker', 123 as unknown as string),
      'functions/invalid-argument',
    );

    const badPathQueue = fn.taskQueue('projects/only-two-parts');
    await expectErrorCode(() => badPathQueue.enqueue({}), 'functions/invalid-argument');

    const queue = fn.taskQueue('validQueue');
    await expectErrorCode(
      () => queue.enqueue({}, { id: 'bad/slash' }),
      'functions/invalid-argument',
    );
    await expectErrorCode(
      () => queue.enqueue({}, { id: 'a'.repeat(501) }),
      'functions/invalid-argument',
    );
    await expectErrorCode(() => queue.delete('bad space'), 'functions/invalid-argument');
    await expectErrorCode(
      () =>
        queue.enqueue(
          {},
          {
            scheduleDelaySeconds: 10,
            scheduleTime: new Date('2026-09-01T00:00:00Z'),
          } as unknown as Parameters<typeof queue.enqueue>[1],
        ),
      'functions/invalid-argument',
    );
    await expectErrorCode(
      () => queue.enqueue({}, { scheduleTime: new Date('not-a-date') }),
      'functions/invalid-argument',
    );
    await expectErrorCode(
      () => queue.enqueue({}, { scheduleDelaySeconds: -5 }),
      'functions/invalid-argument',
    );
    await expectErrorCode(
      () => queue.enqueue({}, { dispatchDeadlineSeconds: 14 }),
      'functions/invalid-argument',
    );
    await expectErrorCode(
      () => queue.enqueue({}, { dispatchDeadlineSeconds: 1801 }),
      'functions/invalid-argument',
    );
    await expectErrorCode(
      () => queue.enqueue({}, { uri: 'ftp://example.com/task' }),
      'functions/invalid-argument',
    );
    await expectErrorCode(
      () => queue.enqueue({}, { headers: { 'x-bad': 42 as unknown as string } }),
      'functions/invalid-argument',
    );
    await expectErrorCode(
      () => queue.enqueue({}, { headers: { 'x-huge': 'x'.repeat(81 * 1024) } }),
      'functions/invalid-argument',
    );
  });
});
