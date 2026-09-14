import {
  doc, setDoc, writeBatch, runTransaction,
  type Firestore, type FirestoreDataConverter,
} from 'pyric/firestore';
import {
  doc as workerDoc, setDoc as workerSetDoc,
  writeBatch as workerBatch, runTransaction as workerTransaction,
  type ClientDb,
} from '@pyric/cli/serve/worker';

interface User {
  label: string;
}

/** App models need no index signature or assertion to use converted write APIs. */
export async function writeUser(database: Firestore, converter: FirestoreDataConverter<User>, model: User): Promise<void> {
  const original = doc(database, 'users/first').withConverter(converter);
  const reference = original.withConverter(null).withConverter(converter);
  await setDoc(reference, model);
  await writeBatch(database).set(reference, model).commit();
  await runTransaction(database, async (transaction) => {
    transaction.set(reference, model);
  });
}

/** The published worker adapter accepts the same converted model and lifecycle. */
export async function writeWorkerUser(database: ClientDb, converter: FirestoreDataConverter<User>, model: User): Promise<void> {
  const original = workerDoc(database, 'users/first').withConverter(converter);
  const reference = original.withConverter(null).withConverter(converter);
  await workerSetDoc(reference, model);
  await workerBatch(database).set(reference, model).commit();
  await workerTransaction(database, async (transaction) => {
    transaction.set(reference, model);
  });
}
