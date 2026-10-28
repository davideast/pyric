import type { FirestoreScenario } from '../scenario-types.ts';

/** `null`, `'Timestamp'` for a Timestamp-like value, otherwise the value itself. */
function kind(value: unknown): unknown {
  if (value === null) return null;
  const isTimestamp = typeof (value as { toMillis?: unknown } | undefined)?.toMillis === 'function';
  return isTimestamp ? 'Timestamp' : value;
}

export const scenario: FirestoreScenario = {
  observation: {
    name: 'firestore-servertimestamp-pending-echo',
    rowIds: ['firestore#servertimestamp-pending-value'],
    description: 'updateDoc with serverTimestamp() while online, seen by a doc listener and a query listener with includeMetadataChanges. Records hasPendingWrites and the field under the default, estimate and previous serverTimestamps options for each snapshot.',
  },
  async run({ db, fs, base, wait }) {
    const ref = fs.doc(db, `${base}/st/d`);
    await fs.setDoc(ref, { t: 'old' });
    const docEvents: unknown[] = [];
    const queryEvents: unknown[] = [];
    const stopDoc = fs.onSnapshot(ref, { includeMetadataChanges: true }, (s) => docEvents.push({
      pending: s.metadata.hasPendingWrites,
      fromCache: s.metadata.fromCache,
      none: kind(s.data()?.t),
      estimate: kind(s.data({ serverTimestamps: 'estimate' })?.t),
      previous: kind(s.data({ serverTimestamps: 'previous' })?.t),
    }));
    const stopQuery = fs.onSnapshot(fs.collection(db, `${base}/st`), { includeMetadataChanges: true }, (s) => queryEvents.push({
      pending: s.metadata.hasPendingWrites,
      docPending: s.docs[0]?.metadata.hasPendingWrites,
      none: kind(s.docs[0]?.data().t),
      previous: kind(s.docs[0]?.data({ serverTimestamps: 'previous' }).t),
    }));
    await wait(1500);
    await fs.updateDoc(ref, { t: fs.serverTimestamp() });
    await wait(2000);
    stopDoc();
    stopQuery();
    return { docEvents, queryEvents };
  },
};
