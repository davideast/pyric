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
