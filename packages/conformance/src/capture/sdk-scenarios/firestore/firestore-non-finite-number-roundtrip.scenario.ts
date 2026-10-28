import type { FirestoreScenario } from '../scenario-types.ts';

/** Name the values JSON cannot hold. */
function tag(value: unknown): unknown {
  if (Number.isNaN(value)) return 'NaN';
  if (Object.is(value, -0)) return '-0';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  return value;
}

const ROWS: Array<[string, number | null]> = [['nan', NaN], ['inf', Infinity], ['ninf', -Infinity], ['neg0', -0], ['nul', null]];

export const scenario: FirestoreScenario = {
  observation: {
    name: 'firestore-non-finite-number-roundtrip',
    rowIds: ['firestore#served-non-finite-numbers', 'firestore#negative-zero-equality'],
    description: 'Docs holding NaN, Infinity, -Infinity, -0 and null, read back with getDocFromServer, and queried with == NaN, == null and == 0.',
  },
  async run({ db, fs, base }) {
    const target = fs.collection(db, `${base}/fp1`);
    for (const [id, v] of ROWS) await fs.setDoc(fs.doc(target, id), { v });
    const read: Record<string, unknown> = {};
    for (const [id] of ROWS) read[id] = tag((await fs.getDocFromServer(fs.doc(target, id))).data()?.v);
    const ids = async (...constraints: Parameters<typeof fs.query>[1][]) =>
      (await fs.getDocsFromServer(fs.query(target, ...constraints))).docs.map((d) => d.id).sort();
    const out = {
      read,
      eqNaN: await ids(fs.where('v', '==', NaN)),
      eqNull: await ids(fs.where('v', '==', null)),
      eq0: await ids(fs.where('v', '==', 0)),
    };
    for (const [id] of ROWS) await fs.deleteDoc(fs.doc(target, id));
    return out;
  },
};
