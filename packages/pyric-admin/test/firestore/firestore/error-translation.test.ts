/**
 * Verify compat errors surface as `SandboxError` with structured
 * `denialContext` attached on `permission-denied`. Auth flows from
 * the operation's `SandboxContext`, never from the sandbox itself.
 */
import { describe, it, expect } from 'bun:test';
import {
  initializeSandbox,
  SandboxError,
  type AuthState,
  type Sandbox,
} from 'pyric/sandbox';
import { getFirestore } from '../../../src/firestore/index.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tickets/{id} {
      allow read: if request.auth != null
        && request.auth.uid == resource.data.ownerId;
      allow create: if request.auth != null
        && request.auth.uid == request.resource.data.ownerId;
    }
  }
}`;

function makeSandbox(): Sandbox {
  const sandbox = initializeSandbox();
  // setup uses an explicit anonymous context for the admin ops;
  // identity for the actual test op is chosen per-test.
  const setupDb = getFirestore(sandbox.withAuth(null));
  setupDb.setRules(RULES);
  setupDb.seed({
    documents: {
      'tickets/T-1': { ownerId: 'alice', title: 'first' },
    },
  });
  return sandbox;
}

function dbAs(sandbox: Sandbox, auth: AuthState) {
  return getFirestore(sandbox.withAuth(auth));
}

describe('SandboxError translation on read denial', () => {
  it('throws SandboxError, not FirestoreError, when a rule denies', async () => {
    const sandbox = makeSandbox();
    const db = dbAs(sandbox, { uid: 'bob' });
    let err: unknown;
    try {
      await db.doc('tickets/T-1').get();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('permission-denied');
  });

  it('attaches denialContext.auth from the operation context', async () => {
    const sandbox = makeSandbox();
    const db = dbAs(sandbox, { uid: 'bob' });
    let err: SandboxError | undefined;
    try {
      await db.doc('tickets/T-1').get();
    } catch (e) {
      err = e as SandboxError;
    }
    expect(err?.denialContext?.auth).toEqual({ uid: 'bob' });
  });

  it('attaches denialContext.reasons recovered from sim debug messages', async () => {
    const sandbox = makeSandbox();
    const db = dbAs(sandbox, { uid: 'bob' });
    let err: SandboxError | undefined;
    try {
      await db.doc('tickets/T-1').get();
    } catch (e) {
      err = e as SandboxError;
    }
    expect(err?.denialContext?.reasons).toBeDefined();
    expect(Array.isArray(err?.denialContext?.reasons)).toBe(true);
    expect((err?.denialContext?.reasons ?? []).length).toBeGreaterThan(0);
  });

  it('sibling contexts carry their own auth in denialContext', async () => {
    const sandbox = makeSandbox();
    const dbCarol = dbAs(sandbox, { uid: 'carol' });
    let err: SandboxError | undefined;
    try {
      await dbCarol.doc('tickets/T-1').get();
    } catch (e) {
      err = e as SandboxError;
    }
    expect(err?.denialContext?.auth).toEqual({ uid: 'carol' });
  });

  it('anonymous (auth:null) is reflected in denialContext', async () => {
    const sandbox = makeSandbox();
    const db = dbAs(sandbox, null);
    let err: SandboxError | undefined;
    try {
      await db.doc('tickets/T-1').get();
    } catch (e) {
      err = e as SandboxError;
    }
    expect(err?.denialContext?.auth).toBeNull();
  });
});

describe('SandboxError translation on write denial', () => {
  it('translates create denials with denialContext', async () => {
    const sandbox = makeSandbox();
    const db = dbAs(sandbox, { uid: 'bob' });
    let err: SandboxError | undefined;
    try {
      // Bob tries to create a ticket owned by alice — rule requires
      // ownerId == auth.uid.
      await db.doc('tickets/T-2').set({ ownerId: 'alice', title: 'spoofed' });
    } catch (e) {
      err = e as SandboxError;
    }
    expect(err).toBeInstanceOf(SandboxError);
    expect(err?.code).toBe('permission-denied');
    expect(err?.denialContext?.auth).toEqual({ uid: 'bob' });
  });
});

describe('SandboxError translation surfaces eval-time request/resource', () => {
  it('attaches request.method/path/auth on a read denial', async () => {
    const sandbox = makeSandbox();
    const db = dbAs(sandbox, { uid: 'bob' });
    let err: SandboxError | undefined;
    try {
      await db.doc('tickets/T-1').get();
    } catch (e) {
      err = e as SandboxError;
    }
    expect(err?.denialContext?.request).toBeDefined();
    expect(err?.denialContext?.request?.method).toBe('get');
    expect(err?.denialContext?.request?.path).toBe('tickets/T-1');
    expect(err?.denialContext?.request?.resourceData).toBeUndefined();
  });

  it('attaches resource.data on a read denial when the doc exists', async () => {
    const sandbox = makeSandbox();
    const db = dbAs(sandbox, { uid: 'bob' });
    let err: SandboxError | undefined;
    try {
      await db.doc('tickets/T-1').get();
    } catch (e) {
      err = e as SandboxError;
    }
    expect(err?.denialContext?.resource).toBeDefined();
    expect(err?.denialContext?.resource?.exists).toBe(true);
    expect(err?.denialContext?.resource?.data).toEqual({ ownerId: 'alice', title: 'first' });
  });

  it('attaches request.resource.data on a write denial', async () => {
    const sandbox = makeSandbox();
    const db = dbAs(sandbox, { uid: 'bob' });
    let err: SandboxError | undefined;
    try {
      await db.doc('tickets/T-2').set({ ownerId: 'alice', title: 'spoofed' });
    } catch (e) {
      err = e as SandboxError;
    }
    expect(err?.denialContext?.request?.method).toBe('create');
    expect(err?.denialContext?.request?.path).toBe('tickets/T-2');
    expect(err?.denialContext?.request?.resourceData).toEqual({
      ownerId: 'alice',
      title: 'spoofed',
    });
    expect(err?.denialContext?.resource?.exists).toBe(false);
    expect(err?.denialContext?.resource?.data).toBeNull();
  });
});

describe('non-denial codes translate without denialContext', () => {
  it('not-found bubbles through (no rule denial, just absent doc)', async () => {
    const sandbox = makeSandbox();
    const db = dbAs(sandbox, { uid: 'alice' });
    let err: SandboxError | undefined;
    try {
      await db.doc('tickets/missing').update({ title: 'no' });
    } catch (e) {
      err = e as SandboxError;
    }
    expect(err).toBeInstanceOf(SandboxError);
  });
});
