/**
 * Restore and replication paths stay out of `history()` (#1058 follow-up,
 * FS-MET-2 case 3).
 *
 * `sandbox.admin.setDocument` / `deleteDocument` now record `detail.admin`
 * events so replay can reproduce a seed (`replay-admin-seed.test.ts`). The
 * paths below only move state that was already recorded, or never was a
 * session action, so they write through the quiet
 * `LocalEnvironment.adminSetDocument` / `adminDeleteDocument` and must not
 * add write events: otherwise a restore would flood history and a replay of
 * the restored session would re-apply the restore.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';

import { initializeSandbox, type LocalSandbox, type WriteSandboxEvent } from '../../src/sandbox/index.js';
import { getInternalEnv } from '../../src/sandbox/internal/sandbox-impl.js';
import { applyFullState, captureFullState } from '../../src/sandbox/full-state.js';
import { fork } from '../../src/sandbox/branches/engine.js';
import { promoteFullState } from '../../src/sandbox/branches/promotion.js';
import { createMemoryBackend } from '../../src/sandbox/persistence/index.js';
import { getAdminStorageSandbox } from '../../src/storage/internal.js';

function writesOf(sandbox: LocalSandbox): WriteSandboxEvent[] {
  return sandbox.history().filter((e): e is WriteSandboxEvent => e.kind === 'write');
}

describe('restore and replication paths stay out of history', () => {
  it('applyFullState records no write events', async () => {
    const source = initializeSandbox();
    getInternalEnv(source).adminSetDocument('things/a', { v: 1 });
    const state = await captureFullState(source);

    const target = initializeSandbox();
    getAdminStorageSandbox(target, { dbName: 'pyric-replay-admin-seed:apply' });
    getInternalEnv(target).adminSetDocument('things/stale', { v: 0 });
    await applyFullState(target, state);

    expect(target.admin.getDocument('things/a')).toEqual({ v: 1 });
    expect(target.admin.getDocument('things/stale')).toBeNull();
    expect(writesOf(target)).toEqual([]);
  });

  it('promoteFullState records no write events', async () => {
    const source = initializeSandbox();
    getInternalEnv(source).adminSetDocument('things/a', { v: 1 });
    getInternalEnv(source).adminSetDocument('things/b', { v: 1 });
    const base = await captureFullState(source);
    const branch = await fork(base);
    branch.sandbox.admin.setDocument('things/a', { v: 2 });
    branch.sandbox.admin.deleteDocument('things/b');
    const next = await captureFullState(branch.sandbox);

    const target = initializeSandbox();
    getAdminStorageSandbox(target, { dbName: 'pyric-replay-admin-seed:promote' });
    await applyFullState(target, base);
    await promoteFullState(target, base, next);

    expect(target.admin.getDocument('things/a')).toEqual({ v: 2 });
    expect(target.admin.getDocument('things/b')).toBeNull();
    expect(writesOf(target)).toEqual([]);
  });

  it('persistence boot restore records no write events', async () => {
    const backend = createMemoryBackend();
    const first = initializeSandbox();
    await first.enablePersistence({ key: 'pyric:replay-admin-seed', injectedBackend: backend });
    getInternalEnv(first).adminSetDocument('sessions/a', { v: 1 });
    await first.flush();

    const second = initializeSandbox();
    await second.enablePersistence({ key: 'pyric:replay-admin-seed', injectedBackend: backend });

    expect(second.admin.getDocument('sessions/a')).toEqual({ v: 1 });
    expect(writesOf(second)).toEqual([]);
  });

  it('loadSnapshot records no write events', () => {
    const sb = initializeSandbox();
    sb.loadSnapshot({ firestore: { 'things/a': { v: 1 } }, services: {} });
    expect(sb.admin.getDocument('things/a')).toEqual({ v: 1 });
    expect(writesOf(sb)).toEqual([]);
  });

  it('tab-sync applies a peer tab write without recording it on the receiving tab', () => {
    // Two endpoints of an in-memory channel: a post on one reaches the other.
    type Listener = (ev: { data: unknown }) => void;
    const endpoints: { listeners: Listener[] }[] = [];
    const endpoint = () => {
      const self = { listeners: [] as Listener[] };
      endpoints.push(self);
      return {
        postMessage: (data: unknown) => {
          for (const peer of endpoints) {
            if (peer === self) continue;
            for (const listener of peer.listeners) listener({ data });
          }
        },
        addEventListener: (_type: 'message', listener: Listener) => { self.listeners.push(listener); },
        removeEventListener: (_type: 'message', listener: Listener) => {
          self.listeners = self.listeners.filter((l) => l !== listener);
        },
        close: () => {},
      };
    };
    const a = initializeSandbox();
    const b = initializeSandbox();
    a.enableTabSync({ channel: endpoint(), originId: 'tab-A' });
    b.enableTabSync({ channel: endpoint(), originId: 'tab-B' });

    a.admin.setDocument('things/a', { v: 1 });
    a.admin.deleteDocument('things/a');
    a.admin.setDocument('things/b', { v: 2 });

    expect(writesOf(a).map((w) => [w.method, w.path])).toEqual([
      ['set', 'things/a'], ['delete', 'things/a'], ['set', 'things/b'],
    ]);
    expect(b.admin.getDocument('things/a')).toBeNull();
    expect(b.admin.getDocument('things/b')).toEqual({ v: 2 });
    expect(writesOf(b)).toEqual([]);
  });
});
