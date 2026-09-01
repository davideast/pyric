/**
 * Reload-durability regression tests — an ACKNOWLEDGED write must survive an
 * abrupt SharedWorker teardown (last tab closed / page reloaded).
 *
 * THE BUG THIS PINS DOWN: `entry.ts` wired persistence via the raw
 * `attachPersistence()` helper instead of `sandbox.enablePersistence()`, so
 * the controller was never registered on the sandbox and `sandbox.flush()`
 * threw `failed-precondition` — silently swallowed by the host's best-effort
 * flush. The "awaited flush before ack" was a no-op, and (because
 * `admin.setDocument` emits no persistable sandbox event) not even the
 * debounced auto-flush ever ran for admin writes. Result: a write acked over
 * the worker port never reached IndexedDB, and a page reload (which lets the
 * browser kill the SharedWorker) lost it.
 *
 * Strategy: boot the REAL worker boot path (`buildWorkerCtx`, the exact code
 * `entry.ts` runs) over fake-indexeddb, perform an acked op via
 * `handleMessage`, then ABANDON the ctx — no dispose, no timers awaited, no
 * event-loop settling — exactly like a browser terminating the worker. Boot
 * a second ctx over the SAME IndexedDB and assert the data restored.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { buildWorkerCtx } from '../../../src/serve/worker/serve-init.js';
import type { OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { createIndexedDBBackend } from 'pyric/sandbox';
import { allowRtdbForTransportTests } from './permissive-services.js';

/** Stub fetch: standalone worker (no `pyric dev` behind it) — init.json 404s. */
const offlineFetch = (async () => {
  throw new Error('offline');
}) as unknown as typeof fetch;

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage: (m: OutboundMessage) => { messages.push(m); } };
}

/** Boot the worker exactly as entry.ts does, against the shared fake IDB. */
async function bootWorker(key: string): Promise<HostCtx> {
  const ctx = await buildWorkerCtx({
    fetch: offlineFetch,
    idb: createIndexedDBBackend(),
    persistenceKey: key,
  });
  allowRtdbForTransportTests(ctx.sandbox);
  return ctx;
}

async function op(ctx: HostCtx, msg: Record<string, unknown>): Promise<ResMessage> {
  const port = fakePort();
  await handleMessage(ctx, port, { t: 'op', ...msg } as never);
  const res = port.messages.find(
    (m): m is ResMessage => m.t === 'res' && m.id === msg.id,
  );
  if (!res) throw new Error(`no res for ${String(msg.id)}`);
  return res;
}

let seq = 0;
const freshKey = (): string => `durability-test-${Date.now()}-${seq++}`;

