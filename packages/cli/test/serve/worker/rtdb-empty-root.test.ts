/**
 * The served RTDB plane reads the root of an empty database as the in-page
 * sandbox and the production SDK do: `exists()` is false and the value is
 * `null`, both before any write and after the last child is removed.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { buildWorkerCtx } from '../../../src/serve/worker/serve-init.js';
import type { OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { createIndexedDBBackend } from 'pyric/sandbox';

const offlineFetch = (async () => {
  throw new Error('offline');
}) as unknown as typeof fetch;

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage: (m: OutboundMessage) => { messages.push(m); } };
}

let seq = 0;

async function boot(): Promise<HostCtx> {
  return buildWorkerCtx({
    fetch: offlineFetch,
    idb: createIndexedDBBackend(),
    persistenceKey: `rtdb-empty-root-${Date.now()}-${seq++}`,
  });
}

async function op(ctx: HostCtx, port: ReturnType<typeof fakePort>, msg: Record<string, unknown>): Promise<ResMessage> {
  const id = `m${seq++}`;
  await handleMessage(ctx, port, { t: 'op', id, ...msg } as never);
  const res = port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === id);
  if (!res) throw new Error(`no res for ${String(msg.method)}`);
  return res;
}

const USER = { mode: 'as', uid: 'alice' };
const OPEN = { rules: { '.read': true, '.write': true } };

describe('served RTDB empty root', () => {
  it('a root get on an empty database returns a missing snapshot', async () => {
    const ctx = await boot();
    const port = fakePort();
    expect((await op(ctx, port, { method: 'setDatabaseRules', source: OPEN })).ok).toBe(true);
    const res = await op(ctx, port, { method: 'rtdb.get', path: '/', actAs: USER });
    expect(res.ok).toBe(true);
    expect(res.ok && res.value).toMatchObject({ exists: false, value: null, size: 0, entries: [] });
  });

  it('a root get after the last child is removed returns a missing snapshot', async () => {
    const ctx = await boot();
    const port = fakePort();
    await op(ctx, port, { method: 'setDatabaseRules', source: OPEN });
    expect((await op(ctx, port, { method: 'rtdb.set', path: 'a', value: 1, actAs: USER })).ok).toBe(true);
    expect((await op(ctx, port, { method: 'rtdb.remove', path: 'a', actAs: USER })).ok).toBe(true);
    const res = await op(ctx, port, { method: 'rtdb.get', path: '/', actAs: USER });
    expect(res.ok && res.value).toMatchObject({ exists: false, value: null });
  });
});
