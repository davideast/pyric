/**
 * ADR-0009 decision 6 — characterization pins for how admin-compat
 * queries interact with security rules. Public surface only.
 *
 * Current behavior locked here (contrary to the "admin always bypasses"
 * guess): a default `createCompatFirestore` handle enforces rules — a
 * closed ruleset blocks queries with permission-denied. The rules bypass
 * is opt-in via `{ bypassRules: true }`, and with it a closed ruleset
 * must not block admin queries.
 *
 * Also pinned: the query-proof model ("rules are not filters") — a
 * data-dependent list rule that the query's equality constraints prove is
 * allowed; an unprovable query is denied whole, never silently filtered.
 * And the aggregate surface (count / sum / average via `aggregate()`).
 */
import { describe, it, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import {
  createCompatFirestore,
  FirestoreCompatError,
} from '../../../../../src/firestore/sandbox/admin-compat/index.js';

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

const PUBLIC_ONLY = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} { allow read, write: if resource.data.public == true; }
  }
}`;

const WIDGETS = {
  'widgets/W-1': { name: 'first', qty: 1 },
  'widgets/W-2': { name: 'second', qty: 2 },
} as const;

function seededEnv(rules: string, documents: Record<string, Record<string, unknown>>) {
  const env = new LocalEnvironment();
  env.seed({ rules, documents });
  return env;
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(FirestoreCompatError);
    return (e as FirestoreCompatError).code;
  }
  return undefined;
}

describe('characterization — default handle enforces rules', () => {
  it('deny-all rules block a query with permission-denied', async () => {
    const db = createCompatFirestore(seededEnv(DENY_ALL, WIDGETS), { auth: { uid: 'alice' } });
    expect(await code(db.collection('widgets').get())).toBe('permission-denied');
  });

  it('deny-all rules block aggregate() with permission-denied', async () => {
    const db = createCompatFirestore(seededEnv(DENY_ALL, WIDGETS), { auth: { uid: 'alice' } });
    expect(
      await code(db.collection('widgets').aggregate({ count: { kind: 'count' } })),
    ).toBe('permission-denied');
  });

  it('auth-gated rules deny an unauthenticated handle, allow an authenticated one', async () => {
    const anon = createCompatFirestore(seededEnv(AUTH_ONLY, WIDGETS), { auth: null });
    expect(await code(anon.collection('widgets').get())).toBe('permission-denied');
    const alice = createCompatFirestore(seededEnv(AUTH_ONLY, WIDGETS), { auth: { uid: 'alice' } });
    expect((await alice.collection('widgets').get()).size).toBe(2);
  });

  it('per-op auth override on get() beats the handle default', async () => {
    const env = seededEnv(AUTH_ONLY, WIDGETS);
    const anon = createCompatFirestore(env, { auth: null });
    // Same handle: denied with its default auth, allowed with an override.
    expect(await code(anon.collection('widgets').get())).toBe('permission-denied');
    const snap = await anon.collection('widgets').get({ auth: { uid: 'bob' } });
    expect(snap.size).toBe(2);
  });
});

describe('characterization — rules are not filters (query proof)', () => {
  const NOTES = {
    'notes/n1': { public: true, t: 'a' },
    'notes/n2': { public: false, t: 'b' },
    'notes/n3': { public: true, t: 'c' },
  } as const;

  it('a bare query under a data-dependent rule is denied whole', async () => {
    const db = createCompatFirestore(seededEnv(PUBLIC_ONLY, NOTES), { auth: { uid: 'alice' } });
    expect(await code(db.collection('notes').get())).toBe('permission-denied');
  });

  it('a query whose equality discharges the rule predicate is allowed', async () => {
    const db = createCompatFirestore(seededEnv(PUBLIC_ONLY, NOTES), { auth: { uid: 'alice' } });
    const snap = await db.collection('notes').where('public', '==', true).get();
    expect(snap.docs.map((d) => d.id)).toEqual(['n1', 'n3']);
  });

  it('an unprovable query is denied whole — never silently filtered', async () => {
    const db = createCompatFirestore(seededEnv(PUBLIC_ONLY, NOTES), { auth: { uid: 'alice' } });
    // t == 'a' matches only a public doc, but the constraint does not
    // prove the rule, so the whole query is rejected.
    expect(await code(db.collection('notes').where('t', '==', 'a').get())).toBe('permission-denied');
  });
});

describe('characterization — bypassRules admin lens', () => {
  it('a closed ruleset does not block a bypassRules handle', async () => {
    const db = createCompatFirestore(seededEnv(DENY_ALL, WIDGETS), {
      auth: { uid: 'alice' },
      bypassRules: true,
    });
    const snap = await db.collection('widgets').get();
    expect(snap.docs.map((d) => d.id)).toEqual(['W-1', 'W-2']);
  });

  it('chained where/orderBy/limit keep the bypass', async () => {
    const db = createCompatFirestore(seededEnv(DENY_ALL, WIDGETS), {
      auth: null,
      bypassRules: true,
    });
    const snap = await db
      .collection('widgets')
      .where('qty', '>', 0)
      .orderBy('qty', 'desc')
      .limit(1)
      .get();
    expect(snap.docs.map((d) => d.id)).toEqual(['W-2']);
  });

  it('collectionGroup queries keep the bypass', async () => {
    const db = createCompatFirestore(seededEnv(DENY_ALL, WIDGETS), {
      auth: null,
      bypassRules: true,
    });
    const snap = await db.collectionGroup('widgets').get();
    expect(snap.docs.map((d) => d.ref.path)).toEqual(['widgets/W-1', 'widgets/W-2']);
  });

  it('aggregate() works under deny-all with the bypass', async () => {
    const db = createCompatFirestore(seededEnv(DENY_ALL, WIDGETS), {
      auth: null,
      bypassRules: true,
    });
    const agg = await db.collection('widgets').aggregate({
      c: { kind: 'count' },
      total: { kind: 'sum', field: 'qty' },
      avg: { kind: 'average', field: 'qty' },
    });
    expect(agg.data()).toEqual({ c: 2, total: 3, avg: 1.5 });
  });
});

describe('characterization — aggregate surface shape', () => {
  it('count/sum over an empty set is 0; average is null', async () => {
    const db = createCompatFirestore(seededEnv(AUTH_ONLY, WIDGETS), { auth: { uid: 'alice' } });
    const agg = await db
      .collection('widgets')
      .where('qty', '>', 100)
      .aggregate({ c: { kind: 'count' }, s: { kind: 'sum', field: 'qty' }, a: { kind: 'average', field: 'qty' } });
    expect(agg.data()).toEqual({ c: 0, s: 0, a: null });
  });

  it('sum/average silently skip non-numeric values', async () => {
    const env = seededEnv(AUTH_ONLY, {
      'widgets/W-1': { qty: 2 },
      'widgets/W-2': { qty: 'lots' },
      'widgets/W-3': { qty: 4 },
    });
    const db = createCompatFirestore(env, { auth: { uid: 'alice' } });
    const agg = await db
      .collection('widgets')
      .aggregate({ c: { kind: 'count' }, s: { kind: 'sum', field: 'qty' }, a: { kind: 'average', field: 'qty' } });
    // count counts all matched docs; sum/average only the numeric ones.
    expect(agg.data()).toEqual({ c: 3, s: 6, a: 3 });
  });
});
