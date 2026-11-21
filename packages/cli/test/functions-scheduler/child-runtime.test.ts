import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { initializeSandbox } from 'pyric/sandbox';
import type {
  FunctionsChildEvent,
  TriggerScheduledHostRequest,
} from '../../src/functions/child-protocol.js';
import { createFunctionsDevelopmentRuntime } from '../../src/functions/development-runtime.js';
import { listExecutions } from '../../src/functions/execution-log.js';
import {
  sendChildTriggerScheduled,
  startSchedulerChildRuntime,
} from '../../src/functions/scheduler/child-runtime.js';
import type { FunctionsChildHandle } from '../../src/functions/spawn.js';
import { createRemoteSandboxHandle } from '../../src/remote/index.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const schedulerFunctions = requireFromConformance(
  'firebase-functions/v2/scheduler',
) as typeof import('firebase-functions/v2/scheduler');

describe('startSchedulerChildRuntime and development-runtime IPC bridge', () => {
  test('bridges runtime.triggerScheduled over activeChild.child IPC and records into execution-log', async () => {
    const { onSchedule } = schedulerFunctions;
    const fixedClockMs = Date.UTC(2026, 10, 21, 14, 0, 0);
    const childEvents: FunctionsChildEvent[] = [];
    const seenEvents: Array<{ jobName?: string; scheduleTime: string }> = [];

    const reportJob = onSchedule(
      { schedule: '0 * * * *', retryCount: 2, maxRetrySeconds: 90 },
      async (event) => {
        seenEvents.push({ jobName: event.jobName, scheduleTime: event.scheduleTime });
      },
    );
    const brokenJob = onSchedule('every 5 minutes', async () => {
      throw new Error('simulated failure');
    });

    const remoteSandbox = createRemoteSandboxHandle({
      serveUrl: 'http://127.0.0.1:4500',
      close() {},
      channel: {
        async op(payload) {
          if (payload.method === 'sandbox.clock') {
            return { now: fixedClockMs };
          }
          return { ok: true };
        },
        subscribe() {
          return () => undefined;
        },
      },
    });

    const childRuntime = startSchedulerChildRuntime({
      exported: { reportJob, brokenJob },
      sandbox: remoteSandbox,
      location: 'us-central1',
      projectId: 'demo-project',
      send: (event) => childEvents.push(event),
    });
    await childRuntime.ready;
    expect(childRuntime.triggerCount).toBe(2);

    const childEmitter = new EventEmitter();
    const fakeProc = Object.assign(childEmitter, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      connected: true,
      send(message: unknown, callback?: (error: Error | null) => void): boolean {
        const req = message as TriggerScheduledHostRequest;
        if (req.type === 'trigger-scheduled') {
          void childRuntime.handleHostTriggerRequest(req).then((reply) => {
            queueMicrotask(() => childEmitter.emit('message', reply));
          });
        }
        callback?.(null);
        return true;
      },
    }) as unknown as ChildProcess;

    let resolveExited: (code: number) => void = () => {};
    const exited = new Promise<number>((res) => {
      resolveExited = res;
    });
    const childHandle: FunctionsChildHandle = {
      child: fakeProc,
      ready: Promise.resolve({ triggerCount: 2, unsupportedTriggers: [] }),
      exited,
      async stop() {
        (fakeProc as { exitCode: number | null }).exitCode = 0;
        childRuntime.close();
        await childRuntime.idle();
        resolveExited(0);
        return 0;
      },
    };

    const hostSandbox = initializeSandbox();
    const devRuntime = createFunctionsDevelopmentRuntime({
      sourceDir: '/project/functions',
      entry: '/project/functions/index.js',
      baseEnv: {},
      serveUrl: 'http://127.0.0.1:4500',
      registerUrl: 'file:///register.js',
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
      readiness: { wait: async () => true },
      spawn: () => childHandle,
      sandbox: hostSandbox,
    });

    await expect(devRuntime.triggerScheduled('reportJob')).rejects.toThrow(
      /no active child process/,
    );

    const started = await devRuntime.start();
    expect(started.kind).toBe('ready');

    const okResult = await devRuntime.triggerScheduled('reportJob');
    expect(okResult.status).toBe('fulfilled');
    expect(okResult.scheduleTime).toBe('2026-11-21T14:00:00.000Z');
    expect(okResult.jobName).toBe('firebase-schedule-reportJob-us-central1');
    expect(okResult.retryConfig).toEqual({ retryCount: 2, maxRetrySeconds: 90 });

    const overrideResult = await devRuntime.triggerScheduled('reportJob', {
      scheduleTime: '2026-11-21T15:00:00.000Z',
      jobName: undefined,
    });
    expect(overrideResult.status).toBe('fulfilled');
    expect(overrideResult.jobName).toBeUndefined();
    expect(seenEvents).toEqual([
      {
        jobName: 'firebase-schedule-reportJob-us-central1',
        scheduleTime: '2026-11-21T14:00:00.000Z',
      },
      {
        jobName: undefined,
        scheduleTime: '2026-11-21T15:00:00.000Z',
      },
    ]);

    const failedResult = await devRuntime.triggerScheduled('brokenJob', {
      scheduleTime: '2026-11-21T15:05:00.000Z',
    });
    expect(failedResult.status).toBe('rejected');
    expect(failedResult.error).toContain('HTTP status 500');

    await expect(devRuntime.triggerScheduled('unknownJob')).rejects.toThrow(
      /not an active onSchedule export/,
    );
    await expect(
      devRuntime.triggerScheduled('reportJob', { scheduleTime: 'bad-date' }),
    ).rejects.toThrow(/Invalid scheduleTime/);

    expect(childEvents.map((evt) => [evt.type, evt.exportName, 'status' in evt ? evt.status : ''])).toEqual([
      ['execution', 'reportJob', 'fulfilled'],
      ['execution', 'reportJob', 'fulfilled'],
      ['execution', 'brokenJob', 'rejected'],
    ]);

    const records = listExecutions(hostSandbox);
    expect(records.map((rec) => [rec.id, rec.trigger, rec.status])).toEqual([
      ['1', 'reportJob', 'fulfilled'],
      ['2', 'reportJob', 'fulfilled'],
      ['3', 'brokenJob', 'rejected'],
    ]);
    expect(records[0]?.retryConfig).toEqual({ retryCount: 2, maxRetrySeconds: 90 });

    await devRuntime.close();
    await expect(devRuntime.triggerScheduled('reportJob')).rejects.toThrow(/closed/);
  });

  test('rejects in-flight sendChildTriggerScheduled and cleans up listeners if child disconnects or closes', async () => {
    const emitter = new EventEmitter();
    const proc = Object.assign(emitter, {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      connected: true,
      send(_msg: unknown, cb?: (err: Error | null) => void): boolean {
        cb?.(null);
        return true;
      },
    }) as unknown as ChildProcess;

    const pendingDisconnect = sendChildTriggerScheduled(proc, 'jobA');
    expect(emitter.listenerCount('message')).toBe(1);
    emitter.emit('disconnect');
    await expect(pendingDisconnect).rejects.toThrow(/disconnected/);
    expect(emitter.listenerCount('message')).toBe(0);
    expect(emitter.listenerCount('close')).toBe(0);
    expect(emitter.listenerCount('disconnect')).toBe(0);

    const pendingClose = sendChildTriggerScheduled(proc, 'jobB');
    emitter.emit('close', 1);
    await expect(pendingClose).rejects.toThrow(/exited/);
    expect(emitter.listenerCount('message')).toBe(0);

    (proc as { connected: boolean }).connected = false;
    await expect(sendChildTriggerScheduled(proc, 'jobC')).rejects.toThrow(/disconnected/);
  });
});
