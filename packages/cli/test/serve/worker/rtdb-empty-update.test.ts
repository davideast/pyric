/**
 * The served RTDB plane resolves an empty update as the in-page sandbox and
 * the production SDK do: `update(ref, {})` and `onDisconnect(ref).update({})`
 * resolve without evaluating rules, write nothing, and leave a write already
 * queued at the path in place.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { drainPortRtdbDisconnects } from '../../../src/serve/worker/host/rtdb.js';
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
    persistenceKey: `rtdb-empty-update-${Date.now()}-${seq++}`,
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

describe('served RTDB empty update', () => {
  it('update(ref, {}) resolves under a denying .write and writes nothing', async () => {
    const ctx = await boot();
    const port = fakePort();
    const deployed = await op(ctx, port, {
      method: 'setDatabaseRules', source: { rules: { restricted: { '.read': false, '.write': false } } },
    });
    expect(deployed.ok).toBe(true);
    const before = await op(ctx, port, { method: 'rtdb.adminSnapshot' });
    const res = await op(ctx, port, { method: 'rtdb.update', path: 'restricted', values: {}, actAs: USER });
    expect(res.ok).toBe(true);
    const after = await op(ctx, port, { method: 'rtdb.adminSnapshot' });
    expect(after.ok && after.value).toEqual(before.ok && before.value);
  });

  it('onDisconnect().update({}) resolves and leaves the queued write in place', async () => {
    const ctx = await boot();
    const port = fakePort();
    await op(ctx, port, {
      method: 'setDatabaseRules',
      source: { rules: { status: { '.read': true, '.write': "newData.val() == 'offline'" } } },
    });
    const queued = await op(ctx, port, { method: 'rtdb.onDisconnectSet', path: 'status', value: 'offline', actAs: USER });
    expect(queued.ok).toBe(true);
    const empty = await op(ctx, port, { method: 'rtdb.onDisconnectUpdate', path: 'status', values: {}, actAs: USER });
    expect(empty.ok).toBe(true);
    await drainPortRtdbDisconnects(ctx, port);
    const snapshot = await op(ctx, port, { method: 'rtdb.adminSnapshot' });
    expect(snapshot.ok && snapshot.value).toEqual({ status: 'offline' });
  });
});
