import type { FirestoreScenario } from '../scenario-types.ts';

const STEP_MS = 15_000;

export const scenario: FirestoreScenario = {
  observation: {
    name: 'firestore-query-negative-zero',
    rowIds: ['firestore#negative-zero-equality'],
    description: 'Three docs with v = 0, 1 and -0, read with getDocsFromServer under == 0, == -0, in [0], != 0, not-in [0] and orderBy(v), each step bounded at 15 s. not-in [0] did not settle within the bound.',
  },
  async run({ db, fs, base, bounded }) {
    const log: Array<[string, string]> = [];
    const step = <T>(name: string, promise: Promise<T>) =>
      bounded(name, promise, STEP_MS).then((value) => { log.push([name, 'ok']); return value; });
    const path = `${base}/negzero`;
    const out: Record<string, unknown> = { log };
    try {
      await step('set pos', fs.setDoc(fs.doc(db, `${path}/pos`), { v: 0 }));
      await step('set one', fs.setDoc(fs.doc(db, `${path}/one`), { v: 1 }));
      await step('set neg', fs.setDoc(fs.doc(db, `${path}/neg`), { v: -0 }));
    } catch (error) {
      out.writeError = String((error as Error).message);
    }
    const target = fs.collection(db, path);
    const ids = async (name: string, ...constraints: Parameters<typeof fs.query>[1][]) => {
      try {
        const snapshot = await step(name, fs.getDocsFromServer(fs.query(target, ...constraints)));
        return snapshot.docs.map((d) => d.id).join();
      } catch (error) {
        const { code, message } = error as { code?: string; message?: unknown };
        return { error: code ?? String(message) };
      }
    };
    try {
      const negative = await step('get neg', fs.getDocFromServer(fs.doc(db, `${path}/neg`)));
      out.storedNegIsNegZero = Object.is(negative.get('v'), -0);
    } catch (error) {
      out.getNeg = String((error as Error).message);
    }
    out.eq0 = await ids('eq0', fs.where('v', '==', 0));
    out.eqNeg0 = await ids('eqNeg0', fs.where('v', '==', -0));
    out.in0 = await ids('in0', fs.where('v', 'in', [0]));
    out.ne0 = await ids('ne0', fs.where('v', '!=', 0));
    out.notIn0 = await ids('notIn0', fs.where('v', 'not-in', [0]));
    out.orderBy = await ids('orderBy', fs.orderBy('v'));
    return out;
  },
};
