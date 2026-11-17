import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  collection as sbxCollection,
  doc as sbxDoc,
  getFirestore as sbxGetFirestore,
  onSnapshot as sbxOnSnapshot,
  setDoc as sbxSetDoc,
} from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import { makeSnapshot, type QueryChangeBaseline } from '../../../src/serve/worker/client/snapshots.js';
import * as wc from '../../../src/serve/worker/client.js';
import { connectClientToHost, makeHostCtx } from './integration-support.js';

const OPEN_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} {',
  '      allow read, write: if true;',
  '    }',
    '  }',
  '}',
].join('\n');

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function drain(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await tick();
  }
}

describe('served worker client snapshot key-order equality parity', () => {
  test('does not report a spurious modified docChange when a sibling write fires a query listener after map key reordering', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_RULES);
    const sbxDb = sbxGetFirestore(sandbox);

    const ctx = await makeHostCtx();
    setRules(ctx.sandbox, OPEN_RULES);
    const { db: workerDb } = connectClientToHost(ctx, 'worker://snap-key-order-1');

    try {
      await sbxSetDoc(sbxDoc(sbxDb, 'items/i1'), { meta: { a: 1, b: 2 }, tag: 'same' });
      await sbxSetDoc(sbxDoc(sbxDb, 'items/i2'), { n: 1 });

      await wc.setDoc(wc.doc(workerDb, 'items/i1'), { meta: { a: 1, b: 2 }, tag: 'same' });
      await wc.setDoc(wc.doc(workerDb, 'items/i2'), { n: 1 });

      const sbxChanges: Array<Array<{ type: string; id: string }>> = [];
      const workerChanges: Array<Array<{ type: string; id: string }>> = [];

      const unsubSbx = sbxOnSnapshot(sbxCollection(sbxDb, 'items'), (snap) => {
        sbxChanges.push(snap.docChanges().map((c) => ({ type: c.type, id: c.doc.id })));
      });
      const unsubWorker = wc.onSnapshot(wc.collection(workerDb, 'items'), (snap) => {
        workerChanges.push(snap.docChanges().map((c) => ({ type: c.type, id: c.doc.id })));
      });

      await drain();
      expect(sbxChanges).toHaveLength(1);
      expect(workerChanges).toHaveLength(1);

      // Overwrite i1 with identical Firestore map data whose keys are in reverse
      // insertion order, then modify i2 so a new query snapshot is delivered.
      await sbxSetDoc(sbxDoc(sbxDb, 'items/i1'), { tag: 'same', meta: { b: 2, a: 1 } });
      await sbxSetDoc(sbxDoc(sbxDb, 'items/i2'), { n: 2 });

      await wc.setDoc(wc.doc(workerDb, 'items/i1'), { tag: 'same', meta: { b: 2, a: 1 } });
      await wc.setDoc(wc.doc(workerDb, 'items/i2'), { n: 2 });

      await drain();
      unsubSbx();
      unsubWorker();

      expect(sbxChanges).toEqual([
        [
          { type: 'added', id: 'i1' },
          { type: 'added', id: 'i2' },
        ],
        [{ type: 'modified', id: 'i2' }],
      ]);
      expect(workerChanges).toEqual(sbxChanges);
    } finally {
      ctx.sandbox.dispose();
      sandbox.dispose();
    }
  });

  test('deduplicates re-established document listener frames whose map keys differ only in JSON key order', async () => {
    const ctx = await makeHostCtx();
    const { db: workerDb } = connectClientToHost(ctx, 'worker://snap-key-order-2');
    try {
      const baseline: QueryChangeBaseline = { excludesMetadataChanges: true };
      const first = makeSnapshot(
        {
          id: 'i1',
          path: 'items/i1',
          exists: true,
          data: { json: '{"a":1,"nested":{"x":true,"y":false}}' },
        },
        workerDb.port,
        null,
        baseline,
      );
      const duplicateReordered = makeSnapshot(
        {
          id: 'i1',
          path: 'items/i1',
          exists: true,
          data: { json: '{"nested":{"y":false,"x":true},"a":1}' },
        },
        workerDb.port,
        null,
        baseline,
      );

      expect(first).not.toBeNull();
      expect(duplicateReordered).toBeNull();
    } finally {
      ctx.sandbox.dispose();
    }
  });
});
