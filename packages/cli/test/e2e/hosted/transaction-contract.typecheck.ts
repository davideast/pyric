import { doc, runTransaction, type Firestore, type FirestoreDataConverter } from 'pyric/firestore';
import { doc as workerDoc, runTransaction as workerTransaction, type ClientDb } from '@pyric/cli/serve/worker';

interface User {
  label: string;
}

/** Compile the same public reference/transaction path without assertions or Admin handles. */
export function readUser(database: Firestore, converter: FirestoreDataConverter<User>): Promise<User | undefined> {
  const reference = doc(database, 'users/first').withConverter(converter);
  return runTransaction(database, async (transaction) => {
    const snapshot = await transaction.get(reference);
    const exists: boolean = snapshot.exists();
    if (exists) return snapshot.data();
    return undefined;
  });
}

/** The published worker adapter must preserve the same inferred model. */
export function readWorkerUser(database: ClientDb, converter: FirestoreDataConverter<User>): Promise<User | undefined> {
  const reference = workerDoc(database, 'users/first').withConverter(converter);
  return workerTransaction(database, async (transaction) => {
    const snapshot = await transaction.get(reference);
    const exists: boolean = snapshot.exists();
    if (exists) return snapshot.data();
    return undefined;
  });
}
