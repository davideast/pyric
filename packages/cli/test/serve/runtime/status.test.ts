import { describe, expect, it } from 'bun:test';
import {
  createPyricRuntimeStatus,
  normalizePyricRuntimeError,
} from '../../../src/serve/runtime/status.js';
import type { PyricRuntimeManifest } from '../../../src/serve/runtime/manifest.js';

const manifest: PyricRuntimeManifest = {
  studioUrl: '/__pyric/ui/',
  worker: {
    url: '/__pyric/sdk/worker.js',
    name: 'pyric-shared-worker',
    servedEpoch: 'served-2',
  },
};

describe('Pyric runtime status', () => {
  it('marks a different running worker epoch as an available update', () => {
    const runtime = createPyricRuntimeStatus(manifest);
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'running-1' });

    expect(runtime.getSnapshot()).toMatchObject({
      mode: 'shared-worker',
      servedEpoch: 'served-2',
      runningEpoch: 'running-1',
      updateAvailable: true,
    });

    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'served-2' });
    expect(runtime.getSnapshot().updateAvailable).toBe(false);
  });

  it('publishes the current snapshot immediately and after changes', () => {
    const runtime = createPyricRuntimeStatus(manifest);
    const seen: boolean[] = [];
    const unsubscribe = runtime.subscribe((snapshot) => seen.push(snapshot.updateAvailable));
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'running-1' });
    unsubscribe();
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'served-2' });

    expect(seen).toEqual([false, true]);
  });

  it('normalizes and deduplicates sandbox runtime-error events', () => {
    const runtime = createPyricRuntimeStatus(manifest);
    const event = {
      kind: 'runtime_error' as const,
      id: 'sandbox-error-1',
      at: 123,
      service: 'firestore' as const,
      method: 'setDoc',
      path: 'posts/a',
      auth: { uid: null, token: null },
      error: { code: 'permission-denied', message: 'write denied' },
    };

    runtime.recordSandboxEvents([event, event]);

    expect(runtime.getSnapshot().errors).toEqual([{
      id: 'sandbox-error-1',
      source: 'sandbox',
      at: 123,
      service: 'firestore',
      method: 'setDoc',
      path: 'posts/a',
      code: 'permission-denied',
      message: 'write denied',
    }]);
  });

  it('normalizes errored listeners into the same error shape', () => {
    const runtime = createPyricRuntimeStatus(manifest);
    runtime.recordSandboxEvents([{
      kind: 'listener',
      id: 'listener-error-1',
      at: 456,
      service: 'database',
      phase: 'errored',
      listenerId: 'listener-1',
      target: { kind: 'value', path: 'messages' },
      auth: { uid: null, token: null },
      error: { code: 'database/error', message: 'listener failed' },
    }]);

    expect(runtime.getSnapshot().errors[0]).toMatchObject({
      id: 'listener-error-1',
      source: 'sandbox',
      service: 'database',
      path: 'messages',
      code: 'database/error',
      message: 'listener failed',
    });
  });

  it('normalizes Firestore listener_errored events', () => {
    const runtime = createPyricRuntimeStatus(manifest);
    runtime.recordSandboxEvents([{
      kind: 'listener_errored',
      id: 'firestore-listener-error-1',
      at: 789,
      listenerId: 'listener-2',
      target: { kind: 'doc', path: 'posts/a' },
      auth: null,
      error: { code: 'permission-denied', message: 'read denied' },
    }]);

    expect(runtime.getSnapshot().errors[0]).toMatchObject({
      id: 'firestore-listener-error-1',
      source: 'sandbox',
      service: 'firestore',
      method: 'listener',
      path: 'posts/a',
      code: 'permission-denied',
      message: 'read denied',
    });
  });

  it('normalizes one-shot operation rules denials into runtime error toasts', () => {
    const runtime = createPyricRuntimeStatus(manifest);
    runtime.recordSandboxEvents([{
      kind: 'operation',
      id: 'op-denied-1',
      at: 999,
      service: 'firestore',
      method: 'get',
      path: 'conversations/unauthorized-doc-id',
      auth: { uid: null },
      result: 'deny',
      rulesDisposition: { kind: 'evaluated', verdict: 'deny' },
    }]);

    expect(runtime.getSnapshot().errors[0]).toMatchObject({
      id: 'op-denied-1',
      source: 'sandbox',
      service: 'firestore',
      method: 'get',
      path: 'conversations/unauthorized-doc-id',
      code: 'PERMISSION_DENIED',
      message: 'PERMISSION_DENIED: get on conversations/unauthorized-doc-id denied by rules',
    });
  });

  it('bounds retained errors and clears them without changing worker status', () => {
    const runtime = createPyricRuntimeStatus(manifest, { maxErrors: 2 });
    runtime.reportError('first', 'runtime');
    runtime.reportError('second', 'runtime');
    runtime.reportError('third', 'runtime');
    runtime.setWorker({ mode: 'shared-worker', runningEpoch: 'running-1' });

    expect(runtime.getSnapshot().errors.map((error) => error.message)).toEqual(['second', 'third']);
    runtime.clearErrors();
    expect(runtime.getSnapshot()).toMatchObject({ errors: [], updateAvailable: true });
  });

  it('dismisses an individual error by id without removing remaining errors', () => {
    const runtime = createPyricRuntimeStatus(manifest, { maxErrors: 5 });
    runtime.reportError('first', 'runtime');
    runtime.reportError('second', 'runtime');
    const [err1, err2] = runtime.getSnapshot().errors;
    runtime.dismissError(err1.id);
    expect(runtime.getSnapshot().errors.map((error) => error.message)).toEqual(['second']);
    expect(runtime.getSnapshot().errors[0].id).toBe(err2.id);
  });

  it('runs the configured worker update only when a new epoch is available', async () => {
    const status = createPyricRuntimeStatus({
      ...manifest,
      worker: { ...manifest.worker, servedEpoch: 'served-new' },
    });
    let updates = 0;
    status.setWorkerUpdater(async () => { updates += 1; });

    await expect(status.updateWorker()).rejects.toThrow('No Pyric worker update is available');
    status.setWorker({ mode: 'shared-worker', runningEpoch: 'running-old' });
    await status.updateWorker();

    expect(updates).toBe(1);
    expect(status.getSnapshot().updatingWorker).toBe(true);
  });

  it('returns to an actionable error state when worker replacement fails', async () => {
    const status = createPyricRuntimeStatus(manifest);
    status.setWorker({ mode: 'shared-worker', runningEpoch: 'running-old' });
    status.setWorkerUpdater(async () => { throw new Error('retirement timed out'); });

    await expect(status.updateWorker()).rejects.toThrow('retirement timed out');

    expect(status.getSnapshot()).toMatchObject({
      updateAvailable: true,
      updatingWorker: false,
      errors: [{ source: 'worker', message: 'retirement timed out' }],
    });
  });
});

describe('normalizePyricRuntimeError', () => {
  it('preserves useful Error fields without retaining the original object', () => {
    const error = Object.assign(new Error('worker failed'), { code: 'worker/crashed' });
    const normalized = normalizePyricRuntimeError(error, 'worker', 99, 'error-1');
    expect(normalized).toMatchObject({
      id: 'error-1',
      source: 'worker',
      at: 99,
      code: 'worker/crashed',
      message: 'worker failed',
    });
    expect(normalized.stack).toContain('worker failed');
  });
});
