import type { FirestoreScenario } from '../scenario-types.ts';

export const scenario: FirestoreScenario = {
  observation: {
    name: 'firestore-query-doc-pending-writes',
    rowIds: ['firestore#served-query-doc-pending-writes', 'firestore#listener-local-write-pending'],
    description: 'A query listener with includeMetadataChanges over one stored doc while a second doc is written. Records the snapshot hasPendingWrites and each doc hasPendingWrites.',
  },
  async run({ db, fs, base, wait }) {
    const target = fs.collection(db, `${base}/fp5`);
    await fs.setDoc(fs.doc(target, 'a'), { n: 1 });
    const events: unknown[] = [];
    const stop = fs.onSnapshot(target, { includeMetadataChanges: true }, (s) => events.push({
      pw: s.metadata.hasPendingWrites,
      docs: s.docs.map((d) => [d.id, d.metadata.hasPendingWrites]),
    }));
    await wait(1500);
    await fs.setDoc(fs.doc(target, 'z'), { n: 2 });
    await wait(2000);
    stop();
    await fs.deleteDoc(fs.doc(target, 'a'));
    await fs.deleteDoc(fs.doc(target, 'z'));
    return { events };
  },
};
