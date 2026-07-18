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
});
