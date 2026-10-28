import type { FirestoreScenario } from '../scenario-types.ts';

/** A collection id unique to this scenario, so no composite index covers it. */
const COLLECTION_ID = 'sdkfl30_idx_probe';

export const scenario: FirestoreScenario = {
  observation: {
    name: 'firestore-query-composite-index-required',
    rowIds: ['firestore#composite-index-required'],
    description: 'Queries on a collection id no composite index covers: two controls that need only single-field indexes, and four shapes that need a composite index (equality plus orderBy on another field, range plus orderBy on another field, ranges on two fields, array-contains plus orderBy).',
  },
  async run({ db, fs, base }) {
    const target = fs.collection(db, `${base}/${COLLECTION_ID}`);
    const seeds: Array<[string, number, number]> = [['p', 2, 1], ['q', 1, 2], ['r', 1, 1], ['s', 2, 2]];
    for (const [id, a, b] of seeds) {
      await fs.setDoc(fs.doc(db, `${base}/${COLLECTION_ID}/${id}`), { a, b, tags: [a] });
    }
    const cases = {
      controlEqOnly: () => fs.query(target, fs.where('a', '==', 1)),
      controlRangeAndOrderSame: () => fs.query(target, fs.where('a', '>', 0), fs.orderBy('a')),
      eqPlusOrderOther: () => fs.query(target, fs.where('a', '==', 1), fs.orderBy('b')),
      rangePlusOrderOther: () => fs.query(target, fs.where('a', '>', 0), fs.orderBy('b')),
      twoRangeFields: () => fs.query(target, fs.where('b', '>', 0), fs.where('a', '>', 0)),
      arrayContainsPlusOrder: () => fs.query(target, fs.where('tags', 'array-contains', 1), fs.orderBy('b')),
    };
    const out: Record<string, unknown> = {};
    for (const [key, build] of Object.entries(cases)) {
      try {
        const snapshot = await fs.getDocs(build());
        out[key] = { ok: snapshot.docs.map((d) => d.id).join() };
      } catch (error) {
        const { code, message } = error as { code?: string; message?: unknown };
        out[key] = { code, requiresIndex: /index/i.test(String(message)) };
      }
    }
    return out;
  },
};
