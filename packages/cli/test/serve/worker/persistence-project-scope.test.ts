/**
 * Worker sandbox persistence — IndexedDB project scoping (issue #359 family).
 *
 * The SharedWorker persisted its sandbox snapshots (auth users, Firestore
 * docs, the RTDB tree) under the FIXED key `'pyric-shared-worker'`, and
 * IndexedDB is origin-scoped — so every project served on one localhost port
 * shared ONE snapshot database: another app's chat users and conversations
 * appeared in an unrelated project. `buildWorkerCtx` now derives the key from
 * the init payload's `projectKey` (`pyric-shared-worker:<projectKey>`, the
 * same identity the storage DB scoping uses), falling back to the legacy
 * shared key only when no identity exists (older servers / standalone).
 *
 * Strategy mirrors persistence-durability.test.ts: boot the REAL worker boot
 * path over fake-indexeddb (process-global, standing in for the browser's
 * origin-scoped registry), ack ops, ABANDON the ctx, boot again.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import {
  buildWorkerCtx,
  workerPersistenceKey,
  WORKER_PERSISTENCE_KEY,
} from '../../../src/serve/worker/serve-init.js';
import type { InitPayload } from '../../../src/serve/namespace.js';
import type { OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { createIndexedDBBackend } from 'pyric/sandbox';

/** Serve `/__pyric/init.json` for `projectKey`; every other URL 404s. */
function serveFetch(projectKey: string | null): typeof fetch {
  const payload: InitPayload = {
    rules: null,
    rulesHash: null,
    storageRules: null,
    storageRulesHash: null,
    // Older servers omit projectKey entirely — model that as absent.
    ...(projectKey !== null ? { projectKey } : {}),
    bridgeUrl: null,
    seed: null,
    seedState: null,
    authUsers: null,
  };
  return (async (url: unknown) => {
    if (String(url) === '/__pyric/init.json') {
      return { ok: true, status: 200, json: async () => payload } as Response;
    }
    return { ok: false, status: 404, text: async () => '' } as Response;
  }) as unknown as typeof fetch;
}

/** Boot the worker exactly as entry.ts does — the key derives from the payload. */
function bootWorker(projectKey: string | null): Promise<HostCtx> {
  return buildWorkerCtx({ fetch: serveFetch(projectKey), idb: createIndexedDBBackend() });
}

let seq = 0;
async function op(ctx: HostCtx, msg: Record<string, unknown>): Promise<ResMessage> {
  const id = `pps-${++seq}`;
  return new Promise((resolve) => {
    const port: PortLike = {
      postMessage(m: OutboundMessage) {
        if (m.t === 'res' && m.id === id) resolve(m);
      },
    };
    void handleMessage(ctx, port, { t: 'op', id, ...msg } as never);
  });
}

async function opOk(ctx: HostCtx, msg: Record<string, unknown>): Promise<unknown> {
  const res = await op(ctx, msg);
  if (!res.ok) throw new Error(`expected ok, got: ${res.error.code} — ${res.error.message}`);
  return res.value;
}

const unique = (label: string): string =>
  `/proj/${label}-${Math.random().toString(36).slice(2, 10)}`;

describe('workerPersistenceKey', () => {
  it('scopes by project identity and pins the legacy fallback (naming scheme)', () => {
    expect(workerPersistenceKey('/home/me/app')).toBe('pyric-shared-worker:/home/me/app');
    expect(workerPersistenceKey(null)).toBe(WORKER_PERSISTENCE_KEY);
    expect(workerPersistenceKey(undefined)).toBe(WORKER_PERSISTENCE_KEY);
    expect(WORKER_PERSISTENCE_KEY).toBe('pyric-shared-worker'); // legacy DB name, orphaned not deleted
  });
});

describe('worker sandbox persistence: project scoping', () => {
  it('two projectKeys do not see each other; the same projectKey shares', async () => {
    const keyA = unique('a');
    const keyB = unique('b');

    // Project A: an acked doc write + an acked user creation.
    const ctxA = await bootWorker(keyA);
    await opOk(ctxA, { method: 'admin.setDocument', path: 'chats/general', data: { app: 'A' } });
    await opOk(ctxA, { method: 'auth.createUser', email: 'a@example.com', password: 'pw123456' });
    // Abrupt teardown: nothing runs after the acks.

    // Project B on the SAME origin: pre-fix this booted the shared
    // 'pyric-shared-worker' database and READ project A's chat doc and user.
    const ctxB = await bootWorker(keyB);
    expect(await opOk(ctxB, { method: 'admin.getDocument', path: 'chats/general' })).toBeNull();
    expect(await opOk(ctxB, { method: 'auth.listUsers' })).toEqual([]);

    // Project A again (fresh worker boot): its own state restored.
    const ctxA2 = await bootWorker(keyA);
    expect(await opOk(ctxA2, { method: 'admin.getDocument', path: 'chats/general' })).toEqual({
      app: 'A',
    });
    const users = (await opOk(ctxA2, { method: 'auth.listUsers' })) as Array<{ email?: string }>;
    expect(users.map((u) => u.email)).toEqual(['a@example.com']);
  });

  it('no project identity (older server) falls back to the shared legacy key', async () => {
    // Two boots WITHOUT a projectKey share the legacy database — the pinned
    // compatibility posture for servers that predate InitPayload.projectKey.
    const marker = `legacy-${Math.random().toString(36).slice(2, 10)}`;
    const ctx1 = await bootWorker(null);
    await opOk(ctx1, { method: 'admin.setDocument', path: `legacy/${marker}`, data: { v: 1 } });

    const ctx2 = await bootWorker(null);
    expect(await opOk(ctx2, { method: 'admin.getDocument', path: `legacy/${marker}` })).toEqual({
      v: 1,
    });

    // And a project-scoped boot does NOT see the legacy data.
    const scoped = await bootWorker(unique('scoped'));
    expect(await opOk(scoped, { method: 'admin.getDocument', path: `legacy/${marker}` })).toBeNull();
  });
});
