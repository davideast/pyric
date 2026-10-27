import type { FirestoreScenario } from '../scenario-types.ts';

const shape = (error: unknown) => {
  if (error === null) return null;
  const { code, name, message } = error as { code?: string; name?: string; message?: unknown };
  return { code, name, message: String(message).slice(0, 200) };
};

export const scenario: FirestoreScenario = {
  observation: {
    name: 'firestore-transaction-client-checks',
    rowIds: ['firestore#transaction-read-after-write', 'firestore#transaction-error-codes'],
    description: 'runTransaction client checks: update after reading a missing doc, a read-after-write error the update function swallows, and a read-after-write error it rethrows. Records each error and whether anything was written.',
  },
  async run({ db, fs, base }) {
    const out: Record<string, unknown> = {};

    const missing = fs.doc(db, `${base}/txn/missing`);
    let missingError: unknown = null;
    try {
      await fs.runTransaction(db, async (tx) => {
        await tx.get(missing);
        tx.update(missing, { a: 1 });
      });
    } catch (error) {
      missingError = error;
    }
    out.updateAfterReadMissing = { error: shape(missingError), exists: (await fs.getDoc(missing)).exists() };

    const written = fs.doc(db, `${base}/txn/written`);
    let swallowedError: unknown = null;
    let value: unknown;
    try {
      value = await fs.runTransaction(db, async (tx) => {
        tx.set(written, { a: 1 });
        try {
          await tx.get(fs.doc(db, `${base}/txn/other`));
        } catch {
          // The update function swallows the read-after-write error.
        }
        return 'done';
      });
    } catch (error) {
      swallowedError = error;
    }
    out.swallowedReadAfterWrite = { value: value ?? null, error: shape(swallowedError), written: (await fs.getDoc(written)).exists() };

    const raw = fs.doc(db, `${base}/txn/raw`);
    let inner: unknown = null;
    let outer: unknown = null;
    try {
      await fs.runTransaction(db, async (tx) => {
        tx.set(raw, { a: 1 });
        try {
          await tx.get(raw);
        } catch (error) {
          inner = shape(error);
          throw error;
        }
      });
    } catch (error) {
      outer = error;
    }
    out.readAfterWrite = { inner, outer: shape(outer) };
    return out;
  },
};
