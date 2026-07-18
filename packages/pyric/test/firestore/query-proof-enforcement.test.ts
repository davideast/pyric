/**
 * RULES-B11 — list/query enforcement follows production's QUERY-PROOF
 * model: "rules are not filters."
 *
 *   https://firebase.google.com/docs/firestore/security/rules-query
 *   "When evaluating queries, the rules engine evaluates the query against
 *    its potential result set … If a query could potentially include
 *    documents that the client does not have permission to read, the
 *    entire request fails."
 *
 * Pre-fix the sandbox used "rules-as-filters": after the collection `list`
 * rule passed, every candidate doc was re-evaluated under the per-doc `get`
 * rule and silently dropped on denial — and a `list` rule that read
 * `resource.data` denied EVERY query (even one whose `where()` equalities
 * proved it safe), because the placeholder doc had no data. Production does
 * neither: the `list` rule alone governs queries, provable queries succeed,
 * unprovable queries fail whole.
 *
 * These probes drive the REAL web-modular surface (`getDocs` + `onSnapshot`)
 * end-to-end through `QueryImpl.structuredConstraints()` →
 * `LocalEnvironment`'s query-proof gate (`list-query-proof.ts` →
 * `rules/simulator/query-proof.ts:evaluateQueryProof`, landed in #547).
 * Every "provable → succeeds" case FAILED pre-fix (denied); every
 * "unprovable → whole-query denied, not filtered" case either silently
 * filtered or was indistinguishable from a filtered subset pre-fix.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import { getInternalEnv } from 'pyric/sandbox/internal';
import {
  getFirestore,
  collection,
  getDocs,
  query,
  where,
  limit,
  onSnapshot,
  type QuerySnapshot,
} from '../../src/firestore/index.js';

// The canonical prod example (rules-query doc): list only if each doc is
// public. Provable ONLY with a `where('visibility', '==', 'public')`.
const PUBLIC_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /posts/{id} {
      allow read: if resource.data.visibility == 'public';
      allow write: if true;
    }
  }
}`;

// The docs' auth-pinned example: list only docs the caller owns. Provable
// ONLY with a `where('owner', '==', <the caller's uid>)`.
const OWNER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read: if request.auth != null && resource.data.owner == request.auth.uid;
      allow write: if true;
    }
  }
}`;

// `list` wide open, per-doc `get` owner-gated. Production queries are
// governed by the LIST rule alone — `get` rules never filter query results.
const LIST_OPEN_GET_GATED_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow list: if request.auth != null;
      allow get: if request.auth != null && resource.data.owner == request.auth.uid;
      allow write: if true;
    }
  }
}`;

// Helper-based owner rule — the doc example's `authorOrPublished()` shape:
// a user function inlined during the proof reduces to `owner == auth.uid`,
// provable ONLY with a `where('owner', '==', <the caller's uid>)`.
const OWNER_HELPER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      function isOwner(uid) { return resource.data.owner == uid; }
      allow read: if request.auth != null && isOwner(request.auth.uid);
      allow write: if true;
    }
  }
}`;

// request.query-gated rule — doc-independent, but only satisfiable when the
// query actually carries a small-enough limit.
const QUERY_LIMIT_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /posts/{id} {
      allow list: if request.query.limit != null && request.query.limit <= 50;
      allow write: if true;
    }
  }
}`;

function setup(rules: string, uid: string | null = 'alice') {
  const sandbox = initializeSandbox();
  const db = getFirestore(uid ? sandbox.withAuth({ uid }) : sandbox);
  setRules(sandbox, rules);
  seedDocuments(sandbox, {
    'posts/p1': { visibility: 'public', n: 1 },
    'posts/p2': { visibility: 'private', n: 2 },
    'posts/p3': { visibility: 'public', n: 3 },
    'notes/n1': { owner: 'alice', label: 'mine' },
    'notes/n2': { owner: 'bob', label: 'theirs' },
  });
  return { db, env: getInternalEnv(sandbox) };
}

async function denied(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

describe('RULES-B11 — getDocs under a doc-data-dependent list rule', () => {
  it('PROVABLE: where() discharges the rule → query succeeds (failed pre-fix)', async () => {
    const { db } = setup(PUBLIC_RULES);
    const snap = await getDocs(
      query(collection(db, 'posts'), where('visibility', '==', 'public')),
    );
    expect(snap.size).toBe(2);
    expect(snap.docs.map((d) => d.id).sort()).toEqual(['p1', 'p3']);
  });

  it('UNPROVABLE: no discharging where() → WHOLE query permission-denied, not a filtered subset', async () => {
    const { db } = setup(PUBLIC_RULES);
    // Prod: the unconstrained query COULD return private docs → rejected
    // entirely. A rules-as-filters implementation would instead return the
    // two public docs silently.
    expect(await denied(getDocs(collection(db, 'posts')))).toBe('permission-denied');
  });

  it('UNPROVABLE: where() on the right field but the WRONG value → denied', async () => {
    const { db } = setup(PUBLIC_RULES);
    expect(
      await denied(getDocs(query(collection(db, 'posts'), where('visibility', '==', 'private')))),
    ).toBe('permission-denied');
  });

  it('UNPROVABLE: non-equality where() does not discharge an == requirement', async () => {
    const { db } = setup(PUBLIC_RULES);
    expect(
      await denied(getDocs(query(collection(db, 'posts'), where('visibility', '!=', 'private')))),
    ).toBe('permission-denied');
  });
});

describe('RULES-B11 — auth-pinned owner rule (rules-query docs example)', () => {
  it('PROVABLE: where(owner == <my uid>) → query succeeds (failed pre-fix)', async () => {
    const { db } = setup(OWNER_RULES);
    const snap = await getDocs(
      query(collection(db, 'notes'), where('owner', '==', 'alice')),
    );
    expect(snap.size).toBe(1);
    expect(snap.docs[0]!.id).toBe('n1');
  });

  it('UNPROVABLE: unconstrained query → whole-query denied', async () => {
    const { db } = setup(OWNER_RULES);
    expect(await denied(getDocs(collection(db, 'notes')))).toBe('permission-denied');
  });

  it("UNPROVABLE: where() pins someone ELSE's uid → denied (rule requires the caller's)", async () => {
    const { db } = setup(OWNER_RULES);
    // alice queries bob's notes — the rule requires owner == alice for
    // every returnable doc, but the query guarantees owner == bob.
    expect(
      await denied(getDocs(query(collection(db, 'notes'), where('owner', '==', 'bob')))),
    ).toBe('permission-denied');
  });

  it('residual evaluation: provable shape but unauthenticated → denied by the auth conjunct', async () => {
    const { db } = setup(OWNER_RULES, null);
    expect(
      await denied(getDocs(query(collection(db, 'notes'), where('owner', '==', 'alice')))),
    ).toBe('permission-denied');
  });
});

describe('RULES-B11 — get rules do NOT filter query results', () => {
  it('list-open + get-gated: getDocs returns EVERY doc (pre-fix silently filtered to the readable subset)', async () => {
    const { db } = setup(LIST_OPEN_GET_GATED_RULES);
    // Prod: the query is governed by `allow list: if request.auth != null`
    // — which passes — so BOTH notes come back, including bob's, even
    // though alice could not `get` it individually.
    // (firebase.google.com/docs/firestore/security/rules-structure —
    // granular operations: `list` applies to queries, `get` to single-doc
    // reads.) Pre-fix the per-doc filter dropped n2 silently.
    const snap = await getDocs(collection(db, 'notes'));
    expect(snap.size).toBe(2);
    expect(snap.docs.map((d) => d.id).sort()).toEqual(['n1', 'n2']);
  });

  it('list-open + get-gated: onSnapshot delivers EVERY doc too', () => {
    const { db, env } = setup(LIST_OPEN_GET_GATED_RULES);
    const calls: QuerySnapshot[] = [];
    onSnapshot(collection(db, 'notes'), (snap) => { calls.push(snap as QuerySnapshot); });
    env.flushListeners();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.size).toBe(2);
  });
});

describe('RULES-B11 — onSnapshot under a doc-data-dependent list rule', () => {
  it('PROVABLE: filtered listener attaches and delivers the constrained set (failed pre-fix)', () => {
    const { db, env } = setup(PUBLIC_RULES);
    const calls: QuerySnapshot[] = [];
    const errors: unknown[] = [];
    onSnapshot(
      query(collection(db, 'posts'), where('visibility', '==', 'public')),
      (snap) => { calls.push(snap as QuerySnapshot); },
      (err) => { errors.push(err); },
    );
    env.flushListeners();
    expect(errors).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.size).toBe(2);
    expect(calls[0]!.docs.map((d) => d.id).sort()).toEqual(['p1', 'p3']);
  });

  it('UNPROVABLE: bare collection listen → stream error, NOT a silently truncated snapshot', () => {
    const { db, env } = setup(PUBLIC_RULES);
    const calls: QuerySnapshot[] = [];
    const errors: { code?: string }[] = [];
    onSnapshot(
      collection(db, 'posts'),
      (snap) => { calls.push(snap as QuerySnapshot); },
      (err) => { errors.push(err as { code?: string }); },
    );
    env.flushListeners();
    expect(calls).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('permission-denied');
  });

  it('PROVABLE listener keeps delivering on writes', async () => {
    const { db, env } = setup(PUBLIC_RULES);
    const calls: QuerySnapshot[] = [];
    onSnapshot(
      query(collection(db, 'posts'), where('visibility', '==', 'public')),
      (snap) => { calls.push(snap as QuerySnapshot); },
    );
    env.flushListeners();
    expect(calls).toHaveLength(1);
    const { setDoc, doc } = await import('../../src/firestore/index.js');
    await setDoc(doc(db, 'posts/p4'), { visibility: 'public', n: 4 });
    const last = calls[calls.length - 1]!;
    expect(last.size).toBe(3);
    expect(last.docs.some((d) => d.id === 'p4')).toBe(true);
  });
});

describe('RULES-B11 — helper-based (function-inlined) list rule', () => {
  it('getDocs PROVABLE: where(owner == my uid) discharges the inlined helper → succeeds', async () => {
    const { db } = setup(OWNER_HELPER_RULES);
    const snap = await getDocs(query(collection(db, 'notes'), where('owner', '==', 'alice')));
    expect(snap.size).toBe(1);
    expect(snap.docs[0]!.id).toBe('n1');
  });

  it('getDocs UNPROVABLE: no discharging where → whole-query denied, carrying remediation + query descriptor', async () => {
    const { db } = setup(OWNER_HELPER_RULES);
    let caught: unknown;
    try {
      await getDocs(collection(db, 'notes'));
    } catch (e) {
      caught = e;
    }
    // The web-modular path surfaces a translated SandboxError: remediation on
    // the instance, the query descriptor under `denialContext`.
    const err = caught as {
      code?: string;
      remediation?: string;
      denialContext?: { query?: unknown };
    };
    expect(err.code).toBe('permission-denied');
    // Remediation is query-side and narrowing: suggest the missing where, with
    // the concrete uid shown for the auth-pinned owner field.
    expect(err.remediation).toBeDefined();
    expect(err.remediation).toContain(".where('owner', '==', request.auth.uid)");
    expect(err.remediation).toContain('"alice"');
    // Machine-readable query descriptor: the bare collection query has no wheres.
    expect(err.denialContext?.query).toEqual({ where: [], limit: null, offset: null, orderBy: null });
  });

  it('onSnapshot PROVABLE: filtered listener attaches and delivers the owner subset', () => {
    const { db, env } = setup(OWNER_HELPER_RULES);
    const calls: QuerySnapshot[] = [];
    const errors: unknown[] = [];
    onSnapshot(
      query(collection(db, 'notes'), where('owner', '==', 'alice')),
      (snap) => { calls.push(snap as QuerySnapshot); },
      (err) => { errors.push(err); },
    );
    env.flushListeners();
    expect(errors).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.size).toBe(1);
    expect(calls[0]!.docs[0]!.id).toBe('n1');
  });

  it('onSnapshot UNPROVABLE: bare collection listen → stream error carrying remediation', () => {
    const { db, env } = setup(OWNER_HELPER_RULES);
    const calls: QuerySnapshot[] = [];
    // The listener error callback receives the structured sim error directly:
    // remediation and the query descriptor are top-level fields.
    const errors: { code?: string; remediation?: string; query?: unknown }[] = [];
    onSnapshot(
      collection(db, 'notes'),
      (snap) => { calls.push(snap as QuerySnapshot); },
      (err) => { errors.push(err as { code?: string; remediation?: string; query?: unknown }); },
    );
    env.flushListeners();
    expect(calls).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('permission-denied');
    expect(errors[0]!.remediation).toContain(".where('owner', '==', request.auth.uid)");
    expect(errors[0]!.query).toBeDefined();
  });
});

describe('RULES-B11 — request.query is populated from the structured constraints', () => {
  it('limit(10) satisfies `request.query.limit <= 50` (failed pre-fix: query was never threaded)', async () => {
    const { db } = setup(QUERY_LIMIT_RULES);
    const snap = await getDocs(query(collection(db, 'posts'), limit(10)));
    expect(snap.size).toBe(3);
  });

  it('limit(100) violates the rule → denied', async () => {
    const { db } = setup(QUERY_LIMIT_RULES);
    expect(await denied(getDocs(query(collection(db, 'posts'), limit(100))))).toBe('permission-denied');
  });

  it('no limit at all → request.query.limit is null → denied', async () => {
    const { db } = setup(QUERY_LIMIT_RULES);
    expect(await denied(getDocs(collection(db, 'posts')))).toBe('permission-denied');
  });
});
