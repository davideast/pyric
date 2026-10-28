import type { FirestoreScenario } from '../scenario-types.ts';

const range = (length: number) => Array.from({ length }, (_, index) => index);

export const scenario: FirestoreScenario = {
  observation: {
    name: 'firestore-query-disjunction-limits',
    rowIds: ['firestore#query-disjunction-limits'],
    description: "getDocs at and past the server's query limits: in with 30 and 31 values, not-in with 10 and 11, array-contains-any with 31, or() with 31 branches, and and(in[6], or(6 branches)) for 36 terms after normalization.",
  },
  async run({ db, fs, base }) {
    const target = fs.collection(db, `${base}/lim`);
    await fs.setDoc(fs.doc(db, `${base}/lim/d0`), { a: 0, b: 0, tags: [0] });
    const cases = {
      in30: () => fs.query(target, fs.where('a', 'in', range(30))),
      in31: () => fs.query(target, fs.where('a', 'in', range(31))),
      notIn10: () => fs.query(target, fs.where('a', 'not-in', range(10))),
      notIn11: () => fs.query(target, fs.where('a', 'not-in', range(11))),
      aca31: () => fs.query(target, fs.where('tags', 'array-contains-any', range(31))),
      or31: () => fs.query(target, fs.or(...range(31).map((i) => fs.where('a', '==', i)))),
      dnf36: () => fs.query(target, fs.and(fs.where('a', 'in', range(6)), fs.or(...range(6).map((i) => fs.where('b', '==', i))))),
    };
    const out: Record<string, unknown> = {};
    for (const [key, build] of Object.entries(cases)) {
      let built;
      try {
        built = build();
      } catch (error) {
        const { code, message } = error as { code?: string; message?: unknown };
        out[key] = { at: 'query()', code, message: String(message).slice(0, 200) };
        continue;
      }
      try {
        out[key] = { ok: (await fs.getDocs(built)).size };
      } catch (error) {
        const { code, message } = error as { code?: string; message?: unknown };
        out[key] = { at: 'getDocs', code, message: String(message).slice(0, 200) };
      }
    }
    return out;
  },
};
