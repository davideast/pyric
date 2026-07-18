/**
 * SharedWorker host — the `resetAll` studio op (issue #359).
 *
 * Studio's Settings/Session reset in served mode rides this single op; the
 * host delegates to `sandbox.resetAll()`, which iterates the persistable-
 * service registry. Pre-fix, Studio's reset walked Firestore docs + cleared
 * auth users by hand and storage objects survived — this pins the worker
 * path clearing EVERY service: Firestore docs, auth users, the RTDB tree,
 * and storage objects.
 *
 * Same harness style as storage-ops.test.ts: REAL sandbox + fake ports,
 * fake-indexeddb behind storage, unique dbName per ctx.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { getDatabase, ref as rtdbRef, set as rtdbSet, get as rtdbGet } from 'pyric/database';

import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
} from '../../../src/serve/worker/protocol.js';
import { bytesToBase64 } from '../../../src/serve/worker/protocol.js';
import { applyServeInit } from '../../../src/serve/worker/serve-init.js';
import type { InitPayload } from '../../../src/serve/namespace.js';

let dbSeq = 0;
function uniqueDbName(): string {
  return `pyric-reset-all-op-${++dbSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeCtx(): HostCtx {
  const sandbox = initializeSandbox();
  // Isolated IDB name per ctx (the default DB is process-global under
  // fake-indexeddb) — mirrors how a served page configures the service.
  getStorageSandbox(sandbox, { dbName: uniqueDbName() });
  return { db: getFirestore(sandbox), sandbox, instanceId: 'reset-all-test', subs: new Map() };
}

let opSeq = 0;
function op(ctx: HostCtx, payload: Record<string, unknown>): Promise<ResMessage> {
  return new Promise((resolve) => {
    const port: PortLike = {
      postMessage(msg: OutboundMessage) {
        if (msg.t === 'res') resolve(msg);
      },
    };
    void handleMessage(ctx, port, {
      ...payload,
      t: 'op',
      id: `rop-${++opSeq}`,
    } as InboundMessage);
  });
}

async function opOk(ctx: HostCtx, payload: Record<string, unknown>): Promise<unknown> {
  const res = await op(ctx, payload);
  if (!res.ok) throw new Error(`expected ok, got: ${res.error.code} — ${res.error.message}`);
  return res.value;
}

const ADMIN = { actAs: { mode: 'admin' } } as const;

describe('worker resetAll op', () => {
  it('clears Firestore docs, auth users, the RTDB tree, and storage objects', async () => {
    const ctx = makeCtx();

    // Seed every service the worker owns.
    ctx.sandbox.admin.setDocument('rooms/general', { name: 'General' });
    const auth = getAuth(ctx.sandbox);
    authSandbox.createUser(auth, { email: 'a@example.com', password: 'pw123456' });
    const rtdb = getDatabase(ctx.sandbox);
    await rtdbSet(rtdbRef(rtdb, '/presence/u1'), { online: true });
    await opOk(ctx, {
      method: 'storage.putBytes',
      path: 'uploads/logo.png',
      dataB64: bytesToBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
      contentType: 'image/png',
      ...ADMIN,
    });

    // One op wipes everything.
    await opOk(ctx, { method: 'resetAll' });

    expect(Object.keys(ctx.sandbox.snapshot().firestore)).toHaveLength(0);
    expect(authSandbox.listUsers(auth)).toHaveLength(0);
    expect((await rtdbGet(rtdbRef(rtdb, '/presence/u1'))).val()).toBeNull();
    const read = await op(ctx, { method: 'storage.getBytes', path: 'uploads/logo.png', ...ADMIN });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe('storage/object-not-found');
  });

  it('re-deploys the active Firestore rules after the env swap (data reset, not de-governing)', async () => {
    const ctx = makeCtx();
    const denyAll = `
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /{document=**} { allow read, write: if false; }
        }
      }`;
    await opOk(ctx, { method: 'setRules', source: denyAll });

    await opOk(ctx, { method: 'resetAll' });

    // An app-session write is still governed by the project rules after reset.
    const write = await op(ctx, {
      method: 'setDoc',
      path: 'rooms/general',
      data: { name: 'General' },
    });
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.error.code).toBe('permission-denied');
  });

  it('empties the event history — a post-reset event subscription reads an empty backlog', async () => {
    // "This is a total reset": Studio's Traffic feed sources the worker's
    // `sandbox.history()` as the initial event-sub batch. After resetAll the
    // wiped session's request/denial/delete record must be gone — the sandbox
    // clears `history()` inside `reset()` (boundary not retained); this pins
    // that contract at the layer Studio actually reads.
    const ctx = makeCtx();
    // A rules-governed write emits request/write events onto the history.
    await op(ctx, { method: 'setDoc', path: 'rooms/general', data: { name: 'General' } });
    expect(ctx.sandbox.history().length).toBeGreaterThan(0);

    await opOk(ctx, { method: 'resetAll' });

    const batches: (readonly unknown[])[] = [];
    const subPort: PortLike = {
      postMessage(msg: OutboundMessage) {
        if (msg.t === 'event') batches.push(msg.events);
      },
    };
    await handleMessage(ctx, subPort, {
      t: 'sub',
      subId: 'post-reset-events',
      target: 'events',
    } as InboundMessage);
    expect(batches).toEqual([[]]); // initial history batch: nothing survived
    expect(ctx.sandbox.history()).toEqual([]);
  });

  it('force-flushes the session capture so a rebooting worker cannot re-prime wiped events', async () => {
    // The server capture (`.pyric/last-session.json`) persists the event
    // history `hydrateEventHistory` primes back on the next worker boot.
    // resetAll must push the post-reset (empty) history there IMMEDIATELY —
    // pre-fix the write waited out the capture debounce, so a worker death in
    // that window resurrected the wiped session's traffic.
    const ctx = makeCtx();
    const posts: string[] = [];
    const fetchStub = (async (url: unknown, init?: { method?: string; body?: string }) => {
      if (String(url) === '/__pyric/capture' && init?.method === 'POST') {
        posts.push(init.body ?? '');
        return { status: 200, ok: true } as Response;
      }
      return { status: 404, ok: false } as Response;
    }) as unknown as typeof fetch;

    const payload: InitPayload = {
      rules: null,
      rulesHash: null,
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: null,
      seed: null,
      seedState: null,
      authUsers: null,
      capture: true,
    };
    // A debounce far beyond the test's lifetime: any capture POST observed
    // below can only come from the resetAll op's forced flush.
    applyServeInit(ctx, payload, { fetch: fetchStub, captureDebounceMs: 600_000 });

    // A rules-governed write puts events on the history (and arms the
    // debounced capture, which must NOT fire within this test's lifetime).
    await op(ctx, { method: 'setDoc', path: 'rooms/general', data: { name: 'General' } });
    expect(ctx.sandbox.history().length).toBeGreaterThan(0);
    expect(posts).toHaveLength(0); // debounced — nothing flushed yet

    await opOk(ctx, { method: 'resetAll' });

    expect(posts.length).toBeGreaterThan(0);
    const fixture = JSON.parse(posts[posts.length - 1]!) as { events?: unknown[] };
    expect(fixture.events ?? []).toEqual([]); // the capture now records the empty log
  });
});
