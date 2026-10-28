/**
 * Reads a sparse array on one plane and prints, as JSON, whether `val()` left
 * a hole at the missing index (#1371, hunt finding RT-6):
 *
 *   sparse-array-probe <worker|node>
 *
 * The Node plane runs under Node, built by `buildForNode`, because hosted
 * persistence refuses Bun; its transport carries JSON, as the hosted
 * WebSocket does.
 */
import { openPlane, type PlaneName } from './planes.js';

/** Marks the result line; the test matches the same text. */
const RESULT = 'sparse-array-probe: ';

type Snapshot = { val(): unknown };
type Rtdb = {
  getDatabase(app: unknown): unknown;
  ref(db: unknown, path: string): unknown;
  set(ref: unknown, value: unknown): Promise<void>;
  get(ref: unknown): Promise<Snapshot>;
  onValue(ref: unknown, callback: (snapshot: Snapshot) => void): () => void;
  runTransaction(ref: unknown, update: (current: unknown) => unknown): Promise<{ committed: boolean }>;
};

/** What a reader can tell about `value` as the array `['a', <hole>, 'c']`. */
function shape(value: unknown): unknown {
  if (!Array.isArray(value)) return { isArray: false, value };
  return { isArray: true, length: value.length, hasIndex1: 1 in value, first: value[0], last: value[2] };
}

const session = await openPlane(process.argv[2] as PlaneName);
try {
  await session.setRules(0, { rules: { '.read': true, '.write': true } });
  const rtdb = session.database as unknown as Rtdb;
  const db = rtdb.getDatabase(session.app);
  await rtdb.set(rtdb.ref(db, 'r'), { sparse: { 0: 'a', 2: 'c' } });
  const read = (await rtdb.get(rtdb.ref(db, 'r/sparse'))).val();
  const nested = ((await rtdb.get(rtdb.ref(db, 'r'))).val() as { sparse: unknown }).sparse;
  const heard = await new Promise<unknown>((resolve) => {
    const off = rtdb.onValue(rtdb.ref(db, 'r/sparse'), (snapshot) => { off(); resolve(snapshot.val()); });
  });
  let input: unknown;
  const transaction = await rtdb.runTransaction(rtdb.ref(db, 'r/sparse'), (current) => {
    input = current;
    return current;
  });
  const result = {
    get: shape(read),
    nested: shape(nested),
    onValue: shape(heard),
    transactionInput: shape(input),
    transactionCommitted: transaction.committed,
  };
  // One marked line, since the plane may log its own lines to stdout.
  process.stdout.write(`\n${RESULT}${JSON.stringify(result)}\n`);
} finally {
  await session.close();
}
process.exit(0);
