import { describe, expect, it } from 'bun:test';

import { doc, getDoc, getFirestore, onSnapshot } from 'pyric/firestore';
import {
  initializeSandbox,
  REMOTE_SANDBOX,
  type RemoteSandbox,
} from 'pyric/sandbox';
import * as sandboxApi from 'pyric/sandbox';
import {
  inspect,
  seedDocuments,
  setRules,
} from 'pyric/sandbox/firestore';

const READ_ALL = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read: if true;
    }
  }
}`;

const DENY_ALL = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;

function remoteSandbox(): RemoteSandbox {
  return Object.assign(initializeSandbox(), {
    [REMOTE_SANDBOX]: true as const,
    serveUrl: 'http://127.0.0.1:3473',
    channel: {
      op: async () => undefined,
      subscribe: () => () => {},
    },
  });
}

const tick = (): Promise<void> =>
  new Promise((resolve) => queueMicrotask(() => resolve()));

describe('pyric/sandbox/firestore', () => {
  it('keeps Firestore inspection off the central sandbox surface', () => {
    expect('inspectSandbox' in sandboxApi).toBe(false);
  });

  it('loads rules and bulk-seeds documents through the owning Sandbox', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);

    expect(setRules(sandbox, READ_ALL).warnings.map((finding) => finding.rule)).toEqual([
      'RECURSIVE_WILDCARD_OPEN',
    ]);
    expect(
      seedDocuments(sandbox, {
        'users/alice': { name: 'Alice' },
        'users/bob': { name: 'Bob' },
      }).warnings.map((finding) => finding.rule),
    ).toEqual(['RECURSIVE_WILDCARD_OPEN']);

    expect((await getDoc(doc(db, 'users/alice'))).data()).toEqual({
      name: 'Alice',
    });
    expect(sandbox.snapshot().firestore).toEqual({
      'users/alice': { name: 'Alice' },
      'users/bob': { name: 'Bob' },
    });
  });

  it('inspects rules, documents, and recent requests from the Sandbox', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);
    setRules(sandbox, DENY_ALL);
    seedDocuments(sandbox, {
      'users/alice': { name: 'Alice' },
      'posts/one': { title: 'One' },
    });

    await expect(getDoc(doc(db, 'users/alice'))).rejects.toMatchObject({
      code: 'permission-denied',
    });

    expect(inspect(sandbox, { recentEventLimit: 1 })).toEqual({
      rules: {
        source: DENY_ALL,
        sizeBytes: new TextEncoder().encode(DENY_ALL).byteLength,
        isEmpty: false,
        lint: {
          errors: 0,
          warnings: 0,
          info: 0,
          findings: [],
        },
      },
      documents: {
        totalCount: 2,
        byCollection: { users: 1, posts: 1 },
      },
      events: {
        totalCount: 1,
        recentDenials: [
          {
            path: 'users/alice',
            method: 'get',
            auth: null,
            debugMessage: undefined,
          },
        ],
        recentRequests: [
          {
            path: 'users/alice',
            method: 'get',
            result: 'deny',
            auth: null,
          },
        ],
      },
    });
  });

  it('re-evaluates live listeners when rules are reloaded', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);
    setRules(sandbox, DENY_ALL);
    seedDocuments(sandbox, { 'users/alice': { name: 'Alice' } });

    let resolveAllowed!: (value: unknown) => void;
    const allowed = new Promise<unknown>((resolve) => {
      resolveAllowed = resolve;
    });
    let resolveDenied!: (code: string | undefined) => void;
    const denied = new Promise<string | undefined>((resolve) => {
      resolveDenied = resolve;
    });
    const unsubscribe = onSnapshot(
      doc(db, 'users/alice'),
      (snapshot) => resolveAllowed(snapshot.data()),
      (error) => resolveDenied((error as { code?: string }).code),
    );

    expect(await denied).toBe('permission-denied');
    setRules(sandbox, READ_ALL);
    expect(await allowed).toEqual({ name: 'Alice' });
    unsubscribe();
  });

  it('applies controls only to the Sandbox passed to the operation', async () => {
    const first = initializeSandbox();
    const second = initializeSandbox();
    setRules(first, READ_ALL);
    setRules(second, READ_ALL);
    seedDocuments(first, { 'users/alice': { owner: 'first' } });
    seedDocuments(second, { 'users/alice': { owner: 'second' } });

    expect(
      (await getDoc(doc(getFirestore(first), 'users/alice'))).data(),
    ).toEqual({ owner: 'first' });
    expect(
      (await getDoc(doc(getFirestore(second), 'users/alice'))).data(),
    ).toEqual({ owner: 'second' });
  });

  it('reports synchronous rules and seed controls as unimplemented remotely', () => {
    const remote = remoteSandbox();

    expect(() => setRules(remote, READ_ALL)).toThrowError(
      expect.objectContaining({
        code: 'unimplemented',
        message: expect.stringContaining('setFirestoreRules'),
      }),
    );
    expect(() => seedDocuments(remote, { 'users/alice': { name: 'Alice' } })).toThrowError(
      expect.objectContaining({
        code: 'unimplemented',
        message: expect.stringContaining('admin.setDocument'),
      }),
    );
  });

  it('preserves bulk seed replacement without synthesizing events or listener callbacks', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);
    setRules(sandbox, READ_ALL);
    seedDocuments(sandbox, { 'users/alice': { name: 'Alice' } });

    const snapshots: Array<unknown> = [];
    const events: Array<unknown> = [];
    const unsubscribeSnapshot = onSnapshot(doc(db, 'users/alice'), (snapshot) => {
      snapshots.push(snapshot.data());
    });
    const unsubscribeEvents = sandbox.onEvent((event) => events.push(event));
    await tick();
    expect(snapshots).toEqual([{ name: 'Alice' }]);
    const eventsBeforeSecondSeed = [...events];
    const historyBeforeSecondSeed = sandbox.history();

    seedDocuments(sandbox, { 'users/bob': { name: 'Bob' } });
    await tick();

    expect(sandbox.snapshot().firestore).toEqual({
      'users/bob': { name: 'Bob' },
    });
    expect(snapshots).toEqual([{ name: 'Alice' }]);
    expect(events).toEqual(eventsBeforeSecondSeed);
    expect(sandbox.history()).toEqual(historyBeforeSecondSeed);

    unsubscribeEvents();
    unsubscribeSnapshot();
  });
});
