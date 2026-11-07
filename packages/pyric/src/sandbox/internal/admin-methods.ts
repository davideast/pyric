/**
 * The client SDK method each observed Admin call counts as (A-9 in the #2304
 * plan). Live mode records a firebase-admin call as `<Class>.<method>`, such
 * as `DocumentReference.get`, and Rates, the billed count and the usage
 * measure each know the client SDK's names. Each Admin method reads here as
 * the client method that bills the same way, so an Admin call counts with
 * the client calls of its kind, under that name, until Rates gives Admin
 * calls a group of their own.
 *
 * The live Firestore row records a batch commit as `writeBatch`, its export;
 * it counts as the sandbox's `writeBatch.commit`.
 *
 * Methods with no entry, such as `DocumentReference.listCollections` and the
 * Auth calls, are not counted.
 */
import type { EventService } from '../types/operation.js';

const COVERAGE_METHODS: ReadonlyMap<string, string> = new Map([
  ['firestore/writeBatch', 'writeBatch.commit'],
  ['firestore/DocumentReference.get', 'getDoc'],
  ['firestore/Query.get', 'getDocs'],
  ['firestore/Firestore.getAll', 'getDocs'],
  ['firestore/AggregateQuery.get', 'getAggregateFromServer'],
  ['firestore/DocumentReference.set', 'setDoc'],
  ['firestore/DocumentReference.create', 'setDoc'],
  ['firestore/DocumentReference.update', 'updateDoc'],
  ['firestore/DocumentReference.delete', 'deleteDoc'],
  ['firestore/CollectionReference.add', 'addDoc'],
  ['firestore/WriteBatch.commit', 'writeBatch.commit'],
  ['firestore/Firestore.runTransaction', 'runTransaction'],
  ['firestore/DocumentReference.onSnapshot', 'onSnapshot'],
  ['firestore/Query.onSnapshot', 'onSnapshot'],
  ['rtdb/Query.get', 'get'],
  ['rtdb/Query.once', 'get'],
  ['rtdb/Query.on', 'onValue'],
  ['rtdb/Reference.set', 'set'],
  ['rtdb/Reference.update', 'update'],
  ['rtdb/Reference.remove', 'remove'],
  ['rtdb/Reference.push', 'push'],
  ['rtdb/Reference.setWithPriority', 'setWithPriority'],
  ['rtdb/Reference.transaction', 'runTransaction'],
  ['storage/File.save', 'uploadBytes'],
  ['storage/Bucket.upload', 'uploadBytes'],
  ['storage/File.copy', 'uploadBytes'],
  ['storage/File.move', 'uploadBytes'],
  ['storage/File.download', 'getBytes'],
  ['storage/File.exists', 'getMetadata'],
  ['storage/File.getMetadata', 'getMetadata'],
  ['storage/Bucket.getFiles', 'listAll'],
  ['storage/File.setMetadata', 'updateMetadata'],
  ['storage/File.delete', 'deleteObject'],
  ['storage/Bucket.deleteFiles', 'deleteObject'],
]);

/** The client SDK method an observed call to `method` of `service` counts as: its alias, or the method itself. */
export function coverageMethodOf(service: EventService, method: string): string {
  return COVERAGE_METHODS.get(`${service}/${method}`) ?? method;
}
