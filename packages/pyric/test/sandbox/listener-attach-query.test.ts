/**
 * What a listener attach says about the query the app wrote.
 *
 * A surface that prints the developer's own call back to them needs the
 * operands, and the digest identity that comparison uses cannot be read back.
 * The attach therefore carries a bounded display projection of the operand
 * snapshot taken when the query was built, and the Realtime Database's attach
 * target carries its query spec.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { activeListeners, initializeSandbox } from 'pyric/sandbox';
import {
  collection,
  doc,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import {
  equalTo,
  getDatabase,
  limitToLast,
  onValue,
  orderByChild,
  query as rtdbQuery,
  ref,
  sandbox as rtdbSandbox,
} from 'pyric/database';

const OPEN_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

interface DisplayFilter {
  kind: string;
  field?: string;
  op?: string;
  display?: { type: string; value?: unknown };
  filters?: DisplayFilter[];
}

function attachQueryOf(events: readonly unknown[], listenerId: string): Record<string, unknown> {
  const attach = events.find(
    (event) => (event as { kind?: string; listenerId?: string }).kind === 'listener_attach'
      && (event as { listenerId?: string }).listenerId === listenerId,
  ) as { target?: { query?: Record<string, unknown> } } | undefined;
  if (attach?.target?.query === undefined) throw new Error('attach carried no query');
  return attach.target.query;
}

describe('a listener attach and the query it watches', () => {
  it('states a Firestore query\'s real operands alongside its digest identity', () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_FIRESTORE_RULES);
    const db = getFirestore(sandbox);

    const unsubscribe = onSnapshot(
      query(
        collection(db, 'conversations'),
        where('members', 'array-contains', 'u_8f2a'),
        orderBy('updatedAt', 'desc'),
        limit(50),
      ),
      () => {},
    );

    const listener = activeListeners(sandbox.history())[0]!;
    const spec = attachQueryOf(sandbox.history(), listener.id);
    expect((spec.scope as { kind: string }).kind).toBe('collection');
    const filters = spec.filters as DisplayFilter[];
    expect(filters).toHaveLength(1);
    expect(filters[0]!.field).toBe('members');
    expect(filters[0]!.op).toBe('array-contains');
    expect(filters[0]!.display).toEqual({ type: 'string', value: 'u_8f2a' });
    expect(spec.orderBy).toEqual([{ field: 'updatedAt', direction: 'desc' }]);
    expect(spec.limit).toBe(50);
    expect(listener.query).toBe(spec);

    unsubscribe();
  });

  it('projects a document reference operand as its path and keeps nested filters', () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_FIRESTORE_RULES);
    const db = getFirestore(sandbox);

    const unsubscribe = onSnapshot(
      query(
        collection(db, 'messages'),
        where('conversation', '==', doc(db, 'conversations/c1')),
        where('read', '==', false),
      ),
      () => {},
    );

    const listener = activeListeners(sandbox.history())[0]!;
    const filters = attachQueryOf(sandbox.history(), listener.id).filters as DisplayFilter[];
    expect(filters[0]!.display).toEqual({ type: 'reference', path: 'conversations/c1' });
    expect(filters[1]!.display).toEqual({ type: 'boolean', value: false });

    unsubscribe();
  });

  it('carries the Realtime Database query spec on the attach target', () => {
    const sandbox = initializeSandbox();
    const rtdb = getDatabase(sandbox);
    // The ordered child needs its index, the same as production.
    rtdbSandbox.setRules(rtdb, {
      rules: { '.read': true, '.write': true, presence: { '.indexOn': 'online' } },
    });

    const unsubscribe = onValue(
      rtdbQuery(ref(rtdb, 'presence'), orderByChild('online'), equalTo(true), limitToLast(20)),
      () => {},
    );

    const listener = activeListeners(sandbox.history()).find(
      (entry) => entry.service === 'database',
    )!;
    expect(listener.query).toEqual({
      orderBy: { kind: 'child', path: 'online' },
      bounds: [{ kind: 'equalTo', value: true }],
      limit: { kind: 'limitToLast', n: 20 },
    });

    unsubscribe();
  });

  it('leaves a document listener and a bare path with no query', () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_FIRESTORE_RULES);
    const db = getFirestore(sandbox);
    const rtdb = getDatabase(sandbox);
    rtdbSandbox.setRules(rtdb, rtdbSandbox.DEFAULT_OPEN_RULES);

    const unsubscribeDoc = onSnapshot(doc(db, 'conversations/c1'), () => {});
    const unsubscribeValue = onValue(ref(rtdb, 'presence'), () => {});

    for (const listener of activeListeners(sandbox.history())) {
      expect(listener.query).toBeUndefined();
    }

    unsubscribeDoc();
    unsubscribeValue();
  });
});
