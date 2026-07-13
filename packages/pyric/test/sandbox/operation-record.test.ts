/**
 * Canonical operation-record contract.
 *
 * The public sandbox event stream is the seam: callers issue real operations
 * through public Firestore / Storage handles and observe the one normalized
 * record consumed by Studio, metrics, and audit surfaces. The assertions do
 * not reach into service emitters or the recorder implementation.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import {
  initializeSandbox,
  toOperationRecord,
  type EventProvenance,
  type OperationContext,
  type RulesDisposition,
  type SandboxEvent,
} from 'pyric/sandbox';
import { bindOperationContext } from 'pyric/sandbox/internal';
import { initializeApp } from 'pyric/app';
import {
  collection,
  doc,
  getAdminFirestore,
  getFirestore,
  getDocs,
  runTransaction,
} from 'pyric/firestore';
import {
  getStorageSandbox,
  listAll,
  ref,
  uploadBytes,
} from 'pyric/storage';
import {
  bindStorageOperationContext,
  getAdminStorageSandbox,
} from 'pyric/storage/internal';

const STUDIO_ADMIN = {
  source: { kind: 'studio' },
  authLens: { mode: 'admin' },
} satisfies OperationContext;

let storageSeq = 0;
function storageDb(label: string): string {
  storageSeq += 1;
  return `operation-record-${label}-${storageSeq}`;
}

describe('canonical operation records', () => {
  it('records a Studio Firestore admin LIST as a rules bypass', async () => {
    const sandbox = initializeSandbox();
    sandbox.admin.setDocument('posts/p1', { title: 'One' });
    const context = bindOperationContext(sandbox.withAuth(null), STUDIO_ADMIN);
    const db = getAdminFirestore(context);
    const before = sandbox.history().length;

    await getDocs(collection(db, 'posts'));

    const event = sandbox.history().slice(before).find(
      (candidate) => candidate.kind === 'request' && candidate.method === 'list',
    );
    expect(event).toBeDefined();
    const record = toOperationRecord(event!);
    expect(record).not.toBeNull();
    expect(record!.context).toEqual(STUDIO_ADMIN);
    expect(record!.rules).toEqual({ kind: 'bypassed', reason: 'admin' });
  });

  it('keeps app source orthogonal to an admin Firestore lens', async () => {
    const sandbox = initializeSandbox();
    sandbox.admin.setDocument('posts/p1', { title: 'One' });
    const app = initializeApp(
      { sandbox },
      `operation-record-app-admin-${Math.random().toString(36).slice(2)}`,
    );
    const db = getAdminFirestore(app);
    const before = sandbox.history().length;

    await getDocs(collection(db, 'posts'));

    const event = sandbox.history().slice(before).find(
      (candidate) => candidate.kind === 'request' && candidate.method === 'list',
    );
    const record = toOperationRecord(event!);
    expect(record?.context).toEqual({
      source: { kind: 'app' },
      authLens: { mode: 'admin' },
    });
    expect(record?.rules).toEqual({ kind: 'bypassed', reason: 'admin' });
  });

  it('records an app-as-user Firestore operation without conflating source and lens', async () => {
    const sandbox = initializeSandbox();
    sandbox.admin.setDocument('posts/p1', { title: 'One' });
    const context = bindOperationContext(sandbox.withAuth({ uid: 'alice' }), {
      source: { kind: 'app' },
      authLens: { mode: 'as', uid: 'alice' },
    });
    const before = sandbox.history().length;

    await getDocs(collection(getFirestore(context), 'posts'));

    const event = sandbox.history().slice(before).find(
      (candidate) => candidate.kind === 'request' && candidate.method === 'list',
    );
    expect(toOperationRecord(event!)?.context).toEqual({
      source: { kind: 'app' },
      authLens: { mode: 'as', uid: 'alice' },
    });
  });

  it('preserves Studio/admin provenance after an async transaction callback yields', async () => {
    const sandbox = initializeSandbox();
    const context = bindOperationContext(sandbox.withAuth(null), STUDIO_ADMIN);
    const db = getAdminFirestore(context);
    const before = sandbox.history().length;

    await runTransaction(db, async (tx) => {
      await Promise.resolve();
      tx.set(doc(db, 'posts/async-tx'), { title: 'Async' });
    });

    const event = sandbox.history().slice(before).find(
      (candidate) => candidate.kind === 'request' && candidate.groupKind === 'transaction',
    );
    const record = toOperationRecord(event!);
    expect(record?.context).toEqual(STUDIO_ADMIN);
    expect(record?.rules).toEqual({ kind: 'bypassed', reason: 'admin' });
  });

  it('preserves Studio/admin provenance across an async Storage LIST', async () => {
    const sandbox = initializeSandbox();
    const context = bindOperationContext(sandbox.withAuth(null), STUDIO_ADMIN);
    const storage = getAdminStorageSandbox(context, {
      dbName: storageDb('admin-list'),
    });
    expect(getAdminStorageSandbox(context)).toBe(storage);
    await uploadBytes(ref(storage, 'notes/a.txt'), new Uint8Array([1]));
    const before = sandbox.history().length;

    await listAll(ref(storage, 'notes'));

    const event = sandbox.history().slice(before).find(
      (candidate) => candidate.kind === 'operation' && candidate.service === 'storage',
    );
    expect(event).toBeDefined();
    const record = toOperationRecord(event!);
    expect(record).not.toBeNull();
    expect(record!.context).toEqual(STUDIO_ADMIN);
    expect(record!.rules).toEqual({ kind: 'bypassed', reason: 'admin' });
  });

  it('distinguishes open-by-default Storage from a Rules allow', async () => {
    const sandbox = initializeSandbox();
    const context = bindOperationContext(sandbox.withAuth(null), {
      source: { kind: 'app' },
      authLens: { mode: 'app-session' },
    });
    const storage = getStorageSandbox(context, { dbName: storageDb('open-list') });

    await listAll(ref(storage, ''));

    const event = sandbox.history().find(
      (candidate) => candidate.kind === 'operation' && candidate.service === 'storage',
    );
    expect(event).toBeDefined();
    const record = toOperationRecord(event!);
    expect(record!.context.source).toEqual({ kind: 'app' });
    expect(record!.rules).toEqual({ kind: 'not-evaluated', reason: 'no-rules' });
  });

  it('captures async provenance at issue time', async () => {
    const sandbox = initializeSandbox();
    const storage = getStorageSandbox(sandbox.withAuth(null), {
      dbName: storageDb('issue-time'),
    });
    const provenance: EventProvenance = {
      actor: { kind: 'studio' },
      authLens: { mode: 'anon' },
    };

    const pending = listAll(ref(bindStorageOperationContext(storage, provenance), ''));
    provenance.actor = { kind: 'app' };
    provenance.authLens = { mode: 'app-session' };
    await pending;

    const event = sandbox.history().find(
      (candidate) => candidate.kind === 'operation' && candidate.service === 'storage',
    );
    expect(toOperationRecord(event!)?.context).toEqual({
      source: { kind: 'studio' },
      authLens: { mode: 'anon' },
    });
  });

  it('does not infer a rules bypass from the admin lens alone', () => {
    const event: SandboxEvent = {
      kind: 'operation',
      id: 'admin-lens-without-bypass',
      at: 1,
      service: 'storage',
      method: 'list',
      path: 'notes',
      auth: null,
      result: 'allow',
      origin: 'user',
      operationContext: {
        source: { kind: 'app' },
        authLens: { mode: 'admin' },
      },
    };

    expect(toOperationRecord(event)?.rules).toEqual({
      kind: 'not-evaluated',
      reason: 'no-rules',
    });
  });

  it('deeply snapshots mutable auth and rules inputs', () => {
    const token = { claims: { role: 'reader' } };
    const rules: RulesDisposition = { kind: 'evaluated', verdict: 'allow' };
    const event: SandboxEvent = {
      kind: 'operation',
      id: 'immutable-record',
      at: 1,
      service: 'firestore',
      method: 'get',
      path: 'notes/a',
      auth: { uid: 'alice', token },
      result: 'allow',
      origin: 'user',
      rulesDisposition: rules,
    };
    const record = toOperationRecord(event)!;

    token.claims.role = 'admin';
    rules.verdict = 'deny';

    expect(record.auth).toEqual({
      uid: 'alice',
      token: { claims: { role: 'reader' } },
    });
    expect(record.rules).toEqual({ kind: 'evaluated', verdict: 'allow' });
    expect(Object.isFrozen(record.auth)).toBe(true);
    expect(Object.isFrozen(record.rules)).toBe(true);
  });
});
