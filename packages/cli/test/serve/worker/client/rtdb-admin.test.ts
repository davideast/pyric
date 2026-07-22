import { afterEach, describe, expect, it } from 'bun:test';
import {
  adminDeleteRtdbValue,
  adminReadRtdbState,
  adminSetRtdbValue,
  adminSubscribeRtdbValue,
  adminUpdateRtdbValue,
} from '../../../../src/serve/worker/client/rtdb-admin.js';
import { getFirestore } from '../../../../src/serve/worker/client/connection.js';
import type { ClientPort } from '../../../../src/serve/worker/client/handles.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';

const priorSharedWorker = globalThis.SharedWorker;
afterEach(() => {
  (globalThis as { SharedWorker?: typeof SharedWorker }).SharedWorker = priorSharedWorker;
});

describe('RTDB admin-lens worker client', () => {
  it('stamps admin writes and subscriptions while hydrating snapshots', async () => {
    const sent: InboundMessage[] = [];
    const port: ClientPort = {
      onmessage: null,
      start() {},
      close() {},
      postMessage(message) {
        sent.push(message);
        if (message.t === 'op') {
          queueMicrotask(() => port.onmessage?.({
            data: { t: 'res', id: message.id, ok: true, value: { tree: true } },
          } as MessageEvent<OutboundMessage>));
        }
        if (message.t === 'sub') {
          queueMicrotask(() => port.onmessage?.({
            data: { t: 'snap', subId: message.subId, value: { value: { live: true } } },
          } as MessageEvent<OutboundMessage>));
        }
      },
    };
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class { port = port; };
    const db = getFirestore(`worker://rtdb-admin-${Math.random()}`);

    await adminSetRtdbValue(db, '/rows/a', 1);
    await adminUpdateRtdbValue(db, '/rows', { b: 2 });
    await adminDeleteRtdbValue(db, '/rows/a');
    expect(await adminReadRtdbState(db)).toEqual({ tree: true });

    const values: unknown[] = [];
    const unsubscribe = adminSubscribeRtdbValue(db, '//rows//', (value) => values.push(value));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(values).toEqual([{ live: true }]);
    unsubscribe();

    const operations = sent.filter((message) => message.t === 'op');
    expect(operations.slice(0, 3).every((message) => message.actAs?.mode === 'admin')).toBe(true);
    const subscription = sent.find((message) => message.t === 'sub');
    expect(subscription).toMatchObject({
      target: { service: 'rtdb', path: '/rows' },
      actAs: { mode: 'admin' },
    });
  });
});
