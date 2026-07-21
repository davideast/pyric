import { describe, expect, it } from 'bun:test';
import {
  onWorkerRuntimeReload,
  retireWorkerRuntime,
} from '../../../../src/serve/worker/client/runtime-control.js';
import { wirePort } from '../../../../src/serve/worker/client/core.js';
import type { ClientDb, ClientPort } from '../../../../src/serve/worker/client/handles.js';

describe('worker runtime control', () => {
  it('requests retirement and relays the all-pages reload signal', async () => {
    const sent: Array<{ id?: string; method?: string }> = [];
    const port: ClientPort = {
      onmessage: null,
      postMessage(message) { sent.push(message as { id?: string; method?: string }); },
      start() {},
      close() {},
    };
    wirePort(port);
    const db: ClientDb = { __kind: 'client-db', port };
    let reloads = 0;
    const epochs: string[] = [];
    const unsubscribe = onWorkerRuntimeReload((epoch) => {
      reloads += 1;
      epochs.push(epoch);
    });

    const retiring = retireWorkerRuntime(db, '0123456789abcdef');
    const id = sent[0]?.id;
    expect(sent[0]?.method).toBe('retireRuntime');
    expect(sent[0]).toMatchObject({ targetEpoch: '0123456789abcdef' });
    port.onmessage?.({
      data: { t: 'res', id, ok: true, value: { retiring: true } },
    } as MessageEvent);
    await retiring;
    port.onmessage?.({
      data: { t: 'runtime-reload', epoch: '0123456789abcdef' },
    } as MessageEvent);

    expect(reloads).toBe(1);
    expect(epochs).toEqual(['0123456789abcdef']);
    unsubscribe();
  });

  it('bounds a retirement request when the worker cannot reply', async () => {
    const port: ClientPort = {
      onmessage: null,
      postMessage() {},
      start() {},
      close() {},
    };
    const db: ClientDb = { __kind: 'client-db', port };

    await expect(retireWorkerRuntime(
      db, '0123456789abcdef', { timeoutMs: 5 },
    )).rejects.toThrow('Timed out waiting for the Pyric worker to retire');
  });
});
