import type { FirestoreScenario } from '../scenario-types.ts';

/** Non-finite numbers do not survive JSON, so they are recorded by name. */
function encode(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => {
    const nonFinite = typeof value === 'number' && !Number.isFinite(value);
    return [key, nonFinite ? String(value) : value];
  }));
}

export const scenario: FirestoreScenario = {
  observation: {
    name: 'firestore-aggregate-field-semantics',
    rowIds: ['firestore#76', 'firestore#aggregate-count-with-sum', 'firestore#aggregate-non-finite', 'firestore#composite-index-required'],
    description: 'getAggregateFromServer over four small collections: several aggregations on different fields, count alone, count with sum(y) where one doc lacks y, a null field, a NaN value and an Infinity value. Records each result or error code.',
  },
  async run({ db, fs, base }) {
    const put = (collection: string, id: string, data: Record<string, unknown>) =>
      fs.setDoc(fs.doc(db, `${base}/${collection}/${id}`), data);
    await put('agm', 'a', { x: 1, y: 10 });
    await put('agm', 'b', { x: 2 });
    await put('agm', 'c', { y: 5 });
    await put('agm', 'd', { x: 3, y: 1 });
    await put('agnull', 'a', { x: 1, y: null });
    await put('agnull', 'b', { x: 2, y: 4 });
    await put('agnan', '1', { v: 1 });
    await put('agnan', '2', { v: NaN });
    await put('agnan', '3', { v: 2 });
    await put('aginf', '1', { v: 1 });
    await put('aginf', '2', { v: Infinity });
    const aggregate = async (collection: string, spec: Parameters<typeof fs.getAggregateFromServer>[1]) => {
      try {
        const snapshot = await fs.getAggregateFromServer(fs.collection(db, `${base}/${collection}`), spec);
        return encode(snapshot.data() as Record<string, unknown>);
      } catch (error) {
        const { code, message } = error as { code?: string; message?: unknown };
        return { error: code, message: String(message).slice(0, 200) };
      }
    };
    return {
      multi: await aggregate('agm', { n: fs.count(), sx: fs.sum('x'), sy: fs.sum('y'), ay: fs.average('y') }),
      countOnly: await aggregate('agm', { n: fs.count() }),
      countAndSumY: await aggregate('agm', { n: fs.count(), sy: fs.sum('y') }),
      nullField: await aggregate('agnull', { n: fs.count(), sx: fs.sum('x'), sy: fs.sum('y') }),
      nan: await aggregate('agnan', { s: fs.sum('v'), a: fs.average('v'), n: fs.count() }),
      inf: await aggregate('aginf', { s: fs.sum('v'), a: fs.average('v'), n: fs.count() }),
    };
  },
};
