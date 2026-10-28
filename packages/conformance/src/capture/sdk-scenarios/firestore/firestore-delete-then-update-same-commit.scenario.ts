import type { DocumentReference } from 'firebase/firestore';
import type { FirestoreScenario } from '../scenario-types.ts';

const shape = (error: unknown) => {
  if (error === null) return null;
  const { code, name, message } = error as { code?: string; name?: string; message?: unknown };
  return { code, name, message: String(message).slice(0, 200) };
};

export const scenario: FirestoreScenario = {
  observation: {
    name: 'firestore-delete-then-update-same-commit',
    rowIds: ['firestore#delete-then-update-same-commit'],
    description: 'Delete then update of one doc in a write batch and in a transaction, with set then update and update then delete in a batch as controls. Records the error and the doc afterwards.',
  },
  async run({ db, fs, base }) {
    const col = `${base}/delupd`;
    const out: Record<string, unknown> = {};
    const attempt = async (name: string, path: string, operation: (ref: DocumentReference) => Promise<unknown>) => {
      const ref = fs.doc(db, `${col}/${path}`);
      await fs.setDoc(ref, { n: 0 });
      let error: unknown = null;
      try {
        await operation(ref);
      } catch (caught) {
        error = caught;
      }
      const after = await fs.getDoc(ref);
      out[name] = { threw: error !== null, error: shape(error), exists: after.exists(), data: after.data() ?? null };
    };
    await attempt('batch: delete then update', 'b1', (ref) => {
      const batch = fs.writeBatch(db);
      batch.delete(ref);
      batch.update(ref, { n: 1 });
      return batch.commit();
    });
    await attempt('transaction: delete then update (no read)', 't1', (ref) => fs.runTransaction(db, async (tx) => {
      tx.delete(ref);
      tx.update(ref, { n: 1 });
    }));
    await attempt('control batch: set then update', 'b2', (ref) => {
      const batch = fs.writeBatch(db);
      batch.set(ref, { n: 5 });
      batch.update(ref, { m: 1 });
      return batch.commit();
    });
    await attempt('control batch: update then delete', 'b3', (ref) => {
      const batch = fs.writeBatch(db);
      batch.update(ref, { n: 1 });
      batch.delete(ref);
      return batch.commit();
    });
    return out;
  },
};
