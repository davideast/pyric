import { afterEach, describe, expect, it } from 'bun:test';
import {
  getFirestore,
  getWorkerVersion,
} from '../../../../src/serve/worker/client/connection.js';
import type { ClientDb, ClientPort } from '../../../../src/serve/worker/client/handles.js';

const priorSharedWorker = globalThis.SharedWorker;
afterEach(() => {
  (globalThis as { SharedWorker?: typeof SharedWorker }).SharedWorker = priorSharedWorker;
});

describe('SharedWorker connection', () => {
  it('rejects a version handshake that never receives a worker reply', async () => {
    const port: ClientPort = {
      onmessage: null,
      postMessage() {},
      start() {},
      close() {},
    };
    const db: ClientDb = { __kind: 'client-db', port };

    await expect(getWorkerVersion(db, { timeoutMs: 5 })).rejects.toThrow(
      'Timed out waiting for the Pyric SharedWorker version handshake',
    );
  });

  it('surfaces the SharedWorker script error event', () => {
    let emitError: ((event: { message?: string }) => void) | undefined;
    let wiredBeforeStart = false;
    const port: ClientPort = {
      onmessage: null,
      postMessage() {},
      start() { wiredBeforeStart = port.onmessage !== null; },
      close() {},
    };
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port = port;
      addEventListener(type: string, listener: (event: { message?: string }) => void) {
        if (type === 'error') emitError = listener;
      }
    };
    const errors: Error[] = [];

    getFirestore('/worker.js', 'test-worker', {
      onError: (error) => errors.push(error),
    });
    emitError?.({ message: 'worker script failed' });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('worker script failed');
    expect(wiredBeforeStart).toBe(true);
  });
});
