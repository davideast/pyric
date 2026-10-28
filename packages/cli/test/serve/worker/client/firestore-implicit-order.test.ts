/**
 * Implicit query order on the served planes (#1364, FL-4).
 *
 * With inequality filters on several fields and no orderBy, Firestore orders
 * by those fields in field-path order, then the document key. A snapshot
 * cursor makes the served client send that order to the host as explicit
 * orderBy clauses, so the client must build it the same way the in-page
 * engine does. Runs against a real host over the fake port pair.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { servedFirestoreContext, restoreSharedWorker } from '../oracle-captures/support.ts';

restoreSharedWorker();

describe('served implicit order with several inequality fields', () => {
  async function seeded() {
    const { fs, db } = await servedFirestoreContext();
    const k = fs.collection(db, 'k');
    for (const [id, a, b] of [['p', 2, 1], ['q', 1, 2], ['r', 1, 1], ['s', 2, 2]] as const) {
      await fs.setDoc(fs.doc(k, id), { a, b });
    }
    const ids = async (...constraints: Parameters<typeof fs.query>[1][]) =>
      (await fs.getDocs(fs.query(k, ...constraints))).docs.map((d) => d.id).join();
    return { fs, db, k, ids };
  }

  it('orders by field path, not filter order', async () => {
    const { fs, ids } = await seeded();
    expect(await ids(fs.where('b', '>', 0), fs.where('a', '>', 0))).toBe('r,q,p,s');
  });

  it('a snapshot cursor positions on the same order', async () => {
    const { fs, db, ids } = await seeded();
    const snapR = await fs.getDoc(fs.doc(db, 'k/r'));
    expect(await ids(fs.where('b', '>', 0), fs.where('a', '>', 0), fs.startAfter(snapR))).toBe('q,p,s');
  });
});
