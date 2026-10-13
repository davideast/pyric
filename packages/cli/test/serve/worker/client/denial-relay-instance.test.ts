import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { openSnapshotSubscription, rawRpc, wirePort } from '../../../../src/serve/worker/client/core.js';
import type { ClientPort } from '../../../../src/serve/worker/client/handles.js';

const denialContext = {
  engine: 'rtdb',
  auth: { uid: 'u1' },
  reasons: [],
  request: { method: 'listen', path: '/rooms/r1' },
};

describe('denial relay names the RTDB instance', () => {
  const realFetch = globalThis.fetch;
  let relayed: Array<Record<string, unknown>>;
  let port: ClientPort;

  beforeEach(() => {
    relayed = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      relayed.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    port = { onmessage: null, postMessage() {}, start() {}, close() {} };
    wirePort(port);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('carries target.instance of a denied listener', () => {
    openSnapshotSubscription(
      port,
      'sub-1',
      { port, next() {}, error() {} },
      { t: 'sub', subId: 'sub-1', target: { service: 'rtdb', instance: 'demo-app-shard-1', path: '/rooms/r1' } },
    );
    port.onmessage?.({
      data: { t: 'snap', subId: 'sub-1', value: { __error: { code: 'permission-denied', message: 'denied', denialContext } } },
    } as MessageEvent);
    expect(relayed).toHaveLength(1);
    expect(relayed[0]?.instance).toBe('demo-app-shard-1');
  });

  it('carries the instance of a denied operation, and none for the default instance', async () => {
    const named = rawRpc(port, { t: 'op', id: 'op-1', method: 'rtdb.get', instance: 'demo-app-shard-1', path: '/rooms/r1' } as never);
    port.onmessage?.({
      data: { t: 'res', id: 'op-1', ok: false, error: { code: 'permission-denied', message: 'denied', denialContext } },
    } as MessageEvent);
    await expect(named).rejects.toThrow('denied');
    const unnamed = rawRpc(port, { t: 'op', id: 'op-2', method: 'rtdb.get', instance: undefined, path: '/rooms/r2' } as never);
    port.onmessage?.({
      data: { t: 'res', id: 'op-2', ok: false, error: { code: 'permission-denied', message: 'denied', denialContext } },
    } as MessageEvent);
    await expect(unnamed).rejects.toThrow('denied');
    expect(relayed.map((payload) => payload.instance)).toEqual(['demo-app-shard-1', undefined]);
  });
});
