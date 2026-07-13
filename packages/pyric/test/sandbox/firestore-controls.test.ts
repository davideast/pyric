import { describe, expect, it } from 'bun:test';

import { doc, getDoc, getFirestore, onSnapshot } from 'pyric/firestore';
import { initializeSandbox, inspectSandbox } from 'pyric/sandbox';
import {
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

describe('pyric/sandbox/firestore', () => {
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

    expect(inspectSandbox(sandbox, { recentEventLimit: 1 })).toEqual({
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
});
