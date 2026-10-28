import type { FirestoreScenario } from '../scenario-types.ts';

const WRITE_MS = 15_000;

/** A value nested `levels` maps below the field: nest(2) is `{ m: { m: 1 } }`. */
function nest(levels: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < levels; i++) value = { m: value };
  return value;
}

export const scenario: FirestoreScenario = {
  observation: {
    name: 'firestore-write-server-limits',
    rowIds: ['firestore#write-server-limits'],
    description: 'setDoc at and past the documented write limits: values nested in 19, 20 and 21 maps, a doc over 1 MiB, document ids __x__, . and .., a 1,501-byte id and field name, and 500 and 501 field transforms on one doc. Records whether each resolves or its error.',
  },
  async run({ db, fs, base, bounded }) {
    const col = `${base}/limits`;
    const transforms = (count: number) => {
      const data: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) data[`n${i}`] = fs.increment(1);
      return data;
    };
    const cases: Record<string, () => Promise<void>> = {
      'map depth 19 (value nested in 19 maps)': () => fs.setDoc(fs.doc(db, `${col}/d19`), { r: nest(18) }),
      'map depth 20': () => fs.setDoc(fs.doc(db, `${col}/d20`), { r: nest(19) }),
      'map depth 21': () => fs.setDoc(fs.doc(db, `${col}/d21`), { r: nest(20) }),
      'document over 1 MiB': () => fs.setDoc(fs.doc(db, `${col}/big`), { s: 'x'.repeat(1_048_576) }),
      "document id '__x__'": () => fs.setDoc(fs.doc(db, `${col}/__x__`), { a: 1 }),
      "document id '.'": () => fs.setDoc(fs.doc(db, `${col}/.`), { a: 1 }),
      "document id '..'": () => fs.setDoc(fs.doc(db, `${col}/..`), { a: 1 }),
      'document id of 1,501 bytes': () => fs.setDoc(fs.doc(db, `${col}/${'x'.repeat(1501)}`), { a: 1 }),
      'field name of 1,501 bytes': () => fs.setDoc(fs.doc(db, `${col}/longfield`), { ['f'.repeat(1501)]: 1 }),
      '500 transforms on one document': () => fs.setDoc(fs.doc(db, `${col}/t500`), transforms(500)),
      '501 transforms on one document': () => fs.setDoc(fs.doc(db, `${col}/t501`), transforms(501)),
    };
    const out: Record<string, unknown> = {};
    for (const [name, write] of Object.entries(cases)) {
      let pending: Promise<void>;
      try {
        pending = write();
      } catch (error) {
        const { code, message } = error as { code?: string; message?: unknown };
        out[name] = { ok: false, sync: true, code, message: String(message).slice(0, 200) };
        continue;
      }
      try {
        await bounded('probe', pending, WRITE_MS);
        out[name] = { ok: true };
      } catch (error) {
        const { code, name: errorName, message } = error as { code?: string; name?: string; message?: unknown };
        const timedOut = code === undefined && String(message) === 'probe timeout';
        out[name] = timedOut
          ? { ok: false, sync: false, code: 'probe-timeout', name: 'Error', message: 'probe timeout 15s' }
          : { ok: false, sync: false, code, name: errorName, message: String(message).slice(0, 200) };
      }
    }
    return out;
  },
};
