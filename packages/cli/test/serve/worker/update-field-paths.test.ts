/**
 * The served worker carries `update` field paths as segment vectors. A
 * `FieldPath` segment that contains `.` reaches the worker sandbox, its rules
 * projection and its stored document as one literal field name, for
 * `updateDoc`, `WriteBatch.update` and `Transaction.update`.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { FieldPath } from 'pyric/firestore';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import * as client from '../../../src/serve/worker/client.js';
import { assertOperationArguments } from '../../../src/serve/worker/inbound-validation/operation-arguments.js';
import { connectClientToHost, makeHostCtx } from './integration-support.js';

// Updates are allowed only when rules see the literal top-level key and no
// nested `a` map, or when the literal key sits inside `board`.
const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      allow read: if true;
      allow update: if ('a.b' in request.resource.data && !('a' in request.resource.data))
        || request.resource.data.board['c1.r1'] == 'x';
    }
  }
}`;

const SEED = { board: { c1r1: 'a' }, keep: 1 };

async function connect(): Promise<ReturnType<typeof client.getFirestore>> {
  const ctx = await makeHostCtx();
  setRules(ctx.sandbox, RULES);
  seedDocuments(ctx.sandbox, { 'c/d': structuredClone(SEED) });
  return connectClientToHost(ctx, `worker://update-field-paths-${Math.random()}`).db;
}

async function stored(db: ReturnType<typeof client.getFirestore>): Promise<unknown> {
  return (await client.getDoc(client.doc(db, 'c/d'))).data();
}

describe('served update field paths', () => {
  it('updateDoc writes a literal-dot FieldPath as one top-level field', async () => {
    const previous = globalThis.SharedWorker;
    try {
      const db = await connect();
      await client.updateDoc(client.doc(db, 'c/d'), new FieldPath('a.b'), 'x');
      expect(await stored(db)).toEqual({ ...SEED, 'a.b': 'x' });
    } finally {
      globalThis.SharedWorker = previous;
    }
  });

  it('WriteBatch.update and Transaction.update keep a literal dot inside a nested map', async () => {
    const previous = globalThis.SharedWorker;
    try {
      const db = await connect();
      const ref = client.doc(db, 'c/d');
      const batch = client.writeBatch(db);
      batch.update(ref, new FieldPath('board', 'c1.r1'), 'x');
      await batch.commit();
      expect(await stored(db)).toEqual({ board: { c1r1: 'a', 'c1.r1': 'x' }, keep: 1 });
      await client.runTransaction(db, async (transaction) => {
        await transaction.get(ref);
        transaction.update(ref, new FieldPath('a.b'), 'y');
      });
      expect(await stored(db)).toEqual({ board: { c1r1: 'a', 'c1.r1': 'x' }, keep: 1, 'a.b': 'y' });
    } finally {
      globalThis.SharedWorker = previous;
    }
  });

  it('rejects malformed arguments on the client with the Web SDK message', async () => {
    const previous = globalThis.SharedWorker;
    try {
      const db = await connect();
      expect(() => client.updateDoc(client.doc(db, 'c/d'), 'a', 1, 'b')).toThrow(
        'Function updateDoc() needs to be called with an even number of arguments that alternate between field names and values.',
      );
    } finally {
      globalThis.SharedWorker = previous;
    }
  });

  it('accepts a segment-vector field list and refuses an empty segment', () => {
    const op = (fields: Record<string, unknown>) => ({ t: 'op', id: '1', method: 'updateDoc', path: 'c/d', ...fields });
    expect(() => assertOperationArguments(op({ fields: [{ path: ['a.b'], value: 'x' }] }))).not.toThrow();
    expect(() => assertOperationArguments(op({ data: { 'a.b': 'x' } }))).not.toThrow();
    expect(() => assertOperationArguments(op({ fields: [{ path: [''], value: 'x' }] }))).toThrow();
    expect(() => assertOperationArguments(op({ fields: [{ path: 'a.b', value: 'x' }] }))).toThrow();
    expect(() => assertOperationArguments(op({ fields: [], data: {} }))).toThrow();
  });
});
