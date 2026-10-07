/**
 * `update` in the field-and-value form: field paths are segment vectors, so a
 * `FieldPath` segment that contains `.` names one literal field. Covers the
 * modular `updateDoc`, `WriteBatch.update` and `Transaction.update`, the
 * Admin-shaped chain `update`, and the Web SDK and Admin SDK argument errors.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, replay } from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import {
  FieldPath,
  deleteField,
  doc,
  getDoc,
  getFirestore,
  increment,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type Firestore,
} from '../../src/firestore/index.js';
import { LocalEnvironment } from '../../src/firestore/sandbox/local-environment.js';
import { FirestoreImpl } from '../../src/firestore/sandbox/admin-compat/firestore.js';
import { FieldPath as AdminFieldPath } from '../../src/firestore/sandbox/admin-compat/field-path.js';
import {
  fieldPathKey,
  fieldPathKeySegments,
} from '../../src/firestore/sandbox/update-fields.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const SEED = { board: { c1r1: 'a', c2r2: 'b' }, keep: 1 };

function seededDb(): Firestore {
  const sandbox = initializeSandbox();
  setRules(sandbox, OPEN_RULES);
  seedDocuments(sandbox, { 'c/d': structuredClone(SEED) });
  return getFirestore(sandbox.withAuth({ uid: 'alice' }));
}

async function stored(db: Firestore): Promise<Record<string, unknown> | undefined> {
  return (await getDoc(doc(db, 'c/d'))).data() as Record<string, unknown> | undefined;
}

describe('updateDoc field-and-value form', () => {
  it('writes a FieldPath with a literal dot as one top-level field', async () => {
    const db = seededDb();
    await updateDoc(doc(db, 'c/d'), new FieldPath('a.b'), 'x');
    expect(await stored(db)).toEqual({ ...SEED, 'a.b': 'x' });
  });

  it('writes a dotted string field as a nested path', async () => {
    const db = seededDb();
    await updateDoc(doc(db, 'c/d'), 'board.c1r1', 'y');
    expect(await stored(db)).toEqual({ board: { c1r1: 'y', c2r2: 'b' }, keep: 1 });
  });

  it('writes a literal dotted key inside a nested map', async () => {
    const db = seededDb();
    await updateDoc(doc(db, 'c/d'), new FieldPath('board', 'c1.r1'), 'x');
    expect(await stored(db)).toEqual({ board: { c1r1: 'a', c2r2: 'b', 'c1.r1': 'x' }, keep: 1 });
  });

  it('applies every pair and keeps the last value of a repeated field', async () => {
    const db = seededDb();
    await updateDoc(doc(db, 'c/d'), 'keep', 2, new FieldPath('a.b'), 'x', 'keep', 3);
    expect(await stored(db)).toEqual({ ...SEED, keep: 3, 'a.b': 'x' });
  });

  it('reads the prior value of a literal-dot field for a transform and deletes it by FieldPath', async () => {
    const db = seededDb();
    await updateDoc(doc(db, 'c/d'), new FieldPath('n.m'), 5);
    await updateDoc(doc(db, 'c/d'), new FieldPath('n.m'), increment(2));
    expect((await stored(db))?.['n.m']).toBe(7);
    await updateDoc(doc(db, 'c/d'), new FieldPath('n.m'), deleteField());
    expect(await stored(db)).toEqual(SEED);
  });

  it('keeps a backtick in a dotted object key literal', async () => {
    const db = seededDb();
    await updateDoc(doc(db, 'c/d'), { '`q`.r': 1 });
    expect(await stored(db)).toEqual({ ...SEED, '`q`': { r: 1 } });
  });
});

describe('WriteBatch.update and Transaction.update field-and-value form', () => {
  it('writes literal-dot FieldPaths through a batch', async () => {
    const db = seededDb();
    const batch = writeBatch(db);
    batch.update(doc(db, 'c/d'), new FieldPath('a.b'), 'x', 'board.c1r1', 'z');
    await batch.commit();
    expect(await stored(db)).toEqual({ board: { c1r1: 'z', c2r2: 'b' }, keep: 1, 'a.b': 'x' });
  });

  it('writes literal-dot FieldPaths through a transaction', async () => {
    const db = seededDb();
    await runTransaction(db, async (transaction) => {
      await transaction.get(doc(db, 'c/d'));
      transaction.update(doc(db, 'c/d'), new FieldPath('board', 'c1.r1'), 'x');
    });
    expect(await stored(db)).toEqual({ board: { c1r1: 'a', c2r2: 'b', 'c1.r1': 'x' }, keep: 1 });
  });
});

describe('Web SDK update argument errors', () => {
  it('rejects an odd number of trailing arguments', () => {
    const db = seededDb();
    expect(() => updateDoc(doc(db, 'c/d'), 'a', 1, 'b')).toThrow(
      'Function updateDoc() needs to be called with an even number of arguments that alternate between field names and values.',
    );
    expect(() => writeBatch(db).update(doc(db, 'c/d'), 'a', 1, 'b')).toThrow(
      'Function WriteBatch.update() needs to be called with an even number of arguments that alternate between field names and values.',
    );
  });

  it('rejects malformed string field paths with the SDK messages', () => {
    const db = seededDb();
    const ref = doc(db, 'c/d');
    const caught = (fn: () => unknown): { code?: string; message?: string } => {
      try {
        fn();
      } catch (error) {
        return error as { code?: string; message?: string };
      }
      throw new Error('expected a throw');
    };
    const empty = caught(() => updateDoc(ref, 'a..b', 1));
    expect(empty.code).toBe('invalid-argument');
    expect(empty.message).toBe(
      "Function updateDoc() called with invalid data. Invalid field path (a..b). Paths must not be empty, begin with '.', end with '.', or contain '..'",
    );
    expect(caught(() => updateDoc(ref, { 'a/b': 1 })).message).toBe(
      "Function updateDoc() called with invalid data. Invalid field path (a/b). Paths must not contain '~', '*', '/', '[', or ']' (found in document c/d)",
    );
    // A field argument is reported without the document; an object key names it.
    expect(caught(() => updateDoc(ref, 'a', 1, '.b', 2)).message).toBe(
      "Function updateDoc() called with invalid data. Invalid field path (.b). Paths must not be empty, begin with '.', end with '.', or contain '..'",
    );
    expect(caught(() => updateDoc(ref, 'a', 1, 5 as unknown as string, 2)).message).toBe(
      'Function updateDoc() called with invalid data. Field path arguments must be of type string or ',
    );
  });
});

describe('Admin-shaped chain update', () => {
  function adminDb(): FirestoreImpl {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'c/d': structuredClone(SEED) } });
    return new FirestoreImpl(env, { uid: 'alice' });
  }

  async function adminStored(db: FirestoreImpl): Promise<Record<string, unknown> | undefined> {
    return (await db.doc('c/d').get()).data();
  }

  it('writes literal-dot FieldPaths through DocumentReference.update', async () => {
    const db = adminDb();
    await db.doc('c/d').update(new AdminFieldPath('a.b'), 'x', 'board.c1r1', 'y');
    expect(await adminStored(db)).toEqual({ board: { c1r1: 'y', c2r2: 'b' }, keep: 1, 'a.b': 'x' });
  });

  it('writes literal-dot FieldPaths through WriteBatch.update and Transaction.update', async () => {
    const db = adminDb();
    await db.batch().update(db.doc('c/d'), new AdminFieldPath('a.b'), 'x').commit();
    await db.runTransaction(async (transaction) => {
      await transaction.get(db.doc('c/d'));
      transaction.update(db.doc('c/d'), new AdminFieldPath('board', 'c1.r1'), 'z');
    });
    expect(await adminStored(db)).toEqual({ board: { c1r1: 'a', c2r2: 'b', 'c1.r1': 'z' }, keep: 1, 'a.b': 'x' });
  });

  it('rejects malformed arguments with the Admin SDK messages', async () => {
    const db = adminDb();
    const prefix = 'Update() requires either a single JavaScript object or an alternating list of field/value pairs that can be followed by an optional precondition.';
    expect(() => db.batch().update(db.doc('c/d'), 'a', 1, 'b')).toThrow(`${prefix} Input is not an object.`);
    expect(() => db.batch().update(db.doc('c/d'), 'a..b', 1)).toThrow(
      `${prefix} Element at index 1 is not a valid field path. Paths must not contain ".." in them.`,
    );
    expect(() => db.batch().update(db.doc('c/d'), { '.a': 1 })).toThrow(
      `${prefix} Value for argument ".a" is not a valid field path. Paths must not start or end with ".".`,
    );
  });
});

describe('public payloads carry decoded update field paths', () => {
  const DENY_LITERAL = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, create: if true;
      allow update: if !('a.b' in request.resource.data);
    }
  }
}`;

  function deniedDb(): Firestore {
    const sandbox = initializeSandbox();
    setRules(sandbox, DENY_LITERAL);
    seedDocuments(sandbox, { 'c/d': structuredClone(SEED) });
    return getFirestore(sandbox.withAuth({ uid: 'alice' }));
  }

  it('request and write events hold the field tree and the segment-vector mask', async () => {
    const owner = initializeSandbox();
    setRules(owner, OPEN_RULES);
    seedDocuments(owner, { 'c/d': structuredClone(SEED) });
    const ownedDb = getFirestore(owner.withAuth({ uid: 'alice' }));
    await updateDoc(doc(ownedDb, 'c/d'), new FieldPath('a.b'), 'x', 'board.c1r1', 'y');

    const events = owner.history();
    const request = events.find((event) => event.kind === 'request' && event.method === 'update');
    expect(request?.kind === 'request' ? request.request : undefined).toEqual({
      resourceData: { 'a.b': 'x', board: { c1r1: 'y' } },
      updateMask: [['a.b'], ['board', 'c1r1']],
    });
    const write = events.find((event) => event.kind === 'write' && event.method === 'update');
    expect(write?.kind === 'write' ? [write.data, write.updateMask] : undefined).toEqual([
      { 'a.b': 'x', board: { c1r1: 'y' } },
      [['a.b'], ['board', 'c1r1']],
    ]);
    expect(JSON.stringify(events)).not.toContain('`');
  });

  it('a denied update reports the decoded payload in its error and denial context', async () => {
    const db = deniedDb();
    let error: { code?: string; denialContext?: { request?: unknown } } | undefined;
    try {
      await updateDoc(doc(db, 'c/d'), new FieldPath('a.b'), 'x');
    } catch (caught) {
      error = caught as typeof error;
    }
    expect(error?.code).toBe('permission-denied');
    expect(error?.denialContext?.request).toMatchObject({
      resourceData: { 'a.b': 'x' },
      updateMask: [['a.b']],
    });
    expect(JSON.stringify(error?.denialContext)).not.toContain('`');
  });

  it('the Admin-shaped error carries the decoded payload on its request', async () => {
    const env = new LocalEnvironment();
    env.seed({ rules: DENY_LITERAL, documents: { 'c/d': structuredClone(SEED) } });
    const admin = new FirestoreImpl(env, { uid: 'alice' });
    let error: { simError?: { request?: unknown } } | undefined;
    try {
      await admin.doc('c/d').update(new AdminFieldPath('a.b'), 'x');
    } catch (caught) {
      error = caught as typeof error;
    }
    expect(error?.simError?.request).toMatchObject({ resourceData: { 'a.b': 'x' }, updateMask: [['a.b']] });
  });

  it('rules read an update to a missing document by field path', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow update: if 'a.b' in request.resource.data && !('a' in request.resource.data); }
  }
}`);
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    let code: string | undefined;
    try {
      await updateDoc(doc(db, 'c/missing'), new FieldPath('a.b'), 'x');
    } catch (caught) {
      code = (caught as { code?: string }).code;
    }
    // Rules allow the projection; the write then fails because the document is missing.
    expect(code).toBe('not-found');
  });

  it('replays a literal-dot update, classifying its transform by the same field path', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_RULES);
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    await setDoc(doc(db, 'c/d'), structuredClone(SEED));
    await updateDoc(doc(db, 'c/d'), new FieldPath('a.b'), 'x', 'board.c1r1', 'y');
    await updateDoc(doc(db, 'c/d'), new FieldPath('t.s'), serverTimestamp());
    const original = sandbox.snapshot().firestore;
    const result = replay(sandbox.history(), OPEN_RULES, { pinRequestTime: false }, original);
    expect(result.sandbox.snapshot().firestore['c/d']).toMatchObject({
      board: { c1r1: 'y', c2r2: 'b' },
      'a.b': 'x',
    });
    expect(result.divergences.filter((d) => d.kind === 'real-divergence')).toEqual([]);
    // The transform is recorded at the literal-dot field and matched there.
    const drift = result.divergences.filter((d) => d.kind === 'time-drift');
    expect(drift.map((d) => (d as { field?: string }).field)).toEqual(
      drift.length === 0 ? [] : ['t.s'],
    );
  });
});

describe('undefined field values', () => {
  it('refuses undefined as the SDK does', () => {
    const db = seededDb();
    const ref = doc(db, 'c/d');
    expect(() => updateDoc(ref, 'u', undefined)).toThrow(
      'Function updateDoc() called with invalid data. Unsupported field value: undefined (found in field u in document c/d)',
    );
    expect(() => updateDoc(ref, { 'a.b': { c: undefined } })).toThrow(
      'Function updateDoc() called with invalid data. Unsupported field value: undefined (found in field a.b.c in document c/d)',
    );
    expect(() => updateDoc(ref, new FieldPath('x.y'), [undefined])).toThrow(
      'Function updateDoc() called with invalid data. Unsupported field value: undefined (found in document c/d)',
    );
  });
});

describe('Admin-shaped DocumentReference.update argument errors', () => {
  it('throws synchronously', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: {} });
    const admin = new FirestoreImpl(env, { uid: 'alice' });
    expect(() => admin.doc('c/d').update('a', 1, 'b')).toThrow('Input is not an object.');
  });
});

describe('update field-path keys', () => {
  it('round-trips segment vectors, quoting only segments a split would change', () => {
    const cases: string[][] = [['a'], ['a', 'b'], ['a.b'], ['board', 'c1.r1'], ['`q`', 'r'], ['x\\y', 'z.`w`']];
    for (const segments of cases) {
      expect(fieldPathKeySegments(fieldPathKey(segments))).toEqual(segments);
    }
    expect(fieldPathKey(['board', 'c1r1'])).toBe('board.c1r1');
    expect(fieldPathKey(['a.b'])).toBe('`a.b`');
  });
});
