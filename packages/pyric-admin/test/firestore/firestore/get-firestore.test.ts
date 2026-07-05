/**
 * `/firestore` sub-package surface.
 *
 * Verifies `getFirestore(ctx)` shape, idempotency, and that the
 * context's auth flows into per-op evaluation.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { getFirestore } from '../../../src/firestore/index.js';
import { getInternalEnv } from 'pyric/sandbox/internal';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tickets/{id} {
      allow read: if request.auth != null
        && (request.auth.uid == resource.data.assigneeId
            || request.auth.uid == resource.data.reporterId);
    }
  }
}`;

function seeded(): Sandbox {
  const sandbox = initializeSandbox();
  getInternalEnv(sandbox).seed({
    rules: RULES,
    documents: {
      'tickets/T-1': {
        title: 'Set up CI',
        reporterId: 'alice',
        assigneeId: 'bob',
        status: 'open',
      },
    },
  });
  return sandbox;
}

describe('getFirestore shape', () => {
  it('returns a Firestore with the Admin-shaped methods', () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth(null));
    expect(typeof db.doc).toBe('function');
    expect(typeof db.collection).toBe('function');
    expect(typeof db.batch).toBe('function');
    expect(typeof db.runTransaction).toBe('function');
  });
});

describe('getFirestore idempotency', () => {
  it('returns the same handle for repeated calls with the same context', () => {
    const sandbox = initializeSandbox();
    const ctx = sandbox.withAuth({ uid: 'alice' });
    expect(getFirestore(ctx)).toBe(getFirestore(ctx));
  });

  it('returns distinct handles for distinct contexts even on the same sandbox', () => {
    const sandbox = initializeSandbox();
    const ctxA = sandbox.withAuth({ uid: 'alice' });
    const ctxB = sandbox.withAuth({ uid: 'bob' });
    expect(getFirestore(ctxA)).not.toBe(getFirestore(ctxB));
  });

  it('returns distinct handles for distinct sandboxes', () => {
    const a = initializeSandbox().withAuth({ uid: 'alice' });
    const b = initializeSandbox().withAuth({ uid: 'bob' });
    expect(getFirestore(a)).not.toBe(getFirestore(b));
  });
});

describe('context auth flows into per-op evaluation', () => {
  it('alice (reporter) is allowed on T-1', async () => {
    const sandbox = seeded();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    const snap = await db.doc('tickets/T-1').get();
    expect(snap.exists).toBe(true);
    expect(snap.data()?.title).toBe('Set up CI');
  });

  it('bob (assignee) is allowed on T-1', async () => {
    const sandbox = seeded();
    const db = getFirestore(sandbox.withAuth({ uid: 'bob' }));
    const snap = await db.doc('tickets/T-1').get();
    expect(snap.exists).toBe(true);
  });

  it('carol (neither) is denied on T-1', async () => {
    const sandbox = seeded();
    const db = getFirestore(sandbox.withAuth({ uid: 'carol' }));
    let err: unknown;
    try {
      await db.doc('tickets/T-1').get();
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toBe('permission-denied');
  });

  it('sibling contexts share data on the same sandbox', async () => {
    const sandbox = seeded();
    const dbAlice = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    const dbBob = getFirestore(sandbox.withAuth({ uid: 'bob' }));
    const a = await dbAlice.doc('tickets/T-1').get();
    const b = await dbBob.doc('tickets/T-1').get();
    expect(a.data()?.title).toBe(b.data()?.title);
  });
});

describe('reset is visible to existing contexts', () => {
  it('after sandbox.reset, getInternalEnv on a pre-existing context returns the fresh env', () => {
    const sandbox = seeded();
    const ctx = sandbox.withAuth({ uid: 'bob' });

    const envBefore = getInternalEnv(ctx.sandbox);
    sandbox.reset();
    const envAfter = getInternalEnv(ctx.sandbox);

    // The sandbox holds whatever env is current; the context's
    // sandbox reference is stable across the swap.
    expect(envBefore).not.toBe(envAfter);
    expect(ctx.sandbox).toBe(sandbox);
  });
});