describe('worker persistence: acked writes survive abrupt teardown', () => {
  it('sandbox.flush() is actually wired (enablePersistence, not raw attach)', async () => {
    const ctx = await bootWorker(freshKey());
    // Pre-fix this threw failed-precondition ('flush() called before
    // enablePersistence()') and the host swallowed it.
    await ctx.sandbox.flush();
  });

  it('an acked admin.setDocument restores after a cold reboot over the same IDB', async () => {
    const key = freshKey();
    const ctxA = await bootWorker(key);
    const write = await op(ctxA, {
      id: 'w1',
      method: 'admin.setDocument',
      path: 'notes/reload-check',
      data: { marker: 'alpha' },
    });
    expect(write.ok).toBe(true);
    // Abrupt teardown: nothing runs after the ack (no dispose, no settling).

    const ctxB = await bootWorker(key);
    const read = await op(ctxB, { id: 'r1', method: 'admin.getDocument', path: 'notes/reload-check' });
    expect(read.ok).toBe(true);
    expect((read.value as { marker?: string } | null)?.marker).toBe('alpha');
  });

  it('an acked client setDoc restores after a cold reboot over the same IDB', async () => {
    const key = freshKey();
    const ctxA = await bootWorker(key);
    const write = await op(ctxA, {
      id: 'w1',
      method: 'setDoc',
      path: 'notes/client-write',
      data: { marker: 'beta' },
    });
    expect(write.ok).toBe(true);

    const ctxB = await bootWorker(key);
    const read = await op(ctxB, { id: 'r1', method: 'admin.getDocument', path: 'notes/client-write' });
    expect(read.ok).toBe(true);
    expect((read.value as { marker?: string } | null)?.marker).toBe('beta');
  });

  it('an acked admin.deleteDocument stays deleted after a cold reboot', async () => {
    const key = freshKey();
    const ctxA = await bootWorker(key);
    await op(ctxA, { id: 'w1', method: 'admin.setDocument', path: 'notes/doomed', data: { x: 1 } });
    const del = await op(ctxA, { id: 'd1', method: 'admin.deleteDocument', path: 'notes/doomed' });
    expect(del.ok).toBe(true);

    const ctxB = await bootWorker(key);
    const read = await op(ctxB, { id: 'r1', method: 'admin.getDocument', path: 'notes/doomed' });
    expect(read.ok).toBe(true);
    expect(read.value).toBeNull();
  });

  it('an acked batchCommit restores after a cold reboot', async () => {
    const key = freshKey();
    const ctxA = await bootWorker(key);
    const commit = await op(ctxA, {
      id: 'b1',
      method: 'batchCommit',
      writes: [
        { method: 'set', path: 'notes/batch-a', data: { n: 1 } },
        { method: 'set', path: 'notes/batch-b', data: { n: 2 } },
      ],
    });
    expect(commit.ok).toBe(true);

    const ctxB = await bootWorker(key);
    const a = await op(ctxB, { id: 'r1', method: 'admin.getDocument', path: 'notes/batch-a' });
    const b = await op(ctxB, { id: 'r2', method: 'admin.getDocument', path: 'notes/batch-b' });
    expect((a.value as { n?: number } | null)?.n).toBe(1);
    expect((b.value as { n?: number } | null)?.n).toBe(2);
  });

  it('an acked rtdb.set restores after a cold reboot over the same IDB', async () => {
    const key = freshKey();
    const ctxA = await bootWorker(key);
    const write = await op(ctxA, {
      id: 'w1',
      method: 'rtdb.set',
      path: '/rooms/general',
      value: { name: 'General' },
    });
    expect(write.ok).toBe(true);
    // Abrupt teardown: nothing runs after the ack.

    const ctxB = await bootWorker(key);
    // FIRST op on the rebooted worker is a read — proves the restored tree is
    // queryable immediately (eager RTDB registration at boot), not only after
    // some prior RTDB op lazily creates the backend.
    const read = await op(ctxB, { id: 'r1', method: 'rtdb.get', path: '/rooms/general' });
    expect(read.ok).toBe(true);
    expect((read.value as { value?: { name?: string } }).value).toEqual({ name: 'General' });
  });

  it('an acked rtdb.remove stays removed after a cold reboot', async () => {
    const key = freshKey();
    const ctxA = await bootWorker(key);
    await op(ctxA, { id: 'w1', method: 'rtdb.set', path: '/rooms/doomed', value: { x: 1 } });
    const del = await op(ctxA, { id: 'd1', method: 'rtdb.remove', path: '/rooms/doomed' });
    expect(del.ok).toBe(true);

    const ctxB = await bootWorker(key);
    const read = await op(ctxB, { id: 'r1', method: 'rtdb.get', path: '/rooms/doomed' });
    expect(read.ok).toBe(true);
    expect((read.value as { exists?: boolean }).exists).toBe(false);
  });

  it('an acked rtdb.push value restores after a cold reboot', async () => {
    const key = freshKey();
    const ctxA = await bootWorker(key);
    const pushed = await op(ctxA, {
      id: 'p1',
      method: 'rtdb.push',
      path: '/messages',
      key: 'm-abc',
      value: { text: 'hello' },
    });
    expect(pushed.ok).toBe(true);

    const ctxB = await bootWorker(key);
    const read = await op(ctxB, { id: 'r1', method: 'rtdb.get', path: '/messages/m-abc' });
    expect(read.ok).toBe(true);
    expect((read.value as { value?: { text?: string } }).value).toEqual({ text: 'hello' });
  });

  it('an acked rtdb.update restores after a cold reboot', async () => {
    const key = freshKey();
    const ctxA = await bootWorker(key);
    await op(ctxA, { id: 'w1', method: 'rtdb.set', path: '/rooms/general', value: { name: 'General' } });
    const upd = await op(ctxA, {
      id: 'u1',
      method: 'rtdb.update',
      path: '/rooms/general',
      values: { members: 5 },
    });
    expect(upd.ok).toBe(true);

    const ctxB = await bootWorker(key);
    const read = await op(ctxB, { id: 'r1', method: 'rtdb.get', path: '/rooms/general' });
    expect(read.ok).toBe(true);
    expect((read.value as { value?: unknown }).value).toEqual({ name: 'General', members: 5 });
  });

  it('an acked auth.adminCreateUser restores after a cold reboot', async () => {
    const key = freshKey();
    const ctxA = await bootWorker(key);
    const created = await op(ctxA, {
      id: 'u1',
      method: 'auth.adminCreateUser',
      request: { email: 'durable@example.com', password: 'hunter22' },
    });
    expect(created.ok).toBe(true);

    const ctxB = await bootWorker(key);
    const list = await op(ctxB, { id: 'l1', method: 'auth.listUsers' });
    expect(list.ok).toBe(true);
    const emails = (list.value as Array<{ email?: string }>).map((u) => u.email);
    expect(emails).toContain('durable@example.com');
  });
});
