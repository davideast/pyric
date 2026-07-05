/**
 * FS-B1 / RULES-B1 — query reads enforce security rules.
 *
 * Before FS-B1, `Query.get()` / `getDocs` / `Query.aggregate()` read
 * through the raw, rules-bypassing `env.listDocuments`, so a deny-all
 * rule set silently returned the whole collection — a total bypass on
 * the web-modular + auth-scoped admin-compat surfaces (single-doc
 * `DocumentReference.get()` already enforced rules; query reads did
 * not). These probes lock the enforcement: the masked scenario is a
 * non-trivial rule set (deny-all, auth-gated, field-gated) where the
 * pre-fix bypass returned docs it should not have.
 *
 * The raw `LocalEnvironment.listDocuments` (admin/crawler access) keeps
 * its bypass — that path is exercised by the discover crawler and
 * transaction read-sets and is intentionally rules-free.
 */
import { describe, it, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import {
  createCompatFirestore,
  FirestoreCompatError,
} from '../../../../src/sandbox/firestore/admin-compat/index.js';

const DENY_ALL = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}`;

const AUTH_ONLY = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /widgets/{id} { allow read, write: if request.auth != null; }
  }
}`;

function seed(rules: string) {
  const env = new LocalEnvironment();
  env.seed({
    rules,
    documents: {
      'widgets/W-1': { name: 'first', priority: 1 },
      'widgets/W-2': { name: 'second', priority: 2 },
    },
  });
  return env;
}

describe('FS-B1 — getDocs / Query.get enforces rules', () => {
  it('deny-all rules → Query.get throws permission-denied', async () => {
    const env = seed(DENY_ALL);
    const db = createCompatFirestore(env, { auth: { uid: 'alice' } });
    let err: unknown;
    try {
      await db.collection('widgets').get();
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(FirestoreCompatError);
    expect((err as FirestoreCompatError).code).toBe('permission-denied');
  });

  it('auth-only rules + unauthenticated → throws permission-denied', async () => {
    const env = seed(AUTH_ONLY);
    // No auth (anonymous) — the auth-gated list rule denies.
    const db = createCompatFirestore(env, { auth: null });
    let err: unknown;
    try {
      await db.collection('widgets').get();
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(FirestoreCompatError);
    expect((err as FirestoreCompatError).code).toBe('permission-denied');
  });

  it('auth-only rules + authenticated → returns the collection', async () => {
    const env = seed(AUTH_ONLY);
    const db = createCompatFirestore(env, { auth: { uid: 'alice' } });
    const snap = await db.collection('widgets').get();
    expect(snap.size).toBe(2);
  });
});

describe('FS-B1 — Query.aggregate enforces rules', () => {
  it('deny-all rules → aggregate throws permission-denied', async () => {
    const env = seed(DENY_ALL);
    const db = createCompatFirestore(env, { auth: { uid: 'alice' } });
    let err: unknown;
    try {
      await db.collection('widgets').aggregate({ count: { kind: 'count' } });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(FirestoreCompatError);
    expect((err as FirestoreCompatError).code).toBe('permission-denied');
  });

  it('auth-only rules + authenticated → counts the readable docs', async () => {
    const env = seed(AUTH_ONLY);
    const db = createCompatFirestore(env, { auth: { uid: 'alice' } });
    const snap = await db.collection('widgets').aggregate({ count: { kind: 'count' } });
    expect(snap.data().count).toBe(2);
  });
});

describe('FS-B1 — listDocuments keeps its admin bypass', () => {
  it('raw listDocuments returns docs even under deny-all rules', () => {
    const env = seed(DENY_ALL);
    // The admin/crawler escape hatch is intentionally rules-free.
    const docs = env.listDocuments('widgets').filter((d) => !d.phantom);
    expect(docs.length).toBe(2);
  });
});
