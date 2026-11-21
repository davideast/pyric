/**
 * Unit tests for `startTasksChildRuntime` and child IPC helpers
 * (`sendChildEnqueueTask`, `sendChildDeleteTask`, `sendChildDrainTasks`).
 */
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { REMOTE_SANDBOX } from 'pyric/sandbox';
import { ADMIN_APP_TARGET, deleteApp, getApps, type PyricAdminApp } from 'pyric-admin/app';
import { getFunctions } from 'pyric-admin/functions';
import type { RemoteSandbox } from '../../src/remote/index.js';
import type { FunctionsChildEvent } from '../../src/functions/child-protocol.js';
import {
  sendChildDeleteTask,
  sendChildDrainTasks,
  sendChildEnqueueTask,
  startTasksChildRuntime,
  type TasksHostRequest,
} from '../../src/functions/tasks/child-runtime.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const { onTaskDispatched } = requireFromConformance(
  'firebase-functions/v2/tasks',
) as typeof import('firebase-functions/v2/tasks');

function createMockRemoteSandbox(nowMs: number): RemoteSandbox {
  return {
    [REMOTE_SANDBOX]: true,
    serveUrl: 'http://127.0.0.1:4400',
    channel: {
      async op(payload: { method: string }) {
        if (payload.method === 'sandbox.clock') {
          return { now: nowMs };
        }
        return {};
      },
      subscribe() {
        return () => {};
      },
    },
  } as unknown as RemoteSandbox;
}

afterEach(async () => {
  for (const app of [...getApps()]) {
    await deleteApp(app);
  }
});

describe('functions/tasks child-runtime', () => {
  it('installs PROCESS_TASK_QUEUE_DISPATCHER so in-child getFunctions().taskQueue().enqueue() dispatches to onTaskDispatched', async () => {
    const fixedMs = Date.parse('2026-10-01T12:00:00.000Z');
    const remoteSandbox = createMockRemoteSandbox(fixedMs);
    const childEvents: FunctionsChildEvent[] = [];
    const receivedPayloads: Array<{ invoiceId: string; id: string }> = [];

    const generatePdf = onTaskDispatched<{ invoiceId: string }>((req) => {
      receivedPayloads.push({ invoiceId: req.data.invoiceId, id: req.id });
    });

    const childHost = startTasksChildRuntime({
      exported: { generatePdf },
      sandbox: remoteSandbox,
      location: 'us-central1',
      projectId: 'child-tasks-proj',
      send(event) {
        childEvents.push(event);
      },
    });

    try {
      const childAdminApp = {
        name: 'child-default',
        options: { projectId: 'child-tasks-proj' },
        sandbox: remoteSandbox,
        [ADMIN_APP_TARGET]: 'sandbox',
      } as unknown as PyricAdminApp;

      const queue = getFunctions(childAdminApp).taskQueue<{ invoiceId: string }>('generatePdf');
      await queue.enqueue({ invoiceId: 'inv-900' }, { id: 'pdf-task-900' });
      await childHost.drainTasks();

      expect(receivedPayloads).toEqual([{ invoiceId: 'inv-900', id: 'pdf-task-900' }]);
      expect(childEvents).toHaveLength(1);
      expect(childEvents[0]?.type).toBe('execution');
      if (childEvents[0]?.type === 'execution') {
        expect(childEvents[0].exportName).toBe('generatePdf');
        expect(childEvents[0].status).toBe('fulfilled');
      }
    } finally {
      childHost.close();
    }

    const globalRecord = globalThis as Record<symbol, unknown>;
    expect(globalRecord[Symbol.for('pyric.functions.processTaskQueueDispatcher')]).toBeUndefined();
  });

  it('handles enqueue-task, delete-task, drain-tasks, and coded error replies over child IPC', async () => {
    const fixedMs = Date.parse('2026-10-01T13:00:00.000Z');
    const remoteSandbox = createMockRemoteSandbox(fixedMs);
    const executed: string[] = [];

    const auditTask = onTaskDispatched<{ label: string }>((req) => {
      executed.push(`${req.id}:${req.data.label}`);
    });

    const childHost = startTasksChildRuntime({
      exported: { auditTask },
      sandbox: remoteSandbox,
      location: 'us-central1',
      projectId: 'ipc-tasks-proj',
      send() {},
    });

    const fakeChildEmitter = new EventEmitter();
    const fakeChild = Object.assign(fakeChildEmitter, {
      exitCode: null,
      signalCode: null,
      connected: true,
      send(msg: TasksHostRequest, cb?: (err: Error | null) => void) {
        cb?.(null);
        void childHost.handleHostRequest(msg).then((reply) => {
          fakeChildEmitter.emit('message', reply);
        });
        return true;
      },
    }) as unknown as ChildProcess;

    try {
      const delayedReceipt = await sendChildEnqueueTask(
        fakeChild,
        'auditTask',
        { label: 'delayed' },
        { id: 't-del', scheduleDelaySeconds: 300 },
      );
      expect(delayedReceipt.delayed).toBe(true);

      const wasDeleted = await sendChildDeleteTask(fakeChild, 'auditTask', 't-del');
      expect(wasDeleted).toBe(true);

      const immediateReceipt = await sendChildEnqueueTask(
        fakeChild,
        'auditTask',
        { label: 'now' },
        { id: 't-now' },
      );
      expect(immediateReceipt.delayed).toBe(false);

      await sendChildDrainTasks(fakeChild, { flushDelayed: true });
      expect(executed).toEqual(['t-now:now']);

      let dupCode: unknown;
      try {
        await sendChildEnqueueTask(fakeChild, 'auditTask', { label: 'dup' }, { id: 't-now' });
      } catch (err: unknown) {
        dupCode = (err as { code?: unknown }).code;
      }
      expect(dupCode).toBe('functions/task-already-exists');
    } finally {
      childHost.close();
    }
  });
});
